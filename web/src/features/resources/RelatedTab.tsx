// Related Resources（参考 CLI）：资源详情「关联」tab。
// 上行：ownerReferences 链（逐级 GET 父对象，同命名空间；深度 ≤5 防御环路）。
// 下行：spec.selector.matchLabels → Pod 列表（与 kubectl 的 Deployment→Pods / Service→Pods 等价）。
// 纯既有代理 API + 注册表路由，无需后端改动。
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { SectionTitle } from '@/components/SectionTitle'
import { ApiError, get, list } from '@/api/client'
import type { K8sObject, Pod } from '@/api/types'
import { tf, useT } from '@/i18n'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { RESOURCE_MAP, apiBase, detailRoute, kindIconFor, type AnyResourceDef } from '@/resources/registry'
import { useCrds } from '@/resources/crds'

/** API 原始 ownerRef 带 apiVersion（types.ts 的窄类型没声明，这里按原始响应形状定义） */
interface OwnerRef {
  apiVersion?: string
  kind: string
  name: string
}

interface ChainItem {
  kind: string
  name: string
  ns: string
  def: AnyResourceDef | null
}

/** ownerReferences 链（含直接父）：child → parent → …；父取不到（跨 ns/RBAC/未知 kind）即停 */
export function useOwnerChain(cluster: string, ns: string, owners: OwnerRef[] | undefined, defMap: Record<string, AnyResourceDef>) {
  const first = owners?.[0]
  return useQuery({
    queryKey: ['owner-chain', cluster, ns, owners?.[0] ? `${owners[0].kind}/${owners[0].name}` : ''],
    enabled: !!first && !!cluster && ns !== 'cluster',
    staleTime: 30_000,
    retry: 1,
    queryFn: async (): Promise<ChainItem[]> => {
      const build = async (): Promise<ChainItem[]> => {
        const out: ChainItem[] = []
        let cur: OwnerRef | undefined = first
        while (cur && out.length < 5) {
          const def = defMap[cur.kind] ?? null
          if (def) out.push({ kind: cur.kind, name: cur.name, ns, def })
          if (!def) break
          const base = apiBase(def)
          const p =
            def.scope === 'cluster'
              ? `/${base}/${def.version}/${def.resource}/${encodeURIComponent(cur.name)}`
              : `/${base}/${def.version}/namespaces/${encodeURIComponent(ns)}/${def.resource}/${encodeURIComponent(cur.name)}`
          try {
            const parent = await get<K8sObject>(cluster, p)
            const raw = parent.metadata.ownerReferences as OwnerRef[] | undefined
            cur = raw?.[0]
          } catch {
            cur = undefined
          }
        }
        return out
      }
      // 链是逐级串行 GET：慢集群/挂起的代理请求会让骨架无限转。8s 未落定即放弃
      // 本轮（reject→retry:1→再不行落到 owners 兑底行：可导航，只是少向上几级）
      const timeout = Promise.withResolvers<ChainItem[]>()
      const timer = setTimeout(() => timeout.reject(new Error('owner chain timeout (8s)')), 8_000)
      try {
        return await Promise.race([build(), timeout.promise])
      } finally {
        clearTimeout(timer)
      }
    },
  })
}

/** selector→Pods：matchLabels 拼 labelSelector（无 selector 不发请求） */
export function useSelectorPods(cluster: string, ns: string, matchLabels: Record<string, string> | undefined) {
  const labelSelector = useMemo(
    () => Object.entries(matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(','),
    [matchLabels],
  )
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['related-pods', cluster, ns, labelSelector],
    enabled: !!labelSelector && !!cluster && ns !== 'cluster',
    staleTime: 15_000,
    // 走 api/client 的 list（同 RevisionsTab）：统一错误形状（ApiError）+ managedFields 剥离，URL 与原裸 fetch 一致
    queryFn: async () => (await list<Pod>(cluster, `/api/v1/namespaces/${encodeURIComponent(ns)}/pods`, { labelSelector })).items,
  })
  return { pods: data ?? [], labelSelector, loading: !!labelSelector && isPending, isError, error }
}

function RelRow({ cluster, kind, name, ns, defMap }: { cluster: string; kind: string; name: string; ns: string; defMap: Record<string, AnyResourceDef> }) {
  const Icon = kindIconFor(kind)
  const def = defMap[kind]
  const to = def ? detailRoute(def, cluster, def.scope === 'cluster' ? 'cluster' : ns, name) : null
  // 有路由必须是 <a>(Cmd/中键/新标签可用);无路由(未知 kind)才是 disabled button
  const cls = 'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent/50'
  const inner = (
    <>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium">{kind}</span>
      <span className="min-w-0 flex-1 truncate font-mono" title={name}>{name}</span>
      {to && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
    </>
  )
  if (!to) return <button className={cls} disabled>{inner}</button>
  return <Link to={to} className={cls}>{inner}</Link>
}

/** 通用详情页「关联」tab 内容（owners = metadata.ownerReferences；matchLabels = spec.selector.matchLabels） */
export function RelatedTab({
  cluster,
  ns,
  owners,
  matchLabels,
  workloadKind,
  workloadName,
}: {
  cluster: string
  ns: string
  owners: OwnerRef[] | undefined
  matchLabels: Record<string, string> | undefined
  /** 工作负载视角：在 owner/pod 之外补「托管(HPA)/保护(PDB)/入口(Service)」——
      这些资源靠 label/引用关联，此前只能靠 ⌘K 或终端 grep label */
  workloadKind?: string
  workloadName?: string
}) {
  const t = useT()
  const { defs: crds } = useCrds(cluster)
  const defMap = useMemo(() => ({ ...Object.fromEntries(crds.map(d => [d.kind, d])), ...RESOURCE_MAP }), [crds])
  const chainQ = useOwnerChain(cluster, ns, owners, defMap)
  const { pods, labelSelector, loading: podsLoading, isError: podsFailed, error } = useSelectorPods(cluster, ns, matchLabels)
  const isWl = workloadKind === 'Deployment' || workloadKind === 'StatefulSet' || workloadKind === 'DaemonSet'
  const ctrlQ = useQuery({
    queryKey: ['wl-control-plane', cluster, ns, workloadName, workloadKind],
    queryFn: async () => {
      const hpaAt = async (v: string) => list<K8sObject>(cluster, `/apis/autoscaling/${v}/namespaces/${ns}/horizontalpodautoscalers`)
      let hpas: K8sObject[] = []
      try {
        hpas = (await hpaAt('v2')).items
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) hpas = (await hpaAt('v1')).items
      }
      const pdbs = (await list<K8sObject>(cluster, `/apis/policy/v1/namespaces/${ns}/poddisruptionbudgets`)).items
      const svcs = (await list<K8sObject>(cluster, `/api/v1/namespaces/${ns}/services`)).items
      const sup = (sel: Record<string, string> | undefined) =>
        !!sel && !!matchLabels && Object.entries(matchLabels).every(([k, v]) => sel[k] === v)
      return {
        hpa: hpas.filter(h => {
          const ref = (h as unknown as { spec?: { scaleTargetRef?: { kind?: string; name?: string } } }).spec?.scaleTargetRef
          return ref?.name === workloadName && ref?.kind === workloadKind
        }),
        pdb: pdbs.filter(pp => sup((pp as unknown as { spec?: { selector?: { matchLabels?: Record<string, string> } } }).spec?.selector?.matchLabels)),
        svc: svcs.filter(sv => sup((sv as unknown as { spec?: { selector?: Record<string, string> } }).spec?.selector)),
      }
    },
    enabled: isWl && !!workloadName && !!matchLabels && Object.keys(matchLabels ?? {}).length > 0,
    staleTime: 15_000,
    retry: 0,
  })

  // 直接父 + 向上链合并去重（query 结果含直接父）
  const chain: ChainItem[] = chainQ.data ?? owners?.map(o => ({ kind: o.kind, name: o.name, ns, def: defMap[o.kind] ?? null })) ?? []

  if (chain.length === 0 && !labelSelector) {
    return <div className="py-8 text-center text-[13px] text-muted-foreground">{t('res:relatedNone')}</div>
  }

  return (
    <div className="space-y-3">
      {(chain.length > 0 || chainQ.isPending) && (
        <Card>
          <CardContent className="pt-3">
            <SectionTitle>{t('res:relatedOwners')}</SectionTitle>
            <div className="space-y-1">
              {chain.map(o => (
                <RelRow key={`${o.kind}/${o.name}`} cluster={cluster} kind={o.kind} name={o.name} ns={o.ns} defMap={defMap} />
              ))}
              {/* 兑底行已在时无骨架位（否则链在途时行+骨架双渲） */}
              {chainQ.isPending && owners?.length && chain.length === 0 && <Skeleton className="h-8 w-full" />}
            </div>
          </CardContent>
        </Card>
      )}
      {isWl && ctrlQ.isPending && <Skeleton className="h-24 w-full" />}
      {isWl && ctrlQ.data && (ctrlQ.data.hpa.length > 0 || ctrlQ.data.pdb.length > 0 || ctrlQ.data.svc.length > 0) && (
        <Card>
          <CardContent className="pt-3">
            <SectionTitle>{t('res:relatedCtlTitle')}</SectionTitle>
            <div className="space-y-1">
              {[
                ...ctrlQ.data.hpa.map(h => ({ kind: 'HorizontalPodAutoscaler', name: h.metadata.name })),
                ...ctrlQ.data.pdb.map(p => ({ kind: 'PodDisruptionBudget', name: p.metadata.name })),
                ...ctrlQ.data.svc.map(sv => ({ kind: 'Service', name: sv.metadata.name })),
              ].map(x => (
                <RelRow key={`${x.kind}/${x.name}`} cluster={cluster} kind={x.kind} name={x.name} ns={ns} defMap={defMap} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      {labelSelector && (
        <Card>
          <CardContent className="pt-3">
            <SectionTitle>{tf('res:relatedPods', { sel: labelSelector })}</SectionTitle>
            {podsFailed ? (
              // 错误态显式提示（对齐 RevisionsTab），避免失败被渲染成「未匹配到 Pod」假空态
              <Alert variant="destructive">
                <AlertDescription>{tf('res:loadFailed', { msg: error?.message ?? t('res:unknownError') })}</AlertDescription>
              </Alert>
            ) : podsLoading && pods.length === 0 ? (
              <div className="space-y-1">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-4/5" />
              </div>
            ) : pods.length === 0 ? (
              <div className="text-[13px] text-muted-foreground">{t('res:relatedNoPods')}</div>
            ) : (
              <div className="space-y-1">
                {pods.slice(0, 50).map(p => (
                  <RelRow key={p.metadata.uid} cluster={cluster} kind="Pod" name={p.metadata.name} ns={p.metadata.namespace ?? ns} defMap={defMap} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
