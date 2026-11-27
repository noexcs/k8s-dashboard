// 工作负载聚合日志（Stern 式）：工作负载下多 Pod 日志按时间戳合流交织。
// 滚动发布时新旧 Pod 日志不再逐个切换拉取；[pod] 前缀区分来源，上限 10 Pod 防刷屏。
// 独立于 LogsView（单 Pod 深看仍走 LogsView）：合流视图只做「扫一眼全貌」。
import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, Pause, Play } from 'lucide-react'
import { streamLogs } from '@/api/client'
import { tf, useT } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { findWorkloadPods } from './WorkloadActions'

const MAX_PODS = 10
const TAIL = 100
const MAX_LINES = 3000
const FLUSH_MS = 200
/** 扇出流上限（Pod×容器 展开后封顶；12 路足够滚动发布场景，再多是刷屏） */
const MAX_STREAMS = 12

interface Row {
  ts: string
  pod: string
  line: string
}

/** 合流归并：既有 rows 已按 ts 有序，新批排序后线性归并（3000 行级无感） */
function mergeRows(rows: Row[], batch: Row[]): Row[] {
  if (batch.length === 0) return rows
  const b = [...batch].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0))
  const out: Row[] = []
  let i = 0
  let j = 0
  while (i < rows.length && j < b.length) {
    if (rows[i].ts <= b[j].ts) out.push(rows[i++])
    else out.push(b[j++])
  }
  while (i < rows.length) out.push(rows[i++])
  while (j < b.length) out.push(b[j++])
  return out.length > MAX_LINES ? out.slice(out.length - MAX_LINES) : out
}

export function WorkloadLogsDialog({
  open,
  onOpenChange,
  cluster,
  ns,
  path,
  name,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  cluster: string
  ns: string
  path: string
  name: string
}) {
  const t = useT()
  const [rows, setRows] = useState<Row[]>([])
  const [podsCount, setPodsCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [following, setFollowing] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)

  // 打开时重置：经 onOpenChange 入口做（effect 内同步 setState 会级联渲染）；
  // 流生命周期仍由 open effect 管（cleanup 即停流）
  const handleOpenChange = (v: boolean) => {
    if (v) {
      setRows([])
      setPodsCount(null)
      setError(null)
      setFollowing(true)
    }
    onOpenChange(v)
  }

  useEffect(() => {
    if (!open) return
    const ac = new AbortController()
    // 缓冲 + 定时 flush：多流并发逐行 setState 会渲染风暴；200ms 批 + 归并保持时间序
    let buf: Row[] = []
    const timer = setInterval(() => {
      if (buf.length === 0) return
      const batch = buf
      buf = []
      setRows(prev => mergeRows(prev, batch))
    }, FLUSH_MS)
    void (async () => {
      try {
        // terminating 旧 pod 不筛：滚动场景最该看的恰是旧版本临终输出，流随进程自然结束；
        // 排序取最新——10+ 副本时截掉的应是旧 pod，新起可能正在崩的必须在场
        const pods = (await findWorkloadPods(cluster, path, ns))
          .sort((a, b) => (a.metadata.creationTimestamp ?? '') < (b.metadata.creationTimestamp ?? '') ? 1 : -1)
        const targets = pods.slice(0, MAX_PODS)
        // 全是 Succeeded/Failed（如已完成的 Job）：follow 流秒断会把「看一眼历史」
        // 渲染成顶部红错误框，降级为 tailLines 快照
        const allDone = targets.length > 0 && targets.every(p => {
          const ph = (p as unknown as { status?: { phase?: string } }).status?.phase
          return ph === 'Succeeded' || ph === 'Failed'
        })
        if (!ac.signal.aborted) setPodsCount(pods.length)
        if (targets.length === 0) return
        // 多容器 Pod 不传 container 会被 apiserver 拒 400（无合并输出模式，
        // 与 ai-exec tools-pods.js 参数说明一致）：按 Pod×容器扇出，流数封顶防刷屏
        const streams: { pod: string; container: string }[] = []
        for (const p of targets) {
          const cs = (p as { spec?: { containers?: { name?: string }[] } }).spec?.containers ?? []
          for (const c of cs.length > 0 ? cs.map(x => x.name ?? '') : ['']) {
            if (streams.length >= MAX_STREAMS) break
            streams.push({ pod: p.metadata.name, container: c })
          }
        }
        for (const s of streams) {
          // chunk 边界残段跨块保留（LogsView 同款 buf 模式）：follow 流 TCP 在任意
          // 字节切开是常态，直接 pop 丢弃 = 每次切在行中丢半行 + 后半截错序到队首
          let carry = ''
          void streamLogs(
            cluster,
            ns,
            s.pod,
            { container: s.container || undefined, tailLines: TAIL, follow: !allDone, timestamps: true },
            chunk => {
              const parts = (carry + chunk).split('\n')
              carry = parts.pop() ?? ''
              for (const raw of parts) {
                // timestamps=true 行形如 `2026-...Z main: log line`：切 ts，其余归正文
                const m = /^(\S+Z?)\s(.*)$/.exec(raw)
                buf.push({ ts: m?.[1] ?? '', pod: s.pod, line: m?.[2] ?? raw })
              }
            },
            ac.signal,
          ).catch((e: unknown) => {
            if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
          })
        }
      } catch (e) {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      clearInterval(timer)
      ac.abort()
    }
  }, [open, cluster, ns, path])

  // 跟随底部：仅 following 时贴底（暂停后可自由回滚翻查）
  useEffect(() => {
    if (following && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [rows, following])

  const download = () => {
    const text = rows.map(r => `${r.ts} [${r.pod}] ${r.line}`).join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}-combined.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-5xl flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{tf('res:aggLogsTitle', { name })}</DialogTitle>
          <DialogDescription className="text-xs">
            {podsCount === null
              ? t('res:loading')
              : podsCount > MAX_PODS
                ? tf('res:aggTruncated', { shown: MAX_PODS, total: podsCount })
                : tf('res:aggPodCount', { n: podsCount })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant={following ? 'default' : 'outline'} onClick={() => setFollowing(v => !v)}>
            {following ? <Pause className="size-3" /> : <Play className="size-3" />}
            {following ? t('pods:logsPause') : t('pods:logsFollow')}
          </Button>
          <Button size="xs" variant="outline" onClick={download} disabled={rows.length === 0}>
            <Download className="size-3" />
            {t('pods:logsDownload')}
          </Button>
          {rows.length === 0 && podsCount === 0 && <span className="text-xs text-muted-foreground">{t('res:aggEmpty')}</span>}
        </div>
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error}</div>
        )}
        <div ref={boxRef} className="min-h-[300px] flex-1 overflow-auto rounded-md border bg-muted/30 p-2">
          {podsCount === null ? (
            <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {t('res:loading')}
            </div>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {rows.map((r, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 tabular-nums text-muted-foreground">{r.ts.slice(11, 19)}</span>
                  <span className="shrink-0 truncate text-muted-foreground" title={r.pod}>
                    [{r.pod.slice(0, 24)}]
                  </span>
                  <span className="min-w-0 break-all">{r.line}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
