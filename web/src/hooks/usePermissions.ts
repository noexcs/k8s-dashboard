// RBAC 感知权限查询：SelfSubjectAccessReview 走 headlamp 集群代理。
// - 后端只支持单资源检查（一次 SSR = 一个 verb × 资源）；本 hook 一次编排多个 check，
//   避免每个按钮各发 N 个请求
// - 模块级 60s 缓存 + 在途去重：多组件查同一权限共享结果（按钮逐个悬停不重发）
// - SSR 请求本身被拒（403/404，如用户无 selfsubjectaccessreviews/create 权限）或网络错误
//   → fail open（乐观放行），服务端 403 兜底
import { useEffect, useState } from 'react'
import { ApiError, canI } from '@/api/client'

export interface PermissionCheck {
  verb: string
  group: string // '' = core
  version: string
  resource: string
  /** 带命名空间检查：namespaced 资源传真实 ns，cluster-scoped 省略 */
  namespace?: string
}

const TTL_MS = 60_000
const cache = new Map<string, { allowed: boolean; at: number; /** 负结果（SSR 自身被拒）：会话内永久有效，不再重发 */ sticky?: boolean }>()
const inflight = new Map<string, Promise<boolean>>()

function keyOf(cluster: string, c: PermissionCheck): string {
  return [cluster, c.verb, c.group, c.version, c.resource, c.namespace ?? ''].join('\u0000')
}

function readCache(cluster: string, c: PermissionCheck): boolean | undefined {
  const hit = cache.get(keyOf(cluster, c))
  if (!hit) return undefined
  // sticky 条目不过期：查不了权限的会话内一直查不了，重发只会反复 403
  if (!hit.sticky && Date.now() - hit.at >= TTL_MS) return undefined
  return hit.allowed
}

async function checkOnce(cluster: string, c: PermissionCheck): Promise<boolean> {
  const cached = readCache(cluster, c)
  if (cached !== undefined) return cached
  const k = keyOf(cluster, c)
  const pending = inflight.get(k)
  if (pending) return pending
  const p = canI(cluster, c.verb, c.group, c.version, c.resource, c.namespace)
    .then(allowed => {
      cache.set(k, { allowed, at: Date.now() })
      return allowed
    })
    .catch((err: unknown) => {
      // SSR 自身被拒（用户无 selfsubjectaccessreviews/create 权限）或端点不存在
      // → 乐观放行，负结果也进缓存（key 与正结果一致，sticky 会话内不重发），
      // 否则每个用到 usePermissions 的组件都会反复重试一个永远过不了的端点
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        cache.set(k, { allowed: true, at: Date.now(), sticky: true })
        return true
      }
      throw err
    })
    .finally(() => inflight.delete(k))
  inflight.set(k, p)
  return p
}

function readAll(cluster: string, checks: PermissionCheck[]): Record<string, boolean> | null {
  const results: Record<string, boolean> = {}
  for (const c of checks) {
    const v = readCache(cluster, c)
    if (v === undefined) return null
    results[keyOf(cluster, c)] = v
  }
  return results
}

/**
 * 批量权限查询。
 * `can(chk)`：检查在途时乐观返回 true（按钮可点，服务端 403 兜底），完成后返回精确判定；
 * 结果按 (cluster, verb, group, version, resource, namespace) 缓存 60s。
 * `checks` 请用 useMemo 保持稳定（内部按 JSON 签名比较，普通字面量数组也安全）。
 */
export function usePermissions(
  cluster: string,
  checks: PermissionCheck[],
): { can: (chk: PermissionCheck) => boolean; loading: boolean } {
  const sig = cluster + '\u0000' + JSON.stringify(checks)
  const [state, setState] = useState(() => ({ sig, results: readAll(cluster, checks) }))

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // 并发请求：串行 await 会把 N 个 SSR 的耗时叠加（首屏 N × RTT）
      const entries = await Promise.all(
        checks.map(async c => [keyOf(cluster, c), await checkOnce(cluster, c).catch(() => true)] as const),
      )
      if (!cancelled) setState({ sig, results: Object.fromEntries(entries) })
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  const results = state.sig === sig ? state.results : null
  return {
    can: (chk: PermissionCheck) => (results ? results[keyOf(cluster, chk)] === true : true),
    loading: results === null,
  }
}
