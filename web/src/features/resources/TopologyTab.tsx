// TopologyTab：资源详情「关联」tab 的「列表 / 图形」容器。
// 列表视图直接内嵌 RelatedTab（行为与文案零漂移）；图形视图复用 RelatedTab 已导出的
// useOwnerChain / useSelectorPods —— queryKey 完全一致，react-query 自动去重，不会重复请求。
// 数据→拓扑映射：chain（父在左，depth 取 -(i+1)，父→子边 label=ownerRef）；
// 当前资源 = depth 0 中心节点；selector pods（子在右 depth +1，边 label=selector）。
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Network } from 'lucide-react'
import { useT } from '@/i18n'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RESOURCE_MAP, detailRoute, type AnyResourceDef } from '@/resources/registry'
import { useCrds } from '@/resources/crds'
import { RelatedTab, useOwnerChain, useSelectorPods } from './RelatedTab'
import { TopologyGraph, type TopologyEdge, type TopologyNode } from './TopologyGraph'

/** API 原始 ownerRef（RelatedTab 的 OwnerRef 未导出，结构一致即可互赋值） */
interface OwnerRef {
  apiVersion?: string
  kind: string
  name: string
}

/** 图形视图子资源上限：selector pods 可能上百，画全了反而不可读 */
const MAX_GRAPH_PODS = 30

/**
 * 「关联」tab 容器（props 与 RelatedTab 兼容，可直接替换挂载点）。
 * kind/name 省略时从路由参数取（详情页 /c/:cluster/r/:kind/:ns/:name 下总可用），
 * 仅用于画 depth-0 中心节点。
 */
export function TopologyTab({
  cluster,
  ns,
  owners,
  matchLabels,
  kind: kindProp,
  name: nameProp,
}: {
  cluster: string
  ns: string
  owners: OwnerRef[] | undefined
  matchLabels: Record<string, string> | undefined
  kind?: string
  name?: string
}) {
  const t = useT()
  const params = useParams()
  const [view, setView] = useState<'graph' | 'list'>('graph')
  const { defs: crds } = useCrds(cluster)
  const defMap = useMemo(() => ({ ...Object.fromEntries(crds.map(d => [d.kind, d])), ...RESOURCE_MAP }), [crds])
  const chainQ = useOwnerChain(cluster, ns, owners, defMap)
  const { pods, labelSelector } = useSelectorPods(cluster, ns, matchLabels)

  // 与 RelatedTab 相同的合并逻辑：query 结果优先，未落定时回退直接父
  const chain = useMemo(
    () => chainQ.data ?? owners?.map(o => ({ kind: o.kind, name: o.name, ns, def: defMap[o.kind] ?? null })) ?? [],
    [chainQ.data, owners, ns, defMap],
  )

  const currentKind = kindProp ?? params.kind
  const currentName = nameProp ?? params.name

  const routeOf = useMemo(
    () =>
      (kind: string, nodeNs: string, name: string): string | null => {
        const def: AnyResourceDef | undefined = defMap[kind]
        return def ? detailRoute(def, cluster, def.scope === 'cluster' ? 'cluster' : nodeNs, name) : null
      },
    [defMap, cluster],
  )

  const { graphNodes, graphEdges } = useMemo(() => {
    const nodes: TopologyNode[] = []
    const edges: TopologyEdge[] = []
    const nid = (kind: string, nodeNs: string, name: string) => `${kind}/${nodeNs}/${name}`
    // 中心节点：kind/name 不可得（理论上仅异常路由）时以直接父为中心，图仍可渲染
    const hasCurrent = !!(currentKind && currentName)
    const rootId = hasCurrent ? nid(currentKind!, ns, currentName!) : chain[0] ? nid(chain[0].kind, ns, chain[0].name) : ''
    if (hasCurrent) {
      nodes.push({ id: rootId, kind: currentKind!, name: currentName!, ns, depth: 0, current: true, route: routeOf(currentKind!, ns, currentName!) })
    }
    // 父链：chain[0] 是直接父 → depth -1；边方向父→子（左→右），与 selector 边同向，箭头统一
    chain.forEach((o, i) => {
      const id = nid(o.kind, o.ns, o.name)
      if (nodes.some(n => n.id === id)) return // 环路/重复 ownerRef 防御
      if (id === rootId) {
        // 回退中心：直接父顶替 depth 0，保持链路完整
        if (!hasCurrent) nodes.push({ id, kind: o.kind, name: o.name, ns: o.ns, depth: 0, current: true, route: routeOf(o.kind, o.ns, o.name) })
        return
      }
      nodes.push({ id, kind: o.kind, name: o.name, ns: o.ns, depth: hasCurrent ? -(i + 1) : -i })
      const child = i === 0 ? rootId : nid(chain[i - 1].kind, chain[i - 1].ns, chain[i - 1].name)
      if (child && child !== id) edges.push({ id: `owner-${id}->${child}`, source: id, target: child, label: 'ownerRef' })
    })
    // selector pods：右侧一列；volume/endpoint label 预留给 PVC/Endpoints，当前数据源只有 pods/selector
    pods.slice(0, MAX_GRAPH_PODS).forEach(p => {
      const pns = p.metadata.namespace ?? ns
      const id = nid('Pod', pns, p.metadata.name)
      if (id === rootId || nodes.some(n => n.id === id)) return
      nodes.push({ id, kind: 'Pod', name: p.metadata.name, ns: pns, status: p.status?.phase, depth: 1, route: routeOf('Pod', pns, p.metadata.name) })
      if (rootId) edges.push({ id: `selector-${rootId}->${id}`, source: rootId, target: id, label: 'selector' })
    })
    return { graphNodes: nodes, graphEdges: edges }
  }, [chain, pods, ns, currentKind, currentName, routeOf])

  // 无任何关联：保持 RelatedTab 原空态文案（不出现切换器）
  if (chain.length === 0 && !labelSelector) {
    return <RelatedTab cluster={cluster} ns={ns} owners={owners} matchLabels={matchLabels} workloadKind={currentKind} workloadName={currentName} />
  }

  return (
    <Tabs value={view} onValueChange={v => setView(v as 'graph' | 'list')} className="gap-3">
      <TabsList variant="line" className="h-7">
        <TabsTrigger value="graph" className="flex-none gap-1 text-[13px]">
          <Network className="size-3.5" />
          {t('topo:viewGraph')}
        </TabsTrigger>
        <TabsTrigger value="list" className="flex-none text-[13px]">
          {t('topo:viewList')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="graph">
        <TopologyGraph nodes={graphNodes} edges={graphEdges} />
      </TabsContent>
      <TabsContent value="list">
        {/* 列表 = RelatedTab 原样渲染（含加载骨架/空态文案） */}
        <RelatedTab cluster={cluster} ns={ns} owners={owners} matchLabels={matchLabels} workloadKind={currentKind} workloadName={currentName} />
      </TabsContent>
    </Tabs>
  )
}
