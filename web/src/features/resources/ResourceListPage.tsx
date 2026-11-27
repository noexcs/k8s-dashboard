// 通用资源列表页：/c/:cluster/r/:kind(/:ns)
// 任意注册表 kind：watch 实时 + 名称过滤 + 行点击进详情。
import { useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Lock, PackageOpen, Plus, RotateCcw, Search, SearchX, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { deleteObject, podsPath } from '@/api/client'
import { usePermissions, type PermissionCheck } from '@/hooks/usePermissions'
import { useNodeMetrics } from '@/hooks/useMetrics'
import { useWatch } from '@/hooks/useWatch'
import { tf, useT } from '@/i18n'
import { askAi } from '@/features/ai/askBus'
import type { K8sObject } from '@/api/types'
import { cn } from '@/lib/utils'
import { AnyResourceDef, colsFor, detailRoute, listPath, listRoute, RESOURCE_MAP } from '@/resources/registry'
import { useCrds } from '@/resources/crds'
import { findWorkloadPods, RESTARTABLE, restartWorkloadRollout, ROLLOUT_RESTARTABLE } from './WorkloadActions'
import { GatedButton } from '@/components/GatedButton'
import { Button } from '@/components/ui/button'
import { NodeUsageContext } from '@/components/UsageCell'
import { CreateResourceDialog, useDefMap } from './CreateResourceDialog'
import { BUILTIN_TEMPLATES } from './kindTemplates'
import { ExportButton } from './ExportButton'
import { NetworkPolicyEditor } from './NetworkPolicyEditor'
import { IngressEditor } from './IngressEditor'
import { HpaEditor } from './HpaEditor'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useFlash } from '@/lib/useFlash'
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
import { Input } from '@/components/ui/input'
import { NamespaceFilter } from '@/components/NamespaceFilter'
import { ResourceDataTable } from '@/components/ResourceDataTable'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'

export function ResourceListPage() {
  const { cluster, kind, ns } = useParams()
  const t = useT()
  // 深链刷新时 CRD 发现可能未完成：def 优先取 RESOURCE_MAP，其次直接取发现数据
  //（map 写入在 effect 里、晚于 render，不能只依赖 map）；发现未落定给占位。
  const { defs, isFetched } = useCrds(cluster)
  const def = kind ? RESOURCE_MAP[kind] ?? defs.find(d => d.kind === kind) : undefined
  const [filter, setFilter] = useState('')

  if (!def) {
    return isFetched ? (
      <div className="text-sm text-muted-foreground">{tf('res:unknownKind', { kind: kind ?? '' })}</div>
    ) : (
      <div className="space-y-3">
        <div className="text-sm text-muted-foreground">{t('res:discoveringCrds')}</div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }
  // 专用列表 kind（Pod/Event）：/r/Kind(/Ns) 深链一律跳专用列表路由（此前带 ns 时 watch 被禁用，永久 Skeleton）
  if (def.dedicated) {
    return <Navigate to={ns ? `/c/${cluster}/ns/${ns}/${def.dedicated}` : `/c/${cluster}/${def.dedicated}`} replace />
  }

  return <ListBody def={def} cluster={cluster!} ns={ns} filter={filter} setFilter={setFilter} />
}

function ListBody({
  def,
  cluster,
  ns,
  filter,
  setFilter,
}: {
  def: AnyResourceDef
  cluster: string
  ns: string | undefined
  filter: string
  setFilter: (v: string) => void
}) {
  const navigate = useNavigate()
  const path = listPath(def, ns)
  const t = useT()
  // ns 单一来源=路由参数：选择器只负责 navigate 到带 ns 的列表路由，页面不再存第二份 ns
  const [nsPickerOpen, setNsPickerOpen] = useState(false)
  // 失效深链落地提示（App.tsx 通配符重定向时拼 ?lost=1），关闭即去参
  const [searchParams, setSearchParams] = useSearchParams()
  const lost = searchParams.get('lost') === '1'
  const dismissLost = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('lost')
    setSearchParams(next, { replace: true })
  }
  // RBAC：无 list 权限 → 无权限空态，并停掉 watch 重试循环（SSR 与 403 双重判定）
  const checks = useMemo<PermissionCheck[]>(
    () => [
      {
        verb: 'list',
        group: def.group,
        version: def.version,
        resource: def.resource,
        namespace: def.scope === 'namespaced' ? ns : undefined,
      },
      {
        verb: 'create',
        group: def.group,
        version: def.version,
        resource: def.resource,
        namespace: def.scope === 'namespaced' ? ns : undefined,
      },
      {
        verb: 'delete',
        group: def.group,
        version: def.version,
        resource: def.resource,
        namespace: def.scope === 'namespaced' ? ns : undefined,
      },
      {
        verb: 'update',
        group: def.group,
        version: def.version,
        resource: def.resource,
        namespace: def.scope === 'namespaced' ? ns : undefined,
      },
      {
        // 批量滚动重启=restartedAt 注解 → RBAC 真相是 patch 本体
        verb: 'patch',
        group: def.group,
        version: def.version,
        resource: def.resource,
        namespace: def.scope === 'namespaced' ? ns : undefined,
      },
      {
        // ReplicaSet 只能删 pod 重启：门跟实际动作走
        verb: 'delete',
        group: '',
        version: 'v1',
        resource: 'pods',
        namespace: def.scope === 'namespaced' ? ns : undefined,
      },
    ],
    [def, ns],
  )
  const { can } = usePermissions(cluster, checks)
  const canList = can(checks[0])
  const canCreate = can(checks[1])
  const canDelete = can(checks[2])
  // 批量重启：仅 RESTARTABLE kind；门随实际动作（rollout 注解=patch 本体；RS=delete pods）
  const canBulkRestart =
    def.kind in RESTARTABLE && (ROLLOUT_RESTARTABLE[def.kind] ? can(checks[4]) : can(checks[5]))
  // Node 列表:注入 metrics-server 用量(registry 列经 NodeUsageContext 读取)
  const isNode = def.kind === 'Node'
  const nodeMetrics = useNodeMetrics(cluster, isNode && canList)
  const usageMap = useMemo(() => {
    if (!isNode || !nodeMetrics.data) return null
    return new Map(nodeMetrics.data.map(m => [m.metadata.name, m]))
  }, [isNode, nodeMetrics.data])
  // 导出用：列筛选后的行对象由表格在渲染期写入（列筛选状态在 ResourceDataTable 内部，
  // 用 ref 而非 state 回传，避免「新数组 → setState → 新数组」渲染死循环）
  const filteredRowsRef = useRef<K8sObject[] | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const defMap = useDefMap(cluster)
  // 注：enabled 只能用 SSR 结果门控（canList）；error 兜底的 forbidden 在 useWatch 之后才能算出
  const { items, lastSync, reconnecting, error, forbidden: watchForbidden } = useWatch<K8sObject>({
    cluster,
    path,
    enabled: !def.dedicated && canList,
  })
  // 403 信号直接用 useWatch 的权威判定（status===403）；旧的正则匹配文案在代理层
  // 改写错误体时会漏判，把权限拒绝渲染成「暂无资源」假空态
  const forbidden = !canList || watchForbidden
  // 必须 memo：colsFor 对无 d.columns 的 CRD 每次返回新数组，identity 抖动会连坐
  // ResourceDataTable 的 defs 每帧重建（rowsSig 保护全旁落）
  const cols = useMemo(() => colsFor(def), [def])
  // 首载：还没成功同步过且无数据（含首帧失败退避期）→ Skeleton，避免闪空表格/假「暂无资源」
  const loading = !forbidden && error == null && items.length === 0 && lastSync == null

  const visible = items.filter(i => !filter || i.metadata.name.toLowerCase().includes(filter.toLowerCase()))
  // 表头计数：列筛选生效后的行数（ResourceDataTable 回传），未生效前显示 visible 数。
  // 表格被空态替换后不再回传，旧值会停在最后一帧 → visible 归零时按 0 显示，
  // 否则「12」配「暂无资源」自相矛盾
  const [filteredCount, setFilteredCount] = useState<number | null>(null)
  const shownCount = visible.length === 0 ? 0 : (filteredCount ?? visible.length)
  // watch 增删行让计数跳变时闪一下，标明这是实时数据而非静态快照
  const { flash: countFlash, onEnd: countFlashEnd } = useFlash(shownCount)
  // 批量删除（参考 CLI）：行选择 → 工具条；串行删除 + 进度（k8s 无批量端点）。
  // 打开确认框时快照目标：删除过程中 watch 摘除行会清空 selected，进度/文案不能跟着缩。
  const [selected, setSelected] = useState<K8sObject[]>([])
  const [bulkTargets, setBulkTargets] = useState<K8sObject[]>([])
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkDone, setBulkDone] = useState(0)
  const objPathOf = (o: K8sObject) =>
    `${listPath(def, o.metadata.namespace ?? (def.scope === 'namespaced' ? ns : undefined))}/${o.metadata.name}`
  const runBulkDelete = async () => {
    const targets = bulkTargets
    setBulkBusy(true)
    setBulkDone(0)
    let failed = 0
    for (const o of targets) {
      try {
        await deleteObject(cluster, objPathOf(o), `批量删除（列表页 ${def.kind}）`)
      } catch {
        failed++
      }
      setBulkDone(n => n + 1)
    }
    setBulkBusy(false)
    setBulkOpen(false)
    setBulkTargets([])
    setSelected([])
    if (failed) toast.error(tf('res:bulkDeletePartial', { done: targets.length - failed, failed }))
    else toast.success(tf('res:bulkDeleteDone', { n: targets.length }))
  }

  // 批量重启（参考 CLI）：逐个 workload 找其 Pod 再串行删除；进度按 workload 计
  const [restartOpen, setRestartOpen] = useState(false)
  const [restartTargets, setRestartTargets] = useState<K8sObject[]>([])
  const [restartBusy, setRestartBusy] = useState(false)
  const [restartDone, setRestartDone] = useState(0)
  const runBulkRestart = async () => {
    const targets = restartTargets
    setRestartBusy(true)
    setRestartDone(0)
    let podN = 0
    let failed = 0
    for (const o of targets) {
      const useNs = o.metadata.namespace ?? (ns || 'default')
      try {
        if (ROLLOUT_RESTARTABLE[def.kind]) {
          // 此前批量重启逐个删名下全部 RS 的 pod——滚动中连旧版本一起删(单页重启已修的
          // 故障窗口被批量路径整条带回来);改 restartedAt 注解,一个 PATCH 且走滚动策略
          await restartWorkloadRollout(cluster, objPathOf(o), '批量滚动重启（列表页）')
        } else {
          // ReplicaSet 模板不可变,无滚动机制:删 pod 是唯一选择
          const pods = await findWorkloadPods(cluster, objPathOf(o), useNs)
          let failedHere: string | null = null
          for (const p of pods) {
            try {
              await deleteObject(cluster, `${podsPath(p.metadata.namespace ?? useNs)}/${p.metadata.name}`, '删除重启（批量，ReplicaSet 无滚动机制）')
              podN++
            } catch {
              failedHere = p.metadata.name
            }
          }
          if (failedHere) failed++
        }
      } catch {
        failed++
      }
      setRestartDone(n => n + 1)
    }
    setRestartBusy(false)
    setRestartOpen(false)
    setRestartTargets([])
    setSelected([])
    if (failed) toast.error(tf('res:bulkRestartPartial', { done: targets.length - failed, failed }))
    else toast.success(tf('res:bulkRestartDone', { n: targets.length, pods: podN || 0 }))
  }

  return (
    <NodeUsageContext.Provider value={usageMap}>
    <div className="flex h-full flex-col">
      {lost && (
        <Alert className="mb-3 text-[13px]">
          <SearchX />
          <AlertDescription>{t('res:lostDeepLink')}</AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={dismissLost}
              aria-label={t('core:close')}
            >
              <X className="size-3.5" />
            </Button>
          </AlertAction>
        </Alert>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-medium">{def.label}</h1>
        <span className="whitespace-nowrap text-[13px] text-muted-foreground tabular-nums">
          {def.scope === 'cluster' ? t('res:scopeCluster') : ns ? tf('res:scopeNamespace', { ns }) : t('res:scopeAllNamespaces')}
          {' · '}
          <span data-flash={countFlash || undefined} onAnimationEnd={countFlashEnd}>
            {shownCount}
          </span>
          {' · '}
          {lastSync != null && tf('res:syncedAt', { time: new Date(lastSync).toLocaleTimeString('zh-CN', { hour12: false }) })}
        </span>
        {reconnecting && !forbidden && (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-caution">
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-caution" />
            {t('res:reconnecting')}
          </span>
        )}
        {/* 窄屏：筛选/搜索整组换到第二行；搜索框弹性占满剩余宽度 */}
        {selected.length > 0 && canBulkRestart && (
          <Button variant="outline" onClick={() => { setRestartTargets(selected); setRestartOpen(true) }}>
            <RotateCcw className="size-3.5" />
            {tf('res:bulkRestart', { n: selected.length })}
          </Button>
        )}
        {selected.length > 0 && canDelete && (
          <Button variant="destructive" onClick={() => { setBulkTargets(selected); setBulkOpen(true) }}>
            <Trash2 className="size-3.5" />
            {tf('res:bulkDelete', { n: selected.length })}
          </Button>
        )}
        <div className="ml-auto flex w-full items-center gap-2 @sm/main:w-auto">
          <ExportButton
            items={() => filteredRowsRef.current ?? visible}
            def={def}
            cluster={cluster}
            ns={ns}
            selected={selected}
          />
          {/* 结构化编辑器替代裸 YAML 新建：NetPol 白名单语义、Ingress 流量入口、HPA 指标 target 均易写错 */}
          {ns && def.kind === 'NetworkPolicy' ? (
            <NetworkPolicyEditor cluster={cluster} ns={ns} allowed={canCreate} />
          ) : ns && def.kind === 'Ingress' ? (
            <IngressEditor cluster={cluster} ns={ns} allowed={canCreate} />
          ) : ns && def.kind === 'HorizontalPodAutoscaler' ? (
            <HpaEditor cluster={cluster} ns={ns} allowed={canCreate} />
          ) : (
            <GatedButton allowed={canCreate} variant="outline" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" />
              {t('res:create')}
            </GatedButton>
          )}
          {/* ns 单一来源=URL：选择器改 ns 即换列表路由（watch 也按该 ns 收敛）。
              带 ns 时同样显示——它是在 ns 之间/回全部命名空间切换的出口 */}
          {def.scope === 'namespaced' && (
            <NamespaceFilter
              cluster={cluster}
              value={ns ?? null}
              onChange={next => navigate(listRoute(def, cluster, next ?? undefined))}
              open={nsPickerOpen}
              onOpenChange={setNsPickerOpen}
            />
          )}
          <div className="relative min-w-0 flex-1 @sm/main:w-56 @sm/main:flex-none">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t('res:filterName')}
              title={t('res:filterNameTip')}
              className={cn('w-full pl-8', filter && 'pr-7')}
            />
            {filter && (
              <button
                type="button"
                aria-label={t('res:clearFilter')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => setFilter('')}
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {forbidden ? (
          <Empty className="h-full gap-3 rounded-lg border bg-card p-6">
            <EmptyHeader className="gap-2">
              <EmptyMedia variant="icon" className="text-muted-foreground">
                <Lock className="size-4" />
              </EmptyMedia>
              <EmptyTitle className="text-[13px]">{t('res:noPermissionTitle')}</EmptyTitle>
              <EmptyDescription className="text-[13px]">{t('res:noPermissionDesc')}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="gap-1.5">
              <Alert variant="destructive" className="w-full text-[13px]">
                <AlertTitle className="text-[13px]">{t('res:rbacDeniedTitle')}</AlertTitle>
                <AlertDescription className="text-[13px]">{t('res:rbacDeniedDesc')}</AlertDescription>
              </Alert>
            </EmptyContent>
          </Empty>
        ) : loading ? (
          <div className="space-y-2 rounded-lg border bg-card p-3 motion-safe:transition-opacity motion-safe:duration-100">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-11/12" />
            <Skeleton className="h-5 w-5/6" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : error != null && visible.length === 0 ? (
          // 首帧起就失败且退避重试仍无数据：把真实错误亮出来，而非「暂无资源」假空态
          <Alert variant="destructive" className="my-4">
            <AlertTitle>{t('res:listError')}</AlertTitle>
            <AlertDescription>{tf('res:loadFailed', { msg: error })}</AlertDescription>
          </Alert>
        ) : visible.length === 0 ? (
          filter ? (
            <Empty className="h-full gap-3 rounded-lg border bg-card p-6">
              <EmptyHeader className="gap-2">
                <EmptyMedia variant="icon" className="text-muted-foreground">
                  <SearchX className="size-4" />
                </EmptyMedia>
                <EmptyTitle className="text-[13px]">{t('res:noMatchTitle')}</EmptyTitle>
                <EmptyDescription className="text-[13px]">{tf('res:noMatchDesc', { filter })}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Empty className="h-full gap-3 rounded-lg border bg-card p-6">
              <EmptyHeader className="gap-2">
                <EmptyMedia variant="icon" className="text-muted-foreground">
                  <PackageOpen className="size-4" />
                </EmptyMedia>
                <EmptyTitle className="text-[13px]">{t('res:noResourcesTitle')}</EmptyTitle>
                <EmptyDescription className="text-[13px]">
                  {def.scope === 'cluster' ? t('res:noResourcesCluster') : ns ? tf('res:noResourcesNamespace', { ns }) : t('res:noResourcesAllNs')}
                </EmptyDescription>
              </EmptyHeader>
              {/* 定名 ns 下为空，换个 ns 可能就有货：直达选择器（cluster scope 无 ns 概念，不显示） */}
              {def.scope === 'namespaced' && ns && (
                <EmptyContent className="gap-2">
                  <Button variant="outline" size="sm" onClick={() => setNsPickerOpen(true)}>
                    {t('res:switchNs')}
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          )
        ) : (
          // 骨架 → 表格的切换补一次淡入：@starting-style 只在节点插入时提供起始值，
          // 只淡外层，不动行（行重排时外层不重挂，不会闪）
          <div className="motion-safe:starting:opacity-0 motion-safe:transition-opacity motion-safe:duration-120">
            <ResourceDataTable
              columns={cols}
              rows={visible}
              rowKey={o => o.metadata.uid}
              onRowClick={o =>
                navigate(detailRoute(def, cluster, def.scope === 'cluster' ? 'cluster' : (o.metadata.namespace ?? ns ?? ''), o.metadata.name))
              }
              nameHref={o =>
                detailRoute(def, cluster, def.scope === 'cluster' ? 'cluster' : (o.metadata.namespace ?? ns ?? ''), o.metadata.name)
              }
              onFilteredCount={setFilteredCount}
              filteredRowsRef={filteredRowsRef}
              // 选中集是批量删除与批量重启共同的输入：只卡 canDelete 会让
              // update-only 用户的批量重启永久不可达
              onSelectionChange={canDelete || canBulkRestart ? setSelected : undefined}
              // 行级问 AI：列表页路由不产生资源上下文，提问文本自带 kind/ns/name
              askRow={o =>
                askAi(tf('ai:askDiagnoseRow', { kind: def.kind, ns: o.metadata.namespace ?? '-', name: o.metadata.name }))
              }
            />
          </div>
        )}
      </div>
      <CreateResourceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        cluster={cluster}
        ns={ns}
        allDefs={defMap}
        initialText={BUILTIN_TEMPLATES[def.kind]}
      />
      <AlertDialog open={bulkOpen} onOpenChange={v => !bulkBusy && setBulkOpen(v)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tf('res:bulkDeleteTitle', { kind: def.label, n: bulkTargets.length })}</AlertDialogTitle>
            <AlertDialogDescription>
              {tf('res:bulkDeleteDesc', { n: bulkTargets.length, names: bulkTargets.slice(0, 5).map(o => o.metadata.name).join(', ') + (bulkTargets.length > 5 ? '…' : '') })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {bulkBusy && (
            <div className="space-y-1.5">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full origin-left bg-destructive transition-transform" style={{ transform: `scaleX(${bulkDone / Math.max(bulkTargets.length, 1)})` }} />
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">{tf('res:bulkDeleteProgress', { done: bulkDone, total: bulkTargets.length })}</div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkBusy}>{t('res:cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={e => { e.preventDefault(); void runBulkDelete() }} disabled={bulkBusy}>
              {bulkBusy ? t('res:bulkDeleting') : tf('res:bulkDelete', { n: bulkTargets.length })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={restartOpen} onOpenChange={v => !restartBusy && setRestartOpen(v)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tf('res:bulkRestartTitle', { kind: def.label, n: restartTargets.length })}</AlertDialogTitle>
            <AlertDialogDescription>
              {tf('res:bulkRestartDesc', { n: restartTargets.length, names: restartTargets.slice(0, 5).map(o => o.metadata.name).join(', ') + (restartTargets.length > 5 ? '…' : '') })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {restartBusy && (
            <div className="space-y-1.5">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full origin-left bg-primary transition-transform" style={{ transform: `scaleX(${restartDone / Math.max(restartTargets.length, 1)})` }} />
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">{tf('res:bulkRestartProgress', { done: restartDone, total: restartTargets.length })}</div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restartBusy}>{t('res:cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={e => { e.preventDefault(); void runBulkRestart() }} disabled={restartBusy}>
              {restartBusy ? t('res:bulkRestarting') : tf('res:bulkRestart', { n: restartTargets.length })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </NodeUsageContext.Provider>
  )
}
