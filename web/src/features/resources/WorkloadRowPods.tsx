// 工作负载行的就地 Pod 下钻（首页/列表高密度表格用）：
// 「ready 2/3 到底是哪个 pod 卡住」此前必须进详情页。点开弹层直接看该 workload 的
// pod 实况（phase/重启数/年龄），并可就地聚合日志、重启（权限门与详情页同一套 SSAR 口径）。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, Info, Loader2, RefreshCw, ScrollText } from 'lucide-react'
import { ApiError, get, list, patchObject } from '@/api/client'
import { toast } from 'sonner'
import { findWorkloadPods, RESTARTABLE, restartWorkloadPods, restartWorkloadRollout, ROLLOUT_RESTARTABLE } from './WorkloadActions'
import { WorkloadLogsDialog } from './WorkloadLogsDialog'
import { usePermissions, type PermissionCheck } from '@/hooks/usePermissions'
import { detailRoute } from '@/resources/registry'
import { GatedButton } from '@/components/GatedButton'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { tf, useT } from '@/i18n'
import { severityTone, toneChip } from '@/lib/tone'
import { useFlash } from '@/lib/useFlash'
import type { K8sObject } from '@/api/types'

/** 有 replicas 语义、可走 /scale 子资源的 kind（与 WorkloadActions.SCALEABLE 同集合，DaemonSet 不含） */
const SCALEABLE: Record<string, true> = { Deployment: true, StatefulSet: true, ReplicaSet: true }

const KIND_PATH: Record<string, { group: string; version: string; resource: string }> = {
  Deployment: { group: 'apps', version: 'v1', resource: 'deployments' },
  StatefulSet: { group: 'apps', version: 'v1', resource: 'statefulsets' },
  DaemonSet: { group: 'apps', version: 'v1', resource: 'daemonsets' },
  ReplicaSet: { group: 'apps', version: 'v1', resource: 'replicasets' },
  Job: { group: 'batch', version: 'v1', resource: 'jobs' },
}

function workloadPath(o: K8sObject): string | null {
  const m = KIND_PATH[o.kind]
  if (!m) return null
  const ns = o.metadata.namespace ?? 'default'
  const base = m.group ? `apis/${m.group}/${m.version}` : `api/${m.version}`
  return `/${base}/namespaces/${ns}/${m.resource}/${o.metadata.name}`
}

type RowPod = K8sObject & {
  status?: {
    phase?: string
    containerStatuses?: { restartCount?: number; state?: { waiting?: { reason?: string }; running?: unknown; terminated?: { reason?: string } }; lastState?: { terminated?: { reason?: string } } }[]
  }
}

/**
 * 容器崩溃证据：waiting.reason（CrashLoopBackOff/ImagePullBackOff）优先；刚重启的瞬时
 * waiting 尚未写入时退用 lastState.terminated（OOMKilled/Error）——phase=Running 也可能正在崩
 */
function waitingReason(p: RowPod): string | null {
  for (const cs of p.status?.containerStatuses ?? []) {
    if (cs.state?.waiting?.reason) return cs.state.waiting.reason
  }
  for (const cs of p.status?.containerStatuses ?? []) {
    // 刚崩（state.terminated）：直接给本次原因；重启窗口里（running）：给上次死因；Completed 不算崩
    const t = cs.state?.terminated?.reason ?? ((cs.restartCount ?? 0) > 0 ? cs.lastState?.terminated?.reason : null)
    if (t && t !== 'Completed') return t
  }
  return null
}

function restarts(p: RowPod): number {
  return (p.status?.containerStatuses ?? []).reduce((a, cs) => a + (cs.restartCount ?? 0), 0)
}

/** phase 上色：Running/Succeeded 是事实的好，Pending 是值班语义的「还没好」，Failed/Unknown 才是坏 */
function phaseClass(phase: string): string {
  if (phase === 'Running' || phase === 'Succeeded') return 'text-positive'
  if (phase === 'Pending') return 'text-caution'
  return 'text-destructive'
}

function agoShort(ts: string): string {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  if (s < 172800) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export function WorkloadRowPods({ cluster, obj }: { cluster: string; obj: K8sObject & { spec?: { replicas?: number } } }) {
  const tr = useT()
  const queryClient = useQueryClient()
  const path = workloadPath(obj)
  const ns = obj.metadata.namespace ?? 'default'
  const [open, setOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  // 伸缩本地覆盖：写成功后立即反映目标值（服务端 30s 轮询追上前不能退回旧数）
  const [applied, setApplied] = useState<number | null>(null)
  const [scaling, setScaling] = useState(false)
  // 确认态内联在同一弹层里（mode + 待应用值）——此前是弹层上再叠 AlertDialog：
  // 两层浮层互不避让，取消即杀弹层、确认/取消那一下还会穿透成「跳转详情页」（实测 2/2）
  const [mode, setMode] = useState<null | 'restart' | 'zero'>(null)
  const [zeroTarget, setZeroTarget] = useState<number | null>(null)
  // 确认动线键盘收口：确认块出现即聚焦「取消」（否则要 Tab 越过整个 pod 列表）
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (mode !== null) cancelRef.current?.focus()
  }, [mode])
  // 重启门=RESTARTABLE（Job 无重启语义：Succeeded Job 删 pod 不重建，只会毁掉唯一日志载体，
  // 与详情页同一套 kind 闸门）；Deploy/STS/DS 走 restartedAt 注解（不再删旧 RS 的 pod）
  const rollout = ROLLOUT_RESTARTABLE[obj.kind] !== undefined
  const checks: PermissionCheck[] = path
    ? [
        rollout
          ? { verb: 'patch', group: KIND_PATH[obj.kind]?.group ?? 'apps', version: 'v1', resource: KIND_PATH[obj.kind]?.resource ?? '', namespace: ns }
          : { verb: 'delete', group: '', version: 'v1', resource: 'pods', namespace: ns },
        // scale 子资源 PATCH → RBAC 校验对象是 update <resource>/scale（同详情页口径，查父资源会双向错配）
        { verb: 'update', group: KIND_PATH[obj.kind]?.group ?? '', version: 'v1', resource: `${KIND_PATH[obj.kind]?.resource ?? ''}/scale`, namespace: ns },
        { verb: 'patch', group: KIND_PATH[obj.kind]?.group ?? '', version: 'v1', resource: `${KIND_PATH[obj.kind]?.resource ?? ''}/scale`, namespace: ns },
      ]
    : []
  const { can } = usePermissions(cluster, checks)
  const canRestart = !!path && RESTARTABLE[obj.kind] !== undefined && can(checks[0])
  const canScale = !!path && SCALEABLE[obj.kind] !== undefined && (can(checks[1]) || can(checks[2]))
  const shownReplicas = applied ?? obj.spec?.replicas ?? 0
  // 副本数真实变化（± 写回成功/外部改写被拉回）闪一下（useFlash 只在值变化时触发）
  const replicaFlash = useFlash(shownReplicas)

  // HPA 检测：被管理的负载 ± 会被 reconcile 抹掉，伸缩行必须让位给事实；
  // v2 不存在回退 v1（后端 diagnose 同口径），彻底查不到（403/网络）时收起 ± 而非放行——
  // 「以为能缩其实被抹掉」的假成功比没有 ± 更危险
  const hpaQ = useQuery({
    queryKey: ['wl-row-hpa', cluster, ns],
    queryFn: async () => {
      const p = (v: string) => `/apis/autoscaling/${v}/namespaces/${ns}/horizontalpodautoscalers`
      try {
        return await list<K8sObject & { spec?: { scaleTargetRef?: { kind?: string; name?: string }; minReplicas?: number; maxReplicas?: number } }>(cluster, p('v2'))
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return await list<K8sObject & { spec?: { scaleTargetRef?: { kind?: string; name?: string }; minReplicas?: number; maxReplicas?: number } }>(cluster, p('v1'))
        throw e
      }
    },
    enabled: open && SCALEABLE[obj.kind] !== undefined,
    staleTime: 30_000,
    retry: 0,
  })
  const hpa = (hpaQ.data?.items ?? []).find(h => h.spec?.scaleTargetRef?.kind === obj.kind && h.spec?.scaleTargetRef?.name === obj.metadata.name)

  // 打开才拉：常驻表格每行预取 pods 会把首页打成 N+1 请求风暴
  const podsQ = useQuery({
    queryKey: ['wl-row-pods', cluster, path],
    // K8sObject 不承载 status 字段面；api/v1 pods 运行时必带（registry 同源类型）
    queryFn: async () => (await findWorkloadPods(cluster, path!, ns)) as unknown as RowPod[],
    enabled: open && !!path,
    staleTime: 10_000,
    retry: 0,
  })
  const pods = podsQ.data ?? []

  /** 写 /scale 子资源：先读实值再 ±（30s 前的快照算绝对值会把并发的第二只手静默回滚），
   * 缩到 0 = 整服务摘零，单独确认（与重启的确认成本对齐） */
  // ± 写完后按钮短暂禁用会把焦点甩到 body（Enter/Space 空响、AT 丢上下文）：
  // 恢复焦点到刚按的按钮，被禁用则退到行触发器（质量审计 P3-1）
  const lastBtn = useRef<HTMLElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const refocus = () => {
    setTimeout(() => {
      if (document.activeElement !== document.body) return
      if (lastBtn.current?.isConnected) lastBtn.current.focus()
      else triggerRef.current?.focus()
    }, 0)
  }
  const stepScale = async (delta: number, src?: HTMLElement) => {
    lastBtn.current = src ?? null
    setScaling(true)
    setMode(null)
    let from: number
    try {
      // 读实值失败≠可以用 30s 前的展示值：陈旧快照算绝对值会把并发的第二只手静默回滚，
      // 与 HPA 探测失败同口径 fail-closed——取消本次伸缩（FL20#5）
      const cur = (await get<K8sObject>(cluster, `${path!}/scale`)) as unknown as { spec?: { replicas?: number } }
      from = cur.spec?.replicas ?? shownReplicas
    } catch (e) {
      setScaling(false)
      refocus()
      toast.error(`${tr('sys:scaleReadFail')}：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    try {
      const to = Math.max(0, from + delta)
      if (to === 0) {
        setZeroTarget(to)
        setMode('zero')
        return
      }
      await patchObject(cluster, `${path!}/scale`, { spec: { replicas: to } }, `副本 ${from} → ${to}（来自列表页）`)
      setApplied(to)
      toast.success(tf('res:scaleSuccess2', { kind: obj.kind, name: obj.metadata.name, from, to }))
      void queryClient.invalidateQueries({ queryKey: ['dashboard', cluster] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setScaling(false)
      refocus()
    }
  }
  const applyZero = async () => {
    setMode(null)
    if (zeroTarget === null) return
    await stepScaleApply(zeroTarget)
    setZeroTarget(null)
  }
  const stepScaleApply = async (to: number) => {
    setScaling(true)
    try {
      const from = shownReplicas
      await patchObject(cluster, `${path!}/scale`, { spec: { replicas: to } }, `副本 ${from} → ${to}（来自列表页）`)
      setApplied(to)
      toast.success(tf('res:scaleSuccess2', { kind: obj.kind, name: obj.metadata.name, from, to }))
      void queryClient.invalidateQueries({ queryKey: ['dashboard', cluster] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setScaling(false)
      refocus()
    }
  }

  const doRestart = async () => {
    setRestarting(true)
    setMode(null)
    try {
      // 滚动重启=restartedAt 注解（与详情页/AI 同语义）：控制器按滚动策略逐个替换，
      // 不再按名下全部 RS 直接删 pod（滚动中会连旧版本一起删）
      if (ROLLOUT_RESTARTABLE[obj.kind]) {
        await restartWorkloadRollout(cluster, path!, pods.length ? `滚动重启 ${pods.length} 个 Pod` : '滚动重启（restartedAt 注解）')
      } else {
        // ReplicaSet 模板不可变只能删 pod 重启（RESTARTABLE 含 RS；首页表今日无 RS，防复用进列表页后 422）
        const list0 = podsQ.data ?? (await findWorkloadPods(cluster, path!, ns))
        await restartWorkloadPods(cluster, list0, () => {
          void queryClient.invalidateQueries({ queryKey: ['wl-row-pods', cluster] })
          void queryClient.invalidateQueries({ queryKey: ['dashboard', cluster] })
        })
      }
      toast.success(tr('res:restartRolloutDone'))
      void queryClient.invalidateQueries({ queryKey: ['dashboard', cluster] })
      void queryClient.invalidateQueries({ queryKey: ['wl-row-pods', cluster] })
      setOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setRestarting(false)
    }
  }

  if (!path) return null
  return (
    <>
      {/* modal：非 modal Popover 没有 overlay，确认态下的「外点」只是被忽略的 dismiss——
          那一次 click 原封不动打在底下行/侧栏链接上（穿透跳转，实测 2/2）。modal 层
          拦截外部指针事件才是防穿透的正解；Esc 在确认态只撤确认 */}
      <Popover
        modal
        open={open || mode !== null}
        onOpenChange={v => {
          if (v) { setOpen(true); return }
          setOpen(false)
          setMode(null)
          setApplied(null)
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden"
            aria-label={tf('sys:podsOfNamed', { name: obj.metadata.name })}
            onClick={e => e.stopPropagation()}
            // 行 role=link 的 Enter 会先派发 keydown 再合成 click：只挡 click 会被行导航双触发
            onKeyDown={e => e.stopPropagation()}
          >
            {podsQ.isPending && open ? <Loader2 className="size-3.5 animate-spin" /> : <Boxes className="size-3.5" />}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-96 p-2"
          onClick={e => e.stopPropagation()}
          // 弹层内任何控件上的 Enter 不得冒泡成行导航：React 合成事件沿组件树冒到 TableRow
          // （Radix Portal 只挪 DOM 不挪组件树），确认/日志/重启此前在键盘路径上被静默吞掉
          onKeyDown={e => e.stopPropagation()}
          // 打开弹层=只读意图：焦点不得自动落在 ±（一次 Space 即写生产副本数）
          onOpenAutoFocus={e => e.preventDefault()}
          onEscapeKeyDown={e => {
            // 确认态 Esc=撤确认而非关弹层（此前注释写着这个意图、实现是什么都不做）
            if (mode !== null) {
              e.preventDefault()
              setMode(null)
            }
          }}
        >
          {(canScale || hpa) && (
            <div className="mb-2 border-b border-border/60 pb-2">
              {hpa ? (
                // 只读事实行与操作行刻意不同皮：±因 HPA 消失要能被感知，不是「换了个同样长相的行」
                <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs" title={tr('sys:hpaRowTip')}>
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    <Info className="size-3.5 shrink-0" />
                    <span className="truncate">{tr('sys:hpaManaged')}</span>
                  </span>
                  <span className="shrink-0 font-mono tabular-nums">{hpa.spec?.minReplicas ?? '?'}–{hpa.spec?.maxReplicas ?? '?'}</span>
                </div>
              ) : SCALEABLE[obj.kind] !== undefined && hpaQ.isPending ? (
                // 查询在途先亮 ± 再翻 HPA 只读 = 窗口内点 − 的「假成功」竞态口子；
                // 确认前不给操作（AI 侧 fail-closed，UI 反而 fail-open 说不过去）
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground" aria-busy="true">
                  <Loader2 className="size-3 animate-spin" />
                  {tr('sys:hpaChecking')}
                </div>
              ) : hpaQ.isError ? (
                <p className="px-2 py-1 text-xs text-caution">{tr('sys:hpaUnknown')}</p>
              ) : canScale && (
                <div className="flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1 text-xs">
                  <span className="text-muted-foreground">{tr('sys:rowReplicas')}</span>
                  <span className="flex items-center gap-1 tabular-nums">
                    <Button size="xs" variant="outline" className="size-6 p-0" disabled={scaling || mode !== null} aria-label={tr('sys:scaleDown')} onClick={e => void stepScale(-1, e.currentTarget)}>
                      −
                    </Button>
                    <span
                      className="w-6 text-center font-mono"
                      data-flash={replicaFlash.flash || undefined}
                      onAnimationEnd={replicaFlash.onEnd}
                    >
                      {shownReplicas}
                    </span>
                    <Button size="xs" variant="outline" className="size-6 p-0" disabled={scaling || mode !== null} aria-label={tr('sys:scaleUp')} onClick={e => void stepScale(1, e.currentTarget)}>
                      +
                    </Button>
                  </span>
                </div>
              )}
            </div>
          )}
          <div className="mb-1 flex items-center justify-between gap-2 px-2">
            <span className="min-w-0 truncate text-xs font-medium">{tf('sys:podsOfNamed', { name: obj.metadata.name })}</span>
            <span className="flex shrink-0 items-center gap-1">
              <Button size="icon-xs" variant="ghost" onClick={() => setLogsOpen(true)} aria-label={tr('res:aggLogs')} title={tr('res:aggLogs')}>
                <ScrollText className="size-3.5" />
              </Button>
              {RESTARTABLE[obj.kind] !== undefined && (
                <GatedButton allowed={canRestart} busy={restarting} variant="ghost" size="icon-xs" onClick={() => setMode('restart')} ariaLabel={tr('res:restartTitle')} title={tr('res:restartTitle')}>
                  <RefreshCw className="size-3.5" />
                </GatedButton>
              )}
            </span>
          </div>
          {podsQ.isError ? (
            // 读不到≠没有：pod 列表拉失败不能演成「这个负载没有 pod」
            <p className="px-2 py-2 text-xs text-destructive">{tr('sys:podsUnreadable')}</p>
          ) : pods.length === 0 && !podsQ.isPending ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">{tr('sys:podsNone')}</p>
          ) : (
            <div className="max-h-56 overflow-auto border-t border-border/60 pt-1">
              {pods.map(p => {
                const phase = p.status?.phase ?? 'Unknown'
                const rs = restarts(p)
                const reason = waitingReason(p)
                // 异常 chip 统一语义 bg-{tone}/10 text-{tone}：reason 走 severityTone；
                // 未入表的 reason（BackOff 类）本身就是异常事实，默认 negative
                const chipTone = reason ? (severityTone(reason) === 'muted' ? ('negative' as const) : severityTone(reason)) : ('caution' as const)
                return (
                  <NavLink
                    key={p.metadata.uid ?? p.metadata.name}
                    to={detailRoute({ kind: 'Pod', scope: 'namespaced' }, cluster, p.metadata.namespace ?? ns, p.metadata.name)}
                    className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent"
                  >
                    <span className={`min-w-12 shrink-0 font-mono ${phaseClass(phase)}`}>
                      <FlashVal v={phase}>{phase}</FlashVal>
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono">{p.metadata.name}</span>
                    {(reason || rs > 0) && (
                      // 同一「在崩」事实只出现一次：有 reason 就并入 ×N（此前两徽章并排
                      // 把 pod 名挤到 129px）
                      <span
                        className={`shrink-0 rounded px-1 text-xs tabular-nums ${toneChip[chipTone]}`}
                        title={`${reason ?? tr('sys:containerRestarts')}${rs > 0 ? ` ×${rs}` : ''}`}
                      >
                        <FlashVal v={`${reason ?? ''}:${rs}`}>
                          {reason ? `${reason}${rs > 0 ? `×${rs}` : ''}` : `↑${rs}`}
                        </FlashVal>
                      </span>
                    )}
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{agoShort(p.metadata.creationTimestamp)}</span>
                  </NavLink>
                )
              })}
            </div>
          )}
          {mode && (
            // 两段式确认收进同一浮层：嵌套 modal 的取消/确认那一下会穿透到底下行
            <div className="mt-1.5 border-t border-border/60 pt-2">
              <p className="px-2 pb-2 text-xs leading-5 text-muted-foreground" role="status">
                {mode === 'restart'
                  ? tf('sys:restartRowConfirm', { name: obj.metadata.name, n: pods.length })
                  : tf('sys:zeroScaleDesc', { name: obj.metadata.name })}
              </p>
              <div className="flex justify-end gap-2">
                <Button ref={cancelRef} size="xs" variant="outline" disabled={restarting || scaling} onClick={() => setMode(null)}>
                  {tr('ui:cancel')}
                </Button>
                <Button
                  size="xs"
                  variant={mode === 'restart' ? 'default' : 'destructive'}
                  disabled={restarting || scaling}
                  onClick={() => (mode === 'restart' ? void doRestart() : void applyZero())}
                >
                  {(restarting || scaling) && <Loader2 className="size-3.5 animate-spin" />}
                  {mode === 'restart' ? tr('res:restartRolloutBtn') : tr('res:apply')}
                </Button>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <WorkloadLogsDialog open={logsOpen} onOpenChange={setLogsOpen} cluster={cluster} ns={ns} path={path} name={obj.metadata.name} />
    </>
  )
}

/** useFlash 接线点：弹层在途期间 pod 数据真实刷新（如重启后 invalidate）时 currentColor 闪一下 */
function FlashVal({ v, children }: { v: unknown; children: ReactNode }) {
  const { flash, onEnd } = useFlash(v)
  return (
    <span data-flash={flash || undefined} onAnimationEnd={onEnd}>
      {children}
    </span>
  )
}
