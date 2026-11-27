// Pod 日志视图（参考 CLI Logs）：跟随/暂停/清空 + 关键字过滤高亮（⌘/Ctrl+F）+
// 全屏（⌘/Ctrl+Enter）+ 上次崩溃容器日志（previous，CrashLoopBackOff 取证）+
// 时间戳开关 + 下载 .log + 字号（⌘/Ctrl ±/0）。
// 自动滚动为既有行为：贴底跟随，上滚暂停，「滚动到底」按钮恢复。
import { Clock, Download, Filter, History, Maximize2, Minimize2, Pause, Play, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { streamLogs } from '@/api/client'
import { ansiToNode, hasAnsi, stripAnsi } from '@/lib/ansi'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import {
  CodeBlock,
  CodeBlockContent,
} from '@/components/ui/code-block'
import { useCodeActions } from '@/components/code-actions'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { tf, useT } from '@/i18n'

const MAX_LINES = 5000
const TAIL = 500

export function LogsView(props: {
  cluster: string
  ns: string
  pod: string
  containers: string[]
}) {
  const { cluster, ns, pod, containers } = props
  const t = useT()
  const [container, setContainer] = useState(containers[0] ?? '')
  const [following, setFollowing] = useState(false)
  const [previous, setPrevious] = useState(false)
  const [filter, setFilter] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [timestamps, setTimestamps] = useState(false)
  const [fontPx, setFontPx] = useState(12)
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [stick, setStick] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const filterInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setError(null)
    setLines([])
    const ac = new AbortController()
    let buf = ''

    const append = (text: string) => {
      buf += text
      const nl = buf.lastIndexOf('\n')
      if (nl < 0) return
      const chunk = buf.slice(0, nl + 1)
      buf = buf.slice(nl + 1)
      // 只丢 chunk 尾部残段（下一条 delta 会补全），不 filter(Boolean)——日志里的
      // 真实空行必须保留（kubectl logs/Headlamp 口径，堆栈与 YAML 的排版依赖空行）
      const parts = chunk.split('\n')
      parts.pop()
      if (parts.length === 0) return
      setLines(prev => {
        const next = prev.concat(parts)
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
      })
    }

    void (async () => {
      try {
        await streamLogs(
          cluster,
          ns,
          pod,
          // previous 与 follow 互斥（API 400）：previous 拉上次崩溃实例日志时强制不跟随
          { container: container || undefined, tailLines: TAIL, follow: following && !previous, previous: previous || undefined, timestamps: timestamps || undefined },
          append,
          ac.signal,
        )
      } catch (err) {
        if (!ac.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => ac.abort()
  }, [cluster, ns, pod, container, following, previous, timestamps])

  // 快捷键（仅本视图挂载期间；焦点在输入框内不拦 ⌘F）：⌘/Ctrl+F 过滤框，⌘/Ctrl+Enter 全屏，
  // ⌘/Ctrl ±/0 字号（参考 CLI 日志面板）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const inField = e.target instanceof HTMLElement && (e.target.closest('input') || e.target.closest('textarea') || e.target.closest('.xterm'))
      if (e.key.toLowerCase() === 'f' && !inField) {
        e.preventDefault()
        setFiltering(true)
        requestAnimationFrame(() => filterInputRef.current?.focus())
      } else if (e.key === 'Enter') {
        e.preventDefault()
        setFullscreen(v => !v)
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        setFontPx(v => Math.min(v + 1, 20))
      } else if (e.key === '-') {
        e.preventDefault()
        setFontPx(v => Math.max(v - 1, 9))
      } else if (e.key === '0') {
        e.preventDefault()
        setFontPx(12)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 滚动容器是 CodeBlockContent（pre），组件不转发 ref，从外层容器里取
  useEffect(() => {
    if (!stick) return
    const el = containerRef.current?.querySelector<HTMLElement>('[data-slot="code-block-content"]')
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, stick])

  const onScroll = (e: React.UIEvent<HTMLPreElement>) => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom !== stick) setStick(atBottom)
  }

  // 过滤：大小写不敏感子串，在 ANSI 剥除后的纯文本上匹配（色码会切断原始行的子串）；
  // 仅过滤激活时逐行渲染（未过滤且无色码走整段字符串快路径，5000 行不掉帧）。
  // 有色码（多数 npm/jest/go 日志）时逐行 + '\n' span 渲染：pre 内联流保留原始行距。
  const lower = filter.trim().toLowerCase()
  const stripped = useMemo(() => (lines.some(hasAnsi) ? lines.map(stripAnsi) : lines), [lines])
  const hasAny = stripped !== lines
  const text = stripped.join('\n')
  const filtered = lower ? stripped.filter(l => l.toLowerCase().includes(lower)) : null
  const shownText = filtered ? filtered.join('\n') : text
  const { wrap, actions } = useCodeActions(shownText, `${pod}-${container || 'all'}.log`)

  const highlight = (line: string, i: number) => {
    if (!lower) return line
    const parts: React.ReactNode[] = []
    let rest = line
    let n = 0
    while (true) {
      const idx = rest.toLowerCase().indexOf(lower)
      if (idx < 0) break
      if (idx > 0) parts.push(rest.slice(0, idx))
      parts.push(<mark key={n++} className="rounded-sm bg-caution/40 text-foreground">{rest.slice(idx, idx + lower.length)}</mark>)
      rest = rest.slice(idx + lower.length)
    }
    parts.push(rest)
    return <div key={i}>{parts}</div>
  }

  // 未过滤但含色码：逐行 ansiToNode，'\n' 用 span 保留 pre 内联换行（行距与快路径一致）
  const ansiRows = !filtered && hasAny
    ? lines.map((l, i) => (
        <span key={i}>
          {ansiToNode(l)}
          {i < lines.length - 1 ? '\n' : ''}
        </span>
      ))
    : null

  const downloadLogs = () => {
    const blob = new Blob([shownText.endsWith('\n') ? shownText : shownText + '\n'], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${pod}-${container || 'all'}${timestamps ? '-ts' : ''}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className={fullscreen ? 'fixed inset-0 z-50 flex min-h-0 flex-col bg-background p-4' : 'flex h-full min-h-0 flex-col'}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {containers.length > 1 && (
          <Select value={container} onValueChange={setContainer}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {containers.map(c => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          variant={following ? 'default' : 'outline'}
          onClick={() => setFollowing(f => !f)}
        >
          {following ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {following ? t('pods:logsPause') : t('pods:logsFollow')}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setLines([])
            setError(null)
          }}
        >
          <Trash2 className="size-3.5" />
          {t('pods:logsClear')}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            setLines([])
            setError(null)
            setFollowing(f => !f)
          }}
        >
          <RefreshCw className="size-3.5" />
        </Button>
        <Button
          variant={previous ? 'default' : 'outline'}
          title={t('pods:logsPrevTip')}
          onClick={() => setPrevious(p => !p)}
        >
          <History className="size-3.5" />
          {t('pods:logsPrev')}
        </Button>
        <Button
          variant={timestamps ? 'default' : 'outline'}
          size="icon"
          title={t('pods:logsTsTip')}
          onClick={() => setTimestamps(v => !v)}
        >
          <Clock className="size-3.5" />
        </Button>
        <Button variant="outline" size="icon" title={t('pods:logsDownloadTip')} onClick={downloadLogs} disabled={lines.length === 0}>
          <Download className="size-3.5" />
        </Button>
        {filtering ? (
          <span className="relative">
            <Filter className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={filterInputRef}
              value={filter}
              onChange={e => setFilter(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  setFilter('')
                  setFiltering(false)
                }
              }}
              placeholder={t('pods:logsFilterPlaceholder')}
              className="w-44 pl-7 pr-7 text-[13px]"
              autoFocus
            />
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setFilter('')
                setFiltering(false)
              }}
            >
              <X className="size-3" />
            </button>
          </span>
        ) : (
          <Button variant="outline" size="icon" title={t('pods:logsFilterTip')} onClick={() => setFiltering(true)}>
            <Filter className="size-3.5" />
          </Button>
        )}
        {!stick && (
          <Button
            variant="ghost"
            className="text-caution hover:text-caution"
            onClick={() => setStick(true)}
          >
            {t('pods:logsFollowBottom')}
          </Button>
        )}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {filtered
            ? tf('pods:logsLineFiltered', { n: filtered.length, total: lines.length })
            : tf('pods:logsLineCount', { n: lines.length, max: MAX_LINES })}
        </span>
        <Button
          variant="ghost"
          size="icon"
          title={fullscreen ? t('pods:logsExitFull') : t('pods:logsFullTip')}
          onClick={() => setFullscreen(f => !f)}
        >
          {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-2">
          {error}
        </Alert>
      )}

      <div ref={containerRef} className="min-h-0 flex-1">
        <CodeBlock className="h-full">
          {actions}
          <CodeBlockContent
            wrap={wrap}
            onScroll={onScroll}
            className="flex-1"
            style={{ fontSize: `${fontPx}px` }}
          >
            {lines.length === 0 ? (
              <span className="text-muted-foreground">{t('pods:logsEmpty')}</span>
            ) : filtered && filtered.length === 0 ? (
              <span className="text-muted-foreground">{tf('pods:logsFilterEmpty', { q: filter.trim() })}</span>
            ) : filtered ? (
              filtered.map((l, i) => highlight(l, i))
            ) : ansiRows ? (
              ansiRows
            ) : (
              text
            )}
          </CodeBlockContent>
        </CodeBlock>
      </div>
    </div>
  )
}
