// Node 专用详情页：/c/:cluster/r/Node/cluster/:name
// 概览（conditions/taints/addresses/capacity/节点信息）+ 节点上的 Pod（watch）+ YAML（只读）+
// cordon/uncordon/drain + 删除。
import { FileCodeIcon, Loader2, ShieldBan, ShieldCheck, Trash2, Zap } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, deleteObject, evictPod, getAsYaml, list, patchObject, podsPath } from '@/api/client'
import { tf, useT } from '@/i18n'
import type { K8sObject, Pod } from '@/api/types'
import { useNodeMetric } from '@/hooks/useMetrics'
import { Q, usePromRange, usePrometheus } from '@/hooks/usePrometheus'
import { SectionTitle } from '@/components/SectionTitle'
import { PromTrend } from '@/components/PromTrend'
import { usePermissions, type PermissionCheck } from '@/hooks/usePermissions'
import { useWatch } from '@/hooks/useWatch'
import { cpuDisplay, fmtTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { GatedButton } from '@/components/GatedButton'
import { UsageCell } from '@/components/UsageCell'
import { NodeShell } from './NodeShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block'
import { useCodeActions } from '@/components/code-actions'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { FileQuestion } from 'lucide-react'
import { Link } from 'react-router-dom'

/** 详情页需要的 Node 字段面（api/types 的 Node 只覆盖列表列） */
interface NodeData extends K8sObject {
  spec?: { unschedulable?: boolean; taints?: { key: string; value?: string; effect: string }[] }
  status?: {
    conditions?: { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }[]
    addresses?: { type: string; address: string }[]
    capacity?: Record<string, string>
    allocatable?: Record<string, string>
    nodeInfo?: { kubeletVersion?: string; osImage?: string; kernelVersion?: string; containerRuntimeVersion?: string }
  }
}

const NODES_PATH = '/api/v1/nodes'

/** 压力类条件着色反转：False 才是健康态；其余（Ready/*Sufficient* 等）True 为健康 */
const PRESSURE_CONDITIONS: Record<string, true> = {
  MemoryPressure: true,
  DiskPressure: true,
  PIDPressure: true,
}

export function NodeDetailPage() {
  const t = useT()
  const { cluster, name } = useParams()
  const navigate = useNavigate()
  const nodeName = name!
  const clusterName = cluster!

  const watch = useWatch<NodeData>({
    cluster: clusterName,
    path: NODES_PATH,
    params: { fieldSelector: `metadata.name=${nodeName}` },
  })
  const node = watch.items[0]

  // metrics-server 实时用量（详情页资源表 Usage 列）；无 metrics-server → error，列显示 '-'
  const usage = useNodeMetric(clusterName, nodeName)

  const [tab, setTab] = useState<'overview' | 'pods' | 'shell' | 'monitor' | 'yaml'>('overview')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [cordonBusy, setCordonBusy] = useState(false)
  const [drainOpen, setDrainOpen] = useState(false)
  /** 确认框打开时预列举的驱逐目标（执行前让用户看见会动哪些 Pod） */
  const [drainPreview, setDrainPreview] = useState<Pod[] | null>(null)
  /** 裸 Pod（无控制器）驱逐显式确认——kubectl drain 该场景默认拒绝，--force 才动 */
  const [drainAckOrphan, setDrainAckOrphan] = useState(false)

  // RBAC：cordon/drain 需 update nodes；删除需 delete nodes（cluster-scoped）；
  // shell tab 建 helper Pod 需 default ns 的 create pods
  const checks = useMemo<PermissionCheck[]>(
    () => [
      { verb: 'delete', group: '', version: 'v1', resource: 'nodes' },
      { verb: 'update', group: '', version: 'v1', resource: 'nodes' },
      { verb: 'delete', group: '', version: 'v1', resource: 'pods' },
      { verb: 'create', group: '', version: 'v1', resource: 'pods', namespace: 'default' },
    ],
    [],
  )
  const { can } = usePermissions(clusterName, checks)
  const canDelete = can(checks[0])
  const canUpdate = can(checks[1])
  const canDeletePods = can(checks[2])
  const canCreateShell = can(checks[3])

  const doDelete = async () => {
    setDeleting(true)
    try {
      await deleteObject(clusterName, `${NODES_PATH}/${nodeName}`)
      toast.success(tf('sys:nodeDeleted', { name: nodeName }))
      navigate(`/c/${clusterName}/r/Node`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  const setSchedulable = async (schedulable: boolean) => {
    setCordonBusy(true)
    try {
      // watch 流（fieldSelector 过滤本节点）会自动收到 PATCH 帧，UI 无需手动失效缓存
      await patchObject(clusterName, `${NODES_PATH}/${nodeName}`, { spec: { unschedulable: !schedulable } })
      toast.success(schedulable ? t('sys:uncordonDone') : t('sys:cordonDone'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCordonBusy(false)
    }
  }

  const [drainBusy, setDrainBusy] = useState(false)
  const [drainDone, setDrainDone] = useState(0)
  const [drainForceDs, setDrainForceDs] = useState(false)
  const [drainTargets, setDrainTargets] = useState<Pod[]>([])
  /** 驱逐一个 Pod；eviction 端点缺失（404/405）回退直接 DELETE（对齐 kubectl 回退语义） */
  const evictOrDelete = async (p: Pod, grace: number) => {
    try {
      await evictPod(clusterName, p.metadata.namespace ?? 'default', p.metadata.name, grace, `驱逐（排水节点 ${nodeName}）`)
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 405))
        // 回退直删同样要留痕：排水是最危险的人为批量动作，账上不能只剩 verb
        await deleteObject(clusterName, `${podsPath(p.metadata.namespace ?? 'default')}/${p.metadata.name}`, `驱逐回退直删（排水节点 ${nodeName}，eviction 端点缺失）`)
      else throw err
    }
  }
  /** 驱逐目标过滤（预览与执行共用口径）：完成/失败 Pod、static pod 永不入选；
   *  DaemonSet 按勾选；无控制器裸 Pod 需显式 ack（kubectl --force 语义） */
  const drainFilter = (p: Pod, forceDs: boolean, ackOrphan: boolean) => {
    if (p.status?.phase === 'Succeeded' || p.status?.phase === 'Failed') return false
    const owners = p.metadata.ownerReferences ?? []
    if (owners.some(o => o.kind === 'Node')) return false // static pod（kubelet 直管，API 删不掉）
    if (!forceDs && owners.some(o => o.kind === 'DaemonSet')) return false
    if (owners.length === 0 && !ackOrphan) return false
    return true
  }
  /** 预览口径含裸 Pod（UI 标红让用户确认），执行口径按 ack 收 */
  const listDrainTargets = async () => {
    const res = await list<Pod>(clusterName, '/api/v1/pods', { fieldSelector: `spec.nodeName=${nodeName}` })
    return res.items.filter(p => drainFilter(p, drainForceDs, true))
  }
  const openDrain = () => {
    setDrainOpen(true)
    setDrainAckOrphan(false)
    setDrainPreview(null)
    void listDrainTargets().then(setDrainPreview).catch(() => setDrainPreview(null))
  }
  const drainOrphans = (drainPreview ?? []).filter(p => (p.metadata.ownerReferences ?? []).length === 0)
  const runDrain = async () => {
    setDrainBusy(true)
    setDrainDone(0)
    let failed = 0
    try {
      // 1. cordon（drain 前置：先阻止新调度，失败即中止）
      await patchObject(clusterName, `${NODES_PATH}/${nodeName}`, { spec: { unschedulable: true } })
      // 2. 节点上的 Pod（一次性 list，不用缓存 watch 视图；无控制器裸 Pod
      // 仅在确认框显式 ack 后才执行——对齐 kubectl drain 默认拒绝语义）
      const all = await listDrainTargets()
      const targets = all.filter(p => (p.metadata.ownerReferences ?? []).length > 0 || drainAckOrphan)
      setDrainTargets(targets)
      // 3. 逐个驱逐（Eviction 尊重 PDB），进度回显
      for (const p of targets) {
        try {
          await evictOrDelete(p, 30)
        } catch {
          failed++
        }
        setDrainDone(n => n + 1)
      }
      setDrainOpen(false)
      setDrainTargets([])
      if (failed) toast.error(tf('sys:drainPartial', { done: targets.length - failed, failed }))
      else toast.success(tf('sys:drainDone', { name: nodeName, n: targets.length }))
    } catch (err) {
      setDrainOpen(false)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDrainBusy(false)
    }
  }

  if (watch.error && !node) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {tf('sys:loadFailed', { msg: watch.error })}
      </div>
    )
  }
  if (!node) {
    if (watch.lastSync) {
      return (
        <NotFoundState title={t('sys:nodeNotFound')} desc={tf('sys:nodeNotFoundDesc', { name: nodeName })} to={`/c/${clusterName}/r/Node`} />
      )
    }
    return <div className="p-4 text-sm text-muted-foreground">{t('sys:loading')}</div>
  }

  const ready = node.status?.conditions?.find(c => c.type === 'Ready')
  // 控制面节点可能带裸标签 node-role.kubernetes.io/（空 role）→ 过滤空串
  const roles = Object.keys(node.metadata.labels ?? {})
    .filter(k => k.startsWith('node-role.kubernetes.io/'))
    .map(k => k.slice('node-role.kubernetes.io/'.length))
    .filter(r => r !== '')

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-3">
        <span className={cn('size-2 shrink-0 rounded-full', ready?.status === 'True' ? 'bg-positive' : 'bg-destructive')} />
        <h1 className="min-w-0 truncate font-mono text-sm font-medium" title={nodeName}>
          {nodeName}
        </h1>
        <CodeBlockCopyButton value={nodeName} className="shrink-0" aria-label={t('sys:copyNodeName')} />
        <Badge variant={ready?.status === 'True' ? 'secondary' : 'destructive'}>
          {ready?.status === 'True' ? 'Ready' : 'NotReady'}
        </Badge>
        {node.spec?.unschedulable && (
          <Badge variant="secondary" className="bg-caution/10 text-caution">
            {t('sys:schedulingDisabled')}
          </Badge>
        )}
        {roles.map(r => (
          <Badge key={r} variant="secondary" className="max-w-40 truncate font-normal text-muted-foreground">
            {r}
          </Badge>
        ))}
        <span className="hidden text-[13px] text-muted-foreground lg:inline">
          {node.status?.nodeInfo?.kubeletVersion}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {node.spec?.unschedulable ? (
            <GatedButton allowed={canUpdate} variant="outline" busy={cordonBusy} onClick={() => void setSchedulable(true)}>
              <ShieldCheck className="size-3.5" />
              {t('sys:uncordon')}
            </GatedButton>
          ) : (
            <GatedButton allowed={canUpdate} variant="outline" busy={cordonBusy} onClick={() => void setSchedulable(false)}>
              <ShieldBan className="size-3.5" />
              {t('sys:cordon')}
            </GatedButton>
          )}
          <GatedButton allowed={canUpdate && canDeletePods} variant="outline" onClick={openDrain}>
            <Zap className="size-3.5" />
            {t('sys:drain')}
          </GatedButton>
          <GatedButton allowed={canDelete} variant="ghost" destructive onClick={() => setConfirmDelete(true)}>
            <Trash2 className="size-3.5" />
            {t('sys:delete')}
          </GatedButton>
        </div>
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList variant="line" className="mb-3 w-full justify-start border-b">
          <TabsTrigger value="overview">{t('sys:tabOverview')}</TabsTrigger>
          <TabsTrigger value="pods">{t('sys:nodePodsTab')}</TabsTrigger>
          <TabsTrigger value="shell">{t('shell:tab')}</TabsTrigger>
          <TabsTrigger value="monitor">{t('sys:tabMonitor')}</TabsTrigger>
          <TabsTrigger value="yaml">YAML</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-3 min-h-0 flex-1 space-y-3 overflow-auto">
          {node.status?.conditions && node.status.conditions.length > 0 && (
            <Card>
              <CardContent className="pt-3">
                <SectionTitle>{t('res:conditionsLabel')}</SectionTitle>
                <div className="space-y-1.5">
                  {node.status.conditions.map(c => {
                    const ok = PRESSURE_CONDITIONS[c.type] !== undefined ? c.status === 'False' : c.status === 'True'
                    return (
                    <div
                      key={c.type}
                      className={cn(
                        'flex items-start gap-3 rounded-md border px-3 py-2 text-[13px]',
                        c.type === 'Ready'
                          ? c.status === 'True'
                            ? 'border-positive/40 bg-positive/5'
                            : 'border-destructive/40 bg-destructive/5'
                          : PRESSURE_CONDITIONS[c.type] !== undefined && c.status === 'True'
                            ? 'border-destructive/40 bg-destructive/5'
                            : '',
                      )}
                    >
                      <span className="w-28 shrink-0 font-medium">{c.type}</span>
                      <span
                        className={cn(
                          'w-12 shrink-0',
                          c.status === 'Unknown'
                            ? 'text-muted-foreground'
                            : ok
                              ? 'text-positive'
                              : 'text-destructive',
                        )}
                      >
                        {c.status}
                      </span>
                      <span className="min-w-0 flex-1 text-muted-foreground">
                        {c.reason && <span className="mr-2 font-medium">{c.reason}</span>}
                        {c.message && <span className="truncate" title={c.message}>{c.message}</span>}
                      </span>
                    </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card>
              <CardContent className="pt-3">
                <SectionTitle>{t('sys:nodeInfo')}</SectionTitle>
                <dl className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[13px]">
                  <Info k={t('sys:kubeletVersion')} v={node.status?.nodeInfo?.kubeletVersion} mono />
                  <Info k={t('sys:osImage')} v={node.status?.nodeInfo?.osImage} />
                  <Info k={t('sys:kernel')} v={node.status?.nodeInfo?.kernelVersion} mono />
                  <Info k={t('sys:containerRuntime')} v={node.status?.nodeInfo?.containerRuntimeVersion} mono />
                  <Info k={t('sys:created')} v={fmtTime(node.metadata.creationTimestamp)} />
                  <Info k="UID" v={node.metadata.uid} mono />
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-3">
                <SectionTitle>{t('sys:resourcesHeader')}</SectionTitle>
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-1 font-medium">{t('sys:colResource')}</th>
                      <th className="py-1 text-right font-medium">{t('sys:nodeCapacity')}</th>
                      <th className="py-1 text-right font-medium">{t('sys:nodeAllocatable')}</th>
                      <th className="py-1 text-right font-medium" title={usage.isError ? t('sys:metricsUnavailable') : undefined}>
                        {t('sys:colUsage')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-xs">
                    <ResourceRow label="CPU" cap={node.status?.capacity?.cpu} alloc={node.status?.allocatable?.cpu} cpu usage={usage.data?.usage?.cpu} />
                    <ResourceRow label={t('sys:mem')} cap={node.status?.capacity?.memory} alloc={node.status?.allocatable?.memory} usage={usage.data?.usage?.memory} />
                    <ResourceRow label={t('sys:ephemeralStorage')} cap={node.status?.capacity?.['ephemeral-storage']} alloc={node.status?.allocatable?.['ephemeral-storage']} />
                    <ResourceRow label="Pods" cap={node.status?.capacity?.pods} alloc={node.status?.allocatable?.pods} />
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card>
              <CardContent className="pt-3">
                <SectionTitle>{t('sys:nodeAddresses')}</SectionTitle>
                <div className="space-y-1.5">
                  {(node.status?.addresses ?? []).map(a => (
                    <div key={a.type} className="flex items-center gap-2 text-[13px]">
                      <span className="w-24 shrink-0 text-muted-foreground">{a.type}</span>
                      <span className="font-mono text-xs">{a.address}</span>
                    </div>
                  ))}
                  {(node.status?.addresses ?? []).length === 0 && (
                    <div className="text-[13px] text-muted-foreground">{t('sys:none')}</div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-3">
                <SectionTitle>{t('sys:nodeTaints')}</SectionTitle>
                <div className="flex flex-wrap gap-1.5">
                  {(node.spec?.taints ?? []).map(t => (
                    <Badge key={t.key} variant="secondary" className="font-mono text-xs font-normal">
                      {t.key}={t.value ?? ''}:{t.effect}
                    </Badge>
                  ))}
                  {(node.spec?.taints ?? []).length === 0 && (
                    <span className="text-[13px] text-muted-foreground">{t('sys:none')}</span>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="pods" className="mt-3 min-h-0 flex-1 overflow-auto">
          <NodePods cluster={clusterName} nodeName={nodeName} />
        </TabsContent>

        {/* shell 不套 overflow-auto：终端要占满剩余高度（与 PodDetailPage 终端 tab 一致） */}
        <TabsContent value="shell" className="mt-3 min-h-0 flex-1">
          <NodeShell cluster={clusterName} nodeName={nodeName} allowed={canCreateShell} />
        </TabsContent>

        <TabsContent value="monitor" className="mt-3 min-h-0 flex-1 overflow-auto">
          <NodeMonitor cluster={clusterName} nodeName={nodeName} />
        </TabsContent>

        <TabsContent value="yaml" className="mt-3 min-h-0 flex-1">
          <NodeYaml cluster={clusterName} nodeName={nodeName} />
        </TabsContent>
      </Tabs>

      <AlertDialog open={drainOpen} onOpenChange={v => !drainBusy && setDrainOpen(v)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tf('sys:drainTitle', { name: nodeName })}</AlertDialogTitle>
            <AlertDialogDescription>{t('sys:drainDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex cursor-pointer items-center gap-2 text-[13px]">
            <input type="checkbox" className="size-3.5" checked={drainForceDs} onChange={e => setDrainForceDs(e.target.checked)} />
            {t('sys:drainIncludeDs')}
          </label>
          {/* 执行前列出驱逐目标（RestartDialog 同口径）：看不见动哪些 Pod 的破坏性操作不应可确认 */}
          {!drainBusy && drainPreview === null && (
            <div className="text-xs text-muted-foreground">{t('sys:drainListing')}</div>
          )}
          {!drainBusy && drainPreview !== null && (
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2 text-xs">
              {drainPreview.length === 0 ? (
                <div className="text-muted-foreground">{t('sys:drainNoTargets')}</div>
              ) : (
                <>
                  <div className="font-medium">{tf('sys:drainPreviewCount', { n: drainPreview.length })}</div>
                  {drainPreview.slice(0, 12).map(p => {
                    const orphan = (p.metadata.ownerReferences ?? []).length === 0
                    return (
                      <div key={p.metadata.uid} className={cn('flex gap-1.5 font-mono', orphan && 'font-medium text-destructive')}>
                        <span className="shrink-0 text-muted-foreground">{p.metadata.namespace}/</span>
                        <span className="truncate">{p.metadata.name}</span>
                        {orphan && <span className="ml-auto shrink-0">{t('sys:drainOrphanTag')}</span>}
                      </div>
                    )
                  })}
                  {drainPreview.length > 12 && (
                    <div className="text-muted-foreground">{tf('sys:drainMore', { n: drainPreview.length - 12 })}</div>
                  )}
                </>
              )}
            </div>
          )}
          {!drainBusy && drainOrphans.length > 0 && (
            <label className="flex cursor-pointer items-start gap-2 text-[13px] text-destructive">
              <input type="checkbox" className="mt-0.5 size-3.5" checked={drainAckOrphan} onChange={e => setDrainAckOrphan(e.target.checked)} />
              <span>{tf('sys:drainOrphanAck', { n: drainOrphans.length })}</span>
            </label>
          )}
          {drainBusy && (
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">
                {drainTargets.length === 0 ? t('sys:drainListing') : tf('sys:drainProgress', { done: drainDone, total: drainTargets.length })}
              </div>
              {drainTargets.length > 0 && (
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-full origin-left bg-caution transition-transform" style={{ transform: `scaleX(${drainDone / Math.max(drainTargets.length, 1)})` }} />
                </div>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={drainBusy}>{t('sys:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={drainBusy || (drainOrphans.length > 0 && !drainAckOrphan)}
              onClick={e => {
                e.preventDefault()
                void runDrain()
              }}
            >
              {drainBusy && <Loader2 className="size-3.5 animate-spin" />}
              {!drainBusy && <Zap className="size-3.5" />}
              {drainBusy ? t('sys:draining') : t('sys:drain')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={v => !deleting && setConfirmDelete(v)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tf('sys:deleteNodeTitle', { name: nodeName })}</AlertDialogTitle>
            <AlertDialogDescription>{t('sys:deleteNodeDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('sys:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={e => {
                e.preventDefault()
                void doDelete()
              }}
            >
              {deleting && <Loader2 className="size-3.5 animate-spin" />}
              {!deleting && <Trash2 className="size-3.5" />}
              {deleting ? t('sys:deleting') : t('sys:delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 监控 tab：Prometheus 区间趋势（CPU%/内存%/网络收发）。未配置/不可达 → 引导空态。 */
function NodeMonitor({ cluster, nodeName }: { cluster: string; nodeName: string }) {
  const t = useT()
  const { cfg, reachable } = usePrometheus(cluster)
  const RANGE = 3600
  const cpu = usePromRange(cluster, reachable ? cfg : null, reachable ? Q.nodeCpuPct(nodeName) : null, RANGE)
  const mem = usePromRange(cluster, reachable ? cfg : null, reachable ? Q.nodeMemPct(nodeName) : null, RANGE)
  const rx = usePromRange(cluster, reachable ? cfg : null, reachable ? Q.nodeNetRx(nodeName) : null, RANGE)
  const tx = usePromRange(cluster, reachable ? cfg : null, reachable ? Q.nodeNetTx(nodeName) : null, RANGE)
  if (!cfg) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t('sys:promNotConfigured')}</EmptyTitle>
          <EmptyDescription>{t('sys:promConfigHint')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link to={`/c/${cluster}/settings`} className="text-[13px] text-primary underline">
            {t('sys:promGoSettings')}
          </Link>
        </EmptyContent>
      </Empty>
    )
  }
  if (!reachable) return <div className="px-2 py-6 text-center text-[13px] text-muted-foreground">{t('sys:promUnreachable')}</div>
  const netFmt = (v: number) => `${(v / 1048576).toFixed(1)} MB/s`
  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="pt-3">
          <SectionTitle>{t('sys:promCpu')}</SectionTitle>
          <PromTrend series={cpu.data ?? []} unit="%" yMax={100} error={cpu.isError} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-3">
          <SectionTitle>{t('sys:promMem')}</SectionTitle>
          <PromTrend series={mem.data ?? []} unit="%" yMax={100} error={mem.isError} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-3">
          <SectionTitle>{t('sys:promNet')}</SectionTitle>
          <PromTrend
            series={[
              ...(rx.data ?? []).map(s => ({ ...s, name: `RX ${t('sys:promRx')}` })),
              ...(tx.data ?? []).map(s => ({ ...s, name: `TX ${t('sys:promTx')}` })),
            ]}
            unit=""
            valueFmt={netFmt}
            error={rx.isError && tx.isError}
          />
        </CardContent>
      </Card>
    </div>
  )
}

/** 节点上的 Pod：watch 全部命名空间，fieldSelector spec.nodeName */
function NodePods({ cluster, nodeName }: { cluster: string; nodeName: string }) {
  const t = useT()
  const navigate = useNavigate()
  // 全部命名空间：/api/v1/pods + fieldSelector spec.nodeName
  const { items, reconnecting } = useWatch<Pod>({
    cluster,
    path: '/api/v1/pods',
    params: { fieldSelector: `spec.nodeName=${nodeName}` },
  })

  if (reconnecting) return <div className="p-4 text-[13px] text-muted-foreground">{t('sys:reconnecting')}</div>
  if (items.length === 0)
    return (
      <div className="flex h-full min-h-32 items-center justify-center text-[13px] text-muted-foreground">
        {t('sys:noPodsOnNode')}
      </div>
    )

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="grid h-8 items-center gap-2 border-b bg-muted/40 px-3 text-[13px] font-medium text-muted-foreground"
        style={{ gridTemplateColumns: 'minmax(0,2fr) 100px 90px 70px' }}>
        <span>{t('sys:colName')}</span>
        <span>{t('sys:colNamespace')}</span>
        <span>{t('sys:colStatus')}</span>
        <span className="text-right">{t('sys:colRestarts')}</span>
      </div>
      {items.map(p => {
        const restarts = (p.status.containerStatuses ?? []).reduce((n, c) => n + c.restartCount, 0)
        return (
          <button
            key={p.metadata.uid}
            onClick={() => navigate(`/c/${cluster}/ns/${p.metadata.namespace ?? 'default'}/pods/${p.metadata.name}`)}
            className="grid h-8 w-full items-center gap-2 border-b border-border/50 px-3 text-left text-[13px] transition-colors hover:bg-accent/40 last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            style={{ gridTemplateColumns: 'minmax(0,2fr) 100px 90px 70px' }}
          >
            <span className="truncate font-mono" title={p.metadata.name}>
              {p.metadata.name}
            </span>
            <span className="text-muted-foreground">{p.metadata.namespace}</span>
            <span
              className={
                p.status.phase === 'Running'
                  ? 'text-positive'
                  : p.status.phase === 'Pending'
                    ? 'text-caution'
                    : p.status.phase === 'Succeeded'
                      ? 'text-muted-foreground'
                      : 'text-destructive'
              }
            >
              {p.status.phase}
            </span>
            <span className={cn('text-right font-mono tabular-nums', restarts > 0 && 'text-caution')}>
              {restarts}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** YAML tab：只读 + 删除入口在头部（与 ResourceDetailPage 相同的 yaml 查询键，便于共享缓存） */
function NodeYaml({ cluster, nodeName }: { cluster: string; nodeName: string }) {
  const t = useT()
  const path = `${NODES_PATH}/${nodeName}`
  const { data: yamlText, isLoading, error } = useQuery({
    queryKey: ['yaml', cluster, path],
    queryFn: () => getAsYaml(cluster, path),
  })
  // hook 必须在早退 return 之前：loading→error 切换时 useCodeActions 忽调忽不调会破坏 hook 顺序
  const { wrap, actions } = useCodeActions(yamlText ?? '', `${nodeName}.yaml`)
  if (isLoading) return <div className="p-4 text-[13px] text-muted-foreground">{t('sys:loading')}</div>
  if (error) return <div className="p-4 text-[13px] text-destructive">{tf('sys:loadFailed', { msg: error.message })}</div>
  return (
    <CodeBlock className="h-full min-h-0">
      <CodeBlockHeader>
        <CodeBlockTitle><FileCodeIcon />{nodeName}.yaml</CodeBlockTitle>
        {actions}
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers wrap={wrap} className="flex-1">
        {yamlText}
      </CodeBlockContent>
    </CodeBlock>
  )
}

function Info({ k, v, mono }: { k: string; v?: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className={cn('truncate', mono && 'font-mono text-xs')} title={v ?? '-'}>
        {v ?? '-'}
      </dd>
    </div>
  )
}

function ResourceRow({ label, cap, alloc, cpu, usage }: { label: string; cap?: string; alloc?: string; cpu?: boolean; usage?: string }) {
  const fmt = (v?: string) => (v == null ? '-' : cpu ? cpuDisplay(v) : v)
  return (
    <tr className="border-t border-border/50">
      <td className="py-1.5 font-sans">{label}</td>
      <td className="py-1.5 text-right">{fmt(cap)}</td>
      <td className="py-1.5 text-right">{fmt(alloc)}</td>
      <td className="py-1.5 text-right">
        <UsageCell usage={usage} capacity={cap} cpu={cpu} />
      </td>
    </tr>
  )
}

/** 节点不存在（404）：明确空态 + 返回链接 */
function NotFoundState({ title, desc, to }: { title: string; desc: string; to: string }) {
  const t = useT()
  return (
    <div className="flex h-full items-center justify-center">
      <Empty className="gap-3">
        <EmptyHeader className="gap-2">
          <EmptyMedia variant="icon">
            <FileQuestion />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription className="text-[13px]">{desc}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="gap-2">
          <Button variant="outline" asChild>
            <Link to={to}>{t('sys:backToList')}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}
