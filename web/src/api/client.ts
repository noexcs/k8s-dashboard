// headlamp-server API 客户端：一律 /clusters/:name/... 代理路径，不直连 API server
// 所有请求同源：生产由 headlamp-server 托管；开发由 vite proxy 转发到 :4467

import { stringify as yamlStringify } from 'yaml'
import { RESOURCE_MAP } from '@/resources/registry'
import { t, tf } from '@/i18n'
import type { ConfigResponse, K8sObject, ListResult, WatchEvent } from './types'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message)
  }
  get isConflict() {
    return this.status === 409
  }
  get isGone() {
    return this.status === 410
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let body: unknown
  let message = tf('sys:httpStatus', { n: res.status })
  try {
    const text = await res.text()
    const parsed: unknown = JSON.parse(text)
    body = parsed
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      message = String(parsed.message)
    } else {
      message = text.slice(0, 200) || message
    }
  } catch {
    /* keep default */
  }
  return new ApiError(res.status, message, body)
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as T
}

export function getConfig(): Promise<ConfigResponse> {
  return fetch('/config', { headers: { Accept: 'application/json' } }).then(r => json<ConfigResponse>(r))
}

/** 列出资源。`params` 原样拼 query；managedFields 已剥离。`signal` 中止在途请求（卸载/切集群）。 */
export async function list<T extends K8sObject>(
  cluster: string,
  path: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<ListResult<T>> {
  const qs = new URLSearchParams(params)
  const url = `/clusters/${encodeURIComponent(cluster)}${path}${qs.size ? `?${qs}` : ''}`
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal })
  const data = await json<ListResult<T>>(res)
  for (const item of data.items) stripManagedFields(item)
  return data
}

export async function get<T extends K8sObject>(
  cluster: string,
  path: string,
  opts?: { keepManagedFields?: boolean },
): Promise<T> {
  const res = await fetch(`/clusters/${encodeURIComponent(cluster)}${path}`, {
    headers: { Accept: 'application/json' },
  })
  const data = await json<T>(res)
  // 默认剥离（大列表/编辑器负载）；变更追溯卡显式保留——managedFields 是唯一通用修改人/时间源
  if (!opts?.keepManagedFields) stripManagedFields(data)
  return data
}

export async function getAsYaml(cluster: string, path: string): Promise<string> {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`/clusters/${encodeURIComponent(cluster)}${path}${sep}showManagedFields=false`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw await parseError(res)
  const data = (await res.json()) as K8sObject
  // 实测 k3s 忽略 showManagedFields（JSON/YAML 都返回），客户端统一剥离
  stripManagedFields(data)
  return yamlStringify(data)
}

function stripManagedFields(obj: K8sObject): void {
  if (obj.metadata?.managedFields !== undefined) delete obj.metadata.managedFields
}

/**
 * watch 流。逐帧回调；返回的 Promise 在连接关闭时 resolve。
 * 410 Gone 会抛出 ApiError(410)，调用方应回退到全量 list。
 * 通过 AbortSignal 取消。
 */
export async function watchStream<T extends K8sObject>(
  cluster: string,
  path: string,
  params: Record<string, string>,
  onEvent: (ev: WatchEvent<T>) => void,
  signal: AbortSignal,
): Promise<void> {
  const qs = new URLSearchParams({ watch: '1', ...params })
  const res = await fetch(`/clusters/${encodeURIComponent(cluster)}${path}?${qs}`, {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!res.ok) throw await parseError(res)
  if (!res.body) throw new Error(t('sys:watchNoBody'))

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      // parse 与回调分离：空 catch 只兜脏帧（半行），onEvent 的业务抛出必须逃逸
      // ——useWatch 靠它把流内 ERROR 帧送进统一重连（R2 N1：混在一个 try 里
      // ERROR 帧的 ApiError 会被当脏帧吞掉，RV 过期修复整体失效）
      let ev: WatchEvent<T>
      try {
        ev = JSON.parse(line) as WatchEvent<T>
      } catch {
        continue
      }
      onEvent(ev)
    }
  }
}

/** 首 chunk 超时默认值：对齐 tailnet 拨号实测最坏 5–65s，留到 90s。 */
const LOGS_CONNECT_TIMEOUT_MS = 90_000

/**
 * 日志（follow=true 时长流，onChunk 接收文本块）。
 * 首 chunk 超时：首个分块到达前（代理拨号集群可能挂死，页面会永久无反馈），
 * connectTimeoutMs（默认 90s）到点中止并 reject；首 chunk 一到即撤除定时器——
 * follow 模式长时间无输出是正常现象，之后不得再超时。
 */
export async function streamLogs(
  cluster: string,
  namespace: string,
  pod: string,
  opts: { container?: string; tailLines?: number; follow?: boolean; previous?: boolean; timestamps?: boolean; connectTimeoutMs?: number },
  onChunk: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const qs = new URLSearchParams()
  if (opts.container) qs.set('container', opts.container)
  if (opts.tailLines) qs.set('tailLines', String(opts.tailLines))
  if (opts.follow) qs.set('follow', 'true')
  // previous = 上一次崩溃容器实例的日志（CrashLoopBackOff 取证）；follow 与之互斥，API 会 400
  if (opts.previous) qs.set('previous', 'true')
  // timestamps = 每行前置 RFC3339 时间戳（由 containerd 落盘时间生成）
  if (opts.timestamps) qs.set('timestamps', 'true')
  const path = `/api/v1/namespaces/${namespace}/pods/${pod}/log?${qs}`
  const timeoutMs = opts.connectTimeoutMs ?? LOGS_CONNECT_TIMEOUT_MS

  // 嵌套 controller 中止 fetch：不能直接 abort 调用方的 signal（它可能还用于调用方的其他逻辑）
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) ctrl.abort() // 进来时已取消 → 立即拒绝，与旧行为一致
  let timedOut = false
  const connectTimer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)

  try {
    const res = await fetch(`/clusters/${encodeURIComponent(cluster)}${path}`, { signal: ctrl.signal })
    if (!res.ok) throw await parseError(res)
    if (!res.body) throw new Error(t('sys:logsNoBody'))

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let first = true
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (first) {
        first = false
        clearTimeout(connectTimer) // 首 chunk 到达 → 超时使命完成
      }
      onChunk(decoder.decode(value, { stream: true }))
    }
  } catch (err) {
    // 区分「用户取消」（原样抛 AbortError）与「首 chunk 超时」（给可读错误）
    if (timedOut && !signal.aborted) {
      throw new Error(tf('sys:logsConnectTimeout', { n: Math.round(timeoutMs / 1000) }))
    }
    throw err
  } finally {
    clearTimeout(connectTimer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** PUT 更新（带 resourceVersion 乐观锁）。409 抛 ApiError.isConflict。 */
export async function putObject<T extends K8sObject>(cluster: string, path: string, obj: T, note?: string): Promise<T> {
  const res = await fetch(`/clusters/${encodeURIComponent(cluster)}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(obj),
  })
  if (!res.ok) throw await parseError(res)
  reportWrite(cluster, 'put', path, withNote(note, payloadSummary(obj)))
  return json<T>(res)
}

/** POST 创建（YAML/JSON 对象 → collection 路径）。非 2xx 抛 ApiError。 */
export async function postObject<T extends K8sObject>(cluster: string, path: string, obj: T, note?: string): Promise<T> {
  const res = await fetch(`/clusters/${encodeURIComponent(cluster)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(obj),
  })
  if (!res.ok) throw await parseError(res)
  reportWrite(cluster, 'create', path, withNote(note, payloadSummary(obj)))
  return json<T>(res)
}

// ---------- metrics-server（实时用量；v1 优先、失败回退 v1beta1——k3s 只暴露 v1beta1） ----------

/** metrics 对象共有的 usage 字段 */
export interface MetricsUsage {
  usage?: Record<string, string>
  containers?: Array<{ name: string; usage?: Record<string, string> }>
}

/** metrics-server 集合查询：nodes 或 pods（pods 可限定 ns）。metrics-server 缺失时 reject（调用方降级）。 */
export function listMetrics<T extends K8sObject & MetricsUsage>(
  cluster: string,
  resource: 'nodes' | 'pods',
  ns?: string,
  signal?: AbortSignal,
): Promise<ListResult<T>> {
  const mid = resource === 'pods' && ns ? `namespaces/${encodeURIComponent(ns)}/` : ''
  const attempt = (v: string) => list<T>(cluster, `/apis/metrics.k8s.io/${v}/${mid}${resource}`, {}, signal)
  return attempt('v1').catch(err => (err instanceof ApiError && err.status === 404 ? attempt('v1beta1') : Promise.reject(err)))
}

/** metrics-server 单对象（Pod/Node 实时用量详情）。404（无 metrics-server 或对象无数据）reject。 */
export function getMetrics<T extends K8sObject & MetricsUsage>(
  cluster: string,
  resource: 'nodes' | 'pods',
  name: string,
  ns?: string,
): Promise<T> {
  const mid = resource === 'pods' && ns ? `namespaces/${encodeURIComponent(ns)}/` : ''
  const attempt = (v: string) => get<T>(cluster, `/apis/metrics.k8s.io/${v}/${mid}${resource}/${encodeURIComponent(name)}`)
  return attempt('v1').catch(err => (err instanceof ApiError && err.status === 404 ? attempt('v1beta1') : Promise.reject(err)))
}

/** DELETE 删除。404 抛 ApiError。 */
export async function deleteObject(cluster: string, path: string, note?: string): Promise<void> {
  const res = await fetch(`/clusters/${encodeURIComponent(cluster)}${path}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw await parseError(res)
  reportWrite(cluster, 'delete', path, withNote(note))
}

/** 战略合并 PATCH（cordon 等局部字段更新用；返回更新后的对象）。 */
export async function patchObject<T extends K8sObject>(cluster: string, path: string, patch: unknown, note?: string): Promise<T> {
  const res = await fetch(`/clusters/${encodeURIComponent(cluster)}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/strategic-merge-patch+json', Accept: 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw await parseError(res)
  reportWrite(cluster, path.endsWith('/scale') ? 'scale' : 'patch', path, withNote(note, payloadSummary(patch)))
  return json<T>(res)
}

/** Pod 驱逐（Eviction API，尊重 PDB）；服务端不支持 eviction 时调用方可回退 deleteObject。 */
export async function evictPod(cluster: string, ns: string, name: string, gracePeriodSeconds = 30, note?: string): Promise<void> {
  const path = podsPath(ns) + `/${encodeURIComponent(name)}/eviction`
  const res = await fetch(`/clusters/${encodeURIComponent(cluster)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      apiVersion: 'policy/v1',
      kind: 'Eviction',
      metadata: { name, namespace: ns },
      deleteOptions: { gracePeriodSeconds },
    }),
  })
  // 404/405：老集群只有 policy/v1beta1 或不支持 eviction → 明确抛出供调用方回退
  if (!res.ok) throw await parseError(res)
  reportWrite(cluster, 'evict', path, withNote(note))
}

/**
 * 无 k8s 路径可解析的写入口（Helm 等）走同一本账：verb/target/actor 口径与 reportWrite 一致。
 * 审计页自我声明是「UI 与 AI 写操作的合流留痕」，helm uninstall 不能在账上是空白。
 */
export function auditExtra(cluster: string, verb: string, target: string, summary?: string, kind?: string): void {
  const actor = localStorage.getItem('k8s-oncall')
  void fetch('/ai/audit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cluster, verb, target: target.slice(0, 120), summary: summary?.slice(0, 400), kind, ...(actor ? { actor } : {}) }),
  }).catch(() => {})
}

/** 人工意图注释并入泛型写审计：单条账同时回答「为什么改」（note）与「改了什么」（载荷） */
function withNote(note: string | undefined, payload?: string): string | undefined {
  const both = [note, payload].filter(Boolean).join('｜')
  // 400 硬切补省略号：读到中途要能看出被截（质量审计18#8）
  return both ? (both.length > 400 ? `${both.slice(0, 399)}…` : both) : undefined
}

/**
 * 写操作审计上报（变更留痕，与 AI 工具留痕同汇 /ai/audit）：fire-and-forget，
 * 失败静默——审计是旁路，绝不能反噬业务请求。path 折算 ns/resource/name。
 */

/** 变更载荷摘要：spec/data（YAML 保存、scale 副本数、patch 内容）——审计「改了什么」的内容半边 */
function payloadSummary(obj: unknown): string | undefined {
  try {
    const o = obj as Record<string, unknown>
    const core = {
      ...(o.spec !== undefined ? { spec: o.spec } : {}),
      ...(o.data !== undefined ? { data: o.data } : {}),
      ...(o.stringData !== undefined ? { stringData: o.stringData } : {}),
      ...(o.replicas !== undefined ? { replicas: o.replicas } : {}),
    }
    const str = JSON.stringify(core)
    return str === '{}' ? undefined : str.slice(0, 400)
  } catch {
    return undefined
  }
}

function reportWrite(cluster: string, verb: string, rawPath: string, summary?: string): void {
  const seg = rawPath.split('?')[0].split('/').filter(Boolean)
  // 位置解析（无歧义）：resource 段固定在 api→2 / apis→3；namespaced 对象名固定在 namespaces+3。
  // 旧版按 PATH_WORDS 猜末段会误吞名为 log/status 的对象、把集合 POST 的 resource 当 name
  const resourceIdx = seg[0] === 'apis' ? 3 : 2
  const nsIdx = seg.indexOf('namespaces')
  // namespaces 自身是资源：路径止于 namespaces[/name] 时不是「某 ns 下的对象」
  const isNsSelf = nsIdx >= 0 && seg.length <= nsIdx + 2
  const isNamespaced = nsIdx >= 0 && !isNsSelf
  const ns = isNamespaced && seg[nsIdx + 1] ? decodeURIComponent(seg[nsIdx + 1]) : ''
  const resource = isNsSelf
    ? 'namespaces'
    : decodeURIComponent(seg[isNamespaced ? nsIdx + 2 : resourceIdx] ?? '')
  const nameSeg = isNamespaced ? seg[nsIdx + 3] : (isNsSelf ? seg[nsIdx + 1] : seg[resourceIdx + 1])
  const name = nameSeg ? decodeURIComponent(nameSeg) : ''
  const target = [ns || undefined, resource || undefined, name || undefined].filter(Boolean).join('/')
  // Secret 载荷（data 为 base64、stringData 为明文）一律不落审计盘——名字可查，值不可存
  // Secret 写不记内容，但固定意图（「UI 删除 Secret」这类 note，值在被截掉的 payload 半边）
  // 仍可安全入账——整体丢弃会让审计页对 Secret 操作只剩 verb（质量审计18#8）。
  const safeSummary = /\/secrets(\/|$)/.test(rawPath)
    ? (summary?.includes('｜') ? summary.split('｜')[0] : undefined)
    : summary
  void fetch('/ai/audit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cluster,
      verb,
      target,
      summary: safeSummary,
      ns: ns || undefined,
      name: name || undefined,
      kind: kindOf(resource),
      // 值班名（设置页一次性填写）：多人轮值时「谁改的」必须答得出（审计 actor）
      ...(localStorage.getItem('k8s-oncall') ? { actor: localStorage.getItem('k8s-oncall') } : {}),
    }),
  }).catch(() => {})
}

/** plural resource → Kind（审计跳详情要用 def；RESOURCE_MAP 值上带 resource 字段，惰性反查） */
let KIND_BY_RESOURCE: Record<string, string> | null = null
function kindOf(resource: string): string | undefined {
  if (!resource) return undefined
  KIND_BY_RESOURCE ??= Object.fromEntries(
    Object.entries(RESOURCE_MAP)
      .filter(([, def]) => typeof (def as { resource?: string }).resource === 'string')
      .map(([kind, def]) => [(def as { resource: string }).resource, kind]),
  )
  return KIND_BY_RESOURCE[resource]
}

/**
 * RBAC 自检（SSAR 走集群代理；core 与 group 资源同一端点 `/apis/authorization.k8s.io/v1/...`，
 * `/api/` 前缀实测 404）。namespace 可选：namespaced 资源带真实 ns，cluster-scoped 省略。
 */
export async function canI(
  cluster: string,
  verb: string,
  group: string,
  version: string,
  resource: string,
  namespace?: string,
): Promise<boolean> {
  const res = await fetch(`/clusters/${encodeURIComponent(cluster)}/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectAccessReview',
      spec: {
        resourceAttributes: {
          verb,
          ...(group ? { group } : {}),
          version,
          resource,
          ...(namespace ? { namespace } : {}),
        },
      },
    }),
  })
  const data = await json<{ status: { allowed: boolean } }>(res)
  return data.status.allowed
}

// ---------- 动态集群（headlamp --enable-dynamic-clusters） ----------
// 后端把 kubeconfig 持久化进 headlamp 自己的 kubeconfig 文件（非挂载的只读源），
// 之后 /clusters/:name/* 代理与内置集群完全同路径，前端 API 层零特判。

/** 粘贴的 kubeconfig 文本 → base64 → POST /cluster；后端导入其中全部 context，返回新 config */
export async function addCluster(kubeconfigText: string): Promise<void> {
  const b64 = btoa(unescape(encodeURIComponent(kubeconfigText)))
  const res = await fetch('/cluster', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kubeconfig: b64 }),
  })
  if (!res.ok) throw new Error((await res.text()).trim().slice(0, 200) || `HTTP ${res.status}`)
}

/** 删除动态集群（仅 headlamp 持久文件里的 context 可删；内置 kubeconfig 集群由后端拒绝）。
 *  removeKubeConfig=true：连 headlamp 持久 kubeconfig 一起清，避免重启后复活。 */
export async function deleteCluster(name: string): Promise<void> {
  const res = await fetch(`/cluster/${encodeURIComponent(name)}?removeKubeConfig=true`, { method: 'DELETE' })
  if (!res.ok) throw new Error((await res.text()).trim().slice(0, 200) || `HTTP ${res.status}`)
}

export const podsPath = (ns: string) => `/api/v1/namespaces/${ns}/pods`
export const eventsPath = (ns: string) => `/api/v1/namespaces/${ns}/events`
export const namespacesPath = '/api/v1/namespaces'

export type { WatchEvent }
