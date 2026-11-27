// @ts-check
/**
 * 节点视角工具（契约 T1）：node_view 只读诊断 + drain 驱逐编排（写，走权限门）。
 * 纯导出模块：不 import tools.js，自带 result/safe/parseQty 等价小函数；
 * 导出 committedByNode 供 tools.js 的 top 在 metrics-server 缺失时退化用。
 */
import { Type } from 'typebox'
import { list, get, request, BackendError } from './k8s.js'

// ---------- 模块本地 helper（tools.js 私有，不能 import，按契约复制最小等价实现） ----------

/** 工具统一出口：结果同时给模型（JSON 文本）与 UI（details 结构化） */
/** @template T @param {T} value @returns {{ content: Array<{ type: 'text'; text: string }>, details: T }} */
const result = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  details: value,
})

/** 出错不抛：返回 { error } 供模型如实转述 */
/** @template T @param {() => Promise<T>} fn @returns {Promise<T | { error: string }>} */
async function safe(fn) {
  try {
    return await fn()
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** K8s quantity → 数值（cpu 毫核归一为核，内存归一为字节；与 tools.js 同口径） */
/** @type {Record<string, number>} */
const QTY_MULT = {
  '': 1, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
}
/** @param {string | undefined} v @returns {number | null} */
function parseQty(v) {
  if (!v) return null
  const m = /^([0-9]+(?:\.[0-9]+)?)([A-Za-z]*)$/.exec(v.trim())
  if (!m) return null
  const suffix = m[2]
  const mult = suffix === undefined ? undefined : QTY_MULT[suffix]
  return mult === undefined ? null : Number(m[1]) * mult
}

/** @param {number | null} v @returns {string} */
function fmtCpuQty(v) {
  if (v == null) return '-'
  return v < 1 ? `${Math.round(v * 1000)}m` : String(Math.round(v * 100) / 100)
}
/** 字节 → "123Mi" / "1.5Gi"（二进位） */
/** @param {number | null} v @returns {string} */
function fmtMemQty(v) {
  if (v == null) return '-'
  const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti']
  let n = v
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${Math.round(n * 10) / 10}${units[i]}`
}

/** @param {number | null} part @param {number | null} whole @returns {number | null} */
function pct(part, whole) {
  return part != null && whole ? Math.round((part / whole) * 100) : null
}

// ---------- K8s 最小类型（只声明本模块用到的字段） ----------

/** @typedef {object} K8sCondition @property {string} type @property {string} status @property {string} [reason] @property {string} [message] @property {string} [lastHeartbeatTime] */

/**
 * @typedef {object} K8sNode
 * @property {{ name: string; creationTimestamp?: string }} metadata
 * @property {{ unschedulable?: boolean; taints?: Array<{ key?: string; value?: string; effect?: string }> } & Record<string, unknown>} [spec]
 * @property {{
 *   conditions?: K8sCondition[];
 *   capacity?: Record<string, string>;
 *   allocatable?: Record<string, string>;
 *   nodeInfo?: Record<string, string>;
 *   addresses?: Array<{ type?: string; address?: string }>;
 * }} [status]
 */

/**
 * @typedef {object} K8sPod
 * @property {{ name: string; namespace?: string; ownerReferences?: Array<{ kind?: string; name?: string }> } & Record<string, unknown>} metadata
 * @property {{ nodeName?: string } & Record<string, unknown>} [spec]
 * @property {{ phase?: string } & Record<string, unknown>} [status]
 */

/**
 * 本集群 metricsserver 只暴露 v1beta1（k3s）；v1 优先失败回退，全失败 null。
 * @param {string} cluster @param {AbortSignal | undefined} [signal]
 */
async function listNodeMetrics(cluster, signal) {
  try {
    return /** @type {{ items: Array<{ metadata: { name: string }; usage?: { cpu?: string; memory?: string } }> }} */ (
      await list(cluster, '/apis/metrics.k8s.io/v1/nodes', {}, signal)
    ).items
  } catch {
    try {
      return /** @type {{ items: Array<{ metadata: { name: string }; usage?: { cpu?: string; memory?: string } }> }} */ (
        await list(cluster, '/apis/metrics.k8s.io/v1beta1/nodes', {}, signal)
      ).items
    } catch {
      return null
    }
  }
}

/**
 * Pod 实时用量（v1 优先、仅 404 回退 v1beta1；node_view 的 top5 pod 用，缺失由调用方兜住）。
 * @param {string} cluster @param {string | undefined} ns @param {AbortSignal | undefined} [signal]
 */
async function listPodMetrics(cluster, ns, signal) {
  const mid = ns ? `namespaces/${encodeURIComponent(ns)}/` : ''
  try {
    return /** @type {{ items: Array<{ metadata: { name: string; namespace?: string }; containers?: Array<{ usage?: { cpu?: string; memory?: string } }> }> }} */ (
      await list(cluster, `/apis/metrics.k8s.io/v1/${mid}pods`, {}, signal)
    ).items
  } catch (e) {
    // 仅 API 版本未注册（404）回退；鉴权/网络错误原样抛（safe 兜底）
    const status = e && typeof e === 'object' && 'status' in e ? /** @type {{ status?: number }} */ (e).status : undefined
    if (status !== 404) throw e
    return /** @type {{ items: Array<{ metadata: { name: string; namespace?: string }; containers?: Array<{ usage?: { cpu?: string; memory?: string } }> }> }} */ (
      await list(cluster, `/apis/metrics.k8s.io/v1beta1/${mid}pods`, {}, signal)
    ).items
  }
}

/**
 * 容器资源请求/上限（initContainers 按 k8s effective-request 语义取 max，不含 restart=never 的累加）。
 * @param {K8sPod} p @returns {{ requests: { cpu: number | null; memory: number | null }; limits: { cpu: number | null; memory: number | null } }}
 */
function podRequests(p) {
  const spec = /** @type {{ containers?: Array<{ resources?: Record<string, any> }>; initContainers?: Array<{ restartPolicy?: string; resources?: Record<string, any> }> }} */ (
    /** @type {unknown} */ (p.spec ?? {})
  )
  /** @param {'requests' | 'limits'} kind @returns {{ cpu: number | null; memory: number | null }} */
  const sum = (kind) => {
    let cpu = 0
    let mem = 0
    let anyCpu = false
    let anyMem = false
    const add = (/** @type {Record<string, any> | undefined} */ res) => {
      const c = parseQty(res?.[kind]?.cpu)
      const m = parseQty(res?.[kind]?.memory)
      if (c != null) {
        cpu += c
        anyCpu = true
      }
      if (m != null) {
        mem += m
        anyMem = true
      }
    }
    for (const c of spec.containers ?? []) add(c.resources)
    // init 容器取各资源维度的最大值（restart=Always 的 sidecar 已由 kubelet 并入 containers 口径，跳过）
    let ic = 0
    let im = 0
    for (const c of spec.initContainers ?? []) {
      if (c.restartPolicy === 'Always') continue
      const c1 = parseQty(c.resources?.[kind]?.cpu)
      const m1 = parseQty(c.resources?.[kind]?.memory)
      if (c1 != null) ic = Math.max(ic, c1)
      if (m1 != null) im = Math.max(im, m1)
    }
    // 没声明过该维度时保持 null（显示 '-'），别冒充 0 承诺
    return { cpu: anyCpu || ic > 0 ? cpu + ic : null, memory: anyMem || im > 0 ? mem + im : null }
  }
  return { requests: sum('requests'), limits: sum('limits') }
}

/**
 * 按节点聚合 Pod requests/limits 承诺水位（cpu 核、内存字节）。
 * 排除 Succeeded/Failed——已终结的 Pod 不占调度容量（与 kubectl describe node 的 Allocated resources 同口径）。
 * @param {string} cluster @param {AbortSignal | undefined} [signal]
 * @returns {Promise<Record<string, {pods: number, requestsCpu: number, requestsMem: number, limitsCpu: number, limitsMem: number}>>}
 */
export async function committedByNode(cluster, signal) {
  const { items } = /** @type {{ items: K8sPod[] }} */ (await list(cluster, '/api/v1/pods', {}, signal))
  /** @type {Record<string, {pods: number, requestsCpu: number, requestsMem: number, limitsCpu: number, limitsMem: number}>} */
  const out = {}
  for (const p of items) {
    const node = p.spec?.nodeName
    if (!node) continue
    const phase = p.status?.phase
    if (phase === 'Succeeded' || phase === 'Failed') continue
    const r = out[node] ?? (out[node] = { pods: 0, requestsCpu: 0, requestsMem: 0, limitsCpu: 0, limitsMem: 0 })
    r.pods += 1
    const { requests, limits } = podRequests(p)
    r.requestsCpu += requests.cpu ?? 0
    r.requestsMem += requests.memory ?? 0
    r.limitsCpu += limits.cpu ?? 0
    r.limitsMem += limits.memory ?? 0
  }
  return out
}

// ---------- 工具 ----------

/**
 * @param {{ value: string }} clusterRef 当前会话集群名（可变引用，execute 时读取）
 * 返回类型 any：与 buildTools 字面量联合对齐（object 混入会让 def.execute 报错）
 * @returns {Record<string, any>}
 */
export function buildNodeTools(clusterRef) {
  const cluster = () => clusterRef.value

  return {
    node_view: {
      label: '节点视角',
      description:
        '节点诊断视角（只读）：回答「节点为何 NotReady / Pod 为何调度不上去 / 水位如何 / 还能不能再塞下 N 个 pod」优先用本工具，别用 k8s_get 捞原始 JSON 或 exec 进容器跑 df（宿主机情况只有这里能看到）。不带 name = 全节点摘要表（Ready/不可调度/taints/allocatable/承诺 requests 百分比/DS pod 数/pod 数）；带 name = 单节点深挖：conditions 全量（含 DiskPressure/PIDPressure）、kubelet/os 信息、capacity vs allocatable、requests+limits 承诺水位（永远有，不依赖 metrics-server，回答「还能塞多少」用这个口径）、taints、实时用量（metrics-server 缺失时 metrics=null 并附承诺水位 note）、该节点 Pod 列表、节点相关事件（含磁盘类 Warning：FreeDiskSpaceFailed/EvictionThresholdMet）。',
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: '节点名；缺省输出全节点摘要表' })),
      }),
      /** @param {string} _toolCallId @param {{ name?: string }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const data = await safe(async () => {
          if (!params.name) {
            const [nodesRes, podsRes, committed] = await Promise.all([
              /** @type {Promise<{ items: K8sNode[] }>} */ (list(cluster(), '/api/v1/nodes', {}, signal)),
              /** @type {Promise<{ items: K8sPod[] }>} */ (
                list(cluster(), '/api/v1/pods', { fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed' }, signal)
              ),
              committedByNode(cluster(), signal),
            ])
            // DS pod 数：ownerReferences kind=DaemonSet（从上面已拉的 pods 里筛，不再发一次全量 list）
            /** @type {Record<string, number>} */
            const dsByNode = {}
            for (const p of podsRes.items) {
              const node = p.spec?.nodeName
              if (!node) continue
              if ((p.metadata.ownerReferences ?? []).some((o) => o.kind === 'DaemonSet')) {
                dsByNode[node] = (dsByNode[node] ?? 0) + 1
              }
            }
            return {
              nodes: nodesRes.items.map((n) => {
                const ready = (n.status?.conditions ?? []).find((c) => c.type === 'Ready')
                const name = n.metadata.name
                const c = committed[name]
                const allocCpu = parseQty(n.status?.allocatable?.cpu)
                const allocMem = parseQty(n.status?.allocatable?.memory)
                return {
                  name,
                  ready: ready?.status === 'True',
                  readyStatus: ready?.status ?? 'Unknown',
                  unschedulable: n.spec?.unschedulable === true,
                  taints: (n.spec?.taints ?? []).map((t) => `${t.key}=${t.value ?? ''}:${t.effect}`),
                  allocatableCpu: n.status?.allocatable?.cpu ?? null,
                  allocatableMem: n.status?.allocatable?.memory ?? null,
                  committed: c
                    ? {
                        pods: c.pods,
                        requestsCpuPercent: pct(c.requestsCpu, allocCpu),
                        requestsMemPercent: pct(c.requestsMem, allocMem),
                      }
                    : { pods: 0, requestsCpuPercent: 0, requestsMemPercent: 0 },
                  dsPods: dsByNode[name] ?? 0,
                  pods: c?.pods ?? 0,
                }
              }),
            }
          }
          const name = params.name
          const base = `/api/v1/nodes/${encodeURIComponent(name)}`
          const [node, podsRes, eventsRes, metrics, podMetrics] = await Promise.all([
            /** @type {Promise<K8sNode>} */ (get(cluster(), base, signal)),
            /** @type {Promise<{ items: K8sPod[] }>} */ (
              list(cluster(), '/api/v1/pods', { fieldSelector: `spec.nodeName=${name},status.phase!=Succeeded` }, signal)
            ),
            /** @type {Promise<{ items: Array<{ type?: string; reason?: string; message?: string; lastTimestamp?: string; count?: number }> }>} */ (
              list(cluster(), '/api/v1/events', { fieldSelector: `involvedObject.kind=Node,involvedObject.name=${name}` }, signal)
            ),
            // metrics 缺失是常态（metrics-server 未装）：失败置 null，不让整个 view 失败
            listNodeMetrics(cluster(), signal).catch(() => null),
            listPodMetrics(cluster(), undefined, signal).catch(() => null),
          ])
          const allocCpu = parseQty(node.status?.allocatable?.cpu)
          const allocMem = parseQty(node.status?.allocatable?.memory)
          const c = (await committedByNode(cluster(), signal))[name]
          /** @type {{ requests: { cpu: number; memory: number }, limits: { cpu: number; memory: number } }} */
          const agg = { requests: { cpu: 0, memory: 0 }, limits: { cpu: 0, memory: 0 } }
          const podRows = podsRes.items.map((p) => {
            const r = podRequests(p)
            agg.requests.cpu += r.requests.cpu ?? 0
            agg.requests.memory += r.requests.memory ?? 0
            agg.limits.cpu += r.limits.cpu ?? 0
            agg.limits.memory += r.limits.memory ?? 0
            const cs = /** @type {Array<{ ready?: boolean; restartCount?: number }>} */ (
              /** @type {any} */ (p.status)?.containerStatuses ?? []
            )
            return {
              name: p.metadata.name,
              namespace: p.metadata.namespace ?? null,
              phase: p.status?.phase ?? 'Unknown',
              requestsCpu: fmtCpuQty(r.requests.cpu),
              requestsMem: fmtMemQty(r.requests.memory),
              ready: `${cs.filter((x) => x.ready).length}/${cs.length}`,
              restarts: cs.reduce((n2, x) => n2 + (x.restartCount ?? 0), 0),
            }
          })
          const nodeMetric = (metrics ?? []).find((m) => m.metadata.name === name)
          const cpuU = parseQty(nodeMetric?.usage?.cpu)
          const memU = parseQty(nodeMetric?.usage?.memory)
          /** @type {{ cpuPercent: number | null; memoryPercent: number | null; cpu: string; memory: string; topPods: Array<{ name: string; namespace: string | null; cpu: string; memory: string }> } | null} */
          let metricBlock = null
          if (nodeMetric) {
            const top = (podMetrics ?? [])
              .filter((p) => {
                // podMetrics 是跨 ns 全量：用已知的本节点 pod 名单收窄（无 nodeName 字段可靠可用）
                const key = `${p.metadata.namespace}/${p.metadata.name}`
                return podsRes.items.some((x) => `${x.metadata.namespace}/${x.metadata.name}` === key)
              })
              .map((p) => {
                let cpu = 0
                let mem = 0
                for (const ct of p.containers ?? []) {
                  cpu += parseQty(ct.usage?.cpu) ?? 0
                  mem += parseQty(ct.usage?.memory) ?? 0
                }
                return { name: p.metadata.name, namespace: p.metadata.namespace ?? null, cpuRaw: cpu, memRaw: mem, cpu: fmtCpuQty(cpu), memory: fmtMemQty(mem) }
              })
              .sort((a, b) => b.cpuRaw - a.cpuRaw)
              .slice(0, 5)
              .map(({ cpuRaw: _c, memRaw: _m, ...r }) => r)
            metricBlock = {
              cpu: fmtCpuQty(cpuU),
              memory: fmtMemQty(memU),
              cpuPercent: pct(cpuU, allocCpu),
              memoryPercent: pct(memU, allocMem),
              topPods: top,
            }
          }
          const readyCond = (node.status?.conditions ?? []).find((cd) => cd.type === 'Ready')
          return {
            name,
            ready: readyCond?.status === 'True',
            conditions: (node.status?.conditions ?? []).map((cd) => ({
              type: cd.type,
              status: cd.status,
              reason: cd.reason ?? null,
              message: cd.message?.slice(0, 200) ?? null,
              lastHeartbeat: cd.lastHeartbeatTime ?? null,
            })),
            readySince: readyCond?.lastHeartbeatTime ?? node.metadata.creationTimestamp ?? null,
            nodeInfo: node.status?.nodeInfo ?? null,
            addresses: node.status?.addresses ?? [],
            capacity: node.status?.capacity ?? null,
            allocatable: node.status?.allocatable ?? null,
            unschedulable: node.spec?.unschedulable === true,
            taints: (node.spec?.taints ?? []).map((t) => `${t.key}=${t.value ?? ''}:${t.effect}`),
            committed: {
              pods: c?.pods ?? 0,
              requestsCpu: fmtCpuQty(c?.requestsCpu ?? 0),
              requestsMem: fmtMemQty(c?.requestsMem ?? 0),
              limitsCpu: fmtCpuQty(c?.limitsCpu ?? 0),
              limitsMem: fmtMemQty(c?.limitsMem ?? 0),
              requestsCpuPercent: pct(c?.requestsCpu ?? null, allocCpu),
              requestsMemPercent: pct(c?.requestsMem ?? null, allocMem),
              limitsCpuPercent: pct(c?.limitsCpu ?? null, allocCpu),
              limitsMemPercent: pct(c?.limitsMem ?? null, allocMem),
            },
            metrics: metricBlock,
            ...(metricBlock ? {} : { note: 'metrics-server 不可用，已用承诺水位' }),
            pods: podRows,
            warningEvents: eventsRes.items
              .filter((e) => e.type === 'Warning')
              .slice(-10)
              .map((e) => ({ reason: e.reason, message: e.message?.slice(0, 200), count: e.count ?? 1, last: e.lastTimestamp ?? null })),
          }
        })
        return result(data)
      },
    },

    drain: {
      label: '驱逐节点 Pod',
      description:
        '驱逐（drain）某节点上的 Pod（写操作，直接生效！）：cordon（spec.unschedulable=true）→ 逐个通过 Eviction API 驱逐。PDB 尊重是默认行为：disruptionsAllowed<=0 或被 429 拒绝的 Pod 进 blocked 列表、绝不硬删。自动跳过 Succeeded/Failed Pod 与 DaemonSet 管理的 Pod（skippedDs）。**不自动 uncordon**（对齐 kubectl drain 语义），恢复调度需另行 patch unschedulable=false。务必先 dryRun=true 看驱逐清单（wouldEvict/blocked），确认影响后再执行；namespaces 可收窄到指定命名空间。gracePeriodSeconds 缺省由 API 决定；timeoutSeconds（缺省 60）为等待 Pod 消失的总预算。',
      parameters: Type.Object({
        node: Type.String({ description: '节点名' }),
        dryRun: Type.Optional(Type.Boolean({ description: 'true = 只列驱逐清单，不 cordon 不驱逐' })),
        namespaces: Type.Optional(Type.Array(Type.String(), { description: '仅驱逐这些命名空间的 Pod；缺省全部命名空间' })),
        gracePeriodSeconds: Type.Optional(Type.Number({ description: '驱逐宽限期（秒），缺省由 API 决定' })),
        timeoutSeconds: Type.Optional(Type.Number({ minimum: 5, maximum: 600, description: '等待 Pod 消失的总预算（秒），缺省 60' })),
      }),
      /**
       * @param {string} _toolCallId
       * @param {{ node: string; dryRun?: boolean; namespaces?: string[]; gracePeriodSeconds?: number; timeoutSeconds?: number }} params
       * @param {AbortSignal | undefined} signal
       */
      async execute(_toolCallId, params, signal) {
        const timeoutSeconds = params.timeoutSeconds ?? 60
        const data = await safe(async () => {
          // 确认节点存在（顺带留个 cordoned 前的状态快照），不存在直接抛错
          await get(cluster(), `/api/v1/nodes/${encodeURIComponent(params.node)}`, signal)
          const { items } = /** @type {{ items: K8sPod[] }} */ (
            await list(cluster(), '/api/v1/pods', { fieldSelector: `spec.nodeName=${params.node}` }, signal)
          )
          /** @type {K8sPod[]} */ const skippedDs = []
          /** @type {K8sPod[]} */ const targets = []
          for (const p of items) {
            const phase = p.status?.phase
            if (phase === 'Succeeded' || phase === 'Failed') continue
            if ((p.metadata.ownerReferences ?? []).some((o) => o.kind === 'DaemonSet')) {
              skippedDs.push(p)
              continue
            }
            if (params.namespaces?.length && !params.namespaces.includes(p.metadata.namespace ?? '')) continue
            targets.push(p)
          }
          // 每 ns 拉一次 PDB（list 不支持跨 ns 按 selector 匹配 pod，只能在候选 PDB 里逐个 match）
          /** @type {Array<{ ns: string; name: string; selector: Record<string, string> | null; allowed: number }>} */
          const pdbs = []
          /** @param {K8sPod} p @returns {{ name: string; allowed: number } | null} */
          const blockingPdb = (p) => {
            const labels = /** @type {Record<string, string>} */ (
              /** @type {any} */ (p.metadata).labels ?? {}
            )
            for (const pdb of pdbs) {
              if (pdb.ns !== p.metadata.namespace) continue
              // selector null = 空选择器（labelSelector 为 '' 已过滤），不匹配任何 pod
              if (!pdb.selector) continue
              const hit = Object.entries(pdb.selector).every(([k, v]) => labels[k] === v)
              if (hit && pdb.allowed <= 0) return { name: pdb.name, allowed: pdb.allowed }
            }
            return null
          }
          const nsScope = params.namespaces?.length
            ? params.namespaces
            : [...new Set(targets.flatMap((p) => (p.metadata.namespace ? [p.metadata.namespace] : [])))]
          await Promise.all(
            nsScope.map(async (ns) => {
              try {
                const r = /** @type {{ items: Array<{ metadata: { name: string; namespace?: string }; spec?: { selector?: { matchLabels?: Record<string, string> } }; status?: { disruptionsAllowed?: number } }> }} */ (
                  await list(cluster(), `/apis/policy/v1/namespaces/${encodeURIComponent(ns)}/poddisruptionbudgets`, {}, signal)
                )
                for (const b of r.items) {
                  pdbs.push({
                    ns: b.metadata.namespace ?? ns,
                    name: b.metadata.name,
                    selector: b.spec?.selector?.matchLabels ?? null,
                    allowed: b.status?.disruptionsAllowed ?? 0,
                  })
                }
              } catch {
                // policy/v1 不可用（极老集群）：视为无 PDB，Eviction API 429 仍会兜底拦截
              }
            }),
          )

          if (params.dryRun) {
            /** @type {Array<{ pod: string; pdb: string; reason: string }>} */ const blocked = []
            /** @type {Array<{ pod: string; namespace: string }>} */ const wouldEvict = []
            for (const p of targets) {
              const pod = `${p.metadata.namespace}/${p.metadata.name}`
              const b = blockingPdb(p)
              if (b) blocked.push({ pod, pdb: `${p.metadata.namespace}/${b.name}`, reason: `disruptionsAllowed=${b.allowed}` })
              else wouldEvict.push({ pod, namespace: p.metadata.namespace ?? '' })
            }
            return {
              dryRun: true,
              wouldCordon: true,
              node: params.node,
              wouldEvict,
              blocked,
              skippedDs: skippedDs.map((p) => `${p.metadata.namespace}/${p.metadata.name}`),
              note: 'dryRun：未 cordon 未驱逐。PDB 尊重是默认行为：blocked 中的 Pod 驱逐会被拒。执行时节点会先被 cordon 且不自动 uncordon（kubectl drain 语义），恢复调度需 patch unschedulable=false。',
            }
          }

          // cordon：merge patch（Node 无 strategic 语义差异，unschedulable 是标量）
          const { status: cordonStatus, body: cordonBody } = await request(cluster(), 'PATCH', `/api/v1/nodes/${encodeURIComponent(params.node)}`, {
            body: { spec: { unschedulable: true } },
            contentType: 'application/merge-patch+json',
            signal,
          })
          if (cordonStatus >= 300) {
            const b = cordonBody && typeof cordonBody === 'object' ? /** @type {{ message?: string }} */ (cordonBody) : {}
            throw new Error(typeof b.message === 'string' ? b.message : `cordon 失败（HTTP ${cordonStatus}）`)
          }

          /** @type {string[]} */ const evicted = []
          /** @type {Array<{ pod: string; pdb?: string; reason: string }>} */ const blocked = []
          /** @type {Array<{ pod: string; reason: string }>} */ const failed = []
          for (const p of targets) {
            const pod = `${p.metadata.namespace}/${p.metadata.name}`
            const b = blockingPdb(p)
            if (b) {
              blocked.push({ pod, pdb: `${p.metadata.namespace}/${b.name}`, reason: `disruptionsAllowed=${b.allowed}` })
              continue
            }
            // 宽限期走 Eviction.deleteOptions（k8s Eviction 契约），不是 query
            const { status, body } = await request(
              cluster(),
              'POST',
              `/apis/policy/v1/namespaces/${encodeURIComponent(p.metadata.namespace ?? 'default')}/pods/${encodeURIComponent(p.metadata.name)}/eviction`,
              {
                body: {
                  apiVersion: 'policy/v1',
                  kind: 'Eviction',
                  metadata: { name: p.metadata.name, namespace: p.metadata.namespace },
                  ...(params.gracePeriodSeconds != null
                    ? { deleteOptions: { gracePeriodSeconds: params.gracePeriodSeconds } }
                    : {}),
                },
                signal,
              },
            )
            if (status < 300) evicted.push(pod)
            else if (status === 429) {
              const msg = body && typeof body === 'object' ? /** @type {{ message?: string }} */ (body).message : undefined
              blocked.push({ pod, reason: typeof msg === 'string' ? msg.slice(0, 200) : 'Eviction API 拒绝（PDB 预算不足）' })
            } else if (status === 404) evicted.push(pod) // 已消失算成功
            else {
              const msg = body && typeof body === 'object' ? /** @type {{ message?: string }} */ (body).message : undefined
              failed.push({ pod, reason: typeof msg === 'string' ? msg.slice(0, 200) : `HTTP ${status}` })
            }
          }

          // 等 evicted 消失：轮询 get 404，总预算 timeoutSeconds 均摊到每 500ms 一轮
          const deadline = Date.now() + timeoutSeconds * 1000
          /** @type {string[]} */ let remaining = [...evicted]
          while (remaining.length > 0 && Date.now() < deadline) {
            const checked = await Promise.all(
              remaining.map(async (pod) => {
                const [ns, n] = pod.split('/')
                if (!ns || !n) return true
                try {
                  await get(cluster(), `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(n)}`, signal)
                  return false // 仍存在
                } catch (e) {
                  // 仅 404 算已消失：403/5xx/网络超时是探测失败，不能虚报驱逐成功
                  return e instanceof BackendError && e.status === 404
                }
              }),
            )
            remaining = remaining.filter((_, i) => !checked[i])
            if (remaining.length > 0 && Date.now() < deadline) {
              // sleep 不超预算剩余（timeoutSeconds 均摊到 500ms 轮询间隔）
              await new Promise((r) => setTimeout(r, Math.min(500, Math.max(50, deadline - Date.now()))))
            }
          }
          return {
            cordoned: true,
            node: params.node,
            evicted,
            blocked,
            skippedDs: skippedDs.map((p) => `${p.metadata.namespace}/${p.metadata.name}`),
            failed,
            remaining,
            timedOut: remaining.length > 0,
            uncordoned: false,
            note:
              remaining.length > 0
                ? `超时（${timeoutSeconds}s）仍有 ${remaining.length} 个 Pod 未消失，可稍后用 node_view 复查`
                : '节点已 cordon 且不会自动 uncordon（kubectl drain 语义）；恢复调度用 patch_resource Node spec.unschedulable=false',
          }
        })
        return result(data)
      },
    },
  }
}
