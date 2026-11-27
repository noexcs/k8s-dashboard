// 资源收藏（参考 CLI Favorites）：localStorage（k8s-favs:{cluster}）持久化，
// 全局搜索置顶展示 + 结果行星标切换。无后端依赖。
import { useCallback, useSyncExternalStore } from 'react'

export interface Fav {
  kind: string
  ns: string
  name: string
}

const key = (cluster: string) => `k8s-favs:${cluster}`
/** cluster → Set<`kind/ns/name`>；监听器按 cluster 分桶 */
const cache = new Map<string, Set<string>>()
const listeners = new Map<string, Set<() => void>>()

function member(f: Fav) {
  return `${f.kind}/${f.ns}/${f.name}`
}

function read(cluster: string): Set<string> {
  const hit = cache.get(cluster)
  if (hit) return hit
  let set = new Set<string>()
  try {
    const raw = localStorage.getItem(key(cluster))
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) set = new Set(arr.map(m => String(m)))
    }
  } catch {
    /* localStorage 禁用/坏数据 → 空集 */
  }
  cache.set(cluster, set)
  return set
}

function notify(cluster: string) {
  for (const l of listeners.get(cluster) ?? []) l()
}

export function toggleFav(cluster: string, f: Fav): void {
  const set = new Set(read(cluster))
  const m = member(f)
  if (set.has(m)) set.delete(m)
  else set.add(m)
  cache.set(cluster, set)
  try {
    localStorage.setItem(key(cluster), JSON.stringify([...set]))
  } catch {
    /* 写失败仍更新内存视图 */
  }
  notify(cluster)
}

/** 该集群收藏 key 集合（响应式：任意组件切换收藏即全部刷新） */
export function useFavs(cluster: string | undefined): Set<string> {
  const c = cluster ?? ''
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!c) return () => undefined
      let set = listeners.get(c)
      if (!set) listeners.set(c, (set = new Set()))
      set.add(cb)
      return () => set!.delete(cb)
    },
    [c],
  )
  return useSyncExternalStore(subscribe, () => (c ? read(c) : EMPTY))
}

const EMPTY = new Set<string>()

export const favMember = member
