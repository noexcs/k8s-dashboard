// metrics-server 用量单元格：CPU/内存实时用量列的统一渲染（Node/Pod 列表、Node 详情表共用）。
// 无 metrics-server / 该对象无数据 → '-'；带 capacity 且 ≥90% → amber 高亮（热点一眼可见）。
import { createContext, useContext } from 'react'
import { fmtBytes, fmtCpu, parseQty } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { MetricItem } from '@/hooks/useMetrics'

export function UsageCell({
  usage,
  capacity,
  cpu = false,
}: {
  /** metrics-server usage 原始值（"123456789n" / "1234Ki"）；无数据传 undefined → '-' */
  usage?: string
  /** 同资源 capacity 原始值；给出则可算水位着色 */
  capacity?: string
  cpu?: boolean
}) {
  const u = parseQty(usage)
  const c = parseQty(capacity)
  const hot = u != null && c != null && c > 0 && u / c >= 0.9
  const text = u == null ? '-' : cpu ? fmtCpu(u) : fmtBytes(u)
  return (
    <span
      className={cn(
        'font-mono text-xs tabular-nums',
        u == null && 'text-muted-foreground',
        hot && 'text-caution font-medium',
      )}
      title={usage ? `${usage}${capacity ? ` / ${capacity}` : ''}` : undefined}
    >
      {text}
    </span>
  )
}

// ---------- 通用资源列表页（Node kind）用 Context 注入节点用量 ----------
// registry 列定义是纯函数拿不到外部数据；render 返回组件，组件内再读 Context。

/** name → NodeMetrics（ResourceListPage 在 kind=Node 时提供；null = 无 metrics-server，全 '-'） */
export const NodeUsageContext = createContext<Map<string, MetricItem> | null>(null)

/** Node 列表的用量列：按 name 查 Context map，capacity 用行自身字段 */
export function NodeUsageCell({ name, usageKey, capacity, cpu }: { name: string; usageKey: 'cpu' | 'memory'; capacity?: string; cpu?: boolean }) {
  const map = useContext(NodeUsageContext)
  return <UsageCell usage={map?.get(name)?.usage?.[usageKey]} capacity={capacity} cpu={cpu} />
}
