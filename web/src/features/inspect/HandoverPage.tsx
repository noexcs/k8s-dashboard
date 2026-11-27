import { useState } from 'react'
import { NavLink, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ClipboardCheck, FileText } from 'lucide-react'
import { tf, useT } from '@/i18n'
import { shortTime } from '@/lib/format'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

interface HandoverDoc {
  id: string
  ts: string
  cluster: string
  md: string
  window?: string
  actor?: string
  ackedBy?: string
  ackedTs?: string
}

/**
 * 交接班文档页：交接从此留在 URL 网络里（此前是全产品唯一要「下载文件 + IM 传」的动线）。
 * 「确认接班」进审计（verb=handover_ack）——交过接、谁接的都有账。
 */
export function HandoverPage() {
  const t = useT()
  const { cluster, id } = useParams()
  const [ackState, setAckState] = useState<'idle' | 'busy' | 'done' | 'fail'>('idle')

  const q = useQuery({
    queryKey: ['handover', id],
    queryFn: async (): Promise<HandoverDoc> => {
      const r = await fetch(`/ai/handover?id=${encodeURIComponent(id ?? '')}`, { signal: AbortSignal.timeout(8000) }).catch(() => null)
      if (!r) throw new Error('down')
      // 「读不到」≠「不存在」：瞬断/重启不能演成「交接凭证已丢」（全站空态口径）
      if (r.status === 404) throw new Error('missing')
      if (!r.ok) throw new Error('down')
      return r.json() as Promise<HandoverDoc>
    },
    retry: 0,
  })

  const ack = async () => {
    setAckState('busy')
    try {
      const r = await fetch('/ai/handover/ack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, ...(localStorage.getItem('k8s-oncall') ? { actor: localStorage.getItem('k8s-oncall') } : {}) }),
      })
      if (r.status === 409) {
        // 已被他人接下：不是失败，把真相刷出来（refetch 让 doc.ackedTs 上墙）
        setAckState('idle')
        void q.refetch()
        void ackQ.refetch()
        return
      }
      if (!r.ok) throw new Error(String(r.status))
      setAckState('done')
      // 本人接班的时刻与署名在成功帧定格（此后 doc refetch 带 ackedTs 接管显示）
      setAckedNow({
        ts: new Date().toISOString(),
        ...(localStorage.getItem('k8s-oncall') ? { actor: localStorage.getItem('k8s-oncall') ?? '' } : {}),
      })
      void q.refetch()
    } catch {
      setAckState('fail')
    }
  }

  if (q.isError) {
    const missing = q.error instanceof Error && q.error.message === 'missing'
    return (
      <Empty className="py-24">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileText className="size-5" />
          </EmptyMedia>
          <EmptyTitle>{t(missing ? 'inspect:handoverMissing' : 'inspect:handoverDown')}</EmptyTitle>
          <EmptyDescription>
            {!missing && (
              <Button size="sm" variant="outline" className="mr-3" onClick={() => void q.refetch()}>
                {t('inspect:retry')}
              </Button>
            )}
            <NavLink to={`/c/${encodeURIComponent(cluster ?? '')}/inspect`} className="text-primary hover:underline">
              {t('inspect:handoverBack')}
            </NavLink>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const doc = q.data
  // 「接」的账：刷新后 ack 不再是本地私事——查审计 join（同人对同单可无限重按 = 假握手）
  const [ackedNow, setAckedNow] = useState<{ ts: string; actor?: string } | null>(null)
  const ackQ = useQuery({
    queryKey: ['handover-ack', id, doc?.cluster],
    queryFn: async () => {
      // 旧档（ackedTs 回写上线前）兜底：谓词下推到服务端，账厚后不受 300 条窗口摆布
      const r = await fetch(`/ai/audit?limit=1&verb=handover_ack&target=${encodeURIComponent(id ?? '')}`)
      if (!r.ok) return null
      const items = ((await r.json()) as { items: { ts: string; actor?: string }[] }).items
      return items[0] ?? null
    },
    retry: 0,
    enabled: !!doc,
  })
  // 凭证首选文档本体（永久），审计 join 只兜旧档；服务端 409 是最终闸门
  // render 期不现造时间戳（重渲染=接班时刻漂移）；本人 ack 的时刻在成功分支定格
  const acked = doc?.ackedTs
    ? { ts: doc.ackedTs, actor: doc.ackedBy || undefined }
    : ackQ.data ?? ackedNow

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      {doc && (
        <div className="mb-4 flex flex-wrap items-center gap-3 border-b pb-3">
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            {doc.actor ? tf('inspect:handoverBy', { actor: doc.actor, ts: shortTime(doc.ts) }) : shortTime(doc.ts)}
            {doc.window ? ` · ${doc.window}` : ''}
            {doc.cluster !== cluster ? ` · @${doc.cluster}` : ''}
          </div>
          {acked ? (
            <span className="text-xs text-positive" title={shortTime(acked.ts, true)}>
              {tf('inspect:handoverAckedBy', { actor: acked.actor || t('inspect:handoverAckedAnon'), time: shortTime(acked.ts) })}
            </span>
          ) : (
            <Button size="sm" disabled={ackState === 'busy' || ackQ.isPending} onClick={() => void ack()}>
              <ClipboardCheck className="size-3.5" />
              {t('inspect:handoverAck')}
            </Button>
          )}
          {ackState === 'fail' && <span className="text-xs text-destructive">{t('inspect:handoverAckFail')}</span>}
          <NavLink to={`/c/${encodeURIComponent(doc.cluster || cluster || '')}/inspect`} className="text-xs text-muted-foreground hover:underline">
            {t('inspect:handoverBack')}
          </NavLink>
        </div>
      )}
      {doc ? (
        <article className="text-[13px]">
          <Markdown>{doc.md}</Markdown>
        </article>
      ) : (
        <div className="space-y-2">
          <div className="h-4 w-1/3 animate-pulse rounded bg-muted" aria-hidden />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" aria-hidden />
        </div>
      )}
    </div>
  )
}
