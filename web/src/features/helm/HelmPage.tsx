// Helm releases：/c/:cluster/helm（列表，30s 轮询）+ /c/:cluster/helm/:ns/:name（详情：概览/values/manifest/历史）
// 后端为异步变更（202 秒回 + /action/status 轮询）；list/get 同步走 apiserver，tailnet 慢时耐心等。
import {
  AlertTriangle,
  ChevronLeft,
  History as HistoryIcon,
  Loader2,
  FileCodeIcon,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { stringify as yamlStringify } from 'yaml'
import { toast } from 'sonner'
import {
  HelmHttpError,
  getRelease,
  getReleaseHistory,
  listReleases,
  rollbackRelease,
  uninstallRelease,
  waitForAction,
  type HelmRelease,
} from '@/api/helm'
import { list, namespacesPath } from '@/api/client'
import { tf, useT } from '@/i18n'
import { ChartsTab, RepositoriesTab } from './RepoChartsTab'
import { InstallChartDialog, type HelmDialogTarget } from './InstallChartDialog'
import type { K8sObject } from '@/api/types'
import { fmtTime, shortTime } from '@/lib/format'
import { LIST_GRID_HEADER, LIST_GRID_ROW } from '@/lib/listGrid'
import { cn } from '@/lib/utils'
import { useHighlightedCode } from '@/hooks/use-highlighted-code'
import { Button } from '@/components/ui/button'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
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
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from '@/components/ui/code-block'
import { useCodeActions } from '@/components/code-actions'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

// grid 列模板（布局专属，表头/行样式统一走 lib/listGrid 共享常量）
const REL_COLS = 'grid-cols-[minmax(160px,1.4fr)_minmax(110px,1fr)_minmax(120px,1.2fr)_90px_minmax(110px,0.9fr)_56px_110px_64px]'
const HIST_COLS = 'grid-cols-[64px_minmax(120px,1fr)_minmax(160px,1.4fr)_150px_90px]'

const POLL_MS = 30_000

const STATUS_STYLE: Record<string, { dot: string; text: string; label: string }> = {
  deployed: { dot: 'bg-positive', text: 'text-positive', label: 'deployed' },
  failed: { dot: 'bg-destructive', text: 'text-destructive', label: 'failed' },
  uninstalling: { dot: 'bg-caution', text: 'text-caution', label: 'uninstalling' },
  'pending-install': { dot: 'bg-caution', text: 'text-caution', label: 'pending-install' },
  'pending-upgrade': { dot: 'bg-caution', text: 'text-caution', label: 'pending-upgrade' },
  'pending-rollback': { dot: 'bg-caution', text: 'text-caution', label: 'pending-rollback' },
  superseded: { dot: 'bg-muted-foreground', text: 'text-muted-foreground', label: 'superseded' },
  uninstalled: { dot: 'bg-muted-foreground', text: 'text-muted-foreground', label: 'uninstalled' },
}

function StatusPill({ r }: { r: Pick<HelmRelease, 'info'> }) {
  const s = r.info?.status ?? 'unknown'
  const st = STATUS_STYLE[s] ?? { dot: 'bg-muted-foreground', text: 'text-muted-foreground', label: s }
  return (
    <span className={cn('inline-flex items-center gap-1.5', st.text)}>
      <span className={cn('size-1.5 shrink-0 rounded-full', st.dot)} />
      {st.label}
    </span>
  )
}

export function HelmPage() {
  const { cluster, ns, name } = useParams()
  if (cluster && ns && name) return <HelmDetailPage cluster={cluster} ns={ns} name={name} />
  return <HelmHome cluster={cluster ?? ''} />
}

// ---------- 顶层导航：Releases | Charts | Repositories ----------
// Radix Tabs 未激活的 content 不挂载 → Charts/Repositories 的查询只在切过去后发起。

type HomeTab = 'releases' | 'charts' | 'repos'

function HelmHome({ cluster }: { cluster: string }) {
  const t = useT()
  const [tab, setTab] = useState<HomeTab>(() => {
    const q = new URLSearchParams(window.location.search).get('tab')
    return q === 'charts' || q === 'repos' ? q : 'releases'
  })
  return (
    <Tabs value={tab} onValueChange={v => setTab(v as HomeTab)} className="h-full min-h-0 gap-0">
      <TabsList className="mb-3 w-fit shrink-0">
        <TabsTrigger value="releases">{t('helm:tabReleases')}</TabsTrigger>
        <TabsTrigger value="charts">{t('helm:tabCharts')}</TabsTrigger>
        <TabsTrigger value="repos">{t('helm:tabRepositories')}</TabsTrigger>
      </TabsList>
      <TabsContent value="releases" className="flex min-h-0 flex-col">
        <HelmListPage cluster={cluster} />
      </TabsContent>
      <TabsContent value="charts" className="flex min-h-0 flex-col">
        <ChartsTab cluster={cluster} onGoToRepositories={() => setTab('repos')} onInstalled={() => setTab('releases')} />
      </TabsContent>
      <TabsContent value="repos" className="flex min-h-0 flex-col">
        <RepositoriesTab cluster={cluster} />
      </TabsContent>
    </Tabs>
  )
}

// ---------- 列表 ----------

function HelmListPage({ cluster }: { cluster: string }) {
  const t = useT()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [ns, setNs] = useState<string>('all')
  const [filter, setFilter] = useState('')
  // 「升级」对话框复用 InstallChartDialog（upgrade 模式）；成功后刷新列表
  const [upgradeTarget, setUpgradeTarget] = useState<HelmDialogTarget | null>(null)

  const { data: nsData } = useQuery({
    queryKey: ['namespaces', cluster],
    queryFn: () => list<K8sObject>(cluster, namespacesPath),
    staleTime: 60_000,
  })
  const namespaces = nsData?.items.map(i => i.metadata.name) ?? []

  const { data, isLoading, error, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['helm-releases', cluster, ns],
    queryFn: () =>
      listReleases(cluster, ns === 'all' ? { allNamespaces: true, byDate: true } : { allNamespaces: false, namespace: ns, byDate: true }),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: false,
    staleTime: 0,
  })

  const releases = data?.releases ?? []
  const visible = filter
    ? releases.filter(r => r.name.toLowerCase().includes(filter.toLowerCase()))
    : releases

  return (
    <div className="flex h-full flex-col">
      {/* 窄屏：筛选/搜索/刷新整组换到第二行（w-full），搜索框弹性占满剩余宽度 */}
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <PackageOpen className="mt-1 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 @sm/main:flex-none">
          <h1 className="whitespace-nowrap text-lg font-medium leading-6">Helm Releases</h1>
          <div className="mt-0.5 truncate text-[13px] tabular-nums text-muted-foreground">
            {tf('sys:releaseCount', { n: visible.length })}
            {dataUpdatedAt > 0 && ` · ${tf('sys:syncedAt', { time: new Date(dataUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false }) })}`}
          </div>
        </div>
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 @sm/main:w-auto">
          <div className="w-44 shrink-0">
            <Select value={ns} onValueChange={setNs}>
              <SelectTrigger>
                <SelectValue placeholder={t('sys:allNamespaces')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('sys:allNamespaces')}</SelectItem>
                {namespaces.map(n => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="relative min-w-0 flex-1 @sm/main:w-56 @sm/main:flex-none">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t('sys:filterName')}
              className="w-full pl-8"
            />
          </div>
          <Button
            variant="outline"
            className="shrink-0"
            onClick={() => {
              void refetch().then(() => queryClient.invalidateQueries({ queryKey: ['helm-releases', cluster] }))
            }}
            disabled={isFetching}
          >
            {isFetching ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            {t('sys:refresh')}
          </Button>
        </div>
      </div>

      {error != null && (
        <Alert variant="destructive" className="mb-3">
          <AlertTriangle />
          <AlertDescription>{tf('sys:loadFailed', { msg: error.message })}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="xs" onClick={() => void refetch()}>
              {t('sys:retry')}
            </Button>
          </AlertAction>
        </Alert>
      )}

      {/* 列模板留在本页（布局专属），表头/行样式走 LIST_GRID_*（与 ResourceDataTable 底座同源） */}
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card">
        {isLoading ? (
          <div className="flex h-full min-h-32 items-center justify-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('sys:loadingSlow')}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full min-h-32 items-center justify-center p-8 text-center text-[13px] text-muted-foreground">
            {filter ? t('sys:noMatchingRelease') : t('sys:noReleasesInNs')}
          </div>
        ) : (
          <div className={cn('grid', REL_COLS, LIST_GRID_HEADER)}>
            <span>{t('sys:colName')}</span>
            <span>{t('sys:colNamespace')}</span>
            <span>{t('helm:colChart')}</span>
            <span>{t('sys:colVersion')}</span>
            <span>{t('sys:colStatus')}</span>
            <span className="text-right">{t('sys:colRevision')}</span>
            <span>{t('sys:colUpdated')}</span>
            <span className="text-right">{t('helm:colAction')}</span>
          </div>
        )}
        {visible.map(r => (
          <div
            key={`${r.namespace}/${r.name}`}
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/c/${cluster}/helm/${r.namespace}/${r.name}`)}
            onKeyDown={e => {
              if (e.key === 'Enter') navigate(`/c/${cluster}/helm/${r.namespace}/${r.name}`)
            }}
            className={cn('grid cursor-pointer', REL_COLS, LIST_GRID_ROW, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40')}
          >
            <span className="truncate font-medium" title={r.name}>
              {r.name}
            </span>
            <span className="truncate text-muted-foreground">{r.namespace}</span>
            <span className="truncate text-muted-foreground" title={r.chart?.metadata?.name}>
              {r.chart?.metadata?.name ?? '-'}
            </span>
            <span className="truncate text-muted-foreground">{r.chart?.metadata?.version ?? '-'}</span>
            <span>
              <StatusPill r={r} />
            </span>
            <span className="text-right text-muted-foreground tabular-nums">{r.version}</span>
            <span
              className="truncate text-muted-foreground tabular-nums"
              title={r.info?.last_deployed ? fmtTime(r.info.last_deployed) : undefined}
            >
              {shortTime(r.info?.last_deployed)}
            </span>
            <span className="text-right" onClick={e => e.stopPropagation()}>
              <Button
                variant="ghost"
                size="xs"
                title={t('helm:upgrade')}
                onClick={() =>
                  setUpgradeTarget({
                    mode: 'upgrade',
                    releaseName: r.name,
                    namespace: r.namespace,
                    chartName: r.chart?.metadata?.name ?? '',
                    chartVersion: r.chart?.metadata?.version ?? '',
                  })
                }
              >
                {t('helm:upgrade')}
              </Button>
            </span>
          </div>
        ))}
      </div>

      {upgradeTarget && (
        <InstallChartDialog
          cluster={cluster}
          target={upgradeTarget}
          onClose={() => setUpgradeTarget(null)}
          onDone={() => {
            void queryClient.invalidateQueries({ queryKey: ['helm-releases', cluster] })
          }}
        />
      )}
    </div>
  )
}

// ---------- 详情 ----------

type DetailTab = 'overview' | 'values' | 'manifest' | 'history'

function HelmDetailPage({ cluster, ns, name }: { cluster: string; ns: string; name: string }) {
  const t = useT()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<DetailTab>('overview')
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // waitForAction 最长等 5 分钟：等待期间离开页面（卸载）后不得再 setBusy/toast/navigate
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const { data: release, isLoading, error, refetch } = useQuery({
    queryKey: ['helm-release', cluster, ns, name],
    queryFn: () => getRelease(cluster, ns, name),
    retry: false,
  })

  const { data: historyData } = useQuery({
    queryKey: ['helm-history', cluster, ns, name],
    queryFn: () => getReleaseHistory(cluster, ns, name),
    retry: false,
  })
  const history = useMemo(
    () => [...(historyData?.releases ?? [])].sort((a, b) => b.version - a.version),
    [historyData],
  )

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['helm-release', cluster, ns, name] })
    void queryClient.invalidateQueries({ queryKey: ['helm-history', cluster, ns, name] })
    void queryClient.invalidateQueries({ queryKey: ['helm-releases', cluster] })
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t('sys:loadingSlow')}
      </div>
    )
  }
  if (error != null || release == null) {
    const gone = error instanceof HelmHttpError && error.status === 404
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        {gone ? tf('sys:releaseNotFound', { name }) : tf('sys:loadFailed', { msg: error?.message ?? t('sys:unknownError') })}
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void refetch()}>
            {t('sys:retry')}
          </Button>
          <Button onClick={() => navigate(`/c/${cluster}/helm`)}>
            {t('sys:backToList')}
          </Button>
        </div>
      </div>
    )
  }

  const doUninstall = async () => {
    setConfirmUninstall(false)
    setBusy(true)
    try {
      await uninstallRelease(cluster, ns, name)
      if (!mounted.current) return
      toast.info(tf('sys:uninstalling', { name }))
      const s = await waitForAction(cluster, name, 'uninstall', 5 * 60_000)
      if (!mounted.current) return
      if (s.status === 'success') {
        toast.success(tf('sys:uninstalled', { name }))
        refreshAll()
        navigate(`/c/${cluster}/helm`)
      } else {
        toast.error(tf('sys:uninstallFailed', { msg: s.message ?? t('sys:unknownError') }))
      }
    } catch (e) {
      if (!mounted.current) return
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      if (mounted.current) {
        setBusy(false)
        refreshAll()
      }
    }
  }

  const doRollback = async (revision: number) => {
    setRollbackOpen(false)
    setBusy(true)
    try {
      await rollbackRelease(cluster, ns, name, revision)
      if (!mounted.current) return
      toast.info(tf('sys:rollingBack', { name, rev: revision }))
      const s = await waitForAction(cluster, name, 'rollback', 5 * 60_000)
      if (!mounted.current) return
      if (s.status === 'success') {
        toast.success(tf('sys:rolledBack', { rev: revision }))
      } else {
        toast.error(tf('sys:rollbackFailed', { msg: s.message ?? t('sys:unknownError') }))
      }
    } catch (e) {
      if (!mounted.current) return
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      if (mounted.current) {
        setBusy(false)
        refreshAll()
      }
    }
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      {/* 窄屏：标题可截断、元信息整块换行，避免逐字竖排 */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={() => navigate(`/c/${cluster}/helm`)}
          title={t('sys:backToList')}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-medium @sm/main:flex-none">{release.name}</h1>
        <StatusPill r={release} />
        <span className="whitespace-nowrap text-[13px] tabular-nums text-muted-foreground">
          {release.namespace} · {release.chart?.metadata?.name}{' '}
          {release.chart?.metadata?.version} · {tf('sys:revN', { n: release.version })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            disabled={busy || history.length < 2}
            title={history.length < 2 ? t('sys:onlyOneRevision') : t('sys:rollbackToHistory')}
            onClick={() => setRollbackOpen(true)}
          >
            <RotateCcw className="size-3" />
            {t('sys:rollback')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => setConfirmUninstall(true)}
          >
            <Trash2 className="size-3" />
            {t('sys:uninstall')}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as DetailTab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="w-fit">
          <TabsTrigger value="overview">{t('sys:tabOverview')}</TabsTrigger>
          <TabsTrigger value="values">Values</TabsTrigger>
          <TabsTrigger value="manifest">Manifest</TabsTrigger>
          <TabsTrigger value="history">
            <span className="inline-flex items-center gap-1">
              <HistoryIcon className="size-3" />
              {t('sys:tabHistory')}
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-2 min-w-0 flex-1">
          <div className="max-w-2xl rounded-lg border bg-card">
            <InfoRow k="Chart" v={`${release.chart?.metadata?.name ?? '-'} @ ${release.chart?.metadata?.version ?? '-'}`} />
            {release.chart?.metadata?.appVersion != null && (
              <InfoRow k={t('sys:appVersion')} v={String(release.chart.metadata.appVersion)} />
            )}
            <InfoRow k={t('sys:colNamespace')} v={release.namespace} />
            <InfoRow k={t('sys:colRevision')} v={String(release.version)} />
            <InfoRow k={t('sys:firstDeployed')} v={fmtTime(release.info?.first_deployed)} />
            <InfoRow k={t('sys:lastDeployed')} v={fmtTime(release.info?.last_deployed)} />
            <InfoRow k={t('sys:colDescription')} v={release.info?.description || '-'} />
            {release.notes ? <InfoRow k="Notes" v={release.notes} /> : null}
          </div>
        </TabsContent>

        <TabsContent value="values" className="mt-2 min-w-0 flex-1">
          <ValuesPanel release={release} />
        </TabsContent>

        <TabsContent value="manifest" className="mt-2 min-w-0 flex-1">
          <YamlPanel title={tf('sys:manifestTitle', { n: (release.manifest ?? '').length })} text={release.manifest || t('sys:emptyManifest')} filename="manifest.yaml" />
        </TabsContent>

        <TabsContent value="history" className="mt-2 min-w-0 flex-1">
          <div className="overflow-hidden rounded-lg border bg-card">
            <div className={cn('grid', HIST_COLS, LIST_GRID_HEADER)}>
              <span>{t('sys:colRevision')}</span>
              <span>{t('sys:colStatus')}</span>
              <span>{t('sys:colDescription')}</span>
              <span>{t('sys:colUpdated')}</span>
              <span />
            </div>
            {history.map(h => (
              <div
                key={h.version}
                className={cn('grid last:border-b-0', HIST_COLS, LIST_GRID_ROW)}
              >
                <span className="font-medium tabular-nums">
                  {h.version}
                  {h.version === release.version ? t('sys:currentRevision') : ''}
                </span>
                <span>
                  <StatusPill r={h} />
                </span>
                <span className="truncate text-muted-foreground" title={h.info?.description}>
                  {h.info?.description ?? '-'}
                </span>
                <span className="text-muted-foreground tabular-nums" title={h.info?.last_deployed ? fmtTime(h.info.last_deployed) : undefined}>
                  {shortTime(h.info?.last_deployed)}
                </span>
                <span className="text-right">
                  {h.version !== release.version && (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() => {
                        void doRollback(h.version)
                      }}
                    >
                      <RotateCcw />
                      {t('sys:rollback')}
                    </Button>
                  )}
                </span>
              </div>
            ))}
            {history.length === 0 && <div className="p-8 text-center text-[13px] text-muted-foreground">{t('sys:noHistory')}</div>}
          </div>
        </TabsContent>
      </Tabs>

      {/* 卸载确认 */}
      <AlertDialog open={confirmUninstall} onOpenChange={setConfirmUninstall}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center justify-center gap-2 text-sm sm:justify-start">
              <AlertTriangle className="size-4 text-destructive" />
              {t('sys:uninstallReleaseTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('sys:uninstallWillDelete')}<span className="font-medium text-foreground">{ns}/{name}</span>{' '}
              {t('sys:uninstallRest')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t('sys:cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void doUninstall()}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : null}
              {t('sys:confirmUninstall')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 回滚确认 */}
      <AlertDialog open={rollbackOpen} onOpenChange={setRollbackOpen}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{tf('sys:rollbackTitle', { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {tf('sys:rollbackDesc', { rev: release.version })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {history
              .filter(h => h.version !== release.version)
              .map(h => (
                <button
                  key={h.version}
                  type="button"
                  disabled={busy}
                  onClick={() => void doRollback(h.version)}
                  className="flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/60 disabled:opacity-50"
                >
                  <RotateCcw className="size-3 shrink-0 text-muted-foreground" />
                  <span className="font-medium">{tf('sys:rollbackToRev', { rev: h.version })}</span>
                  <StatusPill r={h} />
                  <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{shortTime(h.info?.last_deployed)}</span>
                </button>
              ))}
              {history.filter(h => h.version !== release.version).length === 0 && (
              <div className="py-4 text-center text-[13px] text-muted-foreground">{t('sys:noRollbackTarget')}</div>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t('sys:cancel')}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex border-b border-border/40 px-3 py-1.5 text-[13px] last:border-b-0">
      <span className="w-24 shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0 break-all">{v}</span>
    </div>
  )
}

function ValuesPanel({ release }: { release: HelmRelease }) {
  const t = useT()
  const config = release.config && Object.keys(release.config).length > 0 ? release.config : undefined
  const values = release.values && Object.keys(release.values).length > 0 ? release.values : undefined
  if (!config && !values) {
    return <div className="rounded-lg border bg-card p-8 text-center text-[13px] text-muted-foreground">{t('sys:noValues')}</div>
  }
  return (
    <div className="space-y-3">
      {config && <YamlPanel title={t('sys:valuesOverrideTitle')} text={yamlStringify(config)} filename="values-override.yaml" />}
      {values && <YamlPanel title={t('sys:valuesEffectiveTitle')} text={yamlStringify(values)} filename="values-effective.yaml" />}
    </div>
  )
}

/** YAML 代码块：shiki 高亮 + 行号 + 官方工具栏（换行/下载/复制） */
function YamlPanel({ title, text, filename }: { title: string; text: string; filename: string }) {
  const lines = useHighlightedCode(text, 'yaml')
  const { wrap, actions } = useCodeActions(text, filename)
  return (
    <CodeBlock className="min-w-0">
      <CodeBlockHeader>
        <CodeBlockTitle><FileCodeIcon />{title}</CodeBlockTitle>
        {actions}
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers wrap={wrap} className="max-h-[60vh]">
        {lines.map((line, i) => (
          <CodeBlockLine key={i}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}
