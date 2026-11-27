// metrics-server 实时用量查询（B 资源用量）：集合 = 列表页列，单个 = 详情页卡片。
// metrics-server 是可选插件：缺失时 list 404/503 → retry 关闭、调用方把列渲染为 '-'，不报错刷屏。
// 刷新节奏与首页 Dashboard 一致（30s）；metrics-server 本身 ~60s 采集，更密无增益。
import { useQuery } from '@tanstack/react-query'
import { getMetrics, listMetrics, type MetricsUsage } from '@/api/client'
import type { K8sObject } from '@/api/types'

export type MetricItem = K8sObject & MetricsUsage

const POLL_MS = 30_000

/** 全部节点的实时用量（列表页/节点详情共享缓存键 ['metrics', cluster, 'nodes']） */
export function useNodeMetrics(cluster: string, enabled = true) {
  return useQuery({
    queryKey: ['metrics', cluster, 'nodes'],
    queryFn: async () => (await listMetrics<MetricItem>(cluster, 'nodes')).items,
    enabled: enabled && !!cluster,
    refetchInterval: POLL_MS,
    retry: false,
  })
}

/** 命名空间内（ns 省略 = 全部）Pod 的实时用量 */
export function usePodMetrics(cluster: string, ns?: string, enabled = true) {
  return useQuery({
    queryKey: ['metrics', cluster, 'pods', ns ?? ''],
    queryFn: async () => (await listMetrics<MetricItem>(cluster, 'pods', ns)).items,
    enabled: enabled && !!cluster,
    refetchInterval: POLL_MS,
    retry: false,
  })
}

/** 单节点用量（详情页）。无 metrics-server/无数据 → query error，调用方显示 '-' */
export function useNodeMetric(cluster: string, name: string) {
  return useQuery({
    queryKey: ['metrics', cluster, 'nodes', name],
    queryFn: () => getMetrics<MetricItem>(cluster, 'nodes', name),
    enabled: !!cluster && !!name,
    refetchInterval: POLL_MS,
    retry: false,
  })
}

/** 单 Pod 用量（详情页，containers[].usage 逐容器） */
export function usePodMetric(cluster: string, ns: string, name: string) {
  return useQuery({
    queryKey: ['metrics', cluster, 'pods', ns, name],
    queryFn: () => getMetrics<MetricItem>(cluster, 'pods', name, ns),
    enabled: !!cluster && !!ns && !!name,
    refetchInterval: POLL_MS,
    retry: false,
  })
}
