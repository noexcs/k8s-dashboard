import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { eventsPath } from '@/api/client'
import {tf, useT, useLang} from '@/i18n'
import { eventReasonLabel, eventTypeLabel } from '@/lib/eventL10n'
import type { Event } from '@/api/types'
import { useWatch } from '@/hooks/useWatch'
import { Skeleton } from '@/components/ui/skeleton'
import { shortTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MessageSquareText } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { NamespaceFilter } from '@/components/NamespaceFilter'
import { RESOURCE_MAP, detailRoute } from '@/resources/registry'
import { askAi } from '@/features/ai/askBus'

const EV_GRID = 'grid grid-cols-[180px_80px_50px_92px_1fr_36px]'

export function EventsPage() {
  const t = useT()
  const { lang } = useLang()
  const { cluster, ns } = useParams()
  const navigate = useNavigate()
  const allNs = ns === undefined
  const [showNormal, setShowNormal] = useState(true)
  const [nsFilter, setNsFilter] = useState<string | null>(null)

  const { items, lastSync, reconnecting, error } = useWatch<Event>({
    cluster: cluster!,
    path: allNs ? '/api/v1/events' : eventsPath(ns!),
  })

  // 同对象+同 reason+同消息前缀折叠为一行（镜像拉取失败风暴 = 一屏重复行）；
  // count 求和、时间取最新，折叠条数进 title
  const sorted = useMemo(() => {
    const groups = new Map<string, { ev: Event; total: number; merged: number }>()
    for (const e of items) {
      if (nsFilter && e.metadata.namespace !== nsFilter) continue
      if (!showNormal && e.type !== 'Warning') continue
      const obj = e.involvedObject
      const key = `${obj.kind}/${obj.namespace}/${obj.name}|${e.reason}|${(e.message ?? '').slice(0, 80)}`
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
  }, [items, showNormal, nsFilter])

  if (error && items.length === 0) {
    return <Alert variant="destructive">{error}</Alert>
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h1 className="text-lg font-medium">Events</h1>
          <span className="whitespace-nowrap text-[13px] tabular-nums text-muted-foreground">
            {allNs ? (nsFilter ? tf('sys:eventsNsOf', { ns: nsFilter }) : t('sys:allNamespaces')) : ns} · {sorted.rows.length}
          </span>
          {reconnecting && <span className="text-[13px] text-caution">{t('sys:reconnecting')}</span>}
          {lastSync && !reconnecting && (
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {tf('sys:syncedAt', { time: new Date(lastSync).toLocaleTimeString('zh-CN', { hour12: false }) })}
            </span>
          )}
        </div>
        {/* 窄屏：筛选控件整组换到第二行（w-full），避免被标题挤成竖排 */}
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 @sm/main:w-auto">
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
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className={cn(EV_GRID, 'h-8 items-center gap-2 border-b bg-muted/40 px-3 text-[13px] font-medium text-muted-foreground')}>
          <span>{t('sys:colObject')}</span>
          <span>{t('sys:colType')}</span>
          <span className="text-right">{t('sys:colCount')}</span>
          <span>{t('sys:colLast')}</span>
          <span>{t('sys:colReasonMsg')}</span>
          <span aria-hidden />
        </div>
        {sorted.rows.map(e => {
          const target = e.involvedObject
          // 全 kind 可跳详情（GlobalSearch 同款 detailRoute）：旧版仅 Pod 可点，其余整行死掉
          const def = RESOURCE_MAP[target.kind]
          const toTarget = def && (def.scope === 'cluster' || target.namespace)
          const merged = sorted.mergedBy.get(e.metadata.uid) ?? 1
          return (
            <div
              key={e.metadata.uid}
              className={cn(
                EV_GRID,
                'items-center gap-2 border-b border-border/50 px-3 py-1.5 text-[13px] hover:bg-accent/40',
                e.type === 'Warning' && 'bg-caution/5',
              )}
            >
              <button
                disabled={!toTarget}
                onClick={() => toTarget && navigate(detailRoute(def, cluster!, target.namespace ?? 'cluster', target.name))}
                className={cn('flex min-w-0 items-center gap-1.5 text-left', toTarget && 'hover:underline')}
              >
                <span className="shrink-0 text-xs text-muted-foreground">{target.kind}</span>
                <span className="truncate font-mono text-[13px]" title={`${target.namespace}/${target.name}`}>
                  {target.name}
                </span>
              </button>
                <span>
                  {/* Warning ≠ Failed：与详情页/行底色同用 caution，不用 destructive 红 */}
                  <Badge variant="secondary" className={cn(e.type === 'Warning' && 'border-caution/40 bg-caution/10 text-caution')}>
                    {eventTypeLabel(e.type, lang)}
                  </Badge>
                </span>
              <span
                className="text-right font-mono text-xs tabular-nums"
                title={merged > 1 ? tf('sys:eventsMerged', { n: merged }) : undefined}
              >
                {e.count ?? 1}
                {merged > 1 && <span className="ml-0.5 text-muted-foreground">≡</span>}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{shortTime(e.lastTimestamp)}</span>
              <span className="min-w-0 truncate" title={e.message}>
                <span className="mr-1.5 font-medium" title={e.reason}>{eventReasonLabel(e.reason, lang)}</span>
                <span className="text-muted-foreground">{e.message}</span>
              </span>
              {/* 行尾问 AI：浏览事件→一键深挖（带 reason/message 上下文预填） */}
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title={t('res:askAi')}
                onClick={() =>
                  askAi(
                    tf('sys:askEvent', {
                      kind: target.kind,
                      ns: target.namespace ?? '-',
                      name: target.name,
                      reason: eventReasonLabel(e.reason, lang),
                      n: e.count ?? 1,
                    }),
                  )
                }
              >
                <MessageSquareText className="size-3.5" />
              </Button>
            </div>
          )
        })}
        {/* 首帧同步完成前是「未知」不是「无事件」：假空态与真空态必须分岔 */}
        {sorted.rows.length === 0 && !lastSync && (
          <div className="space-y-2 p-4">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        )}
        {sorted.rows.length === 0 && lastSync && <div className="p-4 text-[13px] text-muted-foreground">{t('sys:noEvents')}</div>}
      </div>
    </div>
  )
}
