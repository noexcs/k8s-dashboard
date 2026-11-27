// 命名空间配额芯片（挂在 site-header 右侧）：当前路由锁定某个具体 ns 时显示
//   [ns 快切下拉] | [cpu/memory/pods 迷你进度条] → 点击用量区跳 ResourceQuota 列表。
// 数据 = /api/v1/namespaces/{ns}/resourcequotas（react-query 30s staleTime，不用 watch：
// 配额是低频变更的头部提示，不值得一条长连接）。403/404/任意错误 → 用量区静默省略。
// ns 段解析走 useLocation 本地函数，不引入全局 context（头部只有这一处需要）。
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { list, namespacesPath } from '@/api/client'
import type { K8sObject } from '@/api/types'
import { tf, useT } from '@/i18n'
import { fmtBytes, parseQty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Quota extends K8sObject {
  status?: {
    used?: Record<string, string>
    hard?: Record<string, string>
  }
}

interface RouteNs {
  cluster: string
  ns: string
  /** ns 段在 pathname 分段数组里的下标（快切时只替换这一段） */
  index: number
}

/**
 * 解析「当前路由锁定的具体命名空间」：
 *   /c/{c}/ns/{ns}/...（pods、events）  /c/{c}/r/{Kind}/{ns}[/{name}]
 *   /c/{c}/yaml/{ns}/{Kind}/{name}      /c/{c}/helm/{ns}/{name}
 * 集群级路由、全部 ns 视图、cluster-scope 详情的 'cluster' 占位段 → null。
 */
function parseRouteNs(pathname: string): RouteNs | null {
  const segs = pathname.split('/').filter(Boolean)
  if (segs[0] !== 'c' || !segs[1]) return null
  const rest = segs.slice(2)
  let index = -1
  if ((rest[0] === 'ns' || rest[0] === 'yaml') && rest.length >= 2) index = 3
  else if (rest[0] === 'helm' && rest.length >= 3) index = 3 // helm 列表页无 ns
  else if (rest[0] === 'r' && rest.length >= 3) index = 4
  if (index < 0) return null
  // ns 值可能被 URL 编码（罕见字符），解码失败时按原文比对
  let ns = segs[index]
  try {
    ns = decodeURIComponent(ns)
  } catch {
    /* 保留原始段 */
  }
  if (!ns || ns === 'cluster') return null
  return { cluster: segs[1], ns, index }
}

/** 每类资源在 hard/used 里的候选 key（优先更具体的 limits/requests 项） */
const METRICS: { i18nKey: string; keys: string[]; kind: 'cpu' | 'mem' | 'count' }[] = [
  { i18nKey: 'nsq:metricCpu', keys: ['limits.cpu', 'cpu', 'requests.cpu'], kind: 'cpu' },
  { i18nKey: 'nsq:metricMemory', keys: ['limits.memory', 'memory', 'requests.memory'], kind: 'mem' },
  { i18nKey: 'nsq:metricPods', keys: ['pods'], kind: 'count' },
]

interface Bar {
  /** 展示用短名 i18n key（CPU / 内存 / Pod 数） */
  i18nKey: string
  quotaKey: string
  usedText: string
  hardText: string
  pct: number // 真实水位，可 >100（超发时文字如实显示）
  shown: number // 画条用的宽度百分比（clamp 0-100）
}

function buildBars(used: Record<string, string>, hard: Record<string, string>): Bar[] {
  const out: Bar[] = []
  for (const m of METRICS) {
    const key = m.keys.find(k => hard[k] != null)
    if (!key) continue
    const h = parseQty(hard[key])
    if (h == null || h <= 0) continue
    const u = parseQty(used[key]) ?? 0
    const ratio = u / h
    const fmt = (v: number) =>
      m.kind === 'cpu'
        ? String(Math.round(v * 10) / 10) // 核，1 位小数
        : m.kind === 'mem'
          ? fmtBytes(v)
          : String(Math.round(v))
    out.push({
      i18nKey: m.i18nKey,
      quotaKey: key,
      usedText: fmt(u),
      hardText: fmt(h),
      pct: Math.round(ratio * 100),
      shown: Math.min(100, Math.max(0, ratio * 100)),
    })
  }
  return out
}

export function NsQuotaChip() {
  const t = useT()
  const location = useLocation()
  const navigate = useNavigate()
  const route = parseRouteNs(location.pathname)

  const { cluster, ns } = route ?? {}
  const { data: quota, isPending } = useQuery({
    queryKey: ['quota', cluster, ns],
    enabled: !!cluster && !!ns,
    staleTime: 30_000,
    queryFn: async (): Promise<Quota | null> => {
      try {
        const res = await list<Quota>(cluster!, `/api/v1/namespaces/${encodeURIComponent(ns!)}/resourcequotas`)
        return res.items[0] ?? null // 一个 ns 通常只有一个 ResourceQuota，多余的不展示
      } catch {
        return null // 无权限 / 子资源不可用：不打扰用户
      }
    },
  })

  // ns 列表复用 ['namespaces', cluster] 缓存（与侧边栏全局切换器同 key）
  const { data: nsList } = useQuery({
    queryKey: ['namespaces', cluster],
    enabled: !!cluster,
    staleTime: 60_000,
    queryFn: () => list<K8sObject>(cluster!, namespacesPath),
  })
  const namespaces = nsList?.items.map(i => i.metadata.name) ?? []

  if (!route || !cluster || !ns) return null

  // 只替换 ns 那一段，其余路径与查询串原样保留（页内 tab、?session= 等不受影响）
  const switchNs = (next: string) => {
    if (!next || next === ns) return
    const segs = location.pathname.split('/').filter(Boolean)
    segs[route.index] = encodeURIComponent(next)
    navigate({ pathname: `/${segs.join('/')}`, search: location.search })
  }

  const bars = quota?.status?.used && quota?.status?.hard ? buildBars(quota.status.used, quota.status.hard) : []

  return (
    <div
      // 头部右侧空间紧张：< md 收起（面包屑在移动端已占满，配额属于锦上添花）
      className="hidden h-7 items-center gap-1 rounded-md border bg-card pr-1 pl-0.5 md:flex"
    >
      <Select value={ns} onValueChange={switchNs}>
        <SelectTrigger
          size="sm"
          className="h-6 max-w-32 gap-1 border-0 bg-transparent px-1.5 text-[13px] font-medium shadow-none"
          aria-label={t('nsq:switchNs')}
          title={t('nsq:switchHint')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {namespaces.map(n => (
            <SelectItem key={n} value={n}>
              {n}
            </SelectItem>
          ))}
          {/* 列表还没回来或该 ns 不在缓存里时仍要能显示当前值 */}
          {!namespaces.includes(ns) && <SelectItem value={ns}>{ns}</SelectItem>}
        </SelectContent>
      </Select>

      {isPending && <Skeleton className="h-3 w-24 rounded-sm" aria-label={t('nsq:loading')} />}

      {/* 取不到 / 没有配额 / 配额里没有我们展示的资源类型 → 统一「无配额」小字 */}
      {!isPending && bars.length === 0 && (
        <span className="pr-1 text-xs text-muted-foreground" title={tf('nsq:noQuotaTitle', { ns })}>
          {t('nsq:noQuota')}
        </span>
      )}

      {!isPending && bars.length > 0 && (
        <Link
          to={`/c/${cluster}/r/ResourceQuota/${encodeURIComponent(ns)}`}
          className="flex items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          title={tf('nsq:chipTitle', { ns })}
          aria-label={tf('nsq:openQuota', { ns })}
        >
          {bars.map(b => (
            <span
              key={b.quotaKey}
              className="flex items-center gap-1"
              title={tf('nsq:metricTitle', {
                label: t(b.i18nKey),
                key: b.quotaKey,
                used: b.usedText,
                hard: b.hardText,
                pct: b.pct,
              })}
            >
              <span className="text-xs text-muted-foreground">{t(b.i18nKey)}</span>
              <span className="h-1 w-8 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn(
                    'block h-full rounded-full',
                    b.pct > 95 ? 'bg-destructive' : b.pct > 80 ? 'bg-caution' : 'bg-primary',
                  )}
                  style={{ width: `${b.shown}%` }}
                />
              </span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {b.usedText}/{b.hardText}
              </span>
            </span>
          ))}
        </Link>
      )}
    </div>
  )
}
