import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { tf, useT } from '@/i18n'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

interface AiStatus {
  ok: boolean
  gateway?: string
  error?: string
  modelCount?: number
  models?: { id: string }[]
  notifyConfigured?: boolean
  notifyLast?: { ts: string; ok: boolean; err?: string; text?: string } | null
}

/**
 * AI 服务只读状态卡：此前 AI 未就绪时产品让用户「检查容器内 ai-exec 进程」——
 * 把排障完整推给命令行。此卡一次探活回答新人第一问「是服务挂了、网关挂了还是没模型」。
 * 只读（网关/模型运行期切换走 env 重启，配置权在服务端）。
 */
export function AIServiceCard() {
  const t = useT()
  const q = useQuery({
    queryKey: ['ai-status'],
    queryFn: () =>
      fetch('/ai/status')
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json() as Promise<AiStatus>
        })
        .catch((e: Error): AiStatus => ({ ok: false, error: e.message })),
    retry: 0,
    staleTime: 30_000,
  })

  const [testState, setTestState] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle')
  const [testError, setTestError] = useState('')
  const testNotify = async () => {
    setTestState('busy')
    try {
      const r = await fetch('/ai/notify-test', { method: 'POST' })
      const d = (await r.json()) as { ok?: boolean; error?: string }
      // ✗ 必须能指认原因：webhook 端错误在服务体 error 里，裸 ✗ 等于把人送回试错循环
      setTestError(d.error ?? '')
      setTestState(d.ok ? 'ok' : 'fail')
    } catch (e) {
      setTestError(e instanceof Error ? e.message.slice(0, 100) : '')
      setTestState('fail')
    }
  }

  // 白名单三键 UI 可改（env 是底座与默认）：显示生效值，编辑走 PUT /ai/config——
  // 事故当晚要改的节奏/通知指向，不该要求回命令行改 env 重启（本卡自述「不把排障推给命令行」）
  const cfgQ = useQuery({
    queryKey: ['ai-config'],
    queryFn: async () => {
      const r = await fetch('/ai/config')
      if (!r.ok) throw new Error(String(r.status))
      return r.json() as Promise<Record<'inspectIntervalMin' | 'notifyWebhookUrl' | 'panelBaseUrl', { value: string | number; overridden: boolean; env: string | number }>>
    },
    retry: 0,
  })
  const [editKey, setEditKey] = useState<'inspectIntervalMin' | 'notifyWebhookUrl' | 'panelBaseUrl' | null>(null)
  const [draft, setDraft] = useState('')
  const [cfgErr, setCfgErr] = useState('')
  const saveCfg = async () => {
    if (!editKey) return
    setCfgErr('')
    try {
      const r = await fetch('/ai/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [editKey]: draft, ...(localStorage.getItem('k8s-oncall') ? { actor: localStorage.getItem('k8s-oncall') } : {}) }),
      })
      const d = (await r.json()) as { ok?: boolean; error?: string }
      if (!d.ok) {
        setCfgErr(d.error ?? 'save failed')
        return
      }
      setEditKey(null)
      void cfgQ.refetch()
      void q.refetch()
    } catch (e) {
      setCfgErr(e instanceof Error ? e.message : 'save failed')
    }
  }
  // 还原=PUT null（服务端删覆盖键回 env 底座）；与「显式留空」两语义
  const revertCfg = async (key: 'inspectIntervalMin' | 'notifyWebhookUrl' | 'panelBaseUrl') => {
    setCfgErr('')
    try {
      const r = await fetch('/ai/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [key]: null, ...(localStorage.getItem('k8s-oncall') ? { actor: localStorage.getItem('k8s-oncall') } : {}) }),
      })
      const d = (await r.json()) as { ok?: boolean; error?: string }
      if (!d.ok) setCfgErr(d.error ?? 'revert failed')
      else void cfgQ.refetch()
    } catch (e) {
      setCfgErr(e instanceof Error ? e.message : 'revert failed')
    }
  }
  const renderRow = (key: 'inspectIntervalMin' | 'notifyWebhookUrl' | 'panelBaseUrl', fmt: (v: string | number) => string, envName: string) => {
    const row = cfgQ.data?.[key]
    if (editKey === key) {
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void saveCfg()}
            className="h-7 w-36 rounded border border-input bg-transparent px-1.5 font-mono text-xs"
            aria-label={envName}
          />
          <Button size="xs" onClick={() => void saveCfg()}>{t('settings:cfgSave')}</Button>
          <Button size="xs" variant="ghost" onClick={() => setEditKey(null)}>{t('settings:cfgCancel')}</Button>
        </span>
      )
    }
    return (
      <span className="flex min-w-0 items-center gap-2 font-mono">
        {!cfgQ.data ? (
          <span className="inline-block h-3 w-16 animate-pulse rounded bg-muted" aria-hidden />
        ) : (
          <span className="min-w-0 truncate" title={row?.overridden ? `${t('settings:aiOverridden')}；env=${key === 'inspectIntervalMin' ? `${row.env} min` : row.env || '(未设)'}` : `${envName} (env)`}>
            {row ? fmt(row.value) : '–'}
            {row?.overridden && (
              <span className="ml-1 rounded bg-accent px-1 text-[10px] text-accent-foreground" title={t('settings:aiOverridden')}>
                UI
              </span>
            )}
          </span>
        )}
        {row?.overridden && (
          <button
            type="button"
            className="shrink-0 text-[11px] text-muted-foreground underline decoration-muted-foreground/40 hover:decoration-muted-foreground"
            title={`${t('settings:cfgRevert')} → ${key === 'inspectIntervalMin' ? `${row.env} min` : row.env || '(env 未设)'}`}
            onClick={() => void revertCfg(key)}
          >
            {t('settings:cfgRevert')}
          </button>
        )}
        <button
          type="button"
          disabled={!cfgQ.data}
          className="shrink-0 text-[11px] text-muted-foreground underline decoration-muted-foreground/40 hover:decoration-muted-foreground disabled:opacity-40"
          onClick={() => {
            setEditKey(key)
            setDraft(cfgQ.data?.[key] ? String(cfgQ.data[key].value) : '')
            setCfgErr('')
          }}
        >
          {t('settings:cfgEdit')}
        </button>
      </span>
    )
  }

  return (
    <Card className="gap-3 [--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {t('settings:aiCard')}
          {!q.isPending && (
            <Badge variant={q.data?.ok ? 'secondary' : 'destructive'}>{q.data?.ok ? t('settings:aiOk') : t('settings:aiDown')}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-[13px]">
        {q.isPending ? (
          <div className="h-4 w-56 animate-pulse rounded bg-muted" aria-hidden />
        ) : q.data?.ok ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{t('settings:aiGateway')}</span>
              <span className="min-w-0 truncate font-mono text-xs" title={q.data.gateway}>{q.data.gateway}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{t('settings:aiModels')}</span>
              <span className="font-mono tabular-nums">{q.data.modelCount}</span>
            </div>
            {q.data.models?.[0] && (
              <div className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={q.data.models.map(m => m.id).join('\n')}>
                {q.data.models[0].id}
                {q.data.modelCount && q.data.modelCount > 1 ? ` · +${q.data.modelCount - 1}` : ''}
              </div>
            )}
            {/* 把人叫回来的生命线通道也要可观测：配置对不对不该等漏叫事故当晚才知道 */}
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{t('settings:aiNotify')}</span>
              <span className="flex items-center gap-2 font-mono">
                {q.data.notifyConfigured ? t('settings:aiNotifyOn') : t('settings:aiNotifyOff')}
                {q.data.notifyConfigured && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={testState === 'busy'}
                    onClick={() => void testNotify()}
                    aria-live="polite"
                    title={testState === 'fail' ? testError || undefined : undefined}
                  >
                    {testState === 'idle' ? t('settings:aiNotifyTest') : testState === 'busy' ? t('settings:aiNotifyTestBusy') : testState === 'ok' ? t('settings:aiNotifyTestOk') : t('settings:aiNotifyTestFail')}
                  </Button>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{t('settings:aiScanInterval')}</span>
              {renderRow('inspectIntervalMin', min => (Number(min) > 0 ? tf('settings:aiScanOn', { min: Number(min) }) : t('settings:aiScanOff')), 'INSPECT_INTERVAL_MIN')}
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{t('settings:aiNotifyUrl')}</span>
              {renderRow('notifyWebhookUrl', v => (v ? String(v) : t('settings:aiNotifyOff')), 'NOTIFY_WEBHOOK_URL')}
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{t('settings:aiPanelUrl')}</span>
              {renderRow('panelBaseUrl', v => (v ? String(v) : t('settings:aiPanelUrlNone')), 'PANEL_BASE_URL')}
            </div>
            {q.data.notifyLast && (
              <p className="truncate text-xs text-muted-foreground" title={q.data.notifyLast.text}>
                {tf('settings:aiNotifyLast', {
                  time: new Date(q.data.notifyLast.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
                  state: q.data.notifyLast.ok ? '✓' : `✗ ${q.data.notifyLast.err ?? ''}`,
                })}
              </p>
            )}
            {cfgErr && <p className="text-xs text-destructive">{cfgErr}</p>}
          </>
        ) : (
          <>
            <p className="break-words text-destructive">{q.data?.error ?? t('settings:aiDown')}</p>
            {q.data?.gateway && (
              <p className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={q.data.gateway}>
                {t('settings:aiGateway')}: {q.data.gateway}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t('settings:aiFixHint')}</p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
