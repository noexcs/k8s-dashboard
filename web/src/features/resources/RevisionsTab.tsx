// Rollout 历史（对齐 kubectl rollout history）：
// - Deployment：历史由 ReplicaSet 承载（annotation deployment.kubernetes.io/revision，
//   kubectl 同款数据源；k3s 实测 Deployment 不产生 ControllerRevision）
// - StatefulSet/DaemonSet：ControllerRevision（data.template）
// 回滚：把选中 revision 的 PodTemplate PATCH 回工作负载，等价 kubectl rollout undo
// （生成新 revision 而非删除旧的）。
import { useMemo, useState } from 'react'
import { stringify as yamlStringify } from 'yaml'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, History, Loader2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { deleteObject, get, list, putObject } from '@/api/client'
import { tf, useT } from '@/i18n'
import type { K8sObject } from '@/api/types'
import { itemPath, type AnyResourceDef } from '@/resources/registry'
import { usePermissions, type PermissionCheck } from '@/hooks/usePermissions'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { Alert, AlertDescription } from '@/components/ui/alert'

/** 行级 diff（前后缀收缩 + LCS DP，模板行数小、超界退化为整块删增） */
function diffLines(a: string[], b: string[]): { t: 'eq' | 'add' | 'del'; s: string }[] {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let ea = a.length
  let eb = b.length
  while (ea > p && eb > p && a[ea - 1] === b[eb - 1]) {
    ea--
    eb--
  }
  const m0 = a.slice(p, ea)
  const m1 = b.slice(p, eb)
  const out: { t: 'eq' | 'add' | 'del'; s: string }[] = []
  for (const l of a.slice(0, p)) out.push({ t: 'eq', s: l })
  if (m0.length * m1.length <= 640_000) {
    const m = m0.length
    const n = m1.length
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = m0[i] === m1[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (m0[i] === m1[j]) {
        out.push({ t: 'eq', s: m0[i] })
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ t: 'del', s: m0[i++] })
      } else {
        out.push({ t: 'add', s: m1[j++] })
      }
    }
    while (i < m) out.push({ t: 'del', s: m0[i++] })
    while (j < n) out.push({ t: 'add', s: m1[j++] })
  } else {
    for (const l of m0) out.push({ t: 'del', s: l })
    for (const l of m1) out.push({ t: 'add', s: l })
  }
  for (const l of a.slice(ea)) out.push({ t: 'eq', s: l })
  return out
}

/** 等值行折叠：变化点上下留 2 行上下文，其余归并成可展开的「N 行相同」 */
function foldEq(rows: { t: 'eq' | 'add' | 'del'; s: string }[]): ({ t: 'eq' | 'add' | 'del' | 'skip'; s: string; n?: number })[] {
  const keep = new Set<number>()
  rows.forEach((r, i) => {
    if (r.t !== 'eq') for (let k = Math.max(0, i - 2); k <= Math.min(rows.length - 1, i + 2); k++) keep.add(k)
  })
  const out: ({ t: 'eq' | 'add' | 'del' | 'skip'; s: string; n?: number })[] = []
  let skip = 0
  rows.forEach((r, i) => {
    if (r.t === 'eq' && !keep.has(i)) {
      skip++
      return
    }
    if (skip > 0) {
      out.push({ t: 'skip', s: '', n: skip })
      skip = 0
    }
    out.push(r)
  })
  if (skip > 0) out.push({ t: 'skip', s: '', n: skip })
  return out
}

interface Revision extends K8sObject {
  revision: number
  /** ControllerRevision 的模板在 data.spec.template；ReplicaSet 在 spec.template（此处归一） */
  data?: { template?: unknown }
  /** 当前修订：CR 按 workload status.currentRevision 精确判定；Deployment 走 max(revision) */
  current?: boolean
  /** kubectl rollout history --show-change-cause 同款：annotate 的变更原因（模板注解继承） */
  changeCause?: string
}

/** 变更原因注解：优先 PodTemplate 注解（annotate deployment 会随模板继承进 RS/CR），退回对象自身 */
function readChangeCause(annotations: Record<string, string> | undefined, template: unknown): string | undefined {
  const tplAnn = (template as { metadata?: { annotations?: Record<string, string> } } | undefined)?.metadata?.annotations
  return tplAnn?.['kubernetes.io/change-cause'] ?? annotations?.['kubernetes.io/change-cause']
}

export const REVISION_KINDS: Record<string, true> = { Deployment: true, StatefulSet: true, DaemonSet: true }

/** 按 ownerRef.uid 归属工作负载（同 ns 全量 list 后过滤，量小） */
function useRevisions(def: AnyResourceDef, cluster: string, ns: string, name: string, enabled: boolean) {
  const q = useQuery({
    queryKey: ['revisions', cluster, ns, def.kind, name],
    enabled,
    staleTime: 15_000,
    queryFn: async (): Promise<Revision[]> => {
      const wl = await get<K8sObject>(cluster, itemPath(def, ns, name))
      if (def.kind === 'Deployment') {
        // Deployment：ReplicaSet + revision 注解
        const res = await list<K8sObject>(cluster, `/apis/apps/v1/namespaces/${ns}/replicasets`)
        return res.items
          .filter(r => (r.metadata.ownerReferences ?? []).some(o => o.uid === wl.metadata.uid))
          .map(r => ({
            ...r,
            revision: Number((r.metadata.annotations ?? {})['deployment.kubernetes.io/revision'] ?? 0),
            data: { template: (r as unknown as { spec?: { template?: unknown } }).spec?.template },
            changeCause: readChangeCause(r.metadata.annotations, (r as unknown as { spec?: { template?: unknown } }).spec?.template),
          }))
          .sort((a, b) => b.revision - a.revision)
      }
      // SS/DS：ControllerRevision。模板在 data.spec.template（与 ai-exec
      // workloads.js 实测口径一致）；不映射则回滚按钮恒 disabled、镜像恒"—"
      const currentRevision = (wl as unknown as { status?: { currentRevision?: string } }).status?.currentRevision
      const res = await list<Revision & { data?: { spec?: { template?: unknown } } }>(
        cluster,
        `/apis/apps/v1/namespaces/${ns}/controllerrevisions`,
      )
      return res.items
        .filter(r => (r.metadata.ownerReferences ?? []).some(o => o.uid === wl.metadata.uid))
        .map(r => ({
          ...r,
          data: { template: r.data?.spec?.template },
          current: !!currentRevision && r.metadata.name === currentRevision,
          changeCause: readChangeCause(r.metadata.annotations, r.data?.spec?.template),
        }))
        .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))
    },
  })
  return { revisions: q.data ?? [], isLoading: q.isLoading, isError: q.isError, error: q.error }
}

/** 详情页「历史」tab：revision 列表（镜像摘要）+ 回滚确认 */
export function RevisionsTab({ def, cluster, ns, name }: { def: AnyResourceDef; cluster: string; ns: string; name: string }) {
  const t = useT()
  const queryClient = useQueryClient()
  const [confirmRev, setConfirmRev] = useState<Revision | null>(null)
  const [busy, setBusy] = useState(false)
  // 修订两两对比（选满两个自动出模板 diff）：回答「这一版到底改了什么」——
  // 此前只有图像列表与 YAML 全文肉眼 diff
  const [cmp, setCmp] = useState<number[]>([])
  const toggleCmp = (rev: number) => setCmp(c => (c.includes(rev) ? c.filter(x => x !== rev) : [...c.slice(-1), rev]))
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null)
  const [replacing, setReplacing] = useState(false)

  // STS 待替换 Pod：updateRevision 已发布但旧 Pod 还挂着旧 hash（OnDelete 永不自动收敛；
  // RollingUpdate 卡住时也要看得见「还差谁」）。每行给「替换」= 删 Pod 触发按新模板重建
  const stsQ = useQuery({
    queryKey: ['sts-pending', cluster, ns, name],
    queryFn: async () => {
      const wl = (await get<K8sObject>(cluster, itemPath(def, ns, name))) as unknown as {
        status?: { updateRevision?: string }
        spec?: { selector?: { matchLabels?: Record<string, string> }; updateStrategy?: { type?: string } }
      }
      const upd = wl.status?.updateRevision
      const ml = wl.spec?.selector?.matchLabels ?? {}
      if (!upd || Object.keys(ml).length === 0) return { upd, pending: [] as K8sObject[], strat: undefined as string | undefined }
      const sel = Object.entries(ml)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
      const pods = await list<K8sObject>(cluster, `/api/v1/namespaces/${ns}/pods`, { labelSelector: sel })
      const strat = wl.spec?.updateStrategy?.type
      const pending = pods.items.filter(p => (p.metadata.labels as Record<string, string> | undefined)?.['controller-revision-hash'] !== upd)
      return { upd, pending, strat }
    },
    enabled: def.kind === 'StatefulSet',
    staleTime: 10_000,
    retry: 0,
  })
  const doReplace = async (podName: string) => {
    setReplacing(true)
    try {
      await deleteObject(cluster, `/api/v1/namespaces/${ns}/pods/${encodeURIComponent(podName)}`, `手动替换 Pod 至新版本（${stsQ.data?.upd ?? '?'}）`)
      toast.success(tf('res:replaceDone', { name: podName }))
      setReplaceTarget(null)
      void queryClient.invalidateQueries({ queryKey: ['sts-pending', cluster, ns, name] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setReplacing(false)
    }
  }
  const { revisions, isLoading, isError, error } = useRevisions(def, cluster, ns, name, true)

  const rollbackChecks = useMemo<PermissionCheck[]>(
    () => [{ verb: 'update', group: def.group, version: def.version, resource: def.resource, namespace: ns }],
    [def, ns],
  )
  const { can } = usePermissions(cluster, rollbackChecks)
  const canRollback = can(rollbackChecks[0])
  const doRollback = async () => {
    if (!confirmRev?.data?.template) return
    setBusy(true)
    try {
      // SS/DS 的 CR 模板快照带 controller-revision-hash 标签，原样写回会让
      // controller 把新 Pod 归到旧修订（ai-exec workloads.js 同口径剥离）
      const tpl = confirmRev.data.template as { metadata?: { labels?: Record<string, string> } } | undefined
      const { 'controller-revision-hash': _drop, ...labels } = tpl?.metadata?.labels ?? {}
      const cleanTemplate = tpl?.metadata?.labels
        ? { ...tpl, metadata: { ...tpl.metadata, labels } }
        : confirmRev.data.template
      // 整份替换而非 strategic-merge 写回：containers/volumes/env 是按 name 合并键列表，
      // PATCH 旧模板不会删掉其后新增的容器——「回滚」实为旧新嵌合体，与 kubectl rollout
      // undo（整份替换）不等价。GET 现对象→换 template→带 rv PUT。
      const cur = (await get<K8sObject>(cluster, itemPath(def, ns, name))) as unknown as Record<string, unknown> & {
        metadata: Record<string, unknown>
        spec: Record<string, unknown>
      }
      const { status: _st, ...restTop } = cur
      const { managedFields: _mf, ...cleanMeta } = cur.metadata
      await putObject(
        cluster,
        itemPath(def, ns, name),
        { ...restTop, metadata: cleanMeta, spec: { ...cur.spec, template: cleanTemplate } } as unknown as K8sObject,
        `回滚到 revision ${confirmRev.revision}（模板整份替换）`,
      )
      toast.success(tf('res:rollbackDone', { rev: confirmRev.revision }))
      void queryClient.invalidateQueries({ queryKey: ['revisions', cluster, ns, def.kind, name] })
      void queryClient.invalidateQueries({ queryKey: ['yaml', cluster, itemPath(def, ns, name)] })
      setConfirmRev(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">{t('res:loading')}</div>
  if (isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{tf('res:revisionsFailed', { msg: error?.message ?? t('res:unknownError') })}</AlertDescription>
      </Alert>
    )
  if (revisions.length === 0)
    return <div className="py-8 text-center text-[13px] text-muted-foreground">{t('res:noRevisions')}</div>

  return (
    <div className="space-y-2 pb-4">
      {revisions.map(r => {
        const tpl = r.data?.template as
          | { spec?: { containers?: { name: string; image: string }[]; initContainers?: { image: string }[] } }
          | undefined
        const images = [
          ...(tpl?.spec?.containers ?? []).map(c => c.image),
          ...(tpl?.spec?.initContainers ?? []).map(c => c.image),
        ]
        const current = r.current ?? r === revisions[0]
        return (
          <Card key={r.metadata.uid}>
            <CardContent className="flex items-center gap-3">
              <History className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="w-16 shrink-0 font-mono text-[13px] font-medium">rev {r.revision}</span>
              {current && (
                <span className="shrink-0 text-xs text-positive">
                  {t('res:revCurrent')}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={images.join('\n')}>
                {images.join(' , ') || '—'}
              </span>
              {(() => {
                // 盲选回滚防护：revision 行直接给该 RS 现值 ready——「上一版 5/5、当前版 1/5」
                // 不再靠人肉对照时间戳猜哪版健康（RS 对象本来就带 status，零额外请求）
                const st = r as unknown as { status?: { readyReplicas?: number }; spec?: { replicas?: number } }
                if (st.status?.readyReplicas === undefined) return null
                const bad = (st.spec?.replicas ?? 0) > 0 && (st.status.readyReplicas ?? 0) < (st.spec?.replicas ?? 0)
                return (
                  <span
                    className={`shrink-0 font-mono text-xs tabular-nums ${bad ? 'text-caution' : 'text-muted-foreground'}`}
                    title={t('sys:readyNowCol')}
                  >
                    {st.status.readyReplicas}/{st.spec?.replicas ?? '?'}
                  </span>
                )
              })()}
              {r.changeCause && (
                <span className="hidden min-w-0 max-w-52 shrink truncate text-xs text-muted-foreground lg:block" title={r.changeCause}>
                  {r.changeCause}
                </span>
              )}
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{r.metadata.creationTimestamp?.slice(0, 16).replace('T', ' ')}</span>
              <Button
                variant={cmp.includes(r.revision) ? 'default' : 'outline'}
                size="sm"
                className="shrink-0"
                aria-pressed={cmp.includes(r.revision)}
                title={t('res:cmpPick')}
                onClick={() => toggleCmp(r.revision)}
              >
                <ArrowLeftRight />
                {cmp.includes(r.revision) ? String(cmp.indexOf(r.revision) + 1) : t('res:cmpBtn')}
              </Button>
              {!current && canRollback && (
                <Button variant="outline" size="sm" className="shrink-0" onClick={() => setConfirmRev(r)} disabled={!r.data?.template}>
                  <Undo2 />
                  {t('res:rollback')}
                </Button>
              )}
            </CardContent>
          </Card>
        )
      })}

      {stsQ.data && stsQ.data.pending.length > 0 && (
        <Card>
          <CardContent className="pt-3">
            <div className="mb-1.5 flex items-center gap-2 text-[13px] font-medium">
              <History className="size-3.5 text-caution" />
              {tf('res:pendingReplaceTitle', { n: stsQ.data.pending.length, rev: stsQ.data.upd ?? '?' })}
              {stsQ.data.strat === 'OnDelete' && <span className="text-xs font-normal text-muted-foreground">{t('res:pendingReplaceOnDelete')}</span>}
            </div>
            <div className="space-y-1">
              {stsQ.data.pending.map(p => (
                <div key={p.metadata.uid} className="flex items-center gap-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-mono" title={(p.metadata.labels as Record<string, string> | undefined)?.['controller-revision-hash']}>
                    {p.metadata.name}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{(p.metadata.labels as Record<string, string> | undefined)?.['controller-revision-hash'] ?? '–'}</span>
                  <Button variant="outline" size="xs" onClick={() => setReplaceTarget(p.metadata.name)}>
                    {t('res:replaceBtn')}
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {cmp.length === 2 && (() => {
        const [a, b] = [revisions.find(r => r.revision === cmp[0]), revisions.find(r => r.revision === cmp[1])]
        if (!a || !b) return null
        const tpl = (r: typeof a) => yamlStringify((r.data?.template ?? (r as unknown as { spec?: { template?: unknown } }).spec?.template) ?? {}, { lineWidth: 0 }).trimEnd().split('\n')
        const rows = foldEq(diffLines(tpl(a), tpl(b)))
        const changed = rows.filter(x => x.t === 'add' || x.t === 'del').length
        return (
          <Card>
            <CardContent className="pt-3">
              <div className="mb-1.5 flex items-center gap-2 text-[13px] font-medium">
                <ArrowLeftRight className="size-3.5 text-muted-foreground" />
                {tf('res:cmpTitle', { a: cmp[0], b: cmp[1] })}
                <span className="font-mono text-xs text-muted-foreground">+{rows.filter(x => x.t === 'add').length} −{rows.filter(x => x.t === 'del').length}</span>
                {changed === 0 && <span className="text-xs text-muted-foreground">{t('res:cmpSame')}</span>}
              </div>
              <div className="max-h-96 overflow-auto rounded-md border bg-muted/30 font-mono text-xs leading-5">
                {rows.map((x, i) =>
                  x.t === 'skip' ? (
                    <div key={i} className="px-2 text-center text-[11px] text-muted-foreground/70">··· {x.n} ···</div>
                  ) : (
                    <div
                      key={i}
                      suppressHydrationWarning
                      className={`px-2 whitespace-pre-wrap ${x.t === 'add' ? 'bg-positive/10 text-positive' : x.t === 'del' ? 'bg-destructive/10 text-destructive-on-primary' : 'text-muted-foreground'}`}
                    >
                      {x.t === 'add' ? '+ ' : x.t === 'del' ? '− ' : '  '}{x.s}
                    </div>
                  ),
                )}
              </div>
            </CardContent>
          </Card>
        )
      })()}

      <AlertDialog open={replaceTarget !== null} onOpenChange={v => !replacing && !v && setReplaceTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tf('res:replaceTitle', { name: replaceTarget ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('res:replaceDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={replacing}>{t('res:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={replacing}
              onClick={e => {
                e.preventDefault()
                if (replaceTarget) void doReplace(replaceTarget)
              }}
            >
              {replacing && <Loader2 className="size-3.5 animate-spin" />}
              {t('res:replaceBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRev !== null} onOpenChange={v => !busy && !v && setConfirmRev(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tf('res:rollbackTitle', { rev: confirmRev?.revision ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{tf('res:rollbackDesc', { name })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('res:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={e => {
                e.preventDefault()
                void doRollback()
              }}
              disabled={busy}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {t('res:rollback')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
