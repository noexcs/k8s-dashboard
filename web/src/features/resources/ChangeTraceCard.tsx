// 变更追溯（managedFields 时间线）：apiserver 记录的「哪个客户端、何时、经哪个字段管理器」改过本对象。
// 语义边界：manager 是客户端标识（kubectl-client-side-apply/kube-controller-manager），不是集群用户——
// 用户视角的写留痕在「变更审计」页，两者互补：这里连 controller 的隐式重写都能看到。
import { useQuery } from '@tanstack/react-query'
import { Clock } from 'lucide-react'
import { useT } from '@/i18n'
import { get } from '@/api/client'
import type { K8sObject } from '@/api/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { shortTime } from '@/lib/format'

interface ManagedField {
  manager?: string
  operation?: string
  apiVersion?: string
  time?: string
  subresource?: string
}

/** manager 白名单映射：常见客户端标识（kubectl-client-side-apply 等长串）→ 可读名。
 *  白名单外原文透传；原始值始终挂 title 备查，映射只做展示层收敛不改数据。 */
function readableManager(manager: string): string {
  const m = manager.toLowerCase()
  // unknown-controller（cluster-autoscaler）等以 unknown 起头的残串统一归为未知客户端
  if (m.includes('unknown')) return '未知客户端'
  if (m.startsWith('headlamp')) return 'Headlamp'
  if (m.startsWith('kubectl')) return 'kubectl'
  if (m.startsWith('dashboard')) return 'Kubernetes Dashboard'
  return manager
}

export function ChangeTraceCard({ cluster, path }: { cluster: string; path: string }) {
  const t = useT()
  const q = useQuery({
    queryKey: ['change-trace', cluster, path],
    queryFn: () => get<K8sObject>(cluster, path, { keepManagedFields: true }),
    staleTime: 30_000,
    retry: 0,
  })
  const fields = (q.data?.metadata as { managedFields?: ManagedField[] } | undefined)?.managedFields ?? []
  if (q.isError || fields.length === 0) return null

  // 按 manager+operation 归并：同 manager 的多次 apply 只留最新时间与次数（原始逐条是字段级噪音）
  const merged = new Map<string, { manager: string; op: string; sub?: string; time?: string; n: number }>()
  for (const f of fields) {
    const key = `${f.manager}/${f.operation}/${f.subresource ?? ''}`
    const g = merged.get(key)
    if (g) {
      g.n += 1
      if ((f.time ?? '') > (g.time ?? '')) g.time = f.time
    } else {
      merged.set(key, { manager: f.manager ?? '?', op: f.operation ?? '?', sub: f.subresource, time: f.time, n: 1 })
    }
  }
  const rows = [...merged.values()].sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''))

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Clock className="size-3.5 text-muted-foreground" />
          {t('res:traceTitle')}
          <span className="text-xs font-normal text-muted-foreground">{t('res:traceSub')}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {rows.map(r => (
          <div key={`${r.manager}/${r.op}/${r.sub ?? ''}`} className="flex items-center gap-2 text-[13px]">
            <span className="w-32 shrink-0 tabular-nums text-muted-foreground" title={r.time}>{shortTime(r.time)}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={`${r.manager}${r.sub ? ` (${r.sub})` : ''}`}>
              {readableManager(r.manager)}
              {r.sub && <span className="text-muted-foreground"> · {r.sub}</span>}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{r.op}</span>
            {r.n > 1 && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">×{r.n}</span>}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
