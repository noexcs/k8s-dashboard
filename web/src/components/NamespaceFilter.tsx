import { useQuery } from '@tanstack/react-query'
import { list, namespacesPath } from '@/api/client'
import { useT } from '@/i18n'
import type { K8sObject } from '@/api/types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

/**
 * 页内命名空间过滤：只渲染选择器，选中的 ns 怎么生效由调用方决定（onChange 回调）——
 * 资源列表页用它 navigate 到带 ns 的列表路由（URL 单一来源），Pod 列表维持页内过滤。
 * 不影响侧边栏全局切换器。value=null 表示全部命名空间。
 * 复用 ['namespaces', cluster] 查询缓存（与全局切换器/侧边栏同 key 同 staleTime，不重复请求）。
 * open/onOpenChange 供外部触发（空态「切换命名空间」按钮直接展开）；不传时开合由组件自管。
 * 焦点不用外部管：radix 展开时把焦点移进列表，收起时自动还给触发器。
 */
export function NamespaceFilter({
  cluster,
  value,
  onChange,
  open,
  onOpenChange,
}: {
  cluster: string
  value: string | null
  onChange: (ns: string | null) => void
  open?: boolean
  onOpenChange?: (v: boolean) => void
}) {
  const { data } = useQuery({
    queryKey: ['namespaces', cluster],
    queryFn: () => list<K8sObject>(cluster, namespacesPath),
    staleTime: 60_000,
  })
  const namespaces = data?.items.map(i => i.metadata.name) ?? []

  const t = useT()
  return (
    <Select
      value={value ?? 'all'}
      onValueChange={v => onChange(v === 'all' ? null : v)}
      open={open}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger aria-haspopup="listbox"
        className={cn('w-40', !value && 'text-muted-foreground')}
        aria-label={t('core:nsFilter')}
      >
        <SelectValue placeholder={t('core:nsAll')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t('core:nsAll')}</SelectItem>
        {namespaces.map(n => (
          <SelectItem key={n} value={n}>
            {n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
