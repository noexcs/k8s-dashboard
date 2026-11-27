import { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { eventsPath } from '@/api/client'
import { tf, useT, useLang } from '@/i18n'
import { eventReasonLabel, eventTypeLabel } from '@/lib/eventL10n'
import type { Event } from '@/api/types'
import { useWatch } from '@/hooks/useWatch'
import { Skeleton } from '@/components/ui/skeleton'
import { shortTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { NamespaceFilter } from '@/components/NamespaceFilter'
import { ResourceDataTable } from '@/components/ResourceDataTable'
import { ExportButton } from '@/features/resources/ExportButton'
import { RESOURCE_MAP, detailRoute, type Col } from '@/resources/registry'
import { askAi } from '@/features/ai/askBus'

export function EventsPage() {
  const t = useT()
  const { lang } = useLang()
  const { cluster, ns } = useParams()
  const navigate = useNavigate()
  const allNs = ns === undefined
  const [showNormal, setShowNormal] = useState(true)
  const [nsFilter, setNsFilter] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [filteredCount, setFilteredCount] = useState<number | null>(null)

  const { items, lastSync, reconnecting, error } = useWatch<Event>({
    cluster: cluster!,
    path: allNs ? '/api/v1/events' : eventsPath(ns!),
  })

  // 同对象+同 reason+同消息前缀折叠为一行（镜像拉取失败风暴 = 一屏重复行）；
  // count 求和、时间取最新，折叠条数进 title
  const sorted = useMemo(() => {
    const groups = new Map<string, { ev: Event; total: number; merged: number }>()
    for (const e of items) {
      if (!showNormal && e.type !== 'Warning') continue
      if (allNs && nsFilter && e.metadata.namespace !== nsFilter) continue
      if (filter) {
        const hay = `${e.involvedObject.kind}/${e.involvedObject.name} ${e.reason ?? ''} ${e.message ?? ''}`.toLowerCase()
        if (!hay.includes(filter.toLowerCase())) continue
      }
      const key = `${e.involvedObject.namespace}/${e.involvedObject.name}|${e.reason}|${(e.message ?? '').slice(0, 64)}`
      const g = groups.get(key)
      if (g) {
        g.total += e.count ?? 1
        g.merged += 1
        if ((e.lastTimestamp ?? '') > (g.ev.lastTimestamp ?? '')) g.ev = e
      } else {
        groups.set(key, { ev: e, total: e.count ?? 1, merged: 1 })
      }
    }
    const list = [...groups.values()].sort((a, b) => {
      if (a.ev.type !== b.ev.type) return a.ev.type === 'Warning' ? -1 : 1
      return (b.ev.lastTimestamp ?? '').localeCompare(a.ev.lastTimestamp ?? '')
    })
    // 不污染 Event 类型：折叠条数以 uid 为键旁挂（代表行 uid → 折叠条数）
    const mergedBy = new Map(list.map(g => [g.ev.metadata.uid, g.merged]))
    return {
      rows: list.map(g => ({ ...g.ev, count: g.total })),
      mergedBy,
    }
  }, [items, showNormal, nsFilter, filter, allNs])

  if (error && items.length === 0) {
    return <Alert variant="destructive">{error}</Alert>
  }

  // 与其他列表页同一表格（ResourceDataTable）：表头/行高/排序/筛选/分页/问 AI 全部共用，
  // 专用 grid 已退役——同类列表不该有两套密度和两种表头
  const cols = useMemo<Col<Event>[]>(
    () => [
      {
        key: 'object', label: 'sys:colObject', width: '220px',
        value: e => `${e.involvedObject.kind}/${e.involvedObject.name}`, filter: 'text',
        render: e => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-xs text-muted-foreground">{e.involvedObject.kind}</span>
            <span className="truncate font-mono text-[13px]" title={`${e.involvedObject.namespace}/${e.involvedObject.name}`}>
              {e.involvedObject.name}
            </span>
          </span>
        ),
      },
      {
        key: 'type', label: 'sys:colType', width: '90px',
        value: e => e.type, filter: 'select',
        render: e => (
          <Badge variant="secondary" className={cn(e.type === 'Warning' && 'border-caution/40 bg-caution/10 text-caution')}>
            {eventTypeLabel(e.type, lang)}
          </Badge>
        ),
      },
      {
        key: 'count', label: 'sys:colCount', width: '60px', align: 'right',
        value: e => e.count ?? 1,
        render: e => {
          const merged = sorted.mergedBy.get(e.metadata.uid) ?? 1
          return (
            <span className="font-mono text-xs tabular-nums" title={merged > 1 ? tf('sys:eventsMerged', { n: merged }) : undefined}>
              {e.count ?? 1}
              {merged > 1 && <span className="ml-0.5 text-muted-foreground">≡</span>}
            </span>
          )
        },
      },
      {
        key: 'last', label: 'sys:colLast', width: '96px',
        value: e => e.lastTimestamp ?? '',
        render: e => <span className="text-xs tabular-nums text-muted-foreground">{shortTime(e.lastTimestamp)}</span>,
      },
      {
        key: 'reason', label: 'sys:colReasonMsg',
        value: e => `${e.reason ?? ''} ${e.message ?? ''}`, filter: 'text',
        render: e => (
          <span className="min-w-0 truncate" title={e.message}>
            <span className="mr-1.5 font-medium" title={e.reason}>{eventReasonLabel(e.reason, lang)}</span>
            <span className="text-muted-foreground">{e.message}</span>
          </span>
        ),
      },
    ],
    [lang, sorted],
  )

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h1 className="text-lg font-medium">Events</h1>
          {/* 元信息与其他列表页同构：一段式「范围 · 数 · 同步于」 */}
          <span className="whitespace-nowrap text-[13px] tabular-nums text-muted-foreground">
            {allNs ? (nsFilter ? tf('sys:eventsNsOf', { ns: nsFilter }) : t('sys:allNamespaces')) : ns} ·{' '}
            {filteredCount ?? sorted.rows.length}
            {' · '}
            {lastSync != null && tf('sys:syncedAt', { time: new Date(lastSync).toLocaleTimeString('zh-CN', { hour12: false }) })}
          </span>
          {reconnecting && (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-caution">
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-caution" />
              {t('sys:reconnecting')}
            </span>
          )}
        </div>
        {/* 窄屏：筛选控件整组换到第二行（w-full），避免被标题挤成竖排 */}
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 @sm/main:w-auto">
          <ExportButton items={() => sorted.rows} def={RESOURCE_MAP.Event} cluster={cluster!} ns={nsFilter ?? ns ?? undefined} selected={[]} />
          {allNs && <NamespaceFilter cluster={cluster!} value={nsFilter} onChange={setNsFilter} />}
          <Select value={showNormal ? 'all' : 'warning'} onValueChange={v => setShowNormal(v === 'all')}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('sys:allTypes')}</SelectItem>
              <SelectItem value="warning">{t('sys:warningOnly')}</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative min-w-0 flex-1 @sm/main:w-56 @sm/main:flex-none">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t('sys:filterEventsPh')}
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
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {/* 首帧同步完成前是「未知」不是「无事件」：假空态与真空态必须分岔 */}
        {sorted.rows.length === 0 && !lastSync && !error ? (
          <div className="space-y-2 rounded-lg border bg-card p-3 motion-safe:transition-opacity motion-safe:duration-100">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-11/12" />
            <Skeleton className="h-5 w-5/6" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : (
          <ResourceDataTable
            columns={cols}
            rows={sorted.rows}
            rowKey={e => e.metadata.uid}
            getRowClassName={e => (e.type === 'Warning' ? 'bg-caution/5' : undefined)}
            onFilteredCount={setFilteredCount}
            askRow={e =>
              askAi(
                tf('sys:askEvent', {
                  kind: e.involvedObject.kind,
                  ns: e.involvedObject.namespace ?? '-',
                  name: e.involvedObject.name,
                  reason: eventReasonLabel(e.reason, lang),
                  n: e.count ?? 1,
                }),
              )
            }
            onRowClick={e => {
              // 全 kind 可跳详情（GlobalSearch 同款 detailRoute）；未知 kind 行不可导
              const target = e.involvedObject
              const def = RESOURCE_MAP[target.kind]
              if (def && (def.scope === 'cluster' || target.namespace)) {
                navigate(detailRoute(def, cluster!, target.namespace ?? 'cluster', target.name))
              }
            }}
          />
        )}
      </div>
    </div>
  )
}
