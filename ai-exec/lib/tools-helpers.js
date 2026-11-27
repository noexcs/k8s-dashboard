// @ts-check
/**
 * tools 域共享层（自 tools.js 拆出）：常量、discovery 缓存（模块级单例，跨域共享——
 * 迁移时勿改成每域各自 new Map，那会让 24 个工具各自打一遍 discovery）、
 * 结果包装/截断/数量格式化/yaml 工具等纯函数。
 */
import { stringify as yamlStringify } from 'yaml'
import { list, get, request, BackendError } from './k8s.js'

/** 工具统一出口：结果同时给模型（JSON 文本）与 UI（details 结构化） */
/** @template T @param {T} value @returns {{ content: Array<{ type: 'text'; text: string }>, details: T }} */
export const result = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  details: value,
})


/** 列表工具统一上限（照搬 MAX_ITEMS，limit 参数缺省时生效） */
export const MAX_ITEMS = 20
/** limit 参数钳制上限（服务端单页硬上限，防一次拉爆上下文） */
export const LIST_LIMIT_MAX = 200
/** 单对象 JSON 序列化截断上限 */
export const OBJ_JSON_LIMIT = 20_000
/** exec 输出截断（尾取） */
export const EXEC_STDOUT_LIMIT = 8_000
export const EXEC_STDERR_LIMIT = 4_000

// ---------- K8s 最小类型（只声明本文件用到的字段） ----------

/** @typedef {object} K8sMeta @property {string} name @property {string} [namespace] */
/** @typedef {object} K8sCondition @property {string} type @property {string} status @property {string} [reason] */

/** @typedef {object} Pod
 * @property {K8sMeta} metadata
 * @property {{ nodeName?: string }} [spec]
 * @property {{
 *   phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
 *   podIP?: string;
 *   startTime?: string;
 *   reason?: string;
 *   message?: string;
 *   containerStatuses?: Array<{
 *     name: string;
 *     image?: string;
 *     ready: boolean;
 *     restartCount?: number;
 *     state?: {
 *       running?: unknown;
 *       waiting?: { reason?: string };
 *       terminated?: { reason?: string; exitCode?: number };
 *     };
 *   }>;
 *   conditions?: K8sCondition[];
 * }} [status]
 */

/** @typedef {object} Node
 * @property {{ name: string }} metadata
 * @property {{ conditions?: K8sCondition[]; capacity?: Record<string, string>; allocatable?: Record<string, string> }} [status]
 */

/** @typedef {object} Deployment
 * @property {K8sMeta & { annotations?: Record<string, string> }} metadata
 * @property {{
 *   replicas?: number;
 *   selector?: { matchLabels?: Record<string, string> };
 *   template?: unknown;
 * }} [spec]
 * @property {{ readyReplicas?: number; availableReplicas?: number }} [status]
 */

/** @typedef {object} Event
 * @property {K8sMeta} [metadata]
 * @property {string} [type]
 * @property {string} [reason]
 * @property {string} [message]
 * @property {number} [count]
 * @property {string} [lastTimestamp]
 * @property {{ kind?: string; name?: string }} [involvedObject]
 */

/** @typedef {object} NodeMetric
 * @property {{ name: string }} metadata
 * @property {{ cpu?: string; memory?: string }} [usage]
 */

/** @typedef {object} HelmRelease
 * @property {string} name
 * @property {string} namespace
 * @property {number} [version]
 * @property {{ status?: string; last_deployed?: string }} [info]
 * @property {{ metadata?: { name?: string; version?: string; appVersion?: string } }} [chart]
 */

/** @typedef {object} ReplicaSet
 * @property {K8sMeta & { annotations?: Record<string, string>; ownerReferences?: Array<{ kind?: string; name?: string; controller?: boolean }> }} metadata
 * @property {{ replicas?: number; template?: { spec?: { containers?: Array<{ image?: string }> } } }} [spec]
 * @property {{ replicas?: number; readyReplicas?: number }} [status]
 */

/** @typedef {object} WorkloadStatus
 * @property {{ replicas?: number }} [spec]
 * @property {{
 *   readyReplicas?: number;
 *   updatedReplicas?: number;
 *   availableReplicas?: number;
 *   observedGeneration?: number;
 *   conditions?: Array<K8sCondition & { message?: string }>;
 * }} [status]
 */

/** @typedef {{ apiVersion?: string; kind?: string; metadata?: { name?: string; namespace?: string } }} YamlDoc */

/** @typedef {{ plural: string; namespaced: boolean }} ResourceInfo */

// ---------- 全权限工具公共 helper ----------

/**
 * API 发现缓存：`${cluster}|${apiVersion}|${kind}` → 复数名 + namespaced 标志。
 * namespaced 取发现 API 的权威标志（GET /api/v1 或 /apis/{group}/{version}），
 * 不硬编码 ClusterRole/CR 名单（CRD 也能正确判断）。
 * @type {Map<string, ResourceInfo>}
 */
export const discoveryCache = new Map()

/**
 * @param {string} cluster @param {string} apiVersion @param {string} kind
 * @param {AbortSignal | undefined} [signal]
 * @returns {Promise<ResourceInfo>}
 */
export async function resolveResource(cluster, apiVersion, kind, signal) {
  const key = `${cluster}|${apiVersion}|${kind}`
  const hit = discoveryCache.get(key)
  if (hit) return hit
  const isCore = !apiVersion.includes('/')
  const disc = /** @type {{ resources?: Array<{ name: string; kind: string; namespaced?: boolean }> }} */ (
    await get(cluster, isCore ? '/api/v1' : `/apis/${apiVersion}`, signal)
  )
  const res = (disc.resources ?? []).find((r) => r.kind === kind)
  if (!res) throw new Error(`discovery 未找到 kind=${kind}（apiVersion=${apiVersion}），请核对 apiVersion/kind 拼写`)
  const out = { plural: res.name, namespaced: res.namespaced !== false }
  discoveryCache.set(key, out)
  return out
}

/**
 * 拼资源路径：/apis/{group}/{version}[/namespaces/{ns}]/{plural}[/{name}]。
 * cluster-scoped 传 ns=null 即忽略命名空间段。
 * @param {string} apiVersion @param {string} plural @param {string | null} ns @param {string | undefined} [name]
 */
export function resourcePath(apiVersion, plural, ns, name) {
  const base = apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`
  const mid = ns ? `/namespaces/${encodeURIComponent(ns)}` : ''
  const suffix = name ? `/${encodeURIComponent(name)}` : ''
  return `${base}${mid}/${plural}${suffix}`
}

/**
 * 把 /namespaces/{ns} 插入 collection 路径的版本段之后
 * （k8s_get 用：仅当路径尚无命名空间段时；已含 /namespaces/ 的原样返回）。
 * @param {string} path @param {string} ns @returns {string}
 */
export function insertNs(path, ns) {
  const m = /^((?:\/api\/v1)|(?:\/apis\/[^/]+\/[^/]+))\/(.+)$/.exec(path)
  return m ? `${m[1]}/namespaces/${encodeURIComponent(ns)}/${m[2]}` : path
}

/**
 * Deployment / ReplicaSet 的修订号（annotation deployment.kubernetes.io/revision；
 * 缺失或非法记 0，即「不参与修订序列」）。
 * @param {{ metadata?: { annotations?: Record<string, string> } }} obj @returns {number}
 */
export function revisionOf(obj) {
  const v = obj.metadata?.annotations?.['deployment.kubernetes.io/revision']
  return v ? Number.parseInt(v, 10) || 0 : 0
}

/**
 * 回滚时不该写回 Pod 模板的 controller / kubectl 注入注解：
 * pod-template-hash 由 Deployment controller 按新模板重算，last-applied-configuration
 * 是 kubectl 客户端快照，都不该随旧模板传播。
 */
export const ROLLBACK_TEMPLATE_ANNOTATIONS = [
  'deployment.kubernetes.io/pod-template-hash',
  'kubectl.kubernetes.io/pod-template-hash',
  'deployment.kubernetes.io/revision',
  'deployment.kubernetes.io/revision-history-limit',
  'kubectl.kubernetes.io/last-applied-configuration',
]

/**
 * 旧 ReplicaSet 的 Pod 模板 → 可写回 Deployment spec.template 的形态。
 * 黑名单注解统一写 null：strategic merge 的 map 是按键合并，只「不写」删不掉
 * 当前模板上已存在的同名键。模板 label（含 pod-template-hash）原样保留——
 * Deployment spec.selector 不可变，hash 由 controller 重算，客户端不该去动它。
 * @param {unknown} template @returns {Record<string, unknown>}
 */
export function rollbackTemplate(template) {
  const t = /** @type {Record<string, unknown>} */ (template && typeof template === 'object' ? template : {})
  const meta = /** @type {Record<string, unknown>} */ (t.metadata && typeof t.metadata === 'object' ? t.metadata : {})
  const ann = /** @type {Record<string, string>} */ (meta.annotations && typeof meta.annotations === 'object' ? meta.annotations : {})
  // PUT 整份替换下 null 不删键——黑名单键直接不出现在结果里（FL20#4）
  const annotations = {}
  for (const [k, v] of Object.entries(ann)) {
    if (!ROLLBACK_TEMPLATE_ANNOTATIONS.includes(k)) annotations[k] = v
  }
  return { ...t, metadata: { ...meta, annotations } }
}

/**
 * Pod 模板里的容器镜像（history / undo 摘要，便于模型确认「回到的是哪个版本」）。
 * @param {unknown} template @returns {string[]}
 */
export function templateImages(template) {
  const t = /** @type {{ spec?: { containers?: Array<{ image?: string }> } } | null} */ (
    template && typeof template === 'object' ? /** @type {object} */ (template) : null
  )
  const images = (t?.spec?.containers ?? []).map((c) => c.image).filter((v) => typeof v === 'string')
  return [...new Set(images)]
}

/**
 * Pod 模板 → 容器摘要（name/image/ports/resources）：列表瘦身时替代整份模板。
 * @param {unknown} template @returns {unknown[]}
 */
export function templateContainers(template) {
  const spec = asRecord(asRecord(template)?.spec)
  const containers = Array.isArray(spec?.containers) ? /** @type {unknown[]} */ (spec.containers) : []
  /** @type {unknown[]} */
  const out = []
  for (const c of containers) {
    const r = asRecord(c)
    if (!r) continue
    out.push({
      name: r.name,
      image: r.image,
      ...(r.ports !== undefined ? { ports: r.ports } : {}),
      ...(r.resources !== undefined ? { resources: r.resources } : {}),
    })
  }
  return out
}

/**
 * spec.selector.matchLabels → labelSelector 串（list ReplicaSet 时收窄范围）；
 * 空/缺失返回空串（不筛）。
 * @param {Record<string, string> | undefined} labels @returns {string}
 */
export function matchLabelsToSelector(labels) {
  return Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`).join(',')
}

/**
 * 某 Deployment 名下的 ReplicaSet 集合（history / undo 共用的修订候选）。
 * labelSelector 只是少拉数据的优化；权威过滤仍按 ownerReferences——RS 的 owner 是
 * Deployment，同 ns 里别的 Deployment 或孤儿 RS 可能命中同一组 label。
 * @param {string} cluster @param {string} ns @param {string} deploymentName
 * @param {string} [labelSelector] @param {AbortSignal | undefined} [signal]
 * @returns {Promise<ReplicaSet[]>}
 */
export async function listOwnedReplicaSets(cluster, ns, deploymentName, labelSelector, signal) {
  const { items } = /** @type {{ items: ReplicaSet[] }} */ (
    await list(
      cluster,
      `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/replicasets`,
      labelSelector ? { labelSelector } : {},
      signal,
    )
  )
  return items.filter((rs) =>
    (rs.metadata.ownerReferences ?? []).some((o) => o.kind === 'Deployment' && o.name === deploymentName),
  )
}

/**
 * 大值截断：JSON 序列化长度 > limit → { truncated, data: 截断文本 }。
 * @template T @param {T} v @param {number} [limit] @returns {T | { truncated: true; data: string }}
 */
export function cap(v, limit = OBJ_JSON_LIMIT) {
  const s = JSON.stringify(v) ?? 'null'
  if (s.length <= limit) return v
  return { truncated: true, data: `${s.slice(0, limit)}…(已截断)` }
}

// ---------- 泛型读取瘦身（k8s_get / k8s_request GET） ----------

/** 列表返回的字节预算：slim 后仍超就按条数收（比从中间切断 JSON 有用得多） */
export const LIST_JSON_LIMIT = 12_000
/** 单条 data/string 值超过这个长度就折成占位（ConfigMap CA、TLS 证书这类） */
const SLIM_VALUE_LIMIT = 200

/**
 * 列表项瘦身：只删「确定性噪声」，语义字段一律保留（CR 的 spec 不猜语义，原样带）。
 * 实测依据：一次 k8s_request GET 集群 Deployment 列表返回 39607B、命名空间 21252B、
 * 单个 ConfigMap 1116B——八成字节是 spec.template、uid/resourceVersion、
 * configmaps 的证书正文和 Node 的 status.images，而判断「在不在跑/几个副本/什么镜像」
 * 用不到它们。省略的部分没有丢：单资源查询或 full=true 能拿回原始对象。
 * @param {unknown} item @returns {unknown}
 */
export function slimItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item
  const o = /** @type {Record<string, unknown>} */ (item)
  /** @type {Record<string, unknown>} */ const out = { ...o }
  const meta = asRecord(o.metadata)
  if (meta) {
    const { uid: _uid, managedFields: _mf, selfLink: _sl, ownerReferences, creationTimestamp, ...restMeta } = meta
    /** @type {Record<string, unknown>} */ const m = { ...restMeta }
    if (creationTimestamp != null) m.created = creationTimestamp
    const owners = Array.isArray(ownerReferences) ? ownerReferences : undefined
    if (owners?.length) m.owners = owners.map((r) => `${asRecord(r)?.kind ?? '?'}/${asRecord(r)?.name ?? '?'}`)
    out.metadata = m
  }
  const spec = asRecord(o.spec)
  if (spec) {
    /** @type {Record<string, unknown>} */ const s = { ...spec }
    if (s.template !== undefined) {
      // Pod 模板是列表响应里最大的一块，但容器名/镜像/资源是模型真正要看的部分：
      // 只留这三样（实测整模板留全量时模型会转而要 full=true，反而更贵）
      s.template = { containers: templateContainers(spec.template) }
      out.images = templateImages(spec.template)
    }
    if (Array.isArray(s.containers)) s.containers = s.containers.map(slimItem)
    out.spec = s
  }
  const status = asRecord(o.status)
  if (status) {
    /** @type {Record<string, unknown>} */ const st = { ...status }
    // Node 的 status.images 是每个节点几 KB 的镜像清单，与运维判断无关
    if (st.images !== undefined) st.images = '(已省略镜像清单)'
    if (Array.isArray(st.conditions)) {
      st.conditions = st.conditions.map((c) => {
        const r = asRecord(c)
        if (!r) return c
        const { lastHeartbeatTime: _hb, lastTransitionTime: _lt, ...rest } = r
        return rest
      })
    }
    if (Array.isArray(st.containerStatuses)) {
      st.containerStatuses = st.containerStatuses.map((c) => {
        const r = asRecord(c)
        if (!r) return c
        const state = asRecord(r.state)
        const waiting = asRecord(state?.waiting)
        const terminated = asRecord(state?.terminated)
        const running = asRecord(state?.running)
        return {
          name: r.name,
          ready: r.ready,
          restarts: r.restartCount,
          state: waiting ? `waiting:${waiting.reason ?? ''}` : terminated ? `terminated:${terminated.reason ?? terminated.exitCode}` : running ? 'running' : 'unknown',
        }
      })
    }
    out.status = st
  }
  // ConfigMap/Secret 的 data：键名保留（够用来回答「有哪些」），长值折叠
  const data = asRecord(o.data)
  if (data) {
    /** @type {Record<string, unknown>} */ const d = {}
    for (const [k, v] of Object.entries(data)) {
      d[k] = typeof v === 'string' && v.length > SLIM_VALUE_LIMIT ? `(${v.length} 字符，已省略)` : v
    }
    out.data = d
  }
  return out
}

/**
 * 单对象瘦身：写前必读的对象保留全部 spec（改字段要看现值），
 * 只去掉 kubectl 客户端快照和心跳时间戳这类纯噪声。
 * @param {unknown} obj @returns {unknown}
 */
export function slimObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
  const o = /** @type {Record<string, unknown>} */ (obj)
  /** @type {Record<string, unknown>} */ const out = { ...o }
  const meta = asRecord(o.metadata)
  if (meta) {
    const { managedFields: _mf, selfLink: _sl, ...restMeta } = meta
    const ann = asRecord(restMeta.annotations)
    if (ann) {
      const { 'kubectl.kubernetes.io/last-applied-configuration': _drop, ...restAnn } = ann
      restMeta.annotations = Object.keys(restAnn).length ? restAnn : undefined
      if (!Object.keys(restMeta.annotations ?? {}).length) delete restMeta.annotations
    }
    out.metadata = restMeta
  }
  const status = asRecord(o.status)
  if (status) {
    /** @type {Record<string, unknown>} */ const st = { ...status }
    if (st.images !== undefined) st.images = '(已省略镜像清单)'
    out.status = st
  }
  return out
}

/** @param {unknown} v @returns {Record<string, unknown> | undefined} */
function asRecord(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : undefined
}

/**
 * 列表预算控制：slim 后仍超预算时保留前 N 条 + note（中间截断的 JSON 对模型无用，
 * 实测一次 39607B 的 Deployment 列表被切成半截字符串，模型只能重查）。
 * @param {unknown[]} items @param {number} [limit]
 * @returns {{ items: unknown[]; note?: string }}
 */
export function capList(items, limit = LIST_JSON_LIMIT) {
  let keep = items
  /** @type {string | undefined} */ let note
  while (keep.length > 1 && JSON.stringify(keep).length > limit) keep = keep.slice(0, Math.ceil(keep.length / 2))
  if (JSON.stringify(keep).length > limit) keep = []
  if (keep.length < items.length) {
    note = `原始对象过大，仅返回前 ${keep.length}/${items.length} 条：用 ns/labelSelector/limit 收窄，或 full=true 取未瘦身原样`
  }
  return note ? { items: keep, note } : { items: keep }
}

/**
 * 按行 --- 切多文档 YAML（容错：开头 --- 文档标记、空段、纯注释段交给 parse 报错）。
 * @param {string} yamlText @returns {string[]}
 */
export function splitYamlDocs(yamlText) {
  /** @type {string[]} */ const docs = []
  /** @type {string[]} */ let cur = []
  for (const line of yamlText.split('\n')) {
    if (/^---\s*$/.test(line)) {
      const t = cur.join('\n').trim()
      if (t) docs.push(t)
      cur = []
    } else {
      cur.push(line)
    }
  }
  const t = cur.join('\n').trim()
  if (t) docs.push(t)
  return docs
}

/**
 * values 对象 → base64(YAML)。
 * Go helm handler 契约（release.go installRelease/upgradeRelease）：Values 字段是
 * base64 编码的 YAML 文本，解码后 yaml.Unmarshal 成 map。
 * @param {Record<string, unknown> | undefined} values @returns {string}
 */
export function helmValuesB64(values) {
  if (!values) return ''
  return Buffer.from(yamlStringify(values)).toString('base64')
}

/** @param {number} ms @param {AbortSignal | undefined} signal @returns {Promise<void>} */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve(undefined)
    }, { once: true })
  })
}

/**
 * helm 写操作触发后的终态确认：轮询 /action/status 到 processing 结束（≤6 轮 × 1.5s）。
 * 实测：只查一次会稳定拿到 processing（后端异步还没落库），模型因此连查 4 次
 * helm_releases 并去翻 helm secret 猜结果；而失败原因（如「repo bitnami not found」）
 * 就在同一响应的 message 里，之前被丢掉，模型只能自己猜。
 * @param {string} cluster @param {string} name
 * @param {'install' | 'upgrade' | 'uninstall' | 'rollback'} action
 * @param {AbortSignal | undefined} [signal]
 * @returns {Promise<{ status: string; message?: string }>}
 */
export async function helmActionStatus(cluster, name, action, signal) {
  /** @type {{ status: string; message?: string }} */
  let last = { status: 'processing' }
  for (let i = 0; i < 6; i++) {
    if (i > 0) await sleep(1500, signal)
    try {
      const { status, body } = await request(cluster, 'GET', '/helm/action/status', {
        params: { name, action },
        signal,
      })
      if ((status === 200 || status === 202) && body && typeof body === 'object') {
        const b = /** @type {{ status?: string; message?: string }} */ (body)
        if (typeof b.status === 'string') {
          last = { status: b.status, ...(b.message ? { message: String(b.message).slice(0, 300) } : {}) }
          if (last.status !== 'processing' && last.status !== 'pending') return last
        }
      }
    } catch {
      /* 刚触发时后端可能还没有该 action 记录，继续下一轮 */
    }
    if (signal?.aborted) break
  }
  return last
}

/**
 * helm 写操作响应规整：2xx → 触发成功 + 一次状态；非 2xx → 抛错（safe 捕获进 error 字段）。
 * @param {number} status @param {unknown} body
 * @returns {{ triggered: true }}
 */
export function helmTriggered(status, body) {
  if (status >= 300) {
    const b = body && typeof body === 'object' ? /** @type {{ message?: string }} */ (body) : {}
    throw new Error(typeof b.message === 'string' ? b.message : `helm 请求失败（HTTP ${status}）`)
  }
  return { triggered: true }
}

/** 出错不抛：返回 { error } 供模型如实转述（与 web 侧 safe 一致） */
/** @template T @param {() => Promise<T>} fn @returns {Promise<T | { error: string }>} */
export async function safe(fn) {
  try {
    return await fn()
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** K8s quantity → 数值（cpu 毫核归一为核，内存归一为字节） */
/** @type {Record<string, number>} */
export const QTY_MULT = {
  '': 1, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
}
/** @param {string | undefined} v @returns {number | null} */
export function parseQty(v) {
  if (!v) return null
  const m = /^([0-9]+(?:\.[0-9]+)?)([A-Za-z]*)$/.exec(v.trim())
  if (!m) return null
  const suffix = m[2]
  const mult = suffix === undefined ? undefined : QTY_MULT[suffix]
  return mult === undefined ? null : Number(m[1]) * mult
}

/**
 * 本集群 metricsserver 只暴露 v1beta1（k3s）；v1 优先，失败回退。
 * @param {string} cluster @param {AbortSignal | undefined} [signal]
 * @returns {Promise<NodeMetric[] | null>}
 */
export async function listNodeMetrics(cluster, signal) {
  try {
    const r = /** @type {{ items: NodeMetric[] }} */ (await list(cluster, '/apis/metrics.k8s.io/v1/nodes', {}, signal))
    return r.items
  } catch {
    try {
      const r = /** @type {{ items: NodeMetric[] }} */ (await list(cluster, '/apis/metrics.k8s.io/v1beta1/nodes', {}, signal))
      return r.items
    } catch {
      return null
    }
  }
}

/** @typedef {Omit<NodeMetric, 'metadata'> & { metadata: { name: string; namespace?: string }; containers?: Array<{ name?: string; usage?: { cpu?: string; memory?: string } }> }} PodMetric */

/**
 * Pod 实时用量（v1 优先、v1beta1 回退；缺失抛错由调用方转 error 字段）。
 * @param {string} cluster @param {string | undefined} ns @param {AbortSignal | undefined} [signal]
 * @returns {Promise<PodMetric[]>}
 */
export async function listPodMetrics(cluster, ns, signal) {
  const mid = ns ? `namespaces/${encodeURIComponent(ns)}/` : ''
  try {
    const r = /** @type {{ items: PodMetric[] }} */ (await list(cluster, `/apis/metrics.k8s.io/v1/${mid}pods`, {}, signal))
    return r.items
  } catch (e) {
    // 仅 API 版本未注册（404）回退 v1beta1；鉴权/网络错误原样抛（safe 兜底）
    if (!(e instanceof BackendError) || e.status !== 404) throw e
    const r = /** @type {{ items: PodMetric[] }} */ (await list(cluster, `/apis/metrics.k8s.io/v1beta1/${mid}pods`, {}, signal))
    return r.items
  }
}

/** 核数 → "86m" / "1.24"（<1 核用毫核，对齐 kubectl top 观感） */
/** @param {number | null} v @returns {string} */
export function fmtCpuQty(v) {
  if (v == null) return '-'
  return v < 1 ? `${Math.round(v * 1000)}m` : String(Math.round(v * 100) / 100)
}
/** 字节 → "123Mi" / "1.5Gi"（二进位） */
/** @param {number | null} v @returns {string} */
export function fmtMemQty(v) {
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

/** @param {Pod} p */
export function trimPod(p) {
  const cs = p.status?.containerStatuses ?? []
  return {
    name: p.metadata.name,
    namespace: p.metadata.namespace,
    phase: p.status?.phase,
    ready: `${cs.filter((c) => c.ready).length}/${cs.length}`,
    restarts: cs.reduce((n, c) => n + (c.restartCount ?? 0), 0),
    node: p.spec?.nodeName ?? null,
    started: p.status?.startTime ?? null,
  }
}

/**
 * list 类工具统一分页参数（limit + continueToken → k8s 原生 limit/continue query）。
 * limit 钳到 [1,200]，缺省 20 对齐旧 MAX_ITEMS；limit 直接传给服务端，
 * continue 游标从本页末尾精确续拉（本地切页会造成下一页跳段）。
 * @param {{ limit?: number; continueToken?: string }} params @returns {Record<string, string>}
 */
export function pageParams(params) {
  const max = Math.min(Math.max(Math.round(params.limit ?? MAX_ITEMS), 1), LIST_LIMIT_MAX)
  /** @type {Record<string, string>} */
  const q = { limit: String(max) }
  if (params.continueToken) q.continue = params.continueToken
  return q
}

/**
 * 分页结果规整：returned（本页实际条数，别叫 total——分页拿不到全量数）、
 * truncated（有 continue 即还有下一页）、continueToken（续拉凭据，末页为 null）。
 * @template T @param {{ items?: T[]; metadata?: unknown }} res
 * @returns {{ returned: number; truncated: boolean; continueToken: string | null; items: T[] }}
 */
export function pageResult(res) {
  const items = res.items ?? []
  const meta = /** @type {{ continue?: string } | undefined} */ (
    res.metadata && typeof res.metadata === 'object' ? /** @type {unknown} */ (res.metadata) : undefined
  )
  const token = typeof meta?.continue === 'string' && meta.continue ? meta.continue : null
  return { returned: items.length, truncated: token != null, continueToken: token, items }
}

/** Secret data 的 base64 解码（非法值保留原样并由调用方标记）。
 * @param {string} v @returns {string | null} null = 不是合法 base64 */
export function decodeB64(v) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(v) || v.length % 4 !== 0) return null
  const buf = Buffer.from(v, 'base64')
  // 严格往返：重新编码不一致说明原串含非法填充/字符
  if (buf.toString('base64') !== v) return null
  const s = buf.toString('utf8')
  // 二进制内容（含 \0 或非法 utf8 替换符）不冒充文本返回
  if (s.includes('\uFFFD') || s.includes('\0')) return null
  return s
}

/**
 * 构造 k8s 工具集（主文件 20 个 + nodes.js/insight.js 各模块，与前端 TOOL_META 名称一致）。
 * @param {{ value: string }} clusterRef 当前会话的集群名（可变引用，execute 时读取）
 */
