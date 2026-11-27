import { Skeleton } from '@/components/ui/skeleton'

/**
 * 通用资源详情页加载骨架：页头 + 状态卡 + 两张规格卡（YAML 首帧/CRD 发现等待共用）。
 * pulse=false：等待已明显超时（CRD 发现 5s 未落定）后的纯平铺静态位——继续
 * animate-pulse 等于假装「马上就好」，静态底块如实表达「还在等，不知多久」。
 */
export function DetailSkeleton({ pulse = true }: { pulse?: boolean }) {
  if (!pulse) {
    return (
      <div className="space-y-3">
        <div className="h-5 w-64 rounded-md bg-muted" />
        <div className="h-40 w-full rounded-md bg-muted" />
        <div className="h-[520px] w-full rounded-md bg-muted" />
        <div className="h-[520px] w-full rounded-md bg-muted" />
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-64" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-[520px] w-full" />
      <Skeleton className="h-[520px] w-full" />
    </div>
  )
}
