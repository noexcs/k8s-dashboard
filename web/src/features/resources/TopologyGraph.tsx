// TopologyGraph：资源关联拓扑的图形视图（React Flow v13，纯展示组件）。
// 节点/边由调用方（TopologyTab）从 owner 链 + selector 数据映射好；布局手写分层——
// depth 0（当前资源）居中，父链（负 depth）向左、子资源（正 depth）向右，
// 坐标按 depth/列内序号计算，避免引入 dagre 等新依赖。
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import '@xyflow/react/dist/style.css'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { useT } from '@/i18n'
import { useTheme } from '@/hooks/useTheme'
import { kindIconFor } from '@/resources/registry'
import { cn } from '@/lib/utils'

/** 拓扑节点：depth 0 = 当前资源，负数 = 向上 owner 链，正数 = 向下子资源 */
export interface TopologyNode {
  id: string
  kind: string
  name: string
  ns: string
  status?: string
  depth: number
  /** 详情路由；null/undefined = 无路由（未知 kind），节点不可跳转 */
  route?: string | null
  current?: boolean
}

/** 边语义：owner 链 / selector 推导（volume、endpoint 预留给后续数据源扩展） */
type TopologyEdgeLabel = 'ownerRef' | 'selector' | 'volume' | 'endpoint'

export interface TopologyEdge {
  id: string
  source: string
  target: string
  label?: TopologyEdgeLabel
}

type FlowNode = Node<{ topo: TopologyNode }, 'topo'>

// 布局常量：列宽留足边 label 空间；行距 > 节点高度（~54px）保证不重叠
const COL_W = 250
const ROW_H = 82
const NODE_W = 184

/** 状态 → 色点（沿用 PodDetailPage 的 emerald/amber/red 语义，Tailwind 类自带暗色适配） */
function statusDotClass(status?: string): string {
  switch (status) {
    case 'Running':
    case 'Ready':
    case 'Active':
    case 'Bound':
    case 'Available':
      return 'bg-positive'
    case 'Pending':
    case 'ContainerCreating':
      return 'bg-caution'
    case 'Failed':
    case 'CrashLoopBackOff':
    case 'Error':
    case 'NotReady':
      return 'bg-destructive'
    case 'Succeeded':
      return 'bg-muted-foreground'
    default:
      return 'bg-muted-foreground/50'
  }
}

function TopoNodeCard({ data }: NodeProps<FlowNode>) {
  const { topo } = data
  const Icon = kindIconFor(topo.kind)
  return (
    <div
      className={cn(
        'w-[184px] cursor-pointer rounded-md border bg-card px-2 py-2 shadow-sm transition-colors hover:border-primary/50',
        topo.current && 'border-primary/60 ring-1 ring-primary/30',
      )}
      title={`${topo.kind}/${topo.name}${topo.status ? ` (${topo.status})` : ''}`}
    >
      <Handle type="target" position={Position.Left} className="size-1.5!" />
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">{topo.kind}</span>
        {topo.status && (
          <span
            className={cn('ml-auto size-1.5 shrink-0 rounded-full', statusDotClass(topo.status))}
            title={topo.status}
          />
        )}
      </div>
      <div className="mt-0.5 truncate font-mono text-xs" title={`${topo.ns}/${topo.name}`}>
        {topo.name}
      </div>
      <Handle type="source" position={Position.Right} className="size-1.5!" />
    </div>
  )
}

// 模块级常量：引用稳定，避免 React Flow 每次 render 重置 nodeTypes
const nodeTypes = { topo: TopoNodeCard }

/** depth 分列 → 手工分层布局坐标：同列节点围绕 y=0 垂直居中 */
function layout(nodes: TopologyNode[]): FlowNode[] {
  const byDepth = new Map<number, TopologyNode[]>()
  nodes.forEach(n => {
    const arr = byDepth.get(n.depth) ?? []
    arr.push(n)
    byDepth.set(n.depth, arr)
  })
  const out: FlowNode[] = []
  byDepth.forEach((arr, depth) => {
    arr.forEach((n, i) => {
      out.push({
        id: n.id,
        type: 'topo',
        position: { x: depth * COL_W, y: (i - (arr.length - 1) / 2) * ROW_H },
        data: { topo: n },
        // 预置宽度：fitView 边界不依赖 DOM 测量时序，容器首帧高度为 0 也不抖
        width: NODE_W,
      })
    })
  })
  return out
}

/**
 * 拓扑图（只读）：支持缩放/平移，节点固定不拖动。
 * 点击节点：传了 onSelect 则回调；否则有 route 时直接跳详情路由。
 */
export function TopologyGraph({
  nodes,
  edges,
  onSelect,
}: {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  onSelect?: (node: TopologyNode) => void
}) {
  const t = useT()
  const navigate = useNavigate()
  const { resolved } = useTheme()

  const flowNodes = useMemo(() => layout(nodes), [nodes])
  // 边 label 直接用调用方给的语义标识（ownerRef/selector/…）：K8s 术语不翻译，与 kind 显示一致
  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        labelStyle: { fontSize: 11 },
        type: 'default',
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [edges],
  )

  // 显式高度：外层是 overflow-auto 的 tab 容器，h-full 在滚动容器里不可靠，直接定高防 0 高崩溃
  if (nodes.length === 0) {
    return (
      <div className="flex h-[420px] items-center justify-center rounded-md border text-[13px] text-muted-foreground">
        {t('topo:graphEmpty')}
      </div>
    )
  }

  return (
    <div className="relative h-[420px] min-h-[420px] w-full overflow-hidden rounded-md border bg-background md:h-[520px]">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => {
          const n = node.data.topo
          if (onSelect) onSelect(n)
          else if (n.route) navigate(n.route)
        }}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={2}
        // 只读图：节点不可拖动/连线，缩放平移可用
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        // style.css 的 light-dark() 变量靠 color-scheme 切换；显式传入避免 system 档下与页面主题脱节
        forceColorMode={resolved}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
        <Panel position="top-right">
          <span className="rounded bg-card/80 px-1.5 py-0.5 text-xs text-muted-foreground">
            {t('topo:clickNodeHint')}
          </span>
        </Panel>
      </ReactFlow>
    </div>
  )
}
