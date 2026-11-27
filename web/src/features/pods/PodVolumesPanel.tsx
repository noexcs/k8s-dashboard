// Pod 卷视图：spec.volumes 来源摘要 + 各容器挂载点，纯展示。
// 排查刚需——挂的哪个 Secret/PVC、mountPath 对不对、有没有孤立卷，之前只能翻 YAML。
// 只读：不改集群；PVC phase/容量来自同 ns 列表（可选插件缺失/无权限时静默退化为只显 claimName）。
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Boxes, ChevronRight } from 'lucide-react'
import { list } from '@/api/client'
import { tf, useT } from '@/i18n'
import { SectionTitle } from '@/components/SectionTitle'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { RESOURCE_MAP, detailRoute, type AnyResourceDef } from '@/resources/registry'

type Rec = Record<string, unknown>
const asRec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined)
const asArr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') as Rec[] : [])
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** defaultMode 八进制显示（0644 → 0644，与 kubectl 观感一致） */
function octMode(v: unknown): string | undefined {
  if (typeof v !== 'number') return undefined
  return `0${v.toString(8).padStart(3, '0')}`
}

/** 卷类型 + 来源摘要文本：kind 顺序对齐 k8s VolumeSource 常见项 */
function summarizeVolume(v: Rec): { type: string; summary: string; ref?: { kind: string; name: string } } {
  if (v.persistentVolumeClaim) {
    const p = asRec(v.persistentVolumeClaim) ?? {}
    const name = asStr(p.claimName) ?? '?'
    return { type: 'PVC', summary: name, ref: { kind: 'PersistentVolumeClaim', name } }
  }
  if (v.configMap) {
    const p = asRec(v.configMap) ?? {}
    const name = asStr(p.name) ?? '?'
    const items = asArr(p.items)
    const mode = octMode(p.defaultMode)
    const bits = [name, items.length ? `${items.length} items` : null, mode ? `mode ${mode}` : null].filter(Boolean)
    return { type: 'ConfigMap', summary: bits.join(' · '), ref: { kind: 'ConfigMap', name } }
  }
  if (v.secret) {
    const p = asRec(v.secret) ?? {}
    const name = asStr(p.secretName) ?? '?'
    const items = asArr(p.items)
    const mode = octMode(p.defaultMode)
    const bits = [name, items.length ? `${items.length} items` : null, mode ? `mode ${mode}` : null].filter(Boolean)
    return { type: 'Secret', summary: bits.join(' · '), ref: { kind: 'Secret', name } }
  }
  if (v.hostPath) {
    const p = asRec(v.hostPath) ?? {}
    const type = asStr(p.type)
    return { type: 'hostPath', summary: `${asStr(p.path) ?? '?'}${type ? ` (${type})` : ''}` }
  }
  if (v.emptyDir) {
    const p = asRec(v.emptyDir) ?? {}
    const medium = asStr(p.medium)
    const size = asStr(p.sizeLimit)
    return { type: 'emptyDir', summary: [medium === 'Memory' ? 'Memory' : null, size ? `limit ${size}` : null].filter(Boolean).join(' · ') || '-' }
  }
  if (v.projected) {
    const sources = asArr(asRec(v.projected)?.sources)
    const kinds = sources
      .map(s => (s.serviceAccountToken ? 'token' : s.configMap ? 'cm' : s.secret ? 'secret' : s.downwardAPI ? 'downward' : '?'))
    return { type: 'projected', summary: `${sources.length} sources${kinds.length ? ` (${[...new Set(kinds)].join(',')})` : ''}` }
  }
  if (v.downwardAPI) return { type: 'downwardAPI', summary: `${asArr(asRec(v.downwardAPI)?.items).length} items` }
  if (v.csi) {
    const p = asRec(v.csi) ?? {}
    const attrs = asRec(p.volumeAttributes)
    return { type: 'CSI', summary: [asStr(p.driver) ?? '?', attrs ? `${Object.keys(attrs).length} attrs` : null].filter(Boolean).join(' · ') }
  }
  if (v.ephemeral) return { type: 'ephemeral', summary: asRec(asRec(v.ephemeral)?.volumeClaimTemplate) ? 'volumeClaimTemplate' : '-' }
  // 兜底：命中不到的源（新类型/未知）显类型名，不静默吞
  const onlyKey = Object.keys(v).find(k => v[k] != null)
  return { type: onlyKey ?? 'volume', summary: '-' }
}

interface PvcInfo {
  phase?: string
  capacity?: string
  storageClass?: string
}

export function PodVolumesPanel({ cluster, ns, pod }: { cluster: string; ns: string; pod: Rec }) {
  const t = useT()

  const volumes = useMemo(() => asArr(pod.spec && asRec(pod.spec)?.volumes), [pod])
  // 容器（含 initContainers）的挂载点：volumeMounts 按卷名回指 volumes
  const mounts = useMemo(() => {
    const spec = asRec(pod.spec) ?? {}
    const collect = (listKey: 'initContainers' | 'containers', init: boolean) =>
      asArr(spec[listKey]).flatMap(c =>
        asArr(asRec(c)?.volumeMounts).map(m => ({
          container: asStr(asRec(c)?.name) ?? '?',
          init,
          name: asStr(m.name) ?? '?',
          mountPath: asStr(m.mountPath),
          readOnly: asRec(m)?.readOnly === true,
          propagation: asStr(m.mountPropagation),
          subPath: asStr(m.subPath),
          subPathExpr: asStr(m.subPathExpr),
        })),
      )
    return [...collect('initContainers', true), ...collect('containers', false)]
  }, [pod])

  // 被任一容器挂载的卷名集合（未被挂载 = 孤立卷，常见配置错误）
  const mountedNames = useMemo(() => new Set(mounts.map(m => m.name)), [mounts])

  const pvcs = useMemo(() => {
    const s = new Set<string>()
    for (const v of volumes) {
      const ref = summarizeVolume(v).ref
      if (ref?.kind === 'PersistentVolumeClaim') s.add(ref.name)
    }
    return [...s]
  }, [volumes])

  // 同 ns PVC 列表补 phase/容量/SC；失败（无权限/CRD 缺失）静默，退化为只显 claimName
  const pvcQuery = useQuery({
    queryKey: ['pod-pvc-map', cluster, ns],
    queryFn: () => list(cluster, `/api/v1/namespaces/${encodeURIComponent(ns)}/persistentvolumeclaims`),
    retry: false,
    staleTime: 15_000,
    enabled: pvcs.length > 0,
  })
  const pvcMap = useMemo(() => {
    const items = ((pvcQuery.data as { items?: Rec[] } | undefined)?.items ?? []) as Rec[]
    const map: Record<string, PvcInfo> = {}
    for (const it of items) {
      const name = asStr(asRec(it.metadata)?.name)
      if (!name) continue
      const status = asRec(it.status) ?? {}
      map[name] = {
        phase: asStr(status.phase),
        capacity: asStr(asRec(status.capacity)?.storage),
        storageClass: asStr(asRec(it.spec)?.storageClassName),
      }
    }
    return map
  }, [pvcQuery.data])

  if (volumes.length === 0) {
    return (
      <Card>
        <CardContent className="pt-3">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Boxes className="size-3.5" />
            {t('pods:volNone')}
          </div>
        </CardContent>
      </Card>
    )
  }

  const defMap = RESOURCE_MAP as Record<string, AnyResourceDef>
  const linkFor = (ref: { kind: string; name: string }) => {
    const def = defMap[ref.kind]
    if (!def) return null
    return detailRoute(def, cluster, def.scope === 'cluster' ? 'cluster' : ns, ref.name)
  }

  return (
    <div className="space-y-3">
      {/* 卷来源 */}
      <Card>
        <CardContent className="pt-3">
          <SectionTitle>{tf('pods:volHeader', { n: volumes.length })}</SectionTitle>
          <div className="space-y-1.5">
            {volumes.map(v => {
              const name = asStr(asRec(v.metadata)?.name) ?? asStr(v.name) ?? '?'
              const s = summarizeVolume(v)
              const to = s.ref ? linkFor(s.ref) : null
              const orphans = !mountedNames.has(name)
              const pvcInfo = s.ref?.kind === 'PersistentVolumeClaim' ? pvcMap[s.ref.name] : undefined
              return (
                <div key={name} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px]">
                  <Badge variant="secondary" className="shrink-0 font-normal">
                    {s.type}
                  </Badge>
                  <span className="w-52 min-w-0 shrink-0 truncate font-mono" title={name}>
                    {name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={s.summary}>
                    {s.summary}
                    {pvcInfo?.phase ? ` · ${pvcInfo.phase}` : ''}
                    {pvcInfo?.capacity ? ` · ${pvcInfo.capacity}` : ''}
                    {pvcInfo?.storageClass ? ` · ${pvcInfo.storageClass}` : ''}
                  </span>
                  {orphans && (
                    <span className="shrink-0 text-caution" title={t('pods:volOrphanHint')}>
                      {t('pods:volOrphan')}
                    </span>
                  )}
                  {to && (
                    <Link to={to} className="inline-flex size-6 -me-1 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground" title={t('pods:volOpenRef')}>
                      <ChevronRight className="size-3.5" />
                    </Link>
                  )}
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* 挂载点（按容器分组，init 在前） */}
      <Card>
        <CardContent className="pt-3">
          <SectionTitle>{t('pods:volMountsHeader')}</SectionTitle>
          {mounts.length === 0 ? (
            <div className="text-[13px] text-muted-foreground">{t('pods:volNoMounts')}</div>
          ) : (
            <div className="space-y-1">
              {mounts.map((m, i) => {
                const vol = volumes.find(v => (asStr(asRec(v.metadata)?.name) ?? asStr(v.name)) === m.name)
                const s = vol ? summarizeVolume(vol) : undefined
                return (
                  <div key={`${m.container}-${m.name}-${i}`} className="flex items-center gap-2 py-1 text-[13px]">
                    <span className="w-44 min-w-0 shrink-0 truncate" title={m.container}>
                      <span className="font-mono text-muted-foreground">{m.container}</span>
                      {m.init && <span className="ml-1 rounded-sm bg-muted px-1 text-xs text-muted-foreground">init</span>}
                    </span>
                    <span className="w-44 min-w-0 shrink-0 truncate font-mono text-muted-foreground" title={m.name}>
                      {m.name}
                    </span>
                    {s && <span className="hidden w-24 shrink-0 truncate text-xs text-muted-foreground lg:block">{s.type}</span>}
                    <span className="min-w-0 flex-1 truncate font-mono" title={m.mountPath}>
                      {m.mountPath ?? '-'}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {m.readOnly && t('pods:volRO')}
                      {m.propagation ? ` ${m.propagation}` : ''}
                      {m.subPath ? ` · subPath:${m.subPath}` : ''}
                      {m.subPathExpr ? ` · expr:${m.subPathExpr}` : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
