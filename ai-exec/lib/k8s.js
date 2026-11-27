// @ts-check
/**
 * headlamp-server 取数客户端：从 web/src/api/client.ts 与 web/src/api/helm.ts 移植。
 * 同源相对路径改为绝对地址（config.backendBase，默认容器内 127.0.0.1:4467）。
 * headlamp-server 是唯一 k8s 访问点：/clusters/:c/api… 透传 + /clusters/:c/helm/…（契约见 helm.ts 头注释）。
 */
import { config } from './config.js'

/** @typedef {Record<string, string>} QueryParams */

/**
 * @template T
 * @typedef {{ items: T[] } & Record<string, unknown>} ListResult
 */

/** 剥离 managedFields 控上下文（与 web 侧一致） */
/** @param {unknown} obj */
export function stripManagedFields(obj) {
  if (!obj || typeof obj !== 'object') return
  const rec = /** @type {Record<string, unknown>} */ (obj)
  const meta = rec.metadata
  if (!meta || typeof meta !== 'object') return
  const metaRec = /** @type {{ managedFields?: unknown }} */ (meta)
  if (metaRec.managedFields !== undefined) delete metaRec.managedFields
}

/** 后端错误（HTTP 非 2xx） */
export class BackendError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message)
    this.name = 'BackendError'
    this.status = status
  }
}

/** @param {Response} res */
async function parseError(res) {
  let message = `HTTP ${res.status}`
  try {
    const text = await res.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      message = String(parsed.message)
    } else {
      message = text.slice(0, 200) || message
    }
  } catch {
    /* keep default */
  }
  return new BackendError(res.status, message)
}

/** @param {Response} res @returns {Promise<unknown>} */
async function json(res) {
  if (!res.ok) throw await parseError(res)
  return await res.json()
}

/**
 * /clusters/{c} 透传路径白名单（P0 安全门，R2 攻击判定表驱动）。
 * 背景：k8s_get/k8s_request 的 apiPath 来自模型。WHATWG URL 会规整点段逃出代理
 * 前缀（/clusters/x/../../config → /config），且 fetch（undici）发送时还会先解
 * %2e（大小写不敏感）、把 \ 当 / ——只看原始字符串的 R1 版被 %2e%2e/反斜杠实测
 * 绕过（R2 判定表 #3-#6）。k8s 合法透传路径（资源名走 encodeURIComponent 后）
 * 本就不该含 % 或 \，一律拒绝最安全；再对归一化结果复跑同组检查兜底。
 * @param {string} path @throws {Error} 不合规
 */
export function assertClusterPath(path) {
  const clean = path.split('?')[0] ?? ''
  if (/[%\\]/.test(clean)) {
    throw new Error(`apiPath 含百分号编码或反斜杠（合法 k8s 路径不需要），已拒绝：${path}`)
  }
  /** @param {string} p @returns {boolean} */
  const checks = (p) =>
    /^\/(api|apis|helm)(\/|$)/.test(p) &&
    !p.split('/').slice(1).some((s) => s === '..' || s === '.' || s === '')
  if (!checks(clean) || !checks(new URL(`http://k${clean}`).pathname)) {
    throw new Error(`apiPath 必须以 /api、/apis 或 /helm 开头且不含 . / .. / 空路径段，收到：${path}`)
  }
}

/** @param {string} cluster @param {string} path @param {QueryParams} [params] */
function url(cluster, path, params) {
  assertClusterPath(path)
  const qs = new URLSearchParams(params ?? {})
  const q = qs.toString()
  return `${config.backendBase}/clusters/${encodeURIComponent(cluster)}${path}${q ? `?${q}` : ''}`
}

/**
 * 列出资源（managedFields 已剥离）。
 * @template T
 * @param {string} cluster @param {string} path
 * @param {QueryParams} [params] @param {AbortSignal | undefined} [signal]
 * @returns {Promise<ListResult<T>>}
 */
export async function list(cluster, path, params = {}, signal) {
  const res = await fetch(url(cluster, path, params), {
    headers: { Accept: 'application/json' },
    signal,
  })
  const data = /** @type {ListResult<T> & { items?: unknown[] }} */ (await json(res))
  for (const item of data.items ?? []) stripManagedFields(item)
  return data
}

/**
 * 取单个资源。
 * @template T
 * @param {string} cluster @param {string} path @param {AbortSignal | undefined} [signal]
 * @returns {Promise<T>}
 */
export async function get(cluster, path, signal) {
  const res = await fetch(url(cluster, path), { headers: { Accept: 'application/json' }, signal })
  const data = /** @type {T} */ (await json(res))
  if (data && typeof data === 'object') stripManagedFields(data)
  return data
}

/** 泛型请求原始文本上限（防大对象撑爆上下文；超出取尾部并保留标记） */
const RAW_BODY_LIMIT = 100_000

/**
 * 通用请求（全权限兜底）：走 /clusters/{c} 透传，返回原始 status 与 body。
 * 非 2xx 不抛错——k8s 错误 body 是 Status 对象（message/reason/code），由调用方呈给模型转述；
 * body 尽量 JSON 解析，失败退回原始文本（截断到 RAW_BODY_LIMIT）。
 * @param {string} cluster
 * @param {'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'} method
 * @param {string} path
 * @param {{ body?: unknown; contentType?: string; params?: QueryParams; signal?: AbortSignal }} [opts]
 * @returns {Promise<{ status: number; body: unknown }>}
 */
export async function request(cluster, method, path, opts = {}) {
  assertClusterPath(path)
  const qs = new URLSearchParams(opts.params ?? {})
  const q = qs.toString()
  return doFetch(`${config.backendBase}/clusters/${encodeURIComponent(cluster)}${path}${q ? `?${q}` : ''}`, method, opts, opts.signal)
}

/**
 * POST JSON 到后端顶层端点（不在 /clusters/{c} 透传下，如 /exec）。
 * 非 2xx 不抛错，同 request() 返回 { status, body }。
 * @param {string} path @param {unknown} body @param {AbortSignal | undefined} [signal]
 * @returns {Promise<{ status: number; body: unknown }>}
 */
export async function postJson(path, body, signal) {
  return doFetch(`${config.backendBase}${path}`, 'POST', { body, contentType: 'application/json' }, signal)
}

/** @param {string} fullUrl @param {string} method @param {{ body?: unknown; contentType?: string }} opts @param {AbortSignal | undefined} signal */
async function doFetch(fullUrl, method, opts, signal) {
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json' }
  /** @type {string | undefined} */
  let bodyInit
  if (opts.body !== undefined) {
    bodyInit = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    headers['Content-Type'] = opts.contentType ?? 'application/json'
  }
  const res = await fetch(fullUrl, { method, headers, body: bodyInit, signal })
  const text = await res.text()
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  /** @type {unknown} */
  const body = parsed !== null ? parsed : text.length > RAW_BODY_LIMIT ? text.slice(-RAW_BODY_LIMIT) : text
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    stripManagedFields(body)
    const items = /** @type {{ items?: unknown[] }} */ (body).items
    if (Array.isArray(items)) for (const item of items) stripManagedFields(item)
  }
  return { status: res.status, body }
}

/**
 * 日志流（移植自 client.ts streamLogs）：onChunk 逐块回调；
 * 首 chunk 超时（connectTimeoutMs，默认 90s）到点中止；signal 中止在途请求。
 * previous/sinceSeconds/timestamps 为 k8s log query 透传（web 侧不传，向后兼容）：
 * previous=true 取容器上一个已终止实例的日志（CrashLoop 排查关键）。
 * @param {string} cluster @param {string} ns @param {string} name
 * @param {{ container?: string; tailLines?: number; follow?: boolean; connectTimeoutMs?: number; previous?: boolean; sinceSeconds?: number; timestamps?: boolean }} opts
 * @param {(chunk: string) => void} onChunk
 * @param {AbortSignal | undefined} [signal]
 */
export async function streamLogs(cluster, ns, name, opts, onChunk, signal) {
  const qs = new URLSearchParams()
  if (opts.container) qs.set('container', opts.container)
  if (opts.tailLines) qs.set('tailLines', String(opts.tailLines))
  if (opts.follow) qs.set('follow', 'true')
  if (opts.previous) qs.set('previous', 'true')
  if (opts.sinceSeconds) qs.set('sinceSeconds', String(opts.sinceSeconds))
  if (opts.timestamps) qs.set('timestamps', 'true')
  const path = `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}/log?${qs}`
  const timeoutMs = opts.connectTimeoutMs ?? 90_000

  // 嵌套 controller：不能直接 abort 调用方的 signal（它可能还用于其他逻辑）
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) ctrl.abort()
  let timedOut = false
  const connectTimer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)

  try {
    const res = await fetch(`${config.backendBase}/clusters/${encodeURIComponent(cluster)}${path}`, {
      signal: ctrl.signal,
    })
    if (!res.ok) throw await parseError(res)
    if (!res.body) throw new Error('logs: no response body')

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
    if (timedOut && !signal?.aborted) {
      throw new Error(`日志连接超时（${Math.round(timeoutMs / 1000)}s 内未收到任何输出）`)
    }
    throw err
  } finally {
    clearTimeout(connectTimer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Helm releases 列表（契约见 helm.ts 头注释：GET /releases/list，
 * tailnet 慢 → 超时放宽到 120s）。allNamespaces 缺省 true。
 * @template T
 * @param {string} cluster
 * @param {{ allNamespaces?: boolean; namespace?: string }} [params]
 * @param {AbortSignal | undefined} [signal]
 * @returns {Promise<T>}
 */
export async function listReleases(cluster, params = {}, signal) {
  const allNamespaces = params.allNamespaces ?? true
  const qs = new URLSearchParams({ allNamespaces: String(allNamespaces) })
  if (!allNamespaces && params.namespace) qs.set('namespace', params.namespace)
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) ctrl.abort()
  const timer = setTimeout(() => ctrl.abort(new Error('helm releases 查询超时（120s）')), 120_000)
  try {
    const res = await fetch(
      `${config.backendBase}/clusters/${encodeURIComponent(cluster)}/helm/releases/list?${qs}`,
      { signal: ctrl.signal, headers: { Accept: 'application/json' } },
    )
    if (!res.ok) throw await parseError(res)
    const data = /** @type {T} */ (await res.json())
    return data
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
