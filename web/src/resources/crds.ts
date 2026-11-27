// CRD 动态发现：拉集群 API 分组，白名单外 group 逐个取 APIResourceList，
// 运行时注册进 RESOURCE_MAP（通用列表/详情页按 kind 解析，零改动覆盖 CR 实例）。
//
// 契约实测（k3s 1.36）：
//   GET /clusters/:c/apis                → { kind: "APIGroupList", groups: [{ name, preferredVersion, versions[].groupVersion }] }
//   GET /clusters/:c/apis/<groupVersion> → APIResourceList；k3s 的 resources[] 只有 {name,kind,namespaced}，
//                                          group/version 需从清单的 .groupVersion 推导
// 注意：/apis/<group>（group 级、不带版本）在 k3s 上 404；版本清单根响应已带，
// 故发现只需两跳：/apis → /apis/<groupVersion>。core group（''，在白名单）本就不在 groups 里。
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { K8sObject } from '@/api/types'
import { printerCols, type PrinterColumn } from '@/lib/printer-columns'
import { RESOURCE_MAP, type ResourceDef } from '@/resources/registry'

interface ApiGroupList {
  kind: 'APIGroupList'
  groups: {
    name: string
    preferredVersion?: { groupVersion: string; version: string }
    versions: { groupVersion: string; version: string }[]
  }[]
}

interface ApiResource {
  name: string
  singularName?: string
  namespaced: boolean
  kind: string
}

interface ApiResourceList {
  kind: 'APIResourceList'
  groupVersion: string
  resources: ApiResource[]
}

/** 内置 group 白名单（不算 CRD）；白名单外一律按 CRD 处理（k3s 内置 CRD group 可接受）。 */
const BUILTIN_GROUPS: Record<string, true> = {
  apps: true,
  batch: true,
  'networking.k8s.io': true,
  'storage.k8s.io': true,
  'rbac.authorization.k8s.io': true,
  policy: true,
  autoscaling: true,
  'coordination.k8s.io': true,
  'scheduling.k8s.io': true,
  'node.k8s.io': true,
  'discovery.k8s.io': true,
  'events.k8s.io': true,
  'admissionregistration.k8s.io': true,
  'authentication.k8s.io': true,
  'authorization.k8s.io': true,
  'certificates.k8s.io': true,
  'apiextensions.k8s.io': true,
  'apiregistration.k8s.io': true,
  'flowcontrol.apiserver.k8s.io': true,
  'internal.apiserver.k8s.io': true,
  // metrics-server 的聚合 API:NodeMetrics/PodMetrics 是 15s 瞬态指标流,不是可导航资源,
  // 此前被当 CRD 平铺进侧栏「自定义资源」(总览截图实拍泄漏)
  'metrics.k8s.io': true,
  extensions: true,
}

async function fetchJson<T>(url: string): Promise<T> {
  // 每组 20s 硬超时：allSettled 容忍单组失败，但无超时的 fetch 会让一个挂死的
  // group 把整个发现拖过浏览器重试窗口（tailnet 中继实测会挂 30s+）
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return (await res.json()) as T
}

/** CRD 清单的 printer columns + 图标注解（apiextensions CRD 的 kind 全局唯一，name=plural.group 只是兜底解析） */
interface CrdManifest {
  metadata?: { annotations?: Record<string, string> }
  spec: {
    names: { kind: string }
    versions: { name: string; additionalPrinterColumns?: PrinterColumn[] }[]
  }
}

/** v2 > v1 > v1beta2 > v1alpha1，用于同 kind 多 served version 时挑一个（贴近 storage）。 */
function versionScore(v: string): number {
  const m = /^v(\d+)(beta|alpha)?(\d+)?$/.exec(v)
  if (!m) return 0
  const stage = m[2] === 'beta' ? 1 : m[2] === 'alpha' ? 0 : 2
  return Number(m[1]) * 10_000 + stage * 100 + Number(m[3] ?? 0)
}

async function discoverCrds(cluster: string): Promise<ResourceDef<K8sObject>[]> {
  const c = encodeURIComponent(cluster)
  const ext = await fetchJson<ApiGroupList>(`/clusters/${c}/apis`)

  // 每组只取一份资源清单：优先 preferredVersion（≈ storage），否则取第一个 served（versions 降序）
  const seen = new Set<string>()
  const groupVersions = (ext.groups ?? []).flatMap(g => {
    if (g.name === '' || BUILTIN_GROUPS[g.name] || seen.has(g.name)) return []
    seen.add(g.name)
    const gv = g.preferredVersion?.groupVersion ?? g.versions?.[0]?.groupVersion
    return gv ? [{ gv }] : []
  })

  // 单 group 拉取失败（tailnet 抖动 / 502）不应拖垮整个发现
  const lists = (
    await Promise.allSettled(groupVersions.map(({ gv }) => fetchJson<ApiResourceList>(`/clusters/${c}/apis/${gv}`)))
  ).flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))

  // 实测（k3s 1.36）：resources[] 只带 name/kind/namespaced，**不带** group/version，
  // 从清单自身的 groupVersion（"group/version"）推导
  const byKind = new Map<string, { resource: string; kind: string; namespaced: boolean; group: string; version: string }>()
  for (const list of lists) {
    const slash = list.groupVersion.lastIndexOf('/')
    const group = slash >= 0 ? list.groupVersion.slice(0, slash) : ''
    const version = slash >= 0 ? list.groupVersion.slice(slash + 1) : list.groupVersion
    for (const r of list.resources) {
      if (!r.kind || !r.name || r.name.includes('/')) continue // 跳过子资源（status/finalizers…）
      const prev = byKind.get(r.kind)
      if (!prev || versionScore(version) > versionScore(prev.version))
        byKind.set(r.kind, { resource: r.name, kind: r.kind, namespaced: r.namespaced, group, version })
    }
  }

  // printer columns + 图标注解：一次性拉 CRD 清单（kind 全局唯一）；失败不致命（列表退回通用列、图标退回 hash）
  const printerByKind = new Map<string, PrinterColumn[]>()
  const iconByKind = new Map<string, string>()
  try {
    const crds = await fetchJson<{ items: CrdManifest[] }>(`/clusters/${c}/apis/apiextensions.k8s.io/v1/customresourcedefinitions`)
    for (const crd of crds.items ?? []) {
      const v = crd.spec.versions.find(x => x.name === byKind.get(crd.spec.names.kind)?.version) ?? crd.spec.versions.at(-1)
      if (v?.additionalPrinterColumns?.length) printerByKind.set(crd.spec.names.kind, v.additionalPrinterColumns)
      const icon = crd.metadata?.annotations?.['k8s-dashboard.dev/icon']
      if (icon) iconByKind.set(crd.spec.names.kind, icon)
    }
  } catch {
    // apiextensions 不可达（RBAC 受限集群）→ 无自定义列
  }

  const defs: ResourceDef<K8sObject>[] = [...byKind.values()]
    .sort((a, b) => a.kind.localeCompare(b.kind))
    .map(x => ({
      kind: x.kind,
      label: x.kind,
      group: x.group,
      version: x.version,
      resource: x.resource,
      scope: x.namespaced ? 'namespaced' : 'cluster',
      section: 'other',
      printer: printerCols(printerByKind.get(x.kind)),
      iconName: iconByKind.get(x.kind),
    }))

  return defs
}

/** 上次成功发现结果（按集群）：慢链路下本轮失败时回退，避免侧栏「自定义资源」组整体消失 */
const lastGoodDefs = new Map<string, ResourceDef<K8sObject>[]>()

/**
 * 集群自定义资源（CRD 实例类型），按 kind 排序；无 CRD 时 defs 为空数组。
 * isFetched：发现请求首次落定（成功或失败）前为 false——深链页用它区分
 * 「还在发现中」与「确实没有这个 kind」，避免首帧误判卡死。
 */
export function useCrds(cluster: string | undefined): { defs: ResourceDef<K8sObject>[]; isFetched: boolean } {
  const { data, isFetched } = useQuery({
    queryKey: ['crds', cluster],
    // queryFn 保持纯函数：TanStack 在 retry 时会重放 queryFn，写 RESOURCE_MAP 的
    // 副作用会跟着重放；全局写入还会让跨集群同名 kind 后写覆盖内置/先前注册
    queryFn: async () => {
      try {
        const defs = await discoverCrds(cluster!)
        lastGoodDefs.set(cluster!, defs)
        return defs
      } catch (e) {
        // 本轮失败但有过往成功记录（tailnet 抖动 / 中继首请求超时）→ 吃旧结果，
        // 侧栏保留上次的 CRD 条目（图标注解等最多滞后一个刷新周期）
        const stale = lastGoodDefs.get(cluster!)
        if (stale) return stale
        throw e
      }
    },
    enabled: cluster !== undefined,
    staleTime: 5 * 60_000,
    // tailnet 中继首请求常 >30s、代理侧偶发 502；比全局默认（retry:1）更宽容
    retry: 4,
  })

  // 数据到达后在独立 effect 里注册进 RESOURCE_MAP：
  // 已存在的 kind（内置或先前发现的 CRD）跳过——内置 kind 优先，永不覆盖；
  // 过期条目不删除（CRD 被删/切集群）：会话级粘滞可接受，通用页按 kind 解析，
  // 残留条目最多指向一个会 404 的资源，不会造成错误路由。
  // 注意：effect 写入发生在 render 之后且不触发重渲染——深链页不能依赖
  // 「data 到达的那次 render 能读到 map」，必须直接用下面的 defs（同 render 可用）。
  useEffect(() => {
    if (!data) return
    for (const d of data) {
      if (RESOURCE_MAP[d.kind]) continue
      RESOURCE_MAP[d.kind] = d
    }
  }, [data])

  return { defs: data ?? [], isFetched }
}
