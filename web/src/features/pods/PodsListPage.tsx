import { Search, SearchX, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { podsPath } from '@/api/client'
import type { Pod, WatchEvent } from '@/api/types'
import { usePodMetrics } from '@/hooks/useMetrics'
import { useWatch } from '@/hooks/useWatch'
import { age, fmtBytes, fmtCpu, parseQty, podHealth } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { NamespaceFilter } from '@/components/NamespaceFilter'
import { ExportButton } from '@/features/resources/ExportButton'
import { ResourceDataTable } from '@/components/ResourceDataTable'
import { askAi } from '@/features/ai/askBus'
import { RESOURCE_MAP, type Col } from '@/resources/registry'
import { tf, useT } from '@/i18n'

/** 容器重启总数 */
function restartCount(p: Pod): number {
  return (p.status.containerStatuses ?? []).reduce((n, c) => n + c.restartCount, 0)
}

export function PodsListPage() {
  const t = useT()
  const { cluster, ns } = useParams()
  const navigate = useNavigate()
  const allNs = ns === undefined
  const path = allNs ? '/api/v1/pods' : podsPath(ns!)
  const [filter, setFilter] = useState('')
  const [nsFilter, setNsFilter] = useState<string | null>(null)
  // 失效深链落地提示（App.tsx 通配符重定向时拼 ?lost=1）：本页就是通配符的落地页，
  // 不接这个参数用户只会看到地址被悄悄换掉。关闭即去参
  const [searchParams, setSearchParams] = useSearchParams()
  const lost = searchParams.get('lost') === '1'
  const dismissLost = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('lost')
    setSearchParams(next, { replace: true })
  }
  // Pod 详情路由：名称格链接（键盘/Cmd-点）与行点击共用
  const podHref = (p: Pod) => `/c/${cluster!}/ns/${p.metadata.namespace}/pods/${p.metadata.name}`

  // watch 变更高亮：uid → 到期时间戳
  const highlight = useRef(new Map<string, number>())
  const [, bump] = useState(0)

  const onEvent = (ev: WatchEvent<Pod>) => {
    const uid = ev.object.metadata?.uid
    if (!uid) return
    highlight.current.set(uid, Date.now() + 1500)
    bump(t => t + 1)
  }

  const { items, lastSync, reconnecting, error } = useWatch<Pod>({
    cluster: cluster!,
    path,
    onEvent,
  })

  // metrics-server 用量：`${ns}/${name}` → 各容器 usage 求和（kubectl top pods 口径）
  const podMetrics = usePodMetrics(cluster!, ns)
  const usageMap = useMemo(() => {
    const m = new Map<string, { cpu: number; mem: number }>()
    for (const it of podMetrics.data ?? []) {
      let cpu = 0
      let mem = 0
      for (const c of it.containers ?? []) {
        cpu += parseQty(c.usage?.cpu) ?? 0
        mem += parseQty(c.usage?.memory) ?? 0
      }
      m.set(`${it.metadata.namespace}/${it.metadata.name}`, { cpu, mem })
    }
    return m
  }, [podMetrics.data])

  // 数据变化后清理：已删除 pod 的 uid 与已过期的高亮不再累积
  useEffect(() => {
    const now = Date.now()
    const present = new Set(items.map(p => p.metadata.uid))
    for (const [uid, expires] of highlight.current) {
      if (!present.has(uid) || expires <= now) highlight.current.delete(uid)
    }
  }, [items])

  const filtered = useMemo(() => {
    return items.filter(p =>
      (!nsFilter || p.metadata.namespace === nsFilter) &&
      (!filter || p.metadata.name.toLowerCase().includes(filter.toLowerCase())),
    )
  }, [items, filter, nsFilter])

  // 列定义（注册表 Col 形态，ResourceDataTable 消费）：全部命名空间多一列「命名空间」
  const cols = useMemo<Col<Pod>[]>(() => {
    const cs: Col<Pod>[] = [
      {
        key: 'status', label: 'pods:colStatus', width: '104px',
        value: p => podHealth(p).label, filter: 'select',
        render: p => {
          const h = podHealth(p)
          return (
            <span className="flex items-center gap-1.5 truncate">
              <span className={cn('size-2 shrink-0 rounded-full', h.dot)} />
              <span className="truncate">{h.label}</span>
            </span>
          )
        },
      },
      {
        key: 'name', label: 'pods:colName',
        value: p => p.metadata.name, filter: 'text',
        render: p => {
          const owner = p.metadata.ownerReferences?.[0]
          return (
            <span className="truncate font-mono text-[13px]" title={p.metadata.name}>
              {p.metadata.name}
              {owner && <span className="ml-1.5 font-sans text-xs text-muted-foreground">{owner.kind}/{owner.name}</span>}
            </span>
          )
        },
      },
    ]
    if (allNs) {
      cs.push({
        key: 'ns', label: 'pods:colNamespace', width: '100px',
        value: p => p.metadata.namespace, filter: 'select',
        render: p => <span className="truncate text-muted-foreground">{p.metadata.namespace}</span>,
      })
    }
    cs.push(
      {
        key: 'restarts', label: 'pods:colRestarts', width: '60px', align: 'right',
        value: p => restartCount(p), filter: 'select',
        render: p => {
          const n = restartCount(p)
          return <span className={cn('font-mono text-[13px]', n > 0 && 'text-caution')}>{n}</span>
        },
      },
      {
        key: 'ready', label: 'pods:colReady', width: '70px',
        render: p => {
          const cs2 = p.status.containerStatuses ?? []
          const ready = cs2.filter(c => c.ready).length
          // 终态（Succeeded/Failed）的 0/N 是完成不是卡住；active 全不 ready 才是红
          const phase = p.status.phase
          const cls = phase === 'Succeeded' || phase === 'Failed' || cs2.length === 0
            ? 'text-muted-foreground'
            : ready === 0
              ? 'text-negative'
              : ready < cs2.length
                ? 'text-caution'
                : 'text-positive'
          return <span className={cn('text-[13px] tabular-nums', cls)}>{ready}/{cs2.length}</span>
        },
      },
      {
        key: 'usage', label: 'res:colUsage', width: '104px', align: 'right',
        render: p => {
          const u = usageMap.get(`${p.metadata.namespace}/${p.metadata.name}`)
          // 组合两值一列,窄屏省一列宽;metrics-server 无数据 → '-'
          return u ? (
            <span className="whitespace-nowrap font-mono text-xs tabular-nums">
              {fmtCpu(u.cpu)} <span className="text-muted-foreground">·</span> {fmtBytes(u.mem)}
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          )
        },
      },
      {
        key: 'node', label: 'pods:colNode',
        value: p => p.spec.nodeName, filter: 'text',
        render: p => <span className="truncate text-muted-foreground">{p.spec.nodeName ?? '-'}</span>,
      },
      {
        key: 'age', label: 'res:colAge', width: '80px', align: 'right',
        value: p => p.metadata.creationTimestamp,
        render: p => <span className="font-mono text-xs text-muted-foreground">{age(p.metadata.creationTimestamp)}</span>,
      },
    )
    return cs
  }, [allNs, usageMap])
  // 表头计数：列筛选生效后的行数（ResourceDataTable 回传）
  const [filteredCount, setFilteredCount] = useState<number | null>(null)

  if (error && items.length === 0) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
        {tf('pods:loadFailed', { error })}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {lost && (
        <Alert className="mb-3 text-[13px]">
          <SearchX />
          <AlertDescription>{t('res:lostDeepLink')}</AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={dismissLost}
              aria-label={t('core:close')}
            >
              <X className="size-3.5" />
            </Button>
          </AlertAction>
        </Alert>
      )}
      {/* 窄屏：筛选/搜索整组换到第二行（w-full），避免标题元信息被挤成竖排 */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h1 className="text-lg font-medium">Pods</h1>
          {/* 元信息与通用列表页同构：一段式「范围 · 数 · 同步于」，同字号同 tabular */}
          <span className="whitespace-nowrap text-[13px] tabular-nums text-muted-foreground">
            {allNs ? (nsFilter ? tf('pods:namespaceFilter', { ns: nsFilter }) : t('pods:allNamespaces')) : ns} ·{' '}
            {filteredCount ?? filtered.length}
            {' · '}
            {lastSync != null && tf('pods:syncedAt', { time: new Date(lastSync).toLocaleTimeString('zh-CN', { hour12: false }) })}
          </span>
          {reconnecting && (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-caution">
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-caution" />
              {t('pods:reconnecting')}
            </span>
          )}
        </div>
        <div className="ml-auto flex w-full items-center gap-2 @sm/main:w-auto">
          <ExportButton items={() => filtered} def={RESOURCE_MAP.Pod} cluster={cluster!} ns={nsFilter ?? ns ?? undefined} selected={[]} />
          {allNs && <NamespaceFilter cluster={cluster!} value={nsFilter} onChange={setNsFilter} />}
          <div className="relative min-w-0 flex-1 @sm/main:w-56 @sm/main:flex-none">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t('pods:filterNamePlaceholder')}
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
        {/* 已同步但 0 Pod 是正常空态：骨架只在「还没同步过且无错」时显示（同 ResourceListPage 口径） */}
        {items.length === 0 && !error && lastSync == null ? (
          <div className="space-y-2 rounded-lg border bg-card p-3 motion-safe:transition-opacity motion-safe:duration-100">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-11/12" />
            <Skeleton className="h-5 w-5/6" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : (
          <ResourceDataTable
            columns={cols}
            rows={filtered}
            rowKey={p => p.metadata.uid}
            onRowClick={p => navigate(podHref(p))}
            nameHref={podHref}
            getRowClassName={p => ((highlight.current.get(p.metadata.uid) ?? 0) > Date.now() ? 'bg-accent' : undefined)}
            onFilteredCount={setFilteredCount}
            askRow={p => askAi(tf('ai:askDiagnoseRow', { kind: 'Pod', ns: p.metadata.namespace ?? '-', name: p.metadata.name }))}
          />
        )}
      </div>
    </div>
  )
}
