// 通用资源详情页：/c/:cluster/r/:kind/:ns/:name（cluster scope 的 ns 段为 'cluster'）
// 概览（metadata/owner/labels/annotations）+ 事件 + YAML 查看/编辑/Apply（乐观锁）+ 删除。
// 取代原 YamlPage（9 种内置类型白名单）；全部注册表 kind 可用。
import type { ReactNode } from 'react'
import { Check, Copy, Loader2, MessageSquareText, MoreHorizontal, PencilLine, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { parse } from 'yaml'
import { toast } from 'sonner'
import { ApiError, deleteObject, list } from '@/api/client'
import { usePermissions, type PermissionCheck } from '@/hooks/usePermissions'
import { useWatch } from '@/hooks/useWatch'
import { tf, useLang, useT } from '@/i18n'
import { askAi } from '@/features/ai/askBus'
import type { Event, K8sObject } from '@/api/types'
import { cn } from '@/lib/utils'
import { detailRoute, fmtCreated, itemPath, listRoute, RESOURCE_MAP, type AnyResourceDef } from '@/resources/registry'
import { useCrds } from '@/resources/crds'
import { ActionMenuItem, WorkloadActions, useAggLogsGate, WorkloadLogsMenuItem } from './WorkloadActions'
import { WorkloadLogsDialog } from './WorkloadLogsDialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { WorkloadDeployActions } from './WorkloadDeployActions'
import { eventReasonLabel, eventTypeLabel } from '@/lib/eventL10n'
import { SectionTitle } from '@/components/SectionTitle'
import { SetImageDialog } from './SetImageButton'
import { ExposeDialog } from './ExposeButton'
import { REVISION_KINDS, RevisionsTab } from './RevisionsTab'
import { TopologyTab } from './TopologyTab'
import { SecretValues } from './SecretValues'
import { ChangeTraceCard } from './ChangeTraceCard'
import { CronJobActions } from './CronJobActions'
import { JobActions } from './JobActions'
import { PodSpecSection } from './PodSpecSection'

import { PvcExpandButton } from './PvcExpandButton'
import { NetworkPolicyEditor } from './NetworkPolicyEditor'
import { IngressEditor } from './IngressEditor'
import { KeyValueEditor } from './KeyValueEditor'
import { HpaEditor } from './HpaEditor'
import { CreateResourceDialog, stripForClone, useDefMap } from './CreateResourceDialog'
import { fmtTime } from '@/lib/format'
import { useFlash } from '@/lib/useFlash'
import { conditionBad, toneDot, toneText, type Tone } from '@/lib/tone'
import { DetailSkeleton } from './DetailSkeleton'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
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
import { PortLinks } from '@/components/PortLinks'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Card, CardContent } from '@/components/ui/card'
import { FileQuestion } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useYamlEdit, YamlDiff, YamlEditor, YamlView } from './YamlTab'

export function ResourceDetailPage() {
  const { cluster, kind, ns, name } = useParams()
  const location = useLocation()
  const t = useT()
  // 深链刷新时 CRD 发现可能未完成：def 优先取 RESOURCE_MAP，其次直接取发现数据
  //（map 写入在 effect 里、晚于 render，不能只依赖 map）；发现未落定给占位。
  const { defs, isFetched } = useCrds(cluster)
  const def = kind ? RESOURCE_MAP[kind] ?? defs.find(d => d.kind === kind) : undefined
  // 发现是两跳 + retry:4（单跳 20s 超时），tailnet 中继深链能挂 30s+。5s 未落定即
  // 放弃「马上就好」的假象：占位从脉冲骨架降级为纯平铺静态块（发现完成时仍增量升级）
  const [discoveryGaveUp, setDiscoveryGaveUp] = useState(false)
  useEffect(() => {
    if (!kind || def || isFetched) return
    const id = setTimeout(() => setDiscoveryGaveUp(true), 5_000)
    return () => clearTimeout(id)
  }, [kind, def, isFetched])
  if (!def || !ns || !name || !cluster) {
    return isFetched ? (
      <NotFoundState title={t('res:unknownKindTitle')} desc={tf('res:unknownKindDesc', { kind: kind ?? '-' })} />
    ) : (
      // 发现等待位：骨架而非纯文案（发现完成后本组件直接渲染实例，无需刷新）
      <div className="p-4">
        <DetailSkeleton pulse={!discoveryGaveUp} />
      </div>
    )
  }
  // 通用 /r/ 路由下专用详情优先：Pod 走增强详情，Node 走节点专用页
  // 旧 /yaml/ 路由保留 YAML 查看（Pod 详情页有入口）
  const fromYamlAlias = location.pathname.includes('/yaml/')
  if (!fromYamlAlias) {
    if (def.dedicated === 'pods' && ns !== 'cluster') {
      return <Navigate to={`/c/${cluster}/ns/${ns}/pods/${name}`} replace />
    }
    if (def.dedicatedDetail) {
      return <Navigate to={detailRoute(def, cluster, ns, name)} replace />
    }
  }
  return <DetailBody def={def} cluster={cluster} ns={ns} name={name} initialTab={fromYamlAlias ? 'yaml' : 'overview'} />
}

type DetailTab = 'overview' | 'related' | 'revisions' | 'events' | 'yaml'

/** tab 面板（role=tabpanel）：切换时挂载淡入一眼（motion-safe，@starting-style 首帧透明） */
const TAB_CONTENT_CLS =
  'min-h-0 flex-1 overflow-auto opacity-100 transition-opacity duration-120 motion-safe:[@starting-style]:opacity-0'

/** YAML 解析结果：K8s 通用对象 + spec.replicas（扩缩容默认值）+ spec.completions（Job 头图）+ status（头图/状态卡） */
interface YamlDoc extends K8sObject {
  spec?: { replicas?: unknown; completions?: unknown }
  status?: unknown
}

function DetailBody({
  def,
  cluster,
  ns,
  name,
  initialTab,
}: {
  def: AnyResourceDef
  cluster: string
  ns: string
  name: string
  initialTab: DetailTab
}) {
  const navigate = useNavigate()
  const path = itemPath(def, ns, name)
  const t = useT()
  // RBAC：编辑 YAML/Apply 需 update；删除需 delete（cluster-scoped 不带 namespace）
  const checks = useMemo<PermissionCheck[]>(() => {
    const namespace = def.scope === 'namespaced' && ns !== 'cluster' ? ns : undefined
    return [
      { verb: 'update', group: def.group, version: def.version, resource: def.resource, namespace },
      { verb: 'delete', group: def.group, version: def.version, resource: def.resource, namespace },
      { verb: 'create', group: def.group, version: def.version, resource: def.resource, namespace },
    ]
  }, [def, ns])
  const { can } = usePermissions(cluster, checks)
  const canUpdate = can(checks[0])
  const canDelete = can(checks[1])
  const canCreate = can(checks[2])

  const {
    yamlText,
    isLoading,
    error,
    editing,
    draft,
    startEdit,
    discard,
    setDraft,
    applying,
    applyError,
    doApply,
    conflict,
    setConflict,
    reloadYaml,
    reset,
  } = useYamlEdit({ cluster, path })

  const [tab, setTab] = useState<DetailTab>(initialTab)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  // 头栏唯一「更多」：聚合日志/暂停/改镜像/暴露/克隆统一收纳（F10，11 按钮等权墙）
  const canLogs = useAggLogsGate(cluster, ns)
  const [logsOpen, setLogsOpen] = useState(false)
  // 「更多」菜单项的对话框宿主（菜单收起会卸载 Content，状态必须在这里）
  const [imageOpen, setImageOpen] = useState(false)
  const [exposeOpen, setExposeOpen] = useState(false)
  const cloneDefMap = useDefMap(cluster)
  const [deleting, setDeleting] = useState(false)
  const [deleted, setDeleted] = useState(false)

  // 首次挂载保持 initialTab（/yaml/ 别名进来直接落 YAML tab）；仅换资源时重置
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    reset()
    setTab(initialTab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const doDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteObject(cluster, path, `UI 删除 ${def.kind}`)
      setDeleted(true)
      toast.success(tf('res:deleted', { kind: def.kind, name }))
      navigate(listRoute(def, cluster))
    } catch (e) {
      // 此前无 catch：RBAC 竞态、finalizer 409、网络失败全部静默——对话框不关、
      // 零反馈，用户只能反复点击重试。全站写操作都有 toast，这里补齐
      toast.error(tf('res:deleteFailed', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setDeleting(false)
    }
  }, [cluster, path, def, name, navigate])

  // YAML 解析结果按文本缓存（此前每 render 2-3 次 parse）
  // 注意：本 useMemo 必须位于所有早退分支之前——isLoading 早退若排在它前面，
  // 数据到达后的 render hook 数量会 +1，触发 "Rendered more hooks" 崩溃
  const parsed = useMemo(() => {
    if (!yamlText) return null
    try {
      return parse(yamlText) as YamlDoc
    } catch {
      return null
    }
  }, [yamlText])

  // 「关联」tab 用：selector 两种形状——工作负载 = {matchLabels}；Service = 裸 label map
  // （k8s-app: kube-dns）。统一归一为 label map；非纯字符串 map（如 matchExpressions
  // 结构）返回 undefined 不发请求。
  const relatedMatchLabels = useMemo(() => {
    const sel = (parsed as unknown as { spec?: { selector?: unknown } })?.spec?.selector
    if (!sel || typeof sel !== 'object' || Array.isArray(sel)) return undefined
    const ml = (sel as { matchLabels?: Record<string, string> }).matchLabels
    if (ml) return ml
    const vals = Object.values(sel)
    return vals.length > 0 && vals.every(v => typeof v === 'string') ? (sel as Record<string, string>) : undefined
  }, [parsed])

  // 克隆：剥除服务端字段后的源 YAML（打开对话框预填）
  const cloneYaml = useMemo(() => (parsed ? stripForClone(parsed as unknown as Record<string, unknown>) : undefined), [parsed])

  if (deleted) return null
  if (isLoading) return <DetailSkeleton />
  if (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <NotFoundState
          title={tf('res:kindNotFound', { kind: def.kind })}
          desc={tf('res:kindNotFoundDesc', { ref: `${ns}/${name}` })}
          to={listRoute(def, cluster)}
        />
      )
    }
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {tf('res:loadFailed', { msg: error.message })}
      </div>
    )
  }
  if (!yamlText) return <DetailSkeleton />

  let currentReplicas: number | undefined
  // yaml 解析失败时不给默认副本数
  if (!editing && typeof parsed?.spec?.replicas === 'number') currentReplicas = parsed.spec.replicas
  // Deployment 未写 spec.paused = 未暂停（false）；显式 boolean 直接用；其他 kind 不适用
  const deployPaused =
    !editing && (typeof (parsed?.spec as { paused?: unknown } | undefined)?.paused === 'boolean'
      ? (parsed!.spec as { paused: boolean }).paused
      : def.kind === 'Deployment'
        ? false
        : undefined)

  return (
    <div className="flex h-full flex-col motion-safe:[@starting-style]:opacity-0 transition-opacity duration-150">
      {/* 窄屏：标题保持最小宽度并独占第一行，操作按钮组换到第二行 */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="min-w-[12rem] flex-1 truncate font-mono text-[16px] leading-none font-medium" title={`${def.kind}/${name}`}>
          {def.kind}/{name}
          {def.scope === 'namespaced' && ns !== 'cluster' && (
            <span className="ml-1.5 font-sans text-[13px] text-muted-foreground">({ns})</span>
          )}
        </h1>
        <div className="ml-auto flex items-center gap-2">
          {editing ? (
            <>
              <Button variant="ghost" onClick={discard}>
                <RotateCcw className="size-3.5" />
                {t('res:discard')}
              </Button>
              <GatedButton allowed={canUpdate} variant="default" busy={applying} onClick={() => void doApply()}>
                {applying ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                Apply
              </GatedButton>
            </>
          ) : (
            <>
              <WorkloadActions def={def} cluster={cluster} ns={ns} name={name} currentReplicas={currentReplicas} menuMode />
              {def.kind === 'CronJob' && (
                <CronJobActions
                  cluster={cluster}
                  ns={ns}
                  name={name}
                  suspend={(parsed?.spec as { suspend?: boolean } | undefined)?.suspend ?? false}
                  allowed={canUpdate}
                />
              )}
              {def.kind === 'Job' && parsed && ns !== 'cluster' && (() => {
                const conds = ((parsed.status as { conditions?: { type?: string; status?: string }[] } | undefined)?.conditions ?? [])
                const done = conds.some(c => c.status === 'True' && (c.type === 'Complete' || conditionBad(c.type, c.status)))
                return done ? null : (
                  <JobActions
                    cluster={cluster}
                    ns={ns}
                    name={name}
                    suspend={(parsed.spec as { suspend?: boolean } | undefined)?.suspend ?? false}
                    allowed={canUpdate}
                  />
                )
              })()}
              {def.kind === 'PersistentVolumeClaim' && parsed && ns !== 'cluster' && (
                <PvcExpandButton
                  cluster={cluster}
                  ns={ns}
                  name={name}
                  pvc={parsed as unknown as Record<string, unknown>}
                  allowed={canUpdate}
                />
              )}
              {def.kind === 'NetworkPolicy' && parsed && ns !== 'cluster' && (
                <NetworkPolicyEditor
                  cluster={cluster}
                  ns={ns}
                  name={name}
                  obj={parsed as unknown as Record<string, unknown>}
                  allowed={canUpdate}
                />
              )}
              {/* Ingress：host/path 是线上流量入口，结构化表单 + 实时 YAML 预览（裸 YAML 易改错） */}
              {def.kind === 'Ingress' && parsed && ns !== 'cluster' && (
                <IngressEditor
                  cluster={cluster}
                  ns={ns}
                  name={name}
                  obj={parsed as unknown as Record<string, unknown>}
                  allowed={canUpdate}
                />
              )}
              {/* ConfigMap/Secret：键值表格编辑（kind 判定在组件内，非目标 kind 渲染 null） */}
              {(def.kind === 'ConfigMap' || def.kind === 'Secret') && parsed && ns !== 'cluster' && (
                <KeyValueEditor
                  cluster={cluster}
                  ns={ns}
                  name={name}
                  obj={parsed as unknown as Record<string, unknown>}
                  allowed={canUpdate}
                />
              )}
              {/* HPA：指标 target/behavior 手写易错，表单化（编辑保留未知键并告警） */}
              {def.kind === 'HorizontalPodAutoscaler' && parsed && ns !== 'cluster' && (
                <HpaEditor
                  cluster={cluster}
                  ns={ns}
                  name={name}
                  obj={parsed as unknown as Record<string, unknown>}
                  allowed={canUpdate}
                />
              )}
              {/* 唯一「更多」下拉。项内动作若需对话框（改镜像/暴露），状态一律挂在
                  本组件（菜单 Content 收起即卸载，对话框状态必须活在菜单外——
                  曾尝试 forceMount 保挂载，Radix modal 的 RemoveScroll 按 present
                  生效会把整页滚轮/点击锁死）。 */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="gap-1">
                    <MoreHorizontal className="size-3.5" />
                    {t('res:menuMore')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-36 text-popover-foreground">
                  <WorkloadLogsMenuItem allowed={canLogs} onSelect={() => setLogsOpen(true)} />
                  <DropdownMenuSeparator />
                  {def.scope === 'namespaced' && ns !== 'cluster' && (
                    <WorkloadDeployActions def={def} cluster={cluster} ns={ns} name={name} paused={deployPaused} menuMode onImage={() => setImageOpen(true)} onExpose={() => setExposeOpen(true)} />
                  )}
                  {parsed && <DropdownMenuSeparator />}
                  {parsed && (
                    <ActionMenuItem allowed={canCreate} onSelect={() => setCloneOpen(true)} icon={<Copy className="size-3.5" />} label={t('res:clone')} />
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              {imageOpen && (
                <SetImageDialog open={imageOpen} onOpenChange={setImageOpen} cluster={cluster} path={itemPath(def, ns, name)} />
              )}
              {exposeOpen && (
                <ExposeDialog
                  open={exposeOpen}
                  onOpenChange={setExposeOpen}
                  cluster={cluster}
                  ns={ns}
                  def={def}
                  name={name}
                  onCreated={() => {
                    setExposeOpen(false)
                    navigate(`/c/${cluster}/r/Service/${ns}/${name}`)
                  }}
                />
              )}
              {logsOpen && (
                <WorkloadLogsDialog open={logsOpen} onOpenChange={setLogsOpen} cluster={cluster} ns={ns} path={itemPath(def, ns, name)} name={name} />
              )}
              {/* 问 AI：诊断请求进悬浮面板（上下文由路由自动注入，见 askBus） */}
              <Button
                variant="ghost"
                onClick={() => askAi(t('ai:askDiagnose'))}
              >
                <MessageSquareText className="size-3.5" />
                {t('res:askAi')}
              </Button>
              <GatedButton
                allowed={canUpdate}
                variant="outline"
                onClick={() => {
                  setTab('yaml')
                  startEdit()
                }}
              >
                <PencilLine className="size-3.5" />
                {t('res:editYaml')}
              </GatedButton>
              <GatedButton allowed={canDelete} variant="ghost" destructive onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-3.5" />
                {t('res:delete')}
              </GatedButton>
            </>
          )}
        </div>
      </div>

      {parsed?.metadata.deletionTimestamp && (
        // 卡在 Terminating 是最常见的「删了没动静」困惑：把 finalizer 名单和处置指向摊开，
        // 而不是让人对着转圈详情猜（finalizer 是别的控制器写的，UI 不代删——那是危险写）
        <Alert variant="destructive" className="mb-2">
          <AlertTitle>{t('res:deletingStuckTitle')}</AlertTitle>
          <AlertDescription>
            {tf('res:deletingStuck', { time: String(parsed.metadata.deletionTimestamp).slice(0, 19).replace('T', ' ') })}
            {(() => {
              const fz = (parsed.metadata as unknown as { finalizers?: string[] }).finalizers ?? []
              return fz.length > 0 ? ` finalizers: ${fz.join(', ')}` : ` — finalizer ${t('res:noFinalizerHint')}`
            })()}
          </AlertDescription>
        </Alert>
      )}

      <Tabs value={tab} onValueChange={v => setTab(v as DetailTab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList variant="line" className="mb-3 w-full justify-start border-b">
          <TabsTrigger value="overview" className="flex-none">
            {t('res:tabOverview')}
          </TabsTrigger>
          <TabsTrigger value="related" className="flex-none">
            {t('res:tabRelated')}
          </TabsTrigger>
          {def.scope === 'namespaced' && ns !== 'cluster' && REVISION_KINDS[def.kind] && (
            <TabsTrigger value="revisions" className="flex-none">
              {t('res:tabRevisions')}
            </TabsTrigger>
          )}
          {def.scope === 'namespaced' && ns !== 'cluster' && (
            <TabsTrigger value="events" className="flex-none">
              {t('res:tabEvents')}
            </TabsTrigger>
          )}
          <TabsTrigger value="yaml" className="flex-none">
            YAML
          </TabsTrigger>
        </TabsList>

        {applyError && tab === 'yaml' && (
          <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[13px] text-destructive">
            {applyError}
          </div>
        )}
        <TabsContent value="overview" className={TAB_CONTENT_CLS}>
          <Overview yamlText={yamlText} def={def} cluster={cluster} ns={ns} name={name} />
        </TabsContent>
        {parsed && (
          <TabsContent value="related" className={TAB_CONTENT_CLS}>
            <TopologyTab
              cluster={cluster}
              ns={ns}
              kind={def.kind}
              name={name}
              owners={parsed.metadata.ownerReferences as { apiVersion?: string; kind: string; name: string }[] | undefined}
              matchLabels={relatedMatchLabels}
            />
          </TabsContent>
        )}
        {def.scope === 'namespaced' && ns !== 'cluster' && REVISION_KINDS[def.kind] && (
          <TabsContent value="revisions" className={TAB_CONTENT_CLS}>
            <RevisionsTab def={def} cluster={cluster} ns={ns} name={name} />
          </TabsContent>
        )}
        {def.scope === 'namespaced' && ns !== 'cluster' && (
          <TabsContent value="events" className={TAB_CONTENT_CLS}>
            <EventsTab cluster={cluster} ns={ns} name={name} kind={def.kind} />
          </TabsContent>
        )}
        <TabsContent value="yaml" className={TAB_CONTENT_CLS}>
          <div>
            {editing && (
              <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[13px] text-muted-foreground">
                <PencilLine className="size-3.5" />
                {t('res:editingHint')}
              </div>
            )}
            {editing ? (
              <div className="space-y-2">
                <YamlEditor
                  value={draft}
                  onChange={setDraft}
                  title={`${def.kind}/${name}`}
                  filename={`${def.kind.toLowerCase()}-${name}.yaml`}
                />
                <YamlDiff base={yamlText} draft={draft} />
              </div>
            ) : (
              <YamlView yamlText={yamlText} kind={def.kind} name={name} />
            )}
          </div>
        </TabsContent>
      </Tabs>

      <AlertDialog open={conflict} onOpenChange={setConflict}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('res:resourceChangedTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('res:resourceChangedDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('res:cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={reloadYaml}>
              {t('res:reload')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="whitespace-nowrap">{tf('res:deleteTitle', { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {tf('res:deleteDesc', { kind: def.kind, name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('res:cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void doDelete()}>
              {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              {t('res:delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CreateResourceDialog
        open={cloneOpen}
        onOpenChange={setCloneOpen}
        cluster={cluster}
        ns={def.scope === 'namespaced' && ns !== 'cluster' ? ns : undefined}
        allDefs={cloneDefMap}
        initialText={cloneYaml}
      />
    </div>
  )
}

/** 概览：状态（关键数字 + 条件）/ 详情 / Labels / Annotations 四卡，与 Pod/Node 详情页同一套卡片语言 */
function Overview({
  yamlText,
  def,
  cluster,
  ns,
  name,
}: {
  yamlText: string
  def: AnyResourceDef
  cluster: string
  ns: string
  name: string
}) {
  const t = useT()
  const obj = useMemo(() => {
    try {
      return parse(yamlText) as YamlDoc
    } catch {
      return null
    }
  }, [yamlText])
  if (!obj) return <div className="text-[13px] text-muted-foreground">{t('res:yamlParseFailed')}</div>
  const m = obj.metadata
  const labels = Object.entries(m.labels ?? {})
  const annotations = Object.entries(m.annotations ?? {})
  // 系统托管标签折成 +N chip：pod-template-hash 这类每次滚动都换值，全量摊开
  // 会把真正要看的归属标签挤出视线（判定口径同 PodSpecSection 的同名正则）
  const sysLabels: [string, string][] = []
  const userLabels = labels.filter(([k, v]) => {
    const sys = SYS_SELECTOR_RE.test(k) || SYS_SELECTOR_RE.test(String(v))
    if (sys) sysLabels.push([k, v])
    return !sys
  })
  const head = statusHeadline(obj, t)
  const statusEntries = statusScalars(obj)
  const conditions = statusConditions(obj)
  // Service 端口（Kube-Proxy 直访入口）；Pod 走专用详情页
  const svcPorts: { port: number; name?: string; protocol?: string }[] =
    def.kind === 'Service' && ns !== 'cluster'
      ? ((obj as unknown as { spec?: { ports?: { port: number; name?: string; protocol?: string }[] } }).spec?.ports ?? [])
      : []

  return (
    <div className="space-y-3 pb-4">
      {svcPorts.length > 0 && (
        <PortLinks cluster={cluster} ns={ns} name={name} kind="Service" ports={svcPorts} />
      )}
      <div className="space-y-3">
        {/* 三源全空的状态卡是纯噪声（大量 CR/ConfigMap 本就没有 status）：整卡不渲染 */}
        {(head || statusEntries.length > 0 || conditions.length > 0) && (
        <Card>
          <CardContent className="pt-3">
            <SectionTitle>{t('res:statusTitle')}</SectionTitle>
            {head && (
              <div className="mb-3 flex items-baseline gap-2">
                <span className={cn('text-2xl leading-none font-medium tabular-nums', head.tone !== 'muted' && toneText[head.tone])}>
                  <FlashVal v={head.value}>{head.value}</FlashVal>
                </span>
                {head.label && <span className="text-[13px] text-muted-foreground">{t(head.label)}</span>}
                <span className={cn('size-2 self-center rounded-full', toneDot[head.tone])} />
              </div>
            )}
            {statusEntries.length > 0 && (
              <dl className="grid grid-cols-1 gap-x-8 gap-y-0 text-[13px] leading-5 sm:grid-cols-2">
                {statusEntries.map(([k, v]) => (
                  <Item key={k} k={k} v={v} mono vClass={k === 'failed' && Number(v) > 0 ? toneText.negative : undefined} />
                ))}
              </dl>
            )}
            {conditions.length > 0 && (
              <div className={cn('space-y-1', (head || statusEntries.length > 0) && 'mt-3')}>
                {conditions.map(c => {
                  // Failed/FailureTarget=True 是事故本身不是「就绪」——True 不再一律绿
                  const bad = conditionBad(c.type, c.status)
                  return (
                  <div key={c.type} className={cn('flex items-center gap-3 rounded-md border px-3 py-2 text-[13px]', bad && 'border-l-2 border-l-negative/70 bg-negative/[0.04]')}>
                    <span className="w-32 shrink-0 truncate font-medium" title={c.type}>
                      {c.type}
                    </span>
                    <span className={cn('w-12 shrink-0', bad ? toneText.negative : c.status === 'True' ? toneText.positive : 'text-muted-foreground')}>
                      <FlashVal v={c.status}>{c.status}</FlashVal>
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-muted-foreground"
                      title={[c.reason, c.message].filter(Boolean).join(': ')}
                    >
                      {c.reason && <span className="mr-2 font-medium">{c.reason}</span>}
                      {c.message}
                    </span>
                  </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
        )}

        {/* 语义密度上移至状态之后：13" 首屏必须能看到「跑什么版本/探针/配额」，
            UID/resourceVersion 这类低频追溯字段让位（评审外围建议 A） */}
        <PodSpecSection obj={obj as unknown as Record<string, unknown>} />

        <Card>
          <CardContent className="pt-3">
            <SectionTitle>{t('res:detailsTitle')}</SectionTitle>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-0 text-[13px] leading-5 sm:grid-cols-2">
              <Item k={t('res:rowCreatedAt')} v={fmtCreated(obj)} />
              <Item k={t('res:rowNs')} v={m.namespace} />
              {HPA_TARGET_KINDS[def.kind] && ns !== 'cluster' && (
                <HpaOwnerRow cluster={cluster} ns={ns ?? ''} kind={def.kind} name={name ?? ''} />
              )}
              <Item k="UID" v={m.uid} mono />
              <Item k="resourceVersion" v={m.resourceVersion} mono />
              {m.ownerReferences?.[0] && (
                <Item
                  k={t('res:rowOwner')}
                  v={`${m.ownerReferences[0].kind}/${m.ownerReferences[0].name}`}
                />
              )}
            </dl>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3">
        {labels.length > 0 && (
          <Card>
            <CardContent className="pt-3">
              <SectionTitle>{tf('res:labelsCount', { n: labels.length })}</SectionTitle>
              <div className="flex flex-wrap gap-1.5">
                {userLabels.map(([k, v]) => (
                  <Badge key={k} variant="secondary" className="max-w-full truncate font-mono" title={`${k}=${v}`}>
                    {k}={v}
                  </Badge>
                ))}
                {sysLabels.length > 0 && (
                  <Badge variant="outline" className="shrink-0 cursor-help text-muted-foreground" title={sysLabels.map(([k, v]) => `${k}=${v}`).join('、')}>
                    +{sysLabels.length} {t('res:sysTags')}
                  </Badge>
                )}
              </div>
            </CardContent>
          </Card>
        )}
        {annotations.length > 0 && (
          <Card>
            <CardContent className="pt-3">
              <SectionTitle>{tf('res:annotationsCount', { n: annotations.length })}</SectionTitle>
              <div className="space-y-1 text-[13px]">
                {annotations.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[minmax(0,380px)_minmax(0,1fr)] gap-2">
                    <span className="truncate font-mono text-muted-foreground" title={k}>
                      {k}
                    </span>
                    <span className="break-words [overflow-wrap:anywhere] font-mono" title={v}>
                      {v.length > 160 ? v.slice(0, 160) + '…' : v}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Secret：data 各键 base64 解码视图（掩码/展开/复制，仅本机解码） */}
      {obj.kind === 'Secret' && <SecretValues obj={obj as unknown as Record<string, unknown>} />}

      {/* 变更追溯（managedFields）：全 kind 通用，看各控制器/客户端最后一次写入时间 */}
      <ChangeTraceCard cluster={cluster} path={itemPath(def, ns, name)} />
    </div>
  )
}

/**
 * 工作负载类关键数字（状态卡头图）：
 * Deployment/StatefulSet/ReplicaSet → readyReplicas/spec.replicas；
 * DaemonSet → numberReady/desiredNumberScheduled；Job → succeeded/completions。
 * 其余 kind 无头图，只显示状态字段。
 * tone：失败锚（failed>0 且无一成功——Job 的 0/1 此前与「还在跑」不可分，失败计数
 * 只埋在状态标量区）→ negative「失败」；就绪未满 → caution；暂停的 Deployment 读数
 * 再满也不再收敛 → caution（amber 提醒「别等它」）。
 */
function statusHeadline(obj: YamlDoc, t: (key: string) => string): { value: string; label: string; tone: Tone } | null {
  const st = obj.status as Record<string, unknown> | undefined
  const n = (v: unknown) => (typeof v === 'number' ? v : null)
  if (!st || !obj.kind) return null
  if ((n(st.failed) ?? 0) > 0 && (n(st.succeeded) ?? 0) === 0)
    return { value: t('res:colFailed'), label: '', tone: 'negative' }
  let head: { value: string; label: string; tone: Tone } | null = null
  if (obj.kind === 'Deployment' || obj.kind === 'StatefulSet' || obj.kind === 'ReplicaSet') {
    const total = n(obj.spec?.replicas) ?? n(st.replicas)
    if (total != null) {
      const ready = n(st.readyReplicas) ?? 0
      // CrashLoop 与「刚建还没起」都藏在 Available=False 里:ready<total 且 Available=False → 整卡红,不是黄锚灰行
      const availFalse = ((st.conditions ?? []) as { type?: string; status?: string }[]).some(c => c.type === 'Available' && c.status === 'False')
      head = { value: `${ready}/${total}`, label: 'res:readyLabel', tone: ready >= total ? 'positive' : availFalse ? 'negative' : 'caution' }
    }
  }
  if (obj.kind === 'DaemonSet') {
    const total = n(st.desiredNumberScheduled)
    if (total != null) {
      const ready = n(st.numberReady) ?? 0
      head = { value: `${ready}/${total}`, label: 'res:readyLabel', tone: ready < total ? 'caution' : 'positive' }
    }
  }
  if (obj.kind === 'Job') {
    const done = n(st.succeeded)
    if (done != null) {
      const total = n(obj.spec?.completions) ?? 1
      head = { value: `${done}/${total}`, label: 'res:succeededLabel', tone: done >= total ? 'positive' : 'muted' }
    }
  }
  if (!head) return null
  if ((obj.spec as { paused?: unknown } | undefined)?.paused === true && head.tone === 'positive')
    head = { ...head, tone: 'caution' }
  return head
}

/** status 的标量字段（conditions 单独成块）：标量数组逗号拼接，嵌套对象 JSON 化（如 PVC capacity） */
function statusScalars(obj: YamlDoc): [string, string][] {
  const st = obj.status
  if (!st || typeof st !== 'object') return []
  const out: [string, string][] = []
  for (const [k, v] of Object.entries(st as Record<string, unknown>)) {
    if (k === 'conditions' || v == null) continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const s = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? fmtTime(v) : String(v)
      out.push([k, s])
    }
    else if (Array.isArray(v)) {
      if (v.length > 0 && v.every(x => typeof x === 'string' || typeof x === 'number')) out.push([k, v.join(', ')])
    } else if (typeof v === 'object') {
      // 空对象/空数组=还没发生（loadBalancer {}、uncountedTerminatedPods {}）：占行只会成残渣
      const o = JSON.stringify(v)
      if (o !== '{}' && o !== '[]') out.push([k, o])
    }
  }
  return out
}

function statusConditions(obj: YamlDoc): { type: string; status: string; reason?: string; message?: string }[] {
  const st = obj.status as { conditions?: unknown } | undefined
  return Array.isArray(st?.conditions) ? (st!.conditions as { type: string; status: string; reason?: string; message?: string }[]) : []
}

/** 详情/状态行：key 左、value 右（与 Pod/Node 详情页 Item 同款）；长值 truncate + title */
function Item({ k, v, mono, vClass }: { k: string; v?: string | ReactNode; mono?: boolean; vClass?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground" title={k}>
        {k}
      </dt>
      <dd className={cn('min-w-0 truncate leading-5', mono && 'font-mono text-xs', vClass)} title={typeof v === 'string' ? v : undefined}>
        {v ?? '-'}
      </dd>
    </div>
  )
}

/** useFlash 接线点：watch/重查数据真实变化时 currentColor 闪一下（静态文本勿接） */
function FlashVal({ v, children }: { v: unknown; children: ReactNode }) {
  const { flash, onEnd } = useFlash(v)
  return (
    <span data-flash={flash || undefined} onAnimationEnd={onEnd}>
      {children}
    </span>
  )
}

/** 系统托管标签判定（与 PodSpecSection 的同名正则同源） */
const SYS_SELECTOR_RE = /(controller-uid|pod-template-hash|pod-index|batch\.kubernetes\.io|apps\.kubernetes\.io)/

/** 事件 tab：watch 该对象相关事件（fieldSelector involvedObject.name） */
function EventsTab({ cluster, ns, name, kind }: { cluster: string; ns: string; name: string; kind: string }) {
  const { lang } = useLang()
  const t = useT()
  const { items, reconnecting, error } = useWatch<Event>({
    cluster,
    path: `/api/v1/namespaces/${ns}/events`,
    // kind 必须入 fieldSelector：同 ns 同名异 kind（Deployment 与 Service 同名
    // 是常见命名习惯）否则两页事件互串，排障时被误导
    params: { fieldSelector: `involvedObject.name=${name},involvedObject.kind=${kind}` },
  })
  const byTime = (a: (typeof items)[number], b: (typeof items)[number]) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? '')
  const warnings = items.filter(e => e.type === 'Warning').sort(byTime)
  const normals = items.filter(e => e.type === 'Normal').sort(byTime)
  const rows = [...warnings, ...normals]

  if (reconnecting) return <div className="p-4 text-[13px] text-muted-foreground">{t('res:eventsReconnecting')}</div>
  // 403/网络失败渲染成「无事件」假空态会直接误导排障（事件恰恰是无权限时最想看的）
  if (error != null && rows.length === 0)
    return (
      <Alert variant="destructive" className="my-2">
        <AlertTitle>{t('res:listError')}</AlertTitle>
        <AlertDescription>{tf('res:loadFailed', { msg: error })}</AlertDescription>
      </Alert>
    )
  if (rows.length === 0)
    return (
      <div className="flex h-full min-h-32 items-center justify-center text-[13px] text-muted-foreground">
        {t('res:noEvents')}
      </div>
    )

  return (
    <div className="space-y-1.5 pb-4">
      {rows.map(e => (
        <div
          key={e.metadata.uid}
          className={cn(
            'rounded-md border p-2 text-[13px]',
            e.type === 'Warning'
              ? 'border-caution/30 bg-caution/5'
              : 'border-border/50',
          )}
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'w-14 shrink-0',
                e.type === 'Warning' ? 'text-caution' : 'text-muted-foreground',
              )}
            >
              {eventTypeLabel(e.type, lang)}
            </span>
            <span className="min-w-0 truncate font-medium" title={e.reason}>
              {eventReasonLabel(e.reason, lang)}
            </span>
            {e.count && e.count > 1 && <span className="shrink-0 tabular-nums text-muted-foreground">×{e.count}</span>}
            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
              {fmtTime(e.lastTimestamp)}
            </span>
          </div>
          <div className="mt-1 break-words">{e.message}</div>
        </div>
      ))}
    </div>
  )
}

/** 资源不存在（404）：明确空态 + 返回链接 */
function NotFoundState({ title, desc, to }: { title: string; desc: string; to?: string }) {
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
        {to && (
          <EmptyContent className="gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to={to}>{t('res:backToList')}</Link>
            </Button>
          </EmptyContent>
        )}
      </Empty>
    </div>
  )
}

/** 可作为 HPA scaleTargetRef 的 kind */
const HPA_TARGET_KINDS: Record<string, true> = { Deployment: true, StatefulSet: true, DaemonSet: true, ReplicaSet: true }

/** 详情页 → 管它的 HPA 反查（伸缩入口与容量真相之间此前只能凭名字去「其他资源」猜） */
function HpaOwnerRow({ cluster, ns, kind, name }: { cluster: string; ns: string; kind: string; name: string }) {
  const t = useT()
  const q = useQuery({
    queryKey: ['wl-hpa', cluster, ns],
    queryFn: async () => {
      const p = (v: string) => `/apis/autoscaling/${v}/namespaces/${ns}/horizontalpodautoscalers`
      try {
        return await list(cluster, p('v2'))
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return await list(cluster, p('v1'))
        throw e
      }
    },
    staleTime: 30_000,
    retry: 0,
  })
  const owner = (q.data?.items ?? []).find(
    (h: K8sObject & { spec?: { scaleTargetRef?: { kind?: string; name?: string } } }) =>
      h.spec?.scaleTargetRef?.kind === kind && h.spec?.scaleTargetRef?.name === name,
  )
  if (!owner?.metadata?.name) return null
  return (
    <Item
      k={t('sys:hpaChip')}
      v={
        <NavLink to={detailRoute(RESOURCE_MAP['HorizontalPodAutoscaler'], cluster, ns, owner.metadata.name)} className="font-mono text-xs hover:underline">
          {owner.metadata.name}
        </NavLink>
      }
    />
  )
}
