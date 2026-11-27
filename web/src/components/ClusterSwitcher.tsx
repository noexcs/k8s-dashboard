import { Check, ChevronsUpDown } from 'lucide-react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { tf, useT } from '@/i18n'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useClusters } from '@/hooks/useClusters'

export function ClusterSwitcher() {
  const t = useT()
  const { clusters, loading, error } = useClusters()
  const { cluster } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  // 保路由切集群：值班在巡检/审计页轮值多集群，每次被踢回 Pods 是纯粹的重复搬运；
  // 当前路径含 /c/{old} 前缀就原位替换，解析不出（非集群页）才兜底 Pods
  const switchTo = (name: string) => {
    const m = location.pathname.match(/^\/c\/[^/]+(.*)$/)
    navigate(m ? `/c/${encodeURIComponent(name)}${m[1]}` : `/c/${encodeURIComponent(name)}/pods`)
  }

  if (loading) return <div className="h-8 rounded-md bg-muted" />
  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs leading-4 text-destructive">
        {tf('core:clusterConnectError', { err: error })}
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="w-full justify-between">
          <span className="truncate">{cluster ?? t('core:selectCluster')}</span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {clusters.map(c => (
          <DropdownMenuItem key={c.name} onClick={() => switchTo(c.name)}>
            <div className="flex flex-col">
              <span className="text-[13px]">{c.name}</span>
              <span className="text-xs text-muted-foreground">{c.server}</span>
            </div>
            {c.name === cluster && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
