import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, list, watchStream } from '@/api/client'
import type { K8sObject, WatchEvent } from '@/api/types'

export interface WatchState<T extends K8sObject> {
  /** 当前全量（按 name 排序） */
  items: T[]
  /** uid → 对象 */
  map: Map<string, T>
  /** 最近一次同步成功时间（list 完成或 watch 帧到达） */
  lastSync: number | null
  /** 正在重连（list 回退或退避中） */
  reconnecting: boolean
  /** list/watch 被 RBAC 拒绝（403）：退避循环已停止，不会再重连；调用方应与自身 SSR 判定结果取 OR */
  forbidden: boolean
  error: string | null
}

interface Opts<T extends K8sObject> {
  cluster: string
  path: string
  /** 除 watch 外附加的查询参数 */
  params?: Record<string, string>
  enabled?: boolean
  /** 每收到一帧 watch 事件时回调（初始 list 不触发） */
  onEvent?: (ev: WatchEvent<T>) => void
}

/**
 * 跨挂载的 list+watch 快照缓存（informer 语义,对齐 headlamp 的常驻 informer）：
 * 菜单切 kind / 来回翻页时组件重挂,旧实现每次重置空 map → 必闪一帧 Skeleton,
 * 且全量重打 list API(用户实拍指出「点开会闪一下」)。
 * 缓存命中则挂载即渲染旧表 + 从缓存 RV 增量续传 watch:
 * RV 被 etcd 压缩时 watch 410 → 既有退避路径回退全量 list 原子替换,不会陈旧。
 * 有界 LRU:每条目是一张对象表,最多 24 个 (cluster,path,params) 组合。
 */
type CacheEntry<T> = { map: Map<string, T>; rv: string | null; lastSync: number | null }
const watchCache = new Map<string, CacheEntry<unknown>>()
const CACHE_MAX = 24

function cacheSeed<T>(key: string): CacheEntry<T> | null {
  const hit = watchCache.get(key) as CacheEntry<T> | undefined
  if (!hit) return null
  watchCache.delete(key)
  watchCache.set(key, hit) // LRU touch
  // 拷贝:新实例的增量帧不能写回可能仍在场的旧实例
  return { map: new Map(hit.map), rv: hit.rv, lastSync: hit.lastSync }
}

function cachePut<T>(key: string, e: CacheEntry<T>) {
  watchCache.set(key, e)
  while (watchCache.size > CACHE_MAX) watchCache.delete(watchCache.keys().next().value as string)
}

/**
 * list + watch 合并视图。
 * 策略：全量 list（带 continue 翻页）→ 从 resourceVersion 开 watch；
 * 410 Gone / 网络错误 → 指数退避后重新 list；
 * 流正常结束（服务端重启等）→ 保留 resourceVersion，优先增量续传，410 再回退全量；
 * 403（RBAC 拒绝）→ 停止重试，置 forbidden。
 */
export function useWatch<T extends K8sObject>(opts: Opts<T>): WatchState<T> {
  const { cluster, path, params, enabled = true, onEvent } = opts
  const paramsKey = JSON.stringify(params ?? {})
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  // 上下文指纹:集群/路径/参数/启用门任一变化 → 渲染期同步换缓存种子(见下方 syncKey 调整),
  // 不能在 effect 里清状态——effect 跑在首帧绘制之后,Skeleton 已经闪出去了
  const ctxKey = `${cluster}|${path}|${paramsKey}|${enabled ? 1 : 0}`
  const [seed] = useState(() => cacheSeed<T>(ctxKey))
  const mapRef = useRef<Map<string, T>>(null!)
  const rvRef = useRef<string | null>(null)
  const lastSyncRef = useRef<number | null>(null)
  if (!mapRef.current) {
    // 首挂载种子(无缓存=空表,与旧行为一致:首访仍走 Skeleton+全量 list)
    mapRef.current = seed?.map ?? new Map<string, T>()
    rvRef.current = seed?.rv ?? null
    lastSyncRef.current = seed?.lastSync ?? null
  }
  const [syncKey, setSyncKey] = useState(ctxKey)
  const [tick, setTick] = useState(0)
  const [lastSync, setLastSync] = useState<number | null>(() => seed?.lastSync ?? null)
  const [reconnecting, setReconnecting] = useState(false)
  const [forbidden, setForbidden] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 「渲染期派生状态调整」:ctxKey 变了就在同一次渲染里换种子并重渲染,
  // 提交到屏幕的第一帧就带着缓存表——旧实现在 effect 重置 → 空表先画一帧骨架屏
  if (syncKey !== ctxKey) {
    const s = cacheSeed<T>(ctxKey)
    mapRef.current = s?.map ?? new Map<string, T>()
    rvRef.current = s?.rv ?? null
    lastSyncRef.current = s?.lastSync ?? null
    setSyncKey(ctxKey)
    setTick(t => t + 1) // items memo 只认 tick:换 map 必须 bump,否则渲染旧数组
    setLastSync(s?.lastSync ?? null)
    setReconnecting(false)
    setForbidden(false)
    setError(null)
  }

  // rAF 合批：初始同步的连续帧只触发一次渲染
  const rafRef = useRef<number | null>(null)
  const schedule = () => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      setTick(t => t + 1)
    })
  }

  useEffect(() => {
    if (!enabled) return
    // 上下文切换的重置/缓存种子由渲染期 syncKey 调整负责(见上),这里只跑 IO。
    // 种子 rv 非空时首轮直接增量续传;RV 过期走 410 → 下方退避清 rv → 全量 list。
    const cacheNow = () =>
      cachePut(ctxKey, { map: mapRef.current, rv: rvRef.current, lastSync: lastSyncRef.current })

    let cancelled = false
    let ac: AbortController | null = null
    let backoff = 1000
    let timer: ReturnType<typeof setTimeout> | undefined
    // 退避等待的唤醒句柄：卸载时调用，避免 run() 永远挂在 await 上
    let resumeResolve: (() => void) | null = null
    // 处于重连流程（退避等待/重新 list）；恢复后清除
    let recovering = false

    // 从「重连中」恢复：list 成功与 watch 首帧到达都是恢复信号
    // （增量续传成功路径没有 list，只能靠首帧）。清掉过期 error，退避计数归位
    const markRecovered = () => {
      backoff = 1000
      if (!recovering) return
      recovering = false
      setReconnecting(false)
      setError(null)
    }

    const applyEvent = (ev: WatchEvent<T>) => {
      // 流内 ERROR 帧（RV 过期/etcd 压缩，apiserver 以 Status 对象下发后关流）：
      // 必须抛出落入统一重连路径（catch 清 rvRef → 退避 → 全量重建）。
      // 当普通帧吞掉 = watch 静默陈旧，页面永远停在断线前的数据。
      if (ev.type === 'ERROR') {
        const st = ev.object as unknown as { code?: number; message?: string }
        throw new ApiError(st?.code ?? 0, st?.message ?? 'watch ERROR frame')
      }
      const obj = ev.object
      const uid = obj.metadata?.uid
      if (!uid) return
      // 走 mapRef.current 而非闭包 map：fullList 全量重建会整体换 map，
      // 闭包引用旧 map 会把帧写进已被替换的孤儿对象
      const map = mapRef.current
      if (ev.type === 'DELETED') map.delete(uid)
      else map.set(uid, obj)
      if (obj.metadata?.resourceVersion) rvRef.current = obj.metadata.resourceVersion
      onEventRef.current?.(ev)
      markRecovered()
      cacheNow()
      schedule()
    }

    const fullList = async (): Promise<void> => {
      // 全量重建进全新 map：断线窗口里丢掉的 DELETED 帧不能复活（旧实现只 set
      // 不清旧 map → 幽灵行永久残留）。分页期间旧 map 照常渲染，整页齐了原子替换。
      const fresh = new Map<string, T>()
      const p = new URLSearchParams(params ?? {})
      let continueToken: string | undefined
      let lastPageRV: string | undefined
      for (;;) {
        if (continueToken) p.set('continue', continueToken)
        // 传 AbortSignal：卸载/切集群时中止在途的 list（多页 continue 中途也能掐断）
        const res = await list<T>(cluster, path, Object.fromEntries(p), ac?.signal)
        if (cancelled) return
        for (const item of res.items) fresh.set(item.metadata.uid, item)
        lastPageRV = res.metadata.resourceVersion
        continueToken = res.metadata.continue
        if (!continueToken) break
      }
      mapRef.current = fresh
      // 必须用 list 自身的 resourceVersion（list 结束位置），
      // 单个对象的 RV 可能已被 etcd 压缩 → 410 Gone 死循环
      if (lastPageRV) {
        rvRef.current = lastPageRV
        lastSyncRef.current = Date.now()
        setLastSync(lastSyncRef.current)
      }
      markRecovered()
      cacheNow()
      schedule()
    }

    const run = async () => {
      for (;;) {
        if (cancelled) return
        ac = new AbortController()
        try {
          if (rvRef.current) {
            // 有 RV → 增量 watch（从上次同步点续传）；410 → catch 清 rvRef，下轮回退全量
            const p: Record<string, string> = { ...(params ?? {}), resourceVersion: rvRef.current }
            await watchStream<T>(cluster, path, p, applyEvent, ac.signal)
          } else {
            await fullList()
            if (cancelled) return
            const p2: Record<string, string> = { ...(params ?? {}) }
            if (rvRef.current) p2.resourceVersion = rvRef.current
            await watchStream<T>(cluster, path, p2, applyEvent, ac.signal)
          }
          // 流正常结束（服务端重启等）→ 不 return：保留 rvRef，
          // 落入下方统一重连路径，退避后优先从 RV 增量续传
        } catch (err) {
          if (cancelled || ac.signal.aborted) return
          // RBAC 拒绝是永久的：退避循环没有意义，停止重连并暴露 forbidden
          if (err instanceof ApiError && err.status === 403) {
            setError(err.message)
            setForbidden(true)
            setReconnecting(false)
            return
          }
          setError(err instanceof Error ? err.message : String(err))
          // 410（RV 过期）与网络断线都 → 全量重新 list；
          // 只有「流正常结束」才保留 rvRef 走增量续传
          rvRef.current = null
        }
        if (cancelled) return
        // 统一重连：退避等待；rvRef 保留（经正常关闭进来的可增量续传）
        recovering = true
        setReconnecting(true)
        const { promise, resolve } = Promise.withResolvers<void>()
        resumeResolve = resolve
        timer = setTimeout(resolve, backoff)
        await promise
        if (cancelled) return
        backoff = Math.min(backoff * 2, 30_000)
      }
    }

    void run()
    return () => {
      cancelled = true
      ac?.abort()
      // 唤醒退避等待：timer 即将被清掉，不唤醒的话 run() 会永远挂在 await promise
      resumeResolve?.()
      clearTimeout(timer)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [cluster, path, paramsKey, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => {
    const arr = [...mapRef.current.values()]
    arr.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
    return arr
    // syncKey:种子切换与 tick bump 同批提交,列上双保险(memo 不能信「顺手 bump 过」)
  }, [tick, syncKey])

  return { items, map: mapRef.current, lastSync, reconnecting, forbidden, error }
}
