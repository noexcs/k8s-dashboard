import { describe, expect, it } from 'vitest'
import { kindIconFor, listRoute, detailRoute } from './registry'

// 路由函数 = 全站导航的单一事实源（侧栏/关联/搜索/面包屑都拼它），拼错即 404 兜底页。
describe('listRoute / detailRoute', () => {
  it('namespaced 资源：带 ns 与不带 ns 两种列表路径', () => {
    const pod = { kind: 'Pod', scope: 'namespaced' } as const
    expect(listRoute(pod, 'c1', 'ns1')).toBe('/c/c1/r/Pod/ns1')
    expect(listRoute(pod, 'c1')).toBe('/c/c1/r/Pod')
  })
  it('cluster 资源：忽略 ns', () => {
    const node = { kind: 'Node', scope: 'cluster' } as const
    expect(listRoute(node, 'c1', 'whatever')).toBe('/c/c1/r/Node')
  })
  it('namespaced 详情：/r/Kind/ns/name', () => {
    expect(detailRoute({ kind: 'ConfigMap', scope: 'namespaced' }, 'c1', 'ns1', 'cm')).toBe(
      '/c/c1/r/ConfigMap/ns1/cm',
    )
  })
  it('cluster 详情用 cluster 占位段', () => {
    expect(detailRoute({ kind: 'Node', scope: 'cluster' }, 'c1', 'ignored', 'n1')).toBe(
      '/c/c1/r/Node/cluster/n1',
    )
  })
  it('dedicatedDetail 优先于通用形态（Node→/nodes/:name）', () => {
    expect(detailRoute({ kind: 'Node', scope: 'cluster', dedicatedDetail: 'nodes' }, 'c1', 'x', 'n1')).toBe(
      '/c/c1/nodes/n1',
    )
  })
  it('cluster 名/资源名做 URL 编码（中文命名空间安全）', () => {
    expect(listRoute({ kind: 'Pod', scope: 'namespaced' }, 'c 1', '生产环境')).toContain(
      encodeURIComponent('生产环境'),
    )
  })
})

// 图标三层回退：CRD 注解白名单 → 内置映射 → 确定性 hash 兜底（同 kind 必须同组件引用）。
describe('kindIconFor', () => {
  it('内置 kind 确定性且互不相同', () => {
    expect(kindIconFor({ kind: 'Pod' })).toBe(kindIconFor({ kind: 'Pod' }))
    expect(kindIconFor({ kind: 'Pod' })).not.toBe(kindIconFor({ kind: 'Deployment' }))
  })
  it('CRD 注解命中白名单（大小写不敏感）', () => {
    const name = (c: unknown) => (c as { displayName?: string }).displayName
    expect(name(kindIconFor({ kind: 'Widgets', iconName: 'gem' }))).toBe('Gem')
    expect(name(kindIconFor({ kind: 'Widgets', iconName: 'GEM' }))).toBe('Gem')
  })
  it('注解不在白名单 → 回落内置/hash（不抛错）', () => {
    expect(kindIconFor({ kind: 'Widgets', iconName: 'not-a-real-icon' })).toBe(
      kindIconFor({ kind: 'Widgets' }),
    )
  })
  it('hash 兜底：未知 kind 有确定图标，不同 kind 落到图标池', () => {
    const a = kindIconFor({ kind: 'SomeCRDAlpha' })
    expect(a).toBe(kindIconFor({ kind: 'SomeCRDAlpha' }))
    expect(a).toBeDefined()
  })
})
