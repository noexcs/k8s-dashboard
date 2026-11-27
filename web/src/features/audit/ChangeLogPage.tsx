// 变更审计时间线：AI 有集群写权限的责任闭环——「谁在什么时候改了什么」一屏回查。
// 数据源 = ai-exec audit.jsonl（AI 工具执行点直写 + UI 写操作经 POST /audit 上报），
// 与 managedFields（机器视角）互补：这里记的是意图层的操作流。
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { History, RefreshCw, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { NavLink, useParams } from 'react-router-dom'
import { tf, useT } from '@/i18n'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { shortTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { RESOURCE_MAP, detailRoute } from '@/resources/registry'

interface AuditEntry {
  ts: string
  source: 'ai' | 'ui'
  cluster?: string
  verb?: string
  actor?: string
  target?: string
  kind?: string
  ns?: string
  name?: string
  summary?: string
  /** AI 写发生时的权限档：full 档（无批准卡直写）与逐条批准的写必须在账面可区分 */
  mode?: string
}

/** 账面 verb → i18n 标签。工具类复用 AI 页 ai:tool* 键（两页同词），审批/处置/交接类走 audit:verb*；
 *  未知 verb 原样显示（后端新增工具时账面不空洞），mono 原文留 title */
const VERB_LABELS: Record<string, string> = {
  exec_pod: 'ai:toolExecPod',
  scale: 'ai:toolScale',
  patch: 'ai:toolPatchResource',
  patch_resource: 'ai:toolPatchResource',
  apply_yaml: 'ai:toolApplyYaml',
  delete_resource: 'ai:toolDeleteResource',
  delete: 'audit:verbDelete',
  evict: 'audit:verbEvict',
  put: 'audit:verbPut',
  create: 'audit:verbCreate',
  rollout: 'ai:toolRollout',
  drain: 'ai:toolDrain',
  k8s_request: 'ai:toolK8sRequest',
  helm_install: 'ai:toolHelmInstall',
  helm_upgrade: 'ai:toolHelmUpgrade',
  helm_uninstall: 'ai:toolHelmUninstall',
  helm_rollback: 'ai:toolHelmRollback',
  deny: 'audit:verbDenied',
  expired: 'audit:verbExpired',
  auto_allow: 'audit:verbAutoAllow',
  acked: 'audit:verbAcked',
  ignored: 'audit:verbIgnored',
  unack: 'audit:verbUnack',
  handover: 'audit:verbHandover',
  handover_ack: 'audit:verbHandoverAck',
  config: 'audit:verbConfig',
}
/** 破坏性动作用 caution（与全站状态色一致）；其余中性 */
const DESTRUCTIVE: Record<string, true> = {
  // UI 侧 verb（client.ts reportWrite）
  delete: true,
  evict: true,
  // AI 侧 verb = 工具名（tools.js verb: name），名字必须与 buildTools 实际导出一致
  delete_resource: true,
  drain: true,
  rollout: true,
  helm_uninstall: true,
}

export function ChangeLogPage() {
  const t = useT()
  const { cluster } = useParams()
  // 路由在 /c/:cluster 下 → 默认只看本集群（混显他集群条目违背切面语义）；
  // 来源/动作过滤为纯前端内存筛（limit=300 + 2MB 轮换天然封顶，无需服务端参数）
  const [clusterOnly, setClusterOnly] = useState(true)
  // 班次时间窗（与交班 MD 窗口同词汇）：审计员「巡查一整班」要能把账面圈进班次
  const [timeWin, setTimeWin] = useState<'all' | '8h' | 'day' | 'week'>('all')
  const [srcFilter, setSrcFilter] = useState<'all' | 'ai' | 'ui'>('all')
  const [verbFilter, setVerbFilter] = useState<string | null>(null)
  const q = useQuery({
    // 集群与时间窗都在服务端过滤后再进 300 条窗口：客户端先截断再过滤，
    // 多集群下 B 集群写多了会把 A 的条目挤出窗口——审计员看到假「从未有记录」
    queryKey: ['audit-log', clusterOnly ? cluster : null, timeWin],
    queryFn: async (): Promise<AuditEntry[]> => {
      const p = new URLSearchParams({ limit: '300' })
      if (clusterOnly && cluster) p.set('cluster', cluster)
      if (timeWin !== 'all') p.set('since', timeWin === '8h' ? new Date(Date.now() - 8 * 3600_000).toISOString() : timeWin === 'day' ? new Date(new Date().setHours(0, 0, 0, 0)).toISOString() : new Date(Date.now() - 7 * 86_400_000).toISOString())
      const res = await fetch(`/ai/audit?${p}`)
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as { items?: AuditEntry[] }
      // 后端异常可能 200 + {error} 形态;非数组进缓存会让渲染层 spread 崩,查询期就拒
      if (!Array.isArray(data?.items)) throw new Error('bad /ai/audit payload')
      return data.items
    },
    refetchInterval: 15_000,
    // 切时间窗=同账本取子集，保留旧表占位防骨架闪烁（inspect 页同家先例）
    placeholderData: keepPreviousData,
    retry: 0,
  })
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => {
    let items = q.data ?? []
    if (clusterOnly && cluster) items = items.filter((e) => e.cluster === cluster)
    if (srcFilter !== 'all') items = items.filter((e) => e.source === srcFilter)
    if (verbFilter) items = items.filter((e) => e.verb === verbFilter)
    if (filter) {
      const f = filter.toLowerCase()
      items = items.filter((e) => `${e.target ?? ''} ${e.summary ?? ''} ${e.verb ?? ''} ${e.actor ?? ''}`.toLowerCase().includes(f))
    }
    return items
  }, [q.data, clusterOnly, cluster, srcFilter, verbFilter, filter])
  // chip 截断不得静默丢关键账目 verb：deny/acked/ignored/expired 永远保留名额，其余按出现序补足
  const verbs = useMemo(() => {
    const all = [...new Set((q.data ?? []).map((e) => e.verb ?? ''))].filter(Boolean)
    const keep = ['deny', 'expired', 'acked', 'ignored', 'unack'].filter(v => all.includes(v))
    const list = [...keep, ...all.filter(v => !keep.includes(v)).slice(0, 12 - keep.length)].slice(0, 12)
    return { list, hidden: all.length - list.length }
  }, [q.data])
  const verbLabel = (v: string) => (VERB_LABELS[v] ? t(VERB_LABELS[v]) : v)
  // chip 选中态全站统一 primary（caution 在本页语义 = 破坏性动作，不作通用选中色）；focus 环对齐 ui/button
  const CHIP = 'rounded-md border px-2 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden'

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-medium">{t('audit:title')}</h1>
        <span className="text-[13px] text-muted-foreground">{t('audit:sub')}</span>
        {/* 计数元信息与其他列表页同构（N 条 · 更新于） */}
        <span className="whitespace-nowrap text-[13px] tabular-nums text-muted-foreground">
          {tf('audit:metaCount', { n: rows.length })}
          {' · '}
          {tf('audit:metaUpdated', { time: new Date(q.dataUpdatedAt || Date.now()).toLocaleTimeString('zh-CN', { hour12: false }) })}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          {/* 组间 12 组内 6：来源/集群、时间窗、刷新是三个决策，靠间隙分堆而不是再加线 */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSrcFilter((s) => (s === 'all' ? 'ai' : s === 'ai' ? 'ui' : 'all'))}
              className={cn(CHIP, srcFilter !== 'all' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent/50')}
            >
              {`${t('audit:colSource')}: ${srcFilter === 'all' ? t('audit:fAllVal') : srcFilter === 'ai' ? 'AI' : t('audit:sourceUi')}`}
            </button>
            {clusterOnly ? (
              <button onClick={() => setClusterOnly(false)} className={cn(CHIP, 'border-primary/50 bg-primary/10 text-primary')} aria-pressed>
                @{cluster}
              </button>
            ) : (
              <button onClick={() => setClusterOnly(true)} className={cn(CHIP, 'border-border text-muted-foreground hover:bg-accent/50')} aria-pressed={false}>
                {t('audit:fAllClusters')}
              </button>
            )}
          </div>
          {/* 班次窗口：巡查一整班时把账面圈进班次（与交班 MD 窗口同词汇；all 保持默认不打扰） */}
          <div className="flex items-center gap-1.5">
            {/* 组义自释义（全部时间/近8小时/今天/近7天），不加前缀——与来源组「标签在 chip 内」同一标法 */}
            {(['all', '8h', 'day', 'week'] as const).map(w => (
              <button
                key={w}
                onClick={() => setTimeWin(w)}
                aria-pressed={timeWin === w}
                className={cn(CHIP, timeWin === w ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent/50')}
              >
                {t(w === 'all' ? 'audit:wAll' : w === '8h' ? 'audit:w8h' : w === 'day' ? 'audit:wDay' : 'audit:wWeek')}
              </button>
            ))}
          </div>
          {/* 过滤框与资源列表同几何（w-56/pl-8/有值出 X） */}
          <div className="relative w-56 min-w-0">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t('audit:filterPh')}
              className={cn('w-full pl-8', filter && 'pr-7')}
            />
            {filter && (
              <button
                type="button"
                aria-label={tf('res:clearFilter')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => setFilter('')}
              >
                <X className="size-3" />
              </button>
            )}
          </div>
          <Button variant="ghost" size="icon" className="size-8" aria-label={t('core:refresh')} onClick={() => void q.refetch()}>
            <RefreshCw className={cn('size-4', q.isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>
      {verbs.list.length > 1 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('audit:groupAction')}>
          <span className="text-xs text-muted-foreground">{t('audit:groupAction')}</span>
          {verbs.list.map((v) => (
            <button
              key={v}
              onClick={() => setVerbFilter((cur) => (cur === v ? null : v))}
              className={cn(CHIP, verbFilter === v ? cn('border-primary/50 bg-primary/10', DESTRUCTIVE[v] ? 'text-caution-on-primary' : 'text-primary') : 'border-border text-muted-foreground hover:bg-accent/50')}
              aria-pressed={verbFilter === v}
              title={v}
            >
              {verbLabel(v)}
            </button>
          ))}
          {/* 截断不静默：被藏 verb 数可见可查，过滤维度不丢 */}
          {verbs.hidden > 0 && (
            <span className={cn(CHIP, 'border-dashed border-border text-muted-foreground')} title={tf('audit:moreVerbs', { n: verbs.hidden })}>
              +{verbs.hidden}
            </span>
          )}
        </div>
      )}

      {/* 审计层不可达必须显式说：静默空表 = 「没人改过」的假象，恰恰违背本页存在意义。
          横幅保留表格：正在读的 300 行不因一次轮询抖动消失，错误期也能回查已加载账面 */}
      {q.isError && (
        <Alert variant="destructive" className="mb-2">
          <AlertTitle className="flex flex-wrap items-center gap-2">
            {t('audit:failed')}
            <Button size="sm" variant="outline" onClick={() => void q.refetch()}>{t('inspect:retry')}</Button>
          </AlertTitle>
        </Alert>
      )}
      <div className={cn('min-h-0 flex-1 overflow-auto transition-opacity', q.isPlaceholderData && 'opacity-60')}>
        {/* 与其他列表同底座（ResourceDataTable 同款裸 table + ui/table 件）：sticky h-10 表头、同字号 */}
        <table className="w-full table-fixed caption-bottom text-sm" aria-label={t('audit:title')}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="sticky top-0 z-10 h-10 bg-card px-3" style={{ width: 132 }}>{t('audit:colTime')}</TableHead>
            <TableHead className="sticky top-0 z-10 h-10 bg-card px-3" style={{ width: 64 }}>{t('audit:colSource')}</TableHead>
            <TableHead className="sticky top-0 z-10 h-10 bg-card px-3" style={{ width: 112 }}>{t('audit:colAction')}</TableHead>
            <TableHead className="sticky top-0 z-10 h-10 bg-card px-3">{t('audit:colTarget')}</TableHead>
            <TableHead className="sticky top-0 z-10 h-10 bg-card px-3" style={{ width: 110 }}>{t('audit:colActor')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
        {q.isPending && (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={5} className="px-3 py-4">
              <div className="space-y-2">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-11/12" />
                <Skeleton className="h-5 w-5/6" />
                <Skeleton className="h-5 w-2/3" />
              </div>
            </TableCell>
          </TableRow>
        )}
        {rows.length === 0 && !q.isPending && (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={5}>
              {/* 全站 Empty 规范：两种语义（从未有记录 / 过滤无匹配）文案分岔，几何一致 */}
              <Empty className="py-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <History />
                  </EmptyMedia>
                  {/* 空态三分岔：窗口内零条数≠「审计从头累积起就没人改过」——班次窗把账面圈小了，
                      空表话术必须跟着窗口的口径走，否则会诱导值班在交接后误宣「整班零变更」 */}
                  <EmptyTitle>{q.data && q.data.length > 0 ? t('audit:noMatch') : timeWin !== 'all' ? t('audit:emptyWindow') : t('audit:empty')}</EmptyTitle>
                  {q.data && q.data.length > 0 && <EmptyDescription>{t('audit:noMatchDesc')}</EmptyDescription>}
                </EmptyHeader>
              </Empty>
            </TableCell>
          </TableRow>
        )}
        {rows.map(e => {
          // 有 kind+name 的条目一跳进详情（意图层→对象层；旧条目无 kind 保持纯文本）
          const def = e.kind ? RESOURCE_MAP[e.kind] : undefined
          const link = def && e.name ? detailRoute(def, e.cluster ?? cluster ?? '', e.ns ?? 'cluster', e.name) : null
          // UI 写摘要「意图 | {payload}」双写同义——账面展示剥掉 JSON 尾巴（与意图重复且撑爆列宽），
          // 全文留 title；更早版本只写了 payload 的条目整条是 JSON，同样只留 title 不占账面
          let brief = e.summary?.replace(/\s*[|｜]\s*\{.*\}\s*$/, '')
          if (brief && /^\s*\{.*\}\s*$/.test(brief)) brief = ''
          // key 不含行号：15s 轮询插入新行时老行 DOM 必须复用，否则整表 remount、行内链接焦点每 15s 清零
          return (
            <TableRow key={`${e.ts}|${e.verb}|${e.target ?? ''}`} className="h-12 animate-in fade-in-0 duration-150">
              <TableCell className="px-3 font-mono text-muted-foreground">{shortTime(e.ts, true)}</TableCell>
              <TableCell className="px-3">
                <Badge variant={e.source === 'ai' ? 'default' : 'secondary'} className="w-fit">
                  {e.source === 'ai' ? 'AI' : t('audit:sourceUi')}
                </Badge>
              </TableCell>
              <TableCell className={cn('min-w-0 px-3 text-xs', DESTRUCTIVE[e.verb ?? ''] && 'text-caution')}>
                <span className="block truncate" title={e.verb}>{verbLabel(e.verb ?? '')}</span>
                {e.source === 'ai' && e.mode === 'full' && (
                  <span className="mt-0.5 inline-block rounded bg-caution/15 px-1 text-[11px] leading-4 text-caution-on-primary" title={t('audit:modeFullTitle')} aria-label={t('audit:modeFullTitle')}>
                    {t('audit:modeDirect')}
                  </span>
                )}
              </TableCell>
              {/* 常驻第二行（无 summary 也占位）：行高统一节奏不破；触屏/键盘可达，tooltip 留全文 */}
              <TableCell className="min-w-0 px-3">
                {link ? (
                  <NavLink to={link} className="block min-w-0 truncate font-mono text-[13px] hover:underline" title={e.summary ? `${e.target}\n${e.summary}` : e.target}>
                    {e.target ?? '–'}
                    {e.cluster ? <span className="ml-1.5 text-xs text-muted-foreground">@{e.cluster}</span> : null}
                  </NavLink>
                ) : (
                  <span className="block min-w-0 truncate font-mono text-[13px]" title={e.summary ? `${e.target}\n${e.summary}` : e.target}>
                    {e.target ?? '–'}
                    {e.cluster ? <span className="ml-1.5 text-xs text-muted-foreground">@{e.cluster}</span> : null}
                  </span>
                )}
                <span className="block truncate text-xs leading-4 text-muted-foreground" title={e.summary ?? ''} suppressHydrationWarning>{brief ?? ''}</span>
              </TableCell>
              <TableCell className="min-w-0 truncate px-3 text-xs text-muted-foreground">
                {e.source === 'ai' && e.actor ? (
                  // AI 条目回链源会话：从「什么改了」一键回到「为什么要改」的对话现场
                  <NavLink to={`/c/${encodeURIComponent(e.cluster ?? '')}/ai?session=${encodeURIComponent(e.actor)}`} className="font-mono hover:underline" title={e.actor}>
                    {e.actor.slice(0, 8)}
                  </NavLink>
                ) : (
                  // UI 行不复读来源列（「面板」已在左列）；无署名留白——整列「–」是占位噪声不是信息
                  e.actor ?? ''
                )}
              </TableCell>
            </TableRow>
          )
        })}
        </TableBody>
        </table>
      </div>
    </div>
  )
}
