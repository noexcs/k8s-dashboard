// topo 字典：资源关联拓扑图（TopologyGraph / TopologyTab）。ns = topo
import type { Entry } from './strings'

export const STRINGS_TOPO: Record<string, Entry> = {
  'topo:viewGraph': { zh: '图形', en: 'Graph' },
  'topo:viewList': { zh: '列表', en: 'List' },
  'topo:clickNodeHint': { zh: '点击节点打开资源详情', en: 'Click a node to open the resource' },
  'topo:graphEmpty': { zh: '暂无可绘制的关联资源', en: 'No related resources to draw' },
}
