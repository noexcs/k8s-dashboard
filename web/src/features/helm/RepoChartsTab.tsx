// Helm「图表」+「仓库」两个 tab（HelmPage 顶层 tabs 的内容区，懒挂载：Radix Tabs 未激活不渲染）。
// 后端没有任何仓库时 GET /charts 直接 500（charts.go 读索引失败即 500）→
// Charts tab 先查 /repositories，空则显示引导去 Repositories，绝不把 500 裸抛给用户。
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Download, Loader2, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  HelmHttpError,
  addRepo,
  listCharts,
  listRepos,
  removeRepo,
  type HelmChartSummary,
} from '@/api/helm'
import { tf, useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { LIST_GRID_HEADER, LIST_GRID_ROW } from '@/lib/listGrid'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
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
import { InstallChartDialog, compareVersionsDesc, type HelmDialogTarget } from './InstallChartDialog'

// grid 列模板（布局专属，表头/行样式统一走 lib/listGrid 共享常量）
const CHART_COLS = 'grid-cols-[28px_minmax(160px,1.4fr)_minmax(200px,2fr)_110px_90px_minmax(120px,1fr)_72px]'
const REPO_COLS = 'grid-cols-[minmax(120px,0.8fr)_minmax(240px,2fr)_180px]'

const CHARTS_STALE_MS = 60_000

// ---------- Charts ----------

/** 按 chart 名聚合：跨 repo 同名合并，版本降序去重 */
interface ChartGroup {
  name: string
  description: string
  appVersion: string
  repos: string[]
  /** version → 提供该版本的仓库（安装坐标 = repo/name + version） */
  versions: { version: string; repos: string[] }[]
}

function groupCharts(rows: HelmChartSummary[]): ChartGroup[] {
  const byName = new Map<string, ChartGroup>()
  for (const r of rows) {
    let g = byName.get(r.name)
    if (!g) {
      g = { name: r.name, description: r.description, appVersion: r.appVersion, repos: [], versions: [] }
      byName.set(r.name, g)
    }
    if (r.repository && !g.repos.includes(r.repository)) g.repos.push(r.repository)
    if (r.description && !g.description) g.description = r.description
    if (r.appVersion && !g.appVersion) g.appVersion = r.appVersion
    let v = g.versions.find(x => x.version === r.version)
    if (!v) {
      v = { version: r.version, repos: [] }
      g.versions.push(v)
    }
    if (r.repository && !v.repos.includes(r.repository)) v.repos.push(r.repository)
  }
  for (const g of byName.values()) g.versions.sort((a, b) => compareVersionsDesc(a.version, b.version))
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function ChartsTab({
  cluster,
  onGoToRepositories,
  onInstalled,
}: {
  cluster: string
  onGoToRepositories: () => void
  /** 安装成功：父组件跳回 Releases tab */
  onInstalled: () => void
}) {
  const t = useT()
  const qc = useQueryClient()
  const [input, setInput] = useState('')
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ group: ChartGroup; version: string } | null>(null)

  // 搜索防抖 300ms 后才打后端（?filter= 走服务端过滤，避免每次按键一个请求）
  useEffect(() => {
    const id = setTimeout(() => setFilter(input.trim()), 300)
    return () => clearTimeout(id)
  }, [input])

  // 仓库为空 = charts 500 的已知原因，先探测再决定是否请求 charts；
  // 探测本身失败时同样无法确认有仓库 → 一并走引导，不裸抛 500 文案
  const { data: repoData, isError: reposProbeFailed, isFetching: reposFetching, refetch: refetchRepos } = useQuery({
    queryKey: ['helm-repos', cluster],
    queryFn: () => listRepos(cluster),
    staleTime: CHARTS_STALE_MS,
    retry: false,
  })
  const noRepos = (repoData != null && repoData.repositories.length === 0) || reposProbeFailed

  // 未加仓库（或索引缺失）时 /charts 会 500：等 repos 探测结果，空则不发必挂的请求
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['helm-charts', cluster, filter],
    queryFn: () => listCharts(cluster, filter || undefined),
    enabled: repoData != null && !noRepos,
    staleTime: CHARTS_STALE_MS,
    placeholderData: keepPreviousData,
    retry: false,
  })
  const groups = useMemo(() => groupCharts(data?.charts ?? []), [data])

  const installTarget = (g: ChartGroup, version: string, repo: string): HelmDialogTarget => ({
    mode: 'install',
    repo,
    name: g.name,
    versions: g.versions.map(v => v.version),
    version,
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 @sm/main:w-64 @sm/main:flex-none">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={t('helm:chartsSearchPlaceholder')}
            className="pl-8"
          />
        </div>
        <Button
          variant="outline"
          onClick={() => {
            // 引导态下 charts 查询是禁用/无意义的：刷新 = 重新探测仓库列表
            if (noRepos) void refetchRepos()
            else void refetch()
          }}
          disabled={isFetching || reposFetching}
        >
          {isFetching || reposFetching ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          {t('sys:refresh')}
        </Button>
      </div>

      {noRepos ? (
        <div className="rounded-lg border bg-card p-8 text-center text-[13px] text-muted-foreground">
          <div className="mx-auto max-w-md space-y-2">
            <div className="text-sm font-medium text-foreground">{t('helm:noReposTitle')}</div>
            <p>{t('helm:noReposDesc')}</p>
            <Button onClick={onGoToRepositories}>
              {t('helm:goToRepositories')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {error != null && (
            <Alert variant="destructive" className="mb-3">
              <AlertTriangle />
              <AlertDescription>{tf('helm:chartsLoadFailed', { msg: error.message })}</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="xs" onClick={() => void refetch()}>
                  {t('sys:retry')}
                </Button>
              </AlertAction>
            </Alert>
          )}
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card">
            {isLoading || (repoData == null && !reposProbeFailed) ? (
              <div className="flex h-full min-h-32 items-center justify-center gap-2 text-[13px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t('sys:loadingSlow')}
              </div>
            ) : groups.length === 0 ? (
              <div className="flex h-full min-h-32 items-center justify-center p-8 text-center text-[13px] text-muted-foreground">{t('helm:emptyCharts')}</div>
            ) : (
              <>
                <div className={cn('grid', CHART_COLS, LIST_GRID_HEADER)}>
                  <span />
                  <span>{t('sys:colName')}</span>
                  <span>{t('sys:colDescription')}</span>
                  <span>{t('sys:appVersion')}</span>
                  <span>{t('sys:colVersion')}</span>
                  <span>{t('helm:colRepos')}</span>
                  <span className="text-right">{t('helm:install')}</span>
                </div>
                {groups.map(g => {
                  const open = expanded === g.name
                  const latest = g.versions[0]
                  return (
                    <div key={g.name} className="border-b border-border/40 last:border-b-0">
                      <div className={cn('grid', CHART_COLS, LIST_GRID_ROW)}>
                        <button
                          type="button"
                          aria-label={open ? t('helm:collapseVersions') : t('helm:expandVersions')}
                          className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                          onClick={() => setExpanded(open ? null : g.name)}
                        >
                          {g.versions.length > 1 ? (
                            open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />
                          ) : null}
                        </button>
                        <span className="truncate font-medium" title={g.name}>
                          {g.name}
                        </span>
                        <span className="truncate text-muted-foreground" title={g.description}>
                          {g.description || '-'}
                        </span>
                        <span className="truncate text-muted-foreground tabular-nums">{g.appVersion || '-'}</span>
                        <span className="truncate text-muted-foreground tabular-nums">{latest?.version ?? '-'}</span>
                        <span className="truncate text-muted-foreground" title={g.repos.join(', ')}>
                          {g.repos.join(', ')}
                        </span>
                        <span className="text-right">
                          {latest && (
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => setDialog({ group: g, version: latest.version })}
                            >
                              <Download />
                              {t('helm:install')}
                            </Button>
                          )}
                        </span>
                      </div>
                      {open && (
                        <div className="space-y-1 border-t border-border/40 bg-muted/20 px-3 py-2 text-[13px]">
                          <div className="text-muted-foreground">{t('helm:allVersions')}</div>
                          {g.versions.map(v => (
                            <div key={v.version} className="flex flex-wrap items-center gap-2">
                              <span className="w-28 shrink-0 font-mono">{v.version}</span>
                              <span className="truncate text-muted-foreground" title={v.repos.join(', ')}>
                                {v.repos.join(', ')}
                              </span>
                              <Button
                                variant="outline"
                                size="xs"
                                className="ml-auto"
                                onClick={() => setDialog({ group: g, version: v.version })}
                              >
                                {t('helm:install')}
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </>
      )}

      {dialog && (
        <InstallChartDialog
          cluster={cluster}
          target={installTarget(dialog.group, dialog.version, pickRepo(dialog.group, dialog.version))}
          onClose={() => setDialog(null)}
          onDone={action => {
            setDialog(null)
            // 新 release 立即可见：Releases tab 重新挂载时查询已失效
            void qc.invalidateQueries({ queryKey: ['helm-releases', cluster] })
            if (action === 'install') onInstalled()
          }}
        />
      )}
    </div>
  )
}

/** 展开面板里选版本时可能只属于某一个仓库；优先给该版本真实来源仓库 */
function pickRepo(g: ChartGroup, version: string): string {
  return g.versions.find(v => v.version === version)?.repos[0] ?? g.repos[0] ?? ''
}

// ---------- Repositories ----------

const NAME_OK = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

export function RepositoriesTab({ cluster }: { cluster: string }) {
  const t = useT()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [insecure, setInsecure] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['helm-repos', cluster],
    queryFn: () => listRepos(cluster),
    staleTime: 15_000,
    retry: false,
  })
  const repos = data?.repositories ?? []

  const refresh = () => {
    void refetch()
    void qc.invalidateQueries({ queryKey: ['helm-charts', cluster] })
  }

  // add 同步下载索引，慢仓库可达几十秒 → mutation pending 期间按钮保持 spinner
  const add = useMutation({
    mutationFn: () =>
      addRepo(cluster, { name: name.trim(), url: url.trim(), ...(insecure ? { insecureSkipTLSverify: true } : {}) }),
    onSuccess: () => {
      toast.success(tf('helm:repoAdded', { name: name.trim() }))
      setName('')
      setUrl('')
      setInsecure(false)
      refresh()
    },
    onError: e => toast.error(tf('helm:repoAddFailed', { msg: e instanceof Error ? e.message : String(e) })),
  })

  const remove = useMutation({
    mutationFn: (n: string) => removeRepo(cluster, n),
    onSuccess: (_d, n) => {
      toast.success(tf('helm:repoRemoved', { name: n }))
      refresh()
    },
    onError: e => {
      // 列表与服务端不一致（他人已删）→ 不报错，刷新即可
      if (e instanceof HelmHttpError && e.status === 404) refresh()
      else toast.error(tf('helm:repoRemoveFailed', { msg: e instanceof Error ? e.message : String(e) }))
    },
  })

  // 「刷新索引」= 同名同地址重新 add：后端 add 同步 DownloadIndexFile，
  // update 端点只改条目不拉索引（repository.go updateRepositoryWithRequest 无 DownloadIndexFile），故不用它。
  const refreshIndex = useMutation({
    mutationFn: (r: { name: string; url: string }) => addRepo(cluster, r),
    onSuccess: (_d, r) => {
      toast.success(tf('helm:indexRefreshed', { name: r.name }))
      refresh()
    },
    onError: (e, _r) => toast.error(tf('helm:indexRefreshFailed', { msg: e instanceof Error ? e.message : String(e) })),
  })

  const canAdd = NAME_OK.test(name.trim()) && /^https?:\/\/.+/i.test(url.trim()) && !add.isPending

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 添加表单 */}
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 text-[13px] font-medium">{t('helm:addRepo')}</div>
        <div className="flex flex-wrap items-start gap-2">
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('helm:repoNamePlaceholder')}
            className="w-40 font-mono"
          />
          <Input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder={t('helm:repoUrlPlaceholder')}
            className="min-w-0 flex-1 font-mono @sm/main:w-80 @sm/main:flex-none"
          />
          <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            {t('sys:refresh')}
          </Button>
          <Button disabled={!canAdd} onClick={() => void add.mutate()}>
            {add.isPending ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
            {add.isPending ? t('helm:repoAdding') : t('helm:addRepo')}
          </Button>
        </div>
        <label className="mt-2 flex items-start gap-2 text-[13px]">
          <Checkbox checked={insecure} onCheckedChange={v => setInsecure(v === true)} className="mt-0.5" />
          <span>
            <span className="font-medium">{t('helm:repoInsecure')}</span>
            <span className="block text-muted-foreground">{t('helm:repoInsecureHint')}</span>
          </span>
        </label>
      </div>

      {error != null && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{tf('sys:loadFailed', { msg: error.message })}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="xs" onClick={() => void refetch()}>
              {t('sys:retry')}
            </Button>
          </AlertAction>
        </Alert>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card">
        {isLoading ? (
          <div className="flex h-full min-h-32 items-center justify-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('sys:loadingSlow')}
          </div>
        ) : repos.length === 0 ? (
          <div className="flex h-full min-h-32 items-center justify-center p-8 text-center text-[13px] text-muted-foreground">{t('helm:emptyRepos')}</div>
        ) : (
          <>
            <div className={cn('grid', REPO_COLS, LIST_GRID_HEADER)}>
              <span>{t('sys:colName')}</span>
              <span>{t('helm:repoUrl')}</span>
              <span className="text-right">{t('helm:colAction')}</span>
            </div>
            {repos.map(r => (
              <div
                key={r.name}
                className={cn(
                  'grid last:border-b-0',
                  REPO_COLS,
                  LIST_GRID_ROW,
                  refreshIndex.isPending && refreshIndex.variables?.name === r.name && 'opacity-60',
                )}
              >
                <span className="truncate font-medium" title={r.name}>
                  {r.name}
                </span>
                <span className="truncate text-muted-foreground" title={r.url}>
                  {r.url}
                </span>
                <span className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={refreshIndex.isPending}
                    title={t('helm:refreshIndexHint')}
                    onClick={() => void refreshIndex.mutate({ name: r.name, url: r.url })}
                  >
                    <RefreshCw />
                    {t('helm:refreshIndex')}
                  </Button>
                  <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => setConfirmRemove(r.name)}>
                    <Trash2 />
                    {t('sys:delete')}
                  </Button>
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      {/* 删除确认 */}
      <AlertDialog open={confirmRemove != null} onOpenChange={v => { if (!v) setConfirmRemove(null) }}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{tf('helm:removeRepoTitle', { name: confirmRemove ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('helm:removeRepoDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>{t('sys:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                const n = confirmRemove
                setConfirmRemove(null)
                if (n) void remove.mutate(n)
              }}
            >
              {remove.isPending ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
              {t('sys:delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
