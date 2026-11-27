import { useQuery } from '@tanstack/react-query'
import { getConfig } from '@/api/client'
import type { ClusterConfig } from '@/api/types'

export function useClusters(): {
  clusters: ClusterConfig[]
  loading: boolean
  error: string | null
  /** headlamp 是否开启 --enable-dynamic-clusters；null=config 读不到（不表态，别让瞬时故障捏造「未开启」） */
  dynamicEnabled: boolean | null
} {
  const { data, isLoading, error } = useQuery({
    queryKey: ['config'],
    queryFn: getConfig,
    staleTime: 5 * 60_000,
  })
  return {
    clusters: data?.clusters ?? [],
    loading: isLoading,
    error: error?.message ?? null,
    dynamicEnabled: data ? data.isDynamicClusterEnabled === true : null,
  }
}
