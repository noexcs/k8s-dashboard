// 侧栏自定义（对齐 Headlamp ui.sidebar 配置 + CLI 工具 持久化）：条目显隐 + 分组排序，
// localStorage `k8s-nav:{cluster}` 按集群持久化（CRD 条目按集群不同，收藏同理）。
// key 约定：条目 = kind（内置/CRD 共用，内置 kind 优先注册故无冲突）；
// 分组 = section 名（workloads…）或 'crd'（自定义资源组）。
import { useCallback, useSyncExternalStore } from 'react'
import { NAV_SECTIONS, type NavSection } from '@/resources/registry'

export type NavGroupKey = NavSection | 'crd'

interface Prefs {
  hidden: string[]
  order: NavGroupKey[]
}

const DEFAULT_ORDER: NavGroupKey[] = [...NAV_SECTIONS.map(s => s.section), 'crd']

const read = (cluster: string): Prefs => {
  try {
    const raw = localStorage.getItem(`k8s-nav:${cluster}`)
    if (!raw) return { hidden: [], order: DEFAULT_ORDER }
    const p = JSON.parse(raw) as { hidden?: string[]; order?: string[] }
    // order 合并：注册表新增分组（或旧数据缺项）追加到 'crd' 前，避免新分组永远不见
    const isKey = (s: string): s is NavGroupKey => (DEFAULT_ORDER as string[]).includes(s)
    const stored = (p.order ?? []).filter(isKey)
    const missing = DEFAULT_ORDER.filter(s => s !== 'crd' && !stored.includes(s))
    const order = [...stored, ...missing, ...(p.order?.includes('crd') || !p.order ? (['crd'] as NavGroupKey[]) : [])]
    return { hidden: p.hidden ?? [], order }
  } catch {
    return { hidden: [], order: DEFAULT_ORDER }
  }
}

const stores = new Map<string, { v: Prefs; subs: Set<() => void> }>()

const store = (cluster: string) => {
  let s = stores.get(cluster)
  if (!s) {
    s = { v: read(cluster), subs: new Set() }
    stores.set(cluster, s)
  }
  return s
}

const write = (cluster: string, v: Prefs) => {
  const s = store(cluster)
  s.v = v
  try {
    localStorage.setItem(`k8s-nav:${cluster}`, JSON.stringify(v))
  } catch {
    /* 隐私模式等写入失败：本次会话内仍生效 */
  }
  for (const cb of s.subs) cb()
}

const EMPTY_P: Prefs = { hidden: [], order: DEFAULT_ORDER }

export function useNavPrefs(cluster: string | undefined) {
  const c = cluster ?? ''
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!c) return () => {}
      const s = store(c)
      s.subs.add(cb)
      return () => s.subs.delete(cb)
    },
    [c],
  )
  const prefs = useSyncExternalStore(
    subscribe,
    () => (c ? store(c).v : EMPTY_P),
    () => EMPTY_P,
  )

  const setHidden = useCallback(
    (key: string, hide: boolean) => {
      if (!c) return
      const cur = store(c).v
      const hidden = hide ? [...new Set([...cur.hidden, key])] : cur.hidden.filter(k => k !== key)
      write(c, { ...cur, hidden })
    },
    [c],
  )

  const move = useCallback(
    (section: NavGroupKey, dir: -1 | 1) => {
      if (!c) return
      const cur = store(c).v
      const i = cur.order.indexOf(section)
      const j = i + dir
      if (i < 0 || j < 0 || j >= cur.order.length) return
      const order = [...cur.order]
      ;[order[i], order[j]] = [order[j], order[i]]
      write(c, { ...cur, order })
    },
    [c],
  )

  const reset = useCallback(() => {
    if (c) write(c, { hidden: [], order: DEFAULT_ORDER })
  }, [c])

  return {
    hidden: new Set(prefs.hidden),
    /** 按持久化顺序排 section（含 'crd'）；未知条目丢弃，缺失由 read 合并补齐 */
    orderedSections: prefs.order.filter(s => s === 'crd' || NAV_SECTIONS.some(n => n.section === s)),
    setHidden,
    move,
    reset,
    dirty: prefs.hidden.length > 0 || prefs.order.join() !== DEFAULT_ORDER.join(),
  }
}
