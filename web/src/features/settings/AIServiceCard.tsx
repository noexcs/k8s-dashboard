import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Check, Info, Pencil, RefreshCw, RotateCcw, Send, X } from 'lucide-react'
import { tf, useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { FADE, INSET, SectionCard } from './parts'

interface AiStatus {
  ok: boolean
  gateway?: string
  error?: string
  modelCount?: number
  models?: { id: string }[]
  llmKeySet?: boolean
  notifyConfigured?: boolean
  notifyLast?: { ts: string; ok: boolean; err?: string; text?: string } | null
}

type CfgKey = 'inspectIntervalMin' | 'notifyWebhookUrl' | 'panelBaseUrl' | 'llmGatewayBase' | 'llmModel'
type CfgRow = { value: string | number; overridden: boolean; env: string | number }
type AiConfig = Record<CfgKey, CfgRow> & {
  /** 密钥明文永不下发浏览器：只有布尔态 */
  llmApiKey: { overridden: boolean; configured: boolean; envConfigured: boolean }
}

/** 配置字段/通知通道共用的瓦片容器：实体边框，与设置页其他卡的行同构 */
const TILE = 'rounded-lg border px-3 py-2.5'

/**
 * AI 服务卡：顶部「健康横幅」承载一眼状态（存活/网关/模型数 + 重探），
 * 明细按「模型接入 / 通知与巡检」两个 Tab 展开；每个配置字段是一枚独立瓦片，
 * 编辑/还原是常驻实体按钮（不做 hover 显隐）。PUT /ai/config 保存即生效并持久化；
 * env 只是底座默认（UI 覆盖徽标 + 还原=PUT null 删覆盖，与「显式留空」两语义）；
 * 密钥只写不回显（服务端 GET 仅返回是否已配置）。
 */
export function AIServiceCard() {
  const t = useT()
  const queryClient = useQueryClient()
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
  const [testNote, setTestNote] = useState('')
  const testNotify = async () => {
    setTestNote('')
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

  const cfgQ = useQuery({
    queryKey: ['ai-config'],
    queryFn: async () => {
      const r = await fetch('/ai/config')
      if (!r.ok) throw new Error(String(r.status))
      return r.json() as Promise<AiConfig>
    },
    retry: 0,
  })
  const [editKey, setEditKey] = useState<'llmApiKey' | CfgKey | null>(null)
  const [draft, setDraft] = useState('')
  // 编辑起始值：原样保存不发 PUT——否则「打开-保存」就把 env 底座盖成 UI 覆盖（假覆盖徽标）
  const editBase = useRef('')
  // 错误按卡片分桶：巡检/webhook 的失败不该飘到「AI 服务」卡底（两卡链路本就不相干）
  const [cfgErrs, setCfgErrs] = useState<{ conn: string; notify: string }>({ conn: '', notify: '' })
  const scopeOf = (k: 'llmApiKey' | CfgKey): 'conn' | 'notify' =>
    k === 'llmGatewayBase' || k === 'llmModel' || k === 'llmApiKey' ? 'conn' : 'notify'
  const setCfgErr = (k: 'llmApiKey' | CfgKey, msg: string) => setCfgErrs(e => ({ ...e, [scopeOf(k)]: msg }))
  // PUT 在途标记：双击保存/还原=并发双 PUT，后一个可能盖掉前一个的错误播报
  const [cfgBusy, setCfgBusy] = useState(false)
  const actorPatch = () => (localStorage.getItem('k8s-oncall') ? { actor: localStorage.getItem('k8s-oncall') } : {})
  const saveCfg = async () => {
    if (!editKey || cfgBusy) return
    // 巡检间隔只收非负整数：type=number 挡不住 paste 垃圾，PUT 前再过一道
    if (editKey === 'inspectIntervalMin' && !/^\d{1,4}$/.test(draft.trim())) {
      setCfgErr(editKey, t('settings:cfgNeedNumber'))
      return
    }
    setCfgBusy(true)
    setCfgErr(editKey, '')
    try {
      if (editKey !== 'llmApiKey' && draft === editBase.current) {
        // 没改任何东西：静默退出，不制造「UI 覆盖=env 值」的假覆盖
        setEditKey(null)
        return
      }
      const r = await fetch('/ai/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [editKey]: draft, ...actorPatch() }),
      })
      const d = (await r.json()) as { ok?: boolean; error?: string }
      if (!d.ok) {
        setCfgErr(editKey, tf('settings:cfgSaveFail', { err: d.error ?? '' }))
        return
      }
      // 乐观写缓存：refetch 要一个 RTT，期间展示瓦若回退 env 旧值+丢覆盖徽标=「保存失败」的假象
      const key = editKey
      queryClient.setQueryData<AiConfig | undefined>(['ai-config'], old => {
        if (!old) return old
        if (key === 'llmApiKey') return { ...old, llmApiKey: { ...old.llmApiKey, overridden: true, configured: true } }
        return { ...old, [key]: { ...old[key], value: key === 'inspectIntervalMin' ? Number(draft) : draft, overridden: true } }
      })
      // 测试按钮/提示跨配置存活=说谎：换了 webhook 还挂着上一条送达结论
      setTestState('idle')
      setTestError('')
      setTestNote('')
      setCfgErr(editKey, '')
      setEditKey(null)
      void cfgQ.refetch()
      void q.refetch()
    } catch (e) {
      setCfgErr(editKey, tf('settings:cfgSaveFail', { err: e instanceof Error ? e.message : '' }))
    } finally {
      setCfgBusy(false)
    }
  }
  // 还原=PUT null（服务端删覆盖键回 env 底座）；与「显式留空」两语义
  const revertCfg = async (key: 'llmApiKey' | CfgKey) => {
    if (cfgBusy) return
    setCfgBusy(true)
    setCfgErr(key, '')
    try {
      const r = await fetch('/ai/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [key]: null, ...actorPatch() }),
      })
      const d = (await r.json()) as { ok?: boolean; error?: string }
      if (!d.ok) setCfgErr(key, tf('settings:cfgRevertFail', { err: d.error ?? '' }))
      else {
        // 同保存：还原成功瞬间就地回 env 底座，不空窗一个 RTT
        queryClient.setQueryData<AiConfig | undefined>(['ai-config'], old => {
          if (!old) return old
          if (key === 'llmApiKey') return { ...old, llmApiKey: { ...old.llmApiKey, overridden: false, configured: old.llmApiKey.envConfigured } }
          return { ...old, [key]: { ...old[key], value: old[key].env, overridden: false } }
        })
        void cfgQ.refetch()
        // 模型/网关还原同样改运行时状态——横幅上的「模型数」不刷会留着已消失的覆盖值
        void q.refetch()
      }
    } catch (e) {
      setCfgErr(key, tf('settings:cfgRevertFail', { err: e instanceof Error ? e.message : '' }))
    } finally {
      setCfgBusy(false)
    }
  }

  const st = q.data
  const envUnset = t('settings:envUnset')
  const startEdit = (key: 'llmApiKey' | CfgKey, initial: string) => {
    setEditKey(key)
    setDraft(initial)
    editBase.current = initial
    setCfgErr(key, '')
  }

  // ---- 编辑态整瓦片接管：等宽输入框 + 实体保存/取消（Enter=保存）；env 底座行常驻，看得见盖住了谁 ----
  // rk=兄弟间唯一的 React key 且 view-*/edit-* 互换即重挂（FADE 重播）；
  // 定值 key="view" 在多个字段瓦片同父并列时是重复 key，进入编辑态会让 React 错误复用 DOM（卡片翻倍）
  const editPanel = (label: string, envName: string, type = 'text', rk = 'edit') => {
    const err = editKey ? cfgErrs[scopeOf(editKey)] : ''
    return (
    <div key={rk} className={cn(TILE, FADE, 'ring-2 ring-ring/25 transition-shadow')}>
      <div className="text-[13px] font-medium">{label}</div>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <Input
          autoFocus
          type={type}
          value={draft}
          placeholder={type === 'password' ? t('settings:aiLlmKeyPh') : undefined}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            // 中文输入法选词按的 Enter 不是提交：isComposing 时保存=半截拼音落盘
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void saveCfg()
            if (e.key === 'Escape') setEditKey(null)
          }}
          className="min-w-0 flex-1 font-mono text-[13px] md:text-[13px]"
          aria-label={label}
        />
        <div className="flex gap-2">
          <Button
            className="flex-1 sm:flex-none"
            size="sm"
            aria-disabled={cfgBusy || undefined}
            onClick={() => {
              if (cfgBusy) return
              void saveCfg()
            }}
          >
            {cfgBusy ? <Spinner /> : <Check />}
            {t('settings:cfgSave')}
          </Button>
          <Button className="flex-1 sm:flex-none" size="sm" variant="outline" onClick={() => setEditKey(null)}>
            {t('settings:cfgCancel')}
          </Button>
        </div>
      </div>
      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">env {envName}</p>
      {err && <p role="alert" className="mt-2 break-words text-xs text-destructive">{err}</p>}
    </div>
    )
  }

  // ---- 展示态字段瓦片：标题+覆盖徽标上排，实体操作常驻右上；值/ env 底座下排 ----
  // mono=true 只给 ASCII 原值；CJK 回显（未配置/每 N 分钟）走正文字体，避免 mono 栈回落字宽抖
  const tileShell = (
    label: string,
    o: { overridden?: boolean; envHint: string; loading?: boolean; mono?: boolean; envMono?: boolean; valKey?: string; rk?: string },
    value: ReactNode,
    valueTitle: string | undefined,
    actions: ReactNode,
  ) => (
    <div key={o.rk ?? 'view'} className={cn(TILE, FADE)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{label}</span>
          {o.overridden && (
            <Badge variant="secondary" className="shrink-0" title={t('settings:aiOverridden')}>
              {t('settings:aiOverrideBadge')}
            </Badge>
          )}
        </div>
        {actions}
      </div>
      {o.loading ? (
        <div className="mt-2.5 space-y-1.5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ) : (
        <div key={o.valKey ?? 'v'} className={cn(FADE, 'mt-2 min-w-0')}>
          <div className={cn('truncate text-[13px]', o.mono && 'font-mono')} title={valueTitle}>
            {value}
          </div>
          <div className={cn('mt-1 truncate text-xs text-muted-foreground', o.envMono !== false && 'font-mono')}>{o.envHint}</div>
        </div>
      )}
    </div>
  )

  const fieldActions = (overridden: boolean, onRevert: () => void, revertTitle: string, onEdit: () => void, editDisabled: boolean, busy: boolean) => (
    <div className="flex shrink-0 items-center gap-1.5">
      {overridden && (
        <Button
          size="sm"
          variant="outline"
          className="text-muted-foreground hover:text-foreground"
          title={revertTitle}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (busy) return
            void onRevert()
          }}
        >
          <RotateCcw />
          {t('settings:cfgRevert')}
        </Button>
      )}
      <Button size="sm" variant="outline" disabled={editDisabled} onClick={onEdit}>
        <Pencil />
        {t('settings:cfgEdit')}
      </Button>
    </div>
  )

  const field = (key: CfgKey, label: string, envName: string, fmt: (v: string | number) => string) => {
    if (editKey === key) return editPanel(label, envName, key === 'inspectIntervalMin' ? 'number' : 'text', `edit-${key}`)
    const row = cfgQ.data?.[key]
    const envText = key === 'inspectIntervalMin' ? `${row?.env ?? 0} min` : String(row?.env ?? '') || envUnset
    return tileShell(
      label,
      {
        overridden: row?.overridden,
        envHint: `env ${envName} = ${envText}`,
        loading: !cfgQ.data,
        mono: key !== 'inspectIntervalMin' && String(row?.value ?? '') !== '',
        envMono: /^[\x20-\x7e]*$/.test(envText),
        valKey: row ? `${row.value}|${row.overridden}` : undefined,
        rk: `view-${key}`,
      },
      row ? fmt(row.value) : '–',
      row?.overridden ? t('settings:aiOverridden') : `${envName} (env)`,
      fieldActions(
        !!row?.overridden,
        () => revertCfg(key),
        `${t('settings:cfgRevert')} → ${envText}`,
        () => startEdit(key, row ? String(row.value) : ''),
        !cfgQ.data,
        cfgBusy,
      ),
    )
  }

  // 密钥字段：只写不回显——编辑框永远从空开始，展示态只有「已设置/未设置」
  const keyField = () => {
    if (editKey === 'llmApiKey') return editPanel(t('settings:aiLlmKey'), 'LLM_API_KEY', 'password', 'edit-llmApiKey')
    const row = cfgQ.data?.llmApiKey
    return tileShell(
      t('settings:aiLlmKey'),
      {
        overridden: row?.overridden,
        envHint: `env LLM_API_KEY = ${row?.envConfigured ? t('settings:aiKeyOn') : envUnset}`,
        loading: !cfgQ.data,
        envMono: false,
        valKey: row ? `${row.configured}|${row.overridden}` : undefined,
        rk: 'view-llmApiKey',
      },
      row?.configured ? t('settings:aiLlmKeySet') : t('settings:aiLlmKeyUnset'),
      row?.overridden ? t('settings:aiOverridden') : 'LLM_API_KEY (env)',
      fieldActions(
        !!row?.overridden,
        () => revertCfg('llmApiKey'),
        t('settings:cfgRevert'),
        () => startEdit('llmApiKey', ''),
        !cfgQ.data,
        cfgBusy,
      ),
    )
  }

  // ---- 通知通道瓦片：通道状态徽标 + 常驻「发送测试」实体按钮 + 最近一次通知回显 ----
  // 探活返回里没带通道态（如服务不可达的错误兜底）时退回配置推导；两者皆无才显骨架
  const notifyOn =
    st?.notifyConfigured !== undefined
      ? !!st.notifyConfigured
      : cfgQ.data
        ? String(cfgQ.data.notifyWebhookUrl.value ?? '') !== ''
        : undefined
  const last = st?.notifyLast
  const testLabel =
    testState === 'idle'
      ? t('settings:aiNotifyTest')
      : testState === 'busy'
        ? t('settings:aiNotifyTestBusy')
        : testState === 'ok'
          ? t('settings:aiNotifyTestOk')
          : t('settings:aiNotifyTestFail')
  const testBtn = (
    <Button
      size="sm"
      // 四态文案宽度差 ~40px（发送测试→失败 / Send test→failed），定宽消除行内抖动与 tooltip 锚点漂移
      className="min-w-[6.5rem] shrink-0 justify-center"
      variant={testState === 'fail' ? 'destructive' : testState === 'ok' ? 'secondary' : 'outline'}
      aria-disabled={testState === 'busy' || undefined}
      onClick={() => {
        if (testState === 'busy') return
        // 未配置不置灰——点击就地给原因（tooltip 不可聚焦，键盘/触屏取不到）
        if (!notifyOn) {
          setTestNote('settings:aiTestNeedWebhook')
          setTestState('idle')
          return
        }
        void testNotify()
      }}
    >
      {testState === 'busy' ? <Spinner /> : testState === 'ok' ? <Check /> : testState === 'fail' ? <X /> : <Send />}
      {testLabel}
    </Button>
  )
  const notifyTile = (
    <div className={TILE}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <Bell className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-[13px] font-medium">{t('settings:aiNotify')}</span>
          {notifyOn === undefined ? (
            <Skeleton className="h-5 w-20 rounded-full" />
          ) : (
            // 未配置是中性缺省态，不占 destructive 红（红只留给不可达/失败）
            <Badge variant="secondary" className={cn('min-w-0 shrink', !notifyOn && 'text-muted-foreground')}>
              {notifyOn ? t('settings:aiNotifyOn') : t('settings:aiNotifyOff')}
            </Badge>
          )}
        </div>
        {/* Tooltip 常驻包裹：失败时才挂 content——按状态换装组件树会让 button 卸载重挂、焦点丢回 body */}
        <Tooltip>
          <TooltipTrigger asChild>{testBtn}</TooltipTrigger>
          {testState === 'fail' && testError && (
            <TooltipContent side="bottom" className="max-w-xs break-all">
              {testError}
            </TooltipContent>
          )}
        </Tooltip>
      </div>
      <div className="mt-2 truncate border-t pt-2 text-xs text-muted-foreground">
        {last ? (
          <span className={cn('block truncate', !last.ok && 'text-destructive')} title={last.text}>
            {tf('settings:aiNotifyLast', {
              time: new Date(last.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
              state: last.ok ? '✓' : `✗ ${last.err ?? ''}`,
            })}
          </span>
        ) : (
          t('settings:aiNotifyNone')
        )}
      </div>
      {testNote && (
        <p role="status" className="mt-1.5 break-all text-xs text-destructive">
          {t(testNote)}
        </p>
      )}
      {testState === 'fail' && testError && (
        <p role="alert" className="mt-1.5 break-all text-xs text-destructive">
          {testError}
        </p>
      )}
    </div>
  )

  // ---- 健康横幅：一眼状态。探活要回答「服务挂了、网关挂了还是没模型」----
  const modelCount = st?.modelCount ?? st?.models?.length ?? 0
  const modelIds = (st?.models ?? []).map(m => m.id)
  const modelChip = (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 text-xs text-muted-foreground">
      <span className="shrink-0 tabular-nums">{modelCount === 1 ? t('settings:aiModelCountOne') : tf('settings:aiModelCount', { n: modelCount })}</span>
      {modelIds[0] && <span className="min-w-0 truncate font-mono">{modelIds[0]}</span>}
      {modelCount > 1 && <span className="shrink-0 tabular-nums">+{modelCount - 1}</span>}
    </span>
  )
  const banner = (
    <div className={cn(INSET, 'p-3')}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <span
            aria-hidden
            className={cn('mt-1.5 size-2 shrink-0 rounded-full transition-colors', q.isPending ? 'bg-muted-foreground/30' : st?.ok ? 'bg-primary' : 'bg-destructive')}
          />
          <div className="min-w-0 space-y-1.5">
            {/* 网关 URL 与模型芯片同行同基线（上下分行会把两个同权重信息读成主从）；
                窄屏整组换行仍是同级排布 */}
            <div className="flex flex-wrap items-center gap-2">
              {q.isPending ? (
                <Skeleton className="h-5 w-24" />
              ) : (
                <span key={String(st?.ok)} className={cn(FADE, 'text-sm font-semibold')}>{st?.ok ? t('settings:aiOk') : t('settings:aiDown')}</span>
              )}
              {st?.ok && st.gateway && (
                <span className="max-w-[15rem] truncate rounded-md border bg-background px-2 py-0.5 font-mono text-xs text-muted-foreground" title={st.gateway}>
                  {st.gateway}
                </span>
              )}
              {q.isPending && <Skeleton className="h-5 w-40" />}
              {st?.ok &&
                (modelIds.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help align-middle">{modelChip}</span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start" className="max-h-64 max-w-xs overflow-y-auto whitespace-pre-line text-left">
                      {modelIds.join('\n')}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  modelChip
                ))}
            </div>
            {!q.isPending && !st?.ok && (
              <p key={st?.error ?? 'down'} className={cn(FADE, 'break-words font-mono text-xs leading-5 text-destructive')}>{st?.error ?? t('settings:aiDown')}</p>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          aria-disabled={q.isFetching || undefined}
          onClick={e => {
            // 双击的第二次点击在 disabled 生效前就发出去了——detail>1 直接吃
            if (q.isFetching || e.detail > 1) return
            void q.refetch()
            void cfgQ.refetch()
          }}
        >
          <RefreshCw className={cn(q.isFetching && 'animate-spin')} />
          {t('settings:aiReprobe')}
        </Button>
      </div>
    </div>
  )

  // 两张卡=两条真实链路：「AI 服务」=大模型网关（对话用）；「通知与巡检」=规则扫描+webhook 推送
  // （服务端不经过 LLM，网关挂了照常工作）——曾合并成一张卡+Tabs，链路相干性是假的，
  // 还带来 tab 高度/空白一族问题；拆开全部消失
  return (
    /* 本地 Provider：应用无全局 TooltipProvider（同 GatedButton 约定），缺失即崩 */
    <TooltipProvider delayDuration={300}>
      <SectionCard
        id="sec-ai"
        title={t('settings:aiCard')}
        desc={t('settings:aiCardDesc')}
        action={
          !q.isPending && (
            <Badge variant={st?.ok ? 'secondary' : 'destructive'} className="mt-0.5">
              {st?.ok ? t('settings:aiOk') : t('settings:aiDown')}
            </Badge>
          )
        }
      >
        <div className="space-y-4">
          {banner}
          <div className="space-y-2">
            {field('llmGatewayBase', t('settings:aiGateway'), 'LLM_GATEWAY_BASE', v => (v ? String(v) : t('settings:aiGatewayNone')))}
            {field('llmModel', t('settings:aiModelName'), 'LLM_MODEL', v => String(v))}
            {keyField()}
          </div>
          <p className="flex items-start gap-1.5 border-t pt-3 text-xs leading-5 text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t('settings:aiFixHint')}
          </p>
          {cfgErrs.conn && !editKey && <p role="alert" className="break-words text-xs text-destructive">{cfgErrs.conn}</p>}
        </div>
      </SectionCard>

      <SectionCard id="sec-notify" title={t('settings:aiGroupNotify')} desc={t('settings:notifyInspectDesc')}>
        <div className="space-y-2">
          {notifyTile}
          {field('inspectIntervalMin', t('settings:aiScanInterval'), 'INSPECT_INTERVAL_MIN', min =>
            Number(min) > 0 ? tf('settings:aiScanOn', { min: Number(min) }) : t('settings:aiScanOff'),
          )}
          {field('notifyWebhookUrl', t('settings:aiNotifyUrl'), 'NOTIFY_WEBHOOK_URL', v => (v ? String(v) : t('settings:aiNotifyOff')))}
          {field('panelBaseUrl', t('settings:aiPanelUrl'), 'PANEL_BASE_URL', v => (v ? String(v) : t('settings:aiPanelUrlNone')))}
        </div>
        {cfgErrs.notify && !editKey && <p role="alert" className="mt-2 break-words text-xs text-destructive">{cfgErrs.notify}</p>}
      </SectionCard>
    </TooltipProvider>
  )
}
