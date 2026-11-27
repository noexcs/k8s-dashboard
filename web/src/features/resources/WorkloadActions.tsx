// workload 头部动作：扩缩容（/scale 子资源 PATCH）+ 重启（逐个删该 owner 的 pod，间隔 500ms）
// + 聚合日志（多 Pod 合流弹窗）。Scale 仅 Deployment/StatefulSet/ReplicaSet；重启仅前三种 workload。
import { Loader2, MoreHorizontal, RotateCcw, Scaling, ScrollText } from 'lucide-react'
import { WorkloadLogsDialog } from './WorkloadLogsDialog'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, deleteObject, get, list, patchObject, podsPath } from '@/api/client'
import { usePermissions, type PermissionCheck } from '@/hooks/usePermissions'
import { itemPath, type AnyResourceDef } from '@/resources/registry'
import type { K8sObject } from '@/api/types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { GatedButton } from '@/components/GatedButton'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldContent, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { t, tf, useT } from '@/i18n'

const WORKLOAD_KINDS: Record<string, true> = {
  Deployment: true,
  StatefulSet: true,
  DaemonSet: true,
  ReplicaSet: true,
  // Job 无 scale/restart 操作（spec.replicas 语义是并行度，UI 不冒充"副本数"）
}
/** 有 replicas 语义、可走 /scale 子资源的 kind。DaemonSet 不在列：
 *  typed spec 无 replicas 字段，写入被 apiserver 静默丢弃（PUT 返回 200 但
 *  零变化）——按 kind 收口，杜绝"toast 成功而集群没发生" */
const SCALEABLE: Record<string, true> = {
  Deployment: true,
  StatefulSet: true,
  ReplicaSet: true,
}
export const RESTARTABLE: Record<string, true> = {
  Deployment: true,
  StatefulSet: true,
  DaemonSet: true,
  ReplicaSet: true,
}
const RESTART_DELAY_MS = 500

/** 重启要删的 Pod：按 ownerReferences[0].uid 匹配（打开时 list 该 ns 的 pods） */
export async function findWorkloadPods(
  cluster: string,
  path: string,
  ns: string,
): Promise<K8sObject[]> {
  const obj = await get<K8sObject>(cluster, path)
  const uid = obj.metadata.uid
  const res = await list(cluster, podsPath(ns))
  // Deployment 的 Pod 由 ReplicaSet 间接拥有（ownerReference 指向 RS）：
  // 先找该 Deployment 拥有的 RS，再按 RS uid 匹配 Pod
  if (obj.kind === 'Deployment') {
    const rsRes = await list(cluster, `/apis/apps/v1/namespaces/${ns}/replicasets`)
    const rsUids = rsRes.items
      .filter(r => (r.metadata.ownerReferences ?? []).some(o => o.uid === uid))
      .map(r => r.metadata.uid)
    return res.items.filter(p => rsUids.includes(p.metadata.ownerReferences?.[0]?.uid ?? ''))
  }
  return res.items.filter(p => p.metadata.ownerReferences?.[0]?.uid === uid)
}

/** 逐个删除 Pod（间隔 500ms），控制器自动重建；返回删除/失败统计并 toast。 */
export async function restartWorkloadPods(
  cluster: string,
  pods: K8sObject[],
  invalidate: () => void,
): Promise<void> {
  let done = 0
  let failed: string | null = null
  for (const p of pods) {
    try {
      await deleteObject(cluster, `${podsPath(p.metadata.namespace ?? 'default')}/${p.metadata.name}`, '删除重启（ReplicaSet 无滚动机制）')
      done++
    } catch (err) {
      failed = err instanceof ApiError ? `${p.metadata.name}: ${err.message}` : `${p.metadata.name}: ${String(err)}`
    }
    if (done < pods.length) {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, RESTART_DELAY_MS)
      await promise
    }
  }
  invalidate()
  if (pods.length === 0) toast.info(t('res:noPodsToDelete'))
  else if (failed) toast.error(tf('res:restartPartial', { done, total: pods.length, failed }))
  else toast.success(tf('res:restartDone', { n: pods.length }))
}

/**
 * 滚动方式重启（FL17#1）：patch 模板注解 restartedAt，控制器按滚动策略逐个替换 Pod，
 * 与 kubectl rollout restart / AI 侧 tools-deploy 同一语义。此前人手路径按 ownerRef
 * 匹配名下全部 RS 直接删 pod——滚动未完成时旧 RS 的 pod 还在扛流量，一把全删=自造
 * 完整故障窗口（AI 手比人手安全）。ReplicaSet 的 template 不可变、无 rollout 机制，
 * 只能删 pod 重启，保留 restartWorkloadPods 专供它。
 */
export const ROLLOUT_RESTARTABLE: Record<string, true> = { Deployment: true, StatefulSet: true, DaemonSet: true }
export async function restartWorkloadRollout(cluster: string, path: string, note?: string): Promise<void> {
  await patchObject(
    cluster,
    path,
    { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } },
    note ?? '滚动重启（restartedAt 注解）',
  )
}

/** 扩缩容走 /scale 子资源，不再读改写全对象 */

/**
 * 「更多」菜单通用动作项：ghost GatedButton 门控与头部 outline 版一致——
 * 无权限禁用 + 「无权限」tooltip；禁用态 onSelect preventDefault 防误关菜单。
 * 注意：项若带对话框/busy 态，菜单 Content 必须 forceMount + `data-[state=closed]:hidden`——
 * 否则菜单收起会连带卸载子树，对话框永远打不开、busy 丢失。
 */
export function ActionMenuItem({
  allowed,
  busy = false,
  onSelect,
  icon,
  label,
}: {
  allowed: boolean
  busy?: boolean
  onSelect: () => void
  icon: ReactNode
  label: string
}) {
  return (
    <DropdownMenuItem
      // 高亮必须走 item 的 focus:bg-accent（Radix hover 也会把 focus 移到 item）：
      // 内钮 pointer-events-none 收不到 :hover，任何 focus:bg-transparent 都会让菜单项零反馈
      className="p-0"
      // 动作挂 menuitem.onSelect：Radix 对鼠标点击与 Enter 都走 select——
      // 动作若挂内钮 onClick，键盘 Enter 只触发 select，内钮永不响应（v6 实测 dialog:false）。
      // 内钮纯展示（pointer-events-none），门控 tooltip 由外层 span 承接。
      onSelect={e => {
        if (!allowed) {
          e.preventDefault()
          return
        }
        onSelect()
      }}
    >
      <GatedButton allowed={allowed} busy={busy} variant="ghost" className="pointer-events-none w-full justify-start">
        {icon}
        {label}
      </GatedButton>
    </DropdownMenuItem>
  )
}

/**
 * 聚合日志「更多」菜单项（F10 头栏收敛的可复用件）：ghost GatedButton 门控与 outline 版一致——
 * 无权限禁用 + 「无权限」tooltip；disabled 时 onSelect 阻止菜单关闭。
 * 注意：日志弹窗不要挂在本组件内部——菜单收起会连带卸载它；由父级（如 ResourceDetailPage）
 * 持有 open 态并渲染 WorkloadLogsDialog（门控用 useAggLogsGate 或自供 allowed）。
 */
export function WorkloadLogsMenuItem({ allowed, onSelect }: { allowed: boolean; onSelect: () => void }) {
  const t = useT()
  return (
    <ActionMenuItem
      allowed={allowed}
      onSelect={onSelect}
      icon={<ScrollText className="size-3.5" />}
      label={t('res:aggLogs')}
    />
  )
}

/** 聚合日志入口门控：pods/log get 的 SSAR（与 WorkloadActions 内置 canLogs 同口径） */
export function useAggLogsGate(cluster: string, ns: string): boolean {
  const checks = useMemo<PermissionCheck[]>(
    () => [{ verb: 'get', group: '', version: 'v1', resource: 'pods/log', namespace: ns }],
    [ns],
  )
  const { can } = usePermissions(cluster, checks)
  return can(checks[0])
}

interface WorkloadActionsProps {
  def: AnyResourceDef
  cluster: string
  ns: string // namespaced kind 的真实 ns
  name: string
  /** 当前 spec.replicas（父组件已从 yaml 解析，undefined = 未声明） */
  currentReplicas: number | undefined
  /** 头栏统一「更多」菜单外部装配时传 true：只留扩缩容/重启按钮，
   *  聚合日志项由父级用 WorkloadLogsMenuItem 放进共享菜单、弹窗由父级渲染 */
  menuMode?: boolean
}

export function WorkloadActions({ def, cluster, ns, name, currentReplicas, menuMode = false }: WorkloadActionsProps) {
  const queryClient = useQueryClient()
  const path = itemPath(def, ns, name)
  const t = useT()
  const isWorkload = WORKLOAD_KINDS[def.kind] !== undefined
  // 权限：扩缩容 = update 该 workload；重启 = delete 该 ns 的 pods
  // （非 workload kind 传空 checks，不发 SSR 请求；can 调用用 isWorkload 短路）
  const checks = useMemo<PermissionCheck[]>(
    () =>
      isWorkload
          ? [
            // scale 走 /scale 子资源 PATCH → RBAC 真身是 <resource>/scale 的 patch（HTTP PATCH→patch verb）；
            // update 是 kubectl scale 惯例授权位——两条都查、任一放行，单向授权不再双向错配
            { verb: 'update', group: def.group, version: def.version, resource: `${def.resource}/scale`, namespace: ns },
            { verb: 'patch', group: def.group, version: def.version, resource: `${def.resource}/scale`, namespace: ns },
            { verb: 'delete', group: '', version: 'v1', resource: 'pods', namespace: ns },
            // 聚合日志门控 = pods/log get。注意：仅当代理转发用户身份时这才是 RBAC 真相；
            // 服务端 kubeconfig 透传形态下 SSAR 查的是代理身份（恒真），此门控只是 UI 提示
            { verb: 'get', group: '', version: 'v1', resource: 'pods/log', namespace: ns },
            // 滚动重启=restartedAt 注解 → RBAC 真相是 patch 本体；仅 RS 的删 pod 重启才查 delete pods
            { verb: 'patch', group: def.group, version: def.version, resource: def.resource, namespace: ns },
          ]
        : [],
    [isWorkload, def, ns],
  )
  const { can } = usePermissions(cluster, checks)
  const canScale = isWorkload && (can(checks[0]) || can(checks[1]))
  const rolloutRestart = ROLLOUT_RESTARTABLE[def.kind] !== undefined
  const canRestart = isWorkload && can(rolloutRestart ? checks[4] : checks[2])
  const canLogs = isWorkload && can(checks[3])
  const [scaleOpen, setScaleOpen] = useState(false)
  const [scaleVal, setScaleVal] = useState(currentReplicas ?? 1)
  const [applying, setApplying] = useState(false)
  const [restartOpen, setRestartOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)

  // 打开对话框时以最新 spec.replicas 为默认值
  useEffect(() => {
    if (scaleOpen) setScaleVal(currentReplicas ?? 1)
  }, [scaleOpen, currentReplicas])

  // HPA 托管提示：直改 replicas 会被控制器按 min/max 抹掉（与行内弹层/AI scale 工具同口径）
  const hpaQ = useQuery({
    queryKey: ['wl-hpa', cluster, ns],
    queryFn: async () => {
      const p = (v: string) => `/apis/autoscaling/${v}/namespaces/${ns}/horizontalpodautoscalers`
      try {
        return await list<K8sObject & { spec?: { scaleTargetRef?: { kind?: string; name?: string }; minReplicas?: number; maxReplicas?: number } }>(cluster, p('v2'))
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return await list<K8sObject & { spec?: { scaleTargetRef?: { kind?: string; name?: string }; minReplicas?: number; maxReplicas?: number } }>(cluster, p('v1'))
        throw e
      }
    },
    enabled: scaleOpen && SCALEABLE[def.kind] !== undefined,
    staleTime: 30_000,
    retry: 0,
  })
  const hpaOwner = (hpaQ.data?.items ?? []).find(
    h => h.spec?.scaleTargetRef?.kind === def.kind && h.spec?.scaleTargetRef?.name === name,
  )

  if (!WORKLOAD_KINDS[def.kind]) return null

  const invalidate = () => {
    // 列表页走 useWatch（watch 帧自动更新）；详情页 yaml 缓存在此失效
    void queryClient.invalidateQueries({ queryKey: ['yaml', cluster, path] })
  }

  const doScale = async () => {
    setApplying(true)
    try {
      // scale 子资源（与 ai-exec scale 工具同姿势）：不读改写全对象——全量 PUT
      // 会把 resourceVersion 竞态与脏字段带进 spec；子资源只动 replicas
      const before = await get<K8sObject>(cluster, `${path}/scale`)
        .then(o => (o as unknown as { spec?: { replicas?: number } }).spec?.replicas)
        .catch(() => undefined)
      await patchObject(cluster, `${path}/scale`, { spec: { replicas: scaleVal } }, `副本 ${before ?? '?'} → ${scaleVal}（来自详情页）`)
      invalidate()
      setScaleOpen(false)
      const from = before ?? t('res:notSet')
      toast.success(tf('res:scaleSuccess2', { kind: def.kind, name, from, to: scaleVal }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  const doRestart = async (pods: K8sObject[]) => {
    setRestarting(true)
    try {
      if (ROLLOUT_RESTARTABLE[def.kind]) {
        // pods 列表读失败时不写「0 个 Pod」假账：注解重启不依赖 pod 清单（与行内弹层同式）
        await restartWorkloadRollout(cluster, path, pods.length ? `滚动重启 ${pods.length} 个 Pod` : '滚动重启（restartedAt 注解，pod 清单未确认）')
        toast.success(t('res:restartRolloutDone'))
        invalidate()
      } else {
        await restartWorkloadPods(cluster, pods, invalidate)
      }
    } catch (err) {
      // UX#3：失败必须响——此前 finally 吞异常，用户以为重启了
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRestarting(false)
      setRestartOpen(false)
    }
  }

  return (
    <>
      {SCALEABLE[def.kind] && (
        <GatedButton allowed={canScale} onClick={() => setScaleOpen(true)}>
          <Scaling className="size-3.5" />
          {t('res:scale')}
        </GatedButton>
      )}
      {RESTARTABLE[def.kind] && (
        <GatedButton allowed={canRestart} onClick={() => setRestartOpen(true)}>
          <RotateCcw className="size-3.5" />
          {t('res:restart')}
        </GatedButton>
      )}
      {/* F10 头栏收敛：高频动作（扩缩容/重启）外置，低频动作入「更多」菜单。
          聚合日志：滚动发布时新旧 Pod 日志合流一眼看全（Stern 式），不必逐个进 Pod。
          menuMode = 头栏已有统一「更多」菜单（父级装配），本组件不再自带菜单与日志弹窗 */}
      {!menuMode && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="xs" className="gap-1">
                <MoreHorizontal className="size-3.5" />
                {t('res:menuMore')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
              <WorkloadLogsMenuItem allowed={canLogs} onSelect={() => setLogsOpen(true)} />
            </DropdownMenuContent>
          </DropdownMenu>
          <WorkloadLogsDialog open={logsOpen} onOpenChange={setLogsOpen} cluster={cluster} ns={ns} path={path} name={name} />
        </>
      )}

      <AlertDialog open={scaleOpen} onOpenChange={v => !applying && setScaleOpen(v)}>
        <AlertDialogContent className="w-fit min-w-88 max-w-[92vw]">
          <AlertDialogHeader>
            <AlertDialogTitle className="whitespace-nowrap">{tf('res:scaleTitle', { kind: def.kind, name })}</AlertDialogTitle>
            <AlertDialogDescription>{tf('res:scaleDesc', { current: currentReplicas ?? t('res:notSet') })}</AlertDialogDescription>
          </AlertDialogHeader>
          <Field className="gap-1.5">
            <FieldLabel className="text-[13px]">{t('res:replicas')}</FieldLabel>
            <FieldContent>
              <Input
                type="number"
                min={0}
                className="w-28 font-mono"
                value={scaleVal}
                onChange={e => setScaleVal(Math.max(0, Number(e.target.value) || 0))}
              />
            </FieldContent>
          </Field>
          {hpaQ.isError && !hpaOwner && (
            // 查不到托管状态就不放行：假成功比不给改危险（与行内弹层同口径 fail-closed）
            <p className="text-xs text-caution" role="note">
              {t('sys:hpaUnknownDialog')}
            </p>
          )}
          {hpaQ.isPending && !hpaOwner && (
            // 查询在途就放行 = 窗口内应用会被 HPA 静默抹掉的「假成功」；与行内弹层同口径收口
            <p className="text-xs text-muted-foreground" role="note" aria-busy="true">
              {t('sys:hpaChecking')}
            </p>
          )}
          {hpaOwner && (
            <p className="text-xs text-caution" role="note">
              {tf('res:hpaScaleWarn', {
                hpa: hpaOwner.metadata?.name ?? '?',
                min: hpaOwner.spec?.minReplicas ?? '?',
                max: hpaOwner.spec?.maxReplicas ?? '?',
              })}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applying}>
              {t('res:cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              // owner 态必须禁用：文案写着「会被调回」而按钮可点=假成功，与行内弹层/AI 同口径收口
              disabled={applying || hpaQ.isPending || hpaQ.isError || !!hpaOwner}
              onClick={e => {
                e.preventDefault()
                void doScale()
              }}
            >
              {applying && <Loader2 className="size-3.5 animate-spin" />}
              {t('res:apply')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {RESTARTABLE[def.kind] && (
        <RestartDialog
          open={restartOpen}
          onOpenChange={v => !restarting && setRestartOpen(v)}
          busy={restarting}
          rollout={rolloutRestart}
          cluster={cluster}
          ns={ns}
          path={path}
          onConfirm={pods => void doRestart(pods)}
        />
      )}
    </>
  )
}

/** 重启确认：按 ownerReferences[0].uid 匹配该 owner 的 Pod（打开时 list 该 ns 的 pods） */
function RestartDialog({
  open,
  onOpenChange,
  busy,
  rollout,
  cluster,
  ns,
  path,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  busy: boolean
  /** true = restartedAt 滚动替换（非删 pod）：pod 名单只是参考，读失败不拦操作 */
  rollout?: boolean
  cluster: string
  ns: string
  path: string
  onConfirm: (pods: K8sObject[]) => void
}) {
  const { data, isLoading, isFetching, isError, error } = useQuery({
    queryKey: ['owner-pods', cluster, path],
    queryFn: () => findWorkloadPods(cluster, path, ns),
    enabled: open,
    staleTime: 0,
  })
  const pods = data ?? []
  const t = useT()

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('res:restartTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {rollout ? (isError && pods.length === 0 ? t('res:restartRolloutDescUnknown') : tf('res:restartRolloutDesc', { n: pods.length })) : tf('res:restartDesc', { n: pods.length, delay: RESTART_DELAY_MS })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-40 space-y-1 overflow-auto rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs">
          {isLoading && <div className="font-sans text-[13px] text-muted-foreground">{t('res:queryingPods')}</div>}
          {!isLoading && isFetching && (
            <div className="font-sans text-[13px] text-muted-foreground">{t('res:refreshingPods')}</div>
          )}
          {pods.map(p => (
            <div key={p.metadata.uid} className="truncate">
              {p.metadata.namespace}/{p.metadata.name}
            </div>
          ))}
          {!isLoading && !isFetching && pods.length === 0 && (
            <div className="font-sans text-[13px] text-muted-foreground">
              {isError ? tf('res:queryFailed', { msg: error?.message ?? t('res:unknownError') }) : t('res:noMatchingPods')}
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            {t('res:cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={rollout ? 'default' : 'destructive'}
            disabled={busy || (rollout ? isLoading || isFetching : isLoading || isFetching || pods.length === 0)}
            onClick={e => {
              e.preventDefault()
              onConfirm(pods)
            }}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? t('res:deleting') : rollout ? tf('res:restartRolloutBtn') : tf('res:deletePods', { n: pods.length })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
