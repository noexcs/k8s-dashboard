// 语义密度渲染：把 Pod 模板及相关 spec 字段翻译成人眼直接可读的信息。
// 设计红线（unslop/impeccable 评审后）：三档字阶 13/12/11；4px 栅格；值列固定 96px 网格对齐；
// 颜色只承载语义（caution=异常，来源统一签名=细箭头 ←）；默认值不显示、系统注入字段不冒充用户配置；
// 无折叠交互，长值折行全文（title+复制兜底）。非工作负载退化为平铺，但 Service 有专属语义视图。
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { detailRoute, RESOURCE_MAP } from '@/resources/registry'
import { tf, useT } from '@/i18n'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { CodeBlockCopyButton } from '@/components/ui/code-block'
import { cpuDisplay } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SectionTitle } from '@/components/SectionTitle'

type Rec = Record<string, unknown>

interface EnvVar {
  name: string
  value?: string
  valueFrom?: {
    secretKeyRef?: { name?: string; key?: string; optional?: boolean }
    configMapKeyRef?: { name?: string; key?: string; optional?: boolean }
    fieldRef?: { fieldPath?: string }
    resourceFieldRef?: { containerName?: string; resource?: string }
  }
}
interface Container {
  name: string
  image?: string
  imagePullPolicy?: string
  command?: string[]
  args?: string[]
  ports?: { containerPort?: number; name?: string; protocol?: string }[]
  resources?: { requests?: Rec; limits?: Rec; claims?: { name?: string }[] }
  env?: EnvVar[]
  envFrom?: { secretRef?: { name?: string }; configMapRef?: { name?: string }; prefix?: string }[]
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean; subPath?: string }[]
  livenessProbe?: Probe
  readinessProbe?: Probe
  startupProbe?: Probe
}
interface Probe {
  httpGet?: { path?: string; port?: number | string; scheme?: string; host?: string }
  tcpSocket?: { port?: number | string }
  exec?: { command?: string[] }
  grpc?: { port?: number; service?: string }
  initialDelaySeconds?: number
  periodSeconds?: number
  timeoutSeconds?: number
  failureThreshold?: number
  successThreshold?: number
}

const MONO = 'font-mono text-[12px]'

/** 值列固定的键值网格行：label 96px（=覆盖最长 serviceAccount 的 4 倍数），值列对齐扫描 */
function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-x-2 leading-5">
      <span className="truncate text-[12px] text-muted-foreground" title={k}>
        {k}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

/** 降级标签：nodeSelector/toleration 这类多项小值——bg-muted+hairline 边,弱于状态 Badge 的语义色强边框 */
function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="inline-flex h-5 items-center rounded border border-border/60 bg-muted px-1.5 font-mono text-xs font-normal text-muted-foreground" title={title}>
      {children}
    </span>
  )
}

function SectionHead({ title, n }: { title: string; n?: number }) {
  return (
    <div className="mb-2 text-[12px] font-medium text-muted-foreground">{n === undefined ? title : tf('res:secCount', { title, n })}</div>
  )
}

// ---- 语义摘要（产品评审 #1/#5/#8/#10：人话优先，参数只写非默认） ----

function imageParts(image: string): { repo: string; last: string } {
  const at = image.lastIndexOf('@')
  if (at > 0 && image.slice(at).includes('sha256:')) {
    // digest 镜像：64 位 hex 人眼不可比对，按 docker 惯例折成 @短hash，全文进 title/复制
    const digest = image.slice(at + 'sha256:'.length + 1)
    return { repo: image.slice(0, at), last: `@${digest.slice(0, 12)}` }
  }
  const slash = image.lastIndexOf('/')
  const colon = image.indexOf(':', slash + 1)
  if (colon === -1) return { repo: '', last: image }
  return { repo: image.slice(0, colon + 1), last: image.slice(colon + 1) }
}

function joinCmd(cmd?: string[], args?: string[]): string {
  return [...(cmd ?? []), ...(args ?? [])].map(p => (/\s/.test(p) ? `'${p}'` : p)).join(' ')
}

function probeValue(p: Probe): string {
  let head = '?'
  if (p.httpGet) head = `HTTP GET :${p.httpGet.port ?? ''}${p.httpGet.path && p.httpGet.path !== '/' ? p.httpGet.path : '/'}${p.httpGet.scheme === 'HTTPS' ? ' (https)' : ''}`
  else if (p.tcpSocket) head = `TCP :${p.tcpSocket.port ?? ''}`
  else if (p.exec) head = `exec ${joinCmd(p.exec.command)}`
  else if (p.grpc) head = `gRPC :${p.grpc.port}${p.grpc.service ? ` ${p.grpc.service}` : ''}`
  const parts = [head]
  if (p.initialDelaySeconds) parts.push(tf('res:pDelay', { n: p.initialDelaySeconds }))
  if (p.periodSeconds && p.periodSeconds !== 10) parts.push(tf('res:pEvery', { n: p.periodSeconds }))
  if (p.timeoutSeconds && p.timeoutSeconds !== 1) parts.push(tf('res:pTimeout', { n: p.timeoutSeconds }))
  if (p.failureThreshold && p.failureThreshold !== 3) parts.push(tf('res:pFail', { n: p.failureThreshold }))
  if (p.successThreshold && p.successThreshold !== 1) parts.push(tf('res:pOk', { n: p.successThreshold }))
  return parts.join(' · ')
}

function resValue(c: Container, t: (k: string) => string): string {
  const rq = (c.resources?.requests ?? {}) as Rec
  const lm = (c.resources?.limits ?? {}) as Rec
  const fmt = (r: string, v: string) => (r === 'cpu' ? `cpu ${cpuDisplay(v)}` : r === 'memory' ? `${t('res:resMem')} ${v}` : `${r.split('/').pop() ?? r} ${v}`)
  const seg = (side: string, o: Rec) => {
    const keys = Object.keys(o)
    if (keys.length === 0) return null
    return `${side} ${keys.map(k => fmt(k, String(o[k]))).join(' · ')}`
  }
  const out = [seg('requests', rq), seg('limits', lm)].filter(Boolean)
  for (const cl of c.resources?.claims ?? []) out.push(`claim ${cl.name}`)
  return out.join('；')
}

function envSource(e: EnvVar, t: (k: string) => string): string | null {
  const v = e.valueFrom
  if (!v) return null
  if (v.secretKeyRef) return `← secret ${v.secretKeyRef.name}/${v.secretKeyRef.key}${v.secretKeyRef.optional ? '?' : ''}`
  if (v.configMapKeyRef) return `← cm ${v.configMapKeyRef.name}/${v.configMapKeyRef.key}${v.configMapKeyRef.optional ? '?' : ''}`
  if (v.fieldRef) return `← field ${v.fieldRef.fieldPath}`
  if (v.resourceFieldRef) return `← resource ${v.resourceFieldRef.containerName ? `${v.resourceFieldRef.containerName}.` : ''}${v.resourceFieldRef.resource}`
  return t('res:affinitySeen')
}

/** 系统自动注入的容忍：每个 Pod 都有，冒充用户调度约束只会制造假约束感——默认对过滤+尾注 */
const DEFAULT_TOLERATIONS = new Set(['node.kubernetes.io/not-ready|Exists|NoExecute|300', 'node.kubernetes.io/unreachable|Exists|NoExecute|300'])
const SYS_SELECTOR_RE = /(controller-uid|pod-template-hash|job-name|pod-index|batch\.kubernetes\.io|apps\.kubernetes\.io)/

function volumeSum(v: Rec): string {
  const cm = v.configMap as Rec | undefined
  const sc = v.secret as Rec | undefined
  const pvc = v.persistentVolumeClaim as Rec | undefined
  const ed = v.emptyDir as Rec | undefined
  const hp = v.hostPath as Rec | undefined
  const pj = v.projected as Rec | undefined
  const t = cm ? `cm:${cm.name}` : sc ? `secret:${sc.name}` : pvc ? `pvc:${pvc.claimName}` : ed ? `emptyDir${ed.sizeLimit ? `(${ed.sizeLimit})` : ''}` : hp ? `host:${hp.path}` : v.downwardAPI ? 'downwardAPI' : pj ? `projected[${((pj.sources as unknown[]) ?? []).length}]` : v.persistentVolume ? 'hostPV' : Object.keys(v).filter(x => x !== 'name')[0] ?? '?'
  return t
}

// ---- 调度摘要：静默丢弃=假阴性，未可摘要形态必须留「已配置(详见 YAML)」痕迹 ----

function affinityRows(podSpec: Rec, t: (k: string) => string): [string, ReactNode][] {
  const aff = podSpec.affinity as Rec | undefined
  const out: [string, ReactNode][] = []
  if (aff && typeof aff === 'object') {
    const exprStr = (e: Rec) => `${String(e.key)} ${String(e.operator)}${e.operator !== 'Exists' && e.operator !== 'DoesNotExist' ? ` (${((e.values as string[]) ?? []).join('|')})` : ''}`
    const na = aff.nodeAffinity as Rec | undefined
    if (na) {
      const req = ((na.required as Rec | undefined)?.nodeSelectorTerms as Rec[]) ?? []
      const terms = req.flatMap(term => [
        ...(((term.matchExpressions as Rec[]) ?? []).map(exprStr)),
        ...(((term.matchFields as Rec[]) ?? []).map(exprStr)),
      ])
      const pref = (((na.preferred as Rec | undefined)?.preferredDuringSchedulingIgnoredDuringExecution as Rec[]) ?? []).length
      // must/preferred 必须可辨：hard 约束被当成建议读 = 「能不能挤同一节点」误判（产品复审 N2）
      const val = [terms.length > 0 ? `must ${terms.join(' · ')}` : '', pref > 0 ? tf('res:affinityPref', { n: pref }) : ''].filter(Boolean).join(' · ') || t('res:affinitySeen')
      out.push(['nodeAffinity', <span className={MONO}>{val}</span>])
    }
    const pa = (aff.podAntiAffinity ?? aff.podAffinity) as Rec | undefined
    if (pa) {
      const reqList = (((pa.requiredDuringExecution as Rec[]) ?? []).concat(((pa.requiredDuringSchedulingIgnoredDuringExecution as Rec[]) ?? [])))
      const prefN = (((pa.preferredDuringExecution as Rec[]) ?? []).concat(((pa.preferredDuringSchedulingIgnoredDuringExecution as Rec[]) ?? [])).length)
      const parts = reqList.map(r => `must ${(r.labelSelector as Rec | undefined)?.matchLabels ? Object.entries((r.labelSelector as Rec).matchLabels as Rec).map(([k, v]) => `${k}=${v}`).join(',') : '*'} @${r.topologyKey}`)
      const key = aff.podAntiAffinity ? 'podAntiAffinity' : 'podAffinity'
      out.push([key, <span className={MONO}>{[...parts, ...(prefN ? [tf('res:affinityPref', { n: prefN })] : [])].join(' · ') || t('res:affinitySeen')}</span>])
    }
    if (out.length === 0) out.push(['affinity', <span className={cn(MONO, 'text-muted-foreground')}>{t('res:affinitySeen')}</span>])
  }
  const tsc = (podSpec.topologySpreadConstraints as Rec[]) ?? []
  if (tsc.length > 0) {
    out.push(['topologySpread', <span className={MONO}>{tsc.map(x => `maxSkew=${x.maxSkew} @${x.topologyKey}${x.whenUnsatisfiable === 'DoNotSchedule' ? ' hard' : ''}`).join(' · ')}</span>])
  }
  return out
}

/** 从任意 kind 的 spec 里找 Pod（模板）；kind 兜底：watch 列表对象可能无 kind，调用方显式传入优先 */
function resolveTemplate(obj: Rec, kindProp?: string): Rec | null {
  const kind = String(kindProp ?? obj.kind ?? '')
  if (kind === 'Pod') return (obj.spec ?? {}) as Rec
  const spec = (obj.spec ?? {}) as Rec
  const tpl = (spec.template as Rec | undefined) ?? (((spec.jobTemplate as Rec | undefined)?.spec as Rec | undefined)?.template as Rec | undefined)
  const ps = tpl?.spec as Rec | undefined
  return ps ?? null
}

// ---- 主组件 ----

export function PodSpecSection({ obj, kind: kindProp, cluster }: { obj: Rec; kind?: string; /** Node 关联跳转用；缺省（理论不发生）则节点名降级为纯文本 */ cluster?: string }) {
  const t = useT()
  const podSpec = resolveTemplate(obj, kindProp)
  const kind = String(kindProp ?? obj.kind ?? '')
  if (!podSpec) return <FlatOrService obj={obj} kind={kind} t={t} />
  const isPod = kind === 'Pod'

  const cs = (podSpec.containers ?? []) as Container[]
  const inits = (podSpec.initContainers ?? []) as Container[]
  const volumes = (podSpec.volumes ?? []) as Rec[]
  const volType = (name: string) => {
    const v = volumes.find(x => x.name === name)
    return v ? volumeSum(v) : ''
  }
  const spec = (obj.spec ?? {}) as Rec

  const sched: [string, ReactNode][] = []
  if (podSpec.serviceAccountName && !isPod) sched.push(['serviceAccount', <span className={MONO}>{String(podSpec.serviceAccountName)}</span>])
  // nodeName 不去重：Pod 页顶部只有 Host IP，节点名在概览仅此一个出口（上轮去重过头的回修）
  if (podSpec.nodeName)
    sched.push([
      'nodeName',
      cluster ? (
        <Link
          to={detailRoute(RESOURCE_MAP.Node!, cluster, 'cluster', String(podSpec.nodeName))}
          className={cn(MONO, 'underline decoration-border decoration-1 underline-offset-2 hover:decoration-foreground/50')}
          title={String(podSpec.nodeName)}
        >
          {String(podSpec.nodeName)}
        </Link>
      ) : (
        <span className={MONO}>{String(podSpec.nodeName)}</span>
      ),
    ])
  if (podSpec.hostNetwork === true) sched.push(['hostNetwork', <span className={MONO}>true</span>])
  if (podSpec.dnsPolicy && podSpec.dnsPolicy !== 'ClusterFirst') sched.push(['dnsPolicy', <span className={MONO}>{String(podSpec.dnsPolicy)}</span>])
  if (podSpec.terminationGracePeriodSeconds !== undefined && podSpec.terminationGracePeriodSeconds !== 30) sched.push(['gracePeriod', <span className={MONO}>{String(podSpec.terminationGracePeriodSeconds)}s</span>])
  if (podSpec.priorityClassName) sched.push(['priorityClass', <span className={MONO}>{String(podSpec.priorityClassName)}</span>])
  if (podSpec.shareProcessNamespace === true) sched.push(['shareProcessNS', <span className={MONO}>true</span>])
  if (podSpec.automountServiceAccountToken === false) sched.push(['automountSA', <span className={MONO}>false</span>])
  if (podSpec.schedulerName && podSpec.schedulerName !== 'default-scheduler') sched.push(['scheduler', <span className={MONO}>{String(podSpec.schedulerName)}</span>])
  if (podSpec.imagePullSecrets) sched.push(['pullSecrets', <span className={MONO}>{((podSpec.imagePullSecrets as Rec[]) ?? []).map(s => s.name).join(', ')}</span>])
  if (podSpec.activeDeadlineSeconds) sched.push(['deadline', <span className={MONO}>{String(podSpec.activeDeadlineSeconds)}s</span>])
  if (podSpec.restartPolicy && podSpec.restartPolicy !== 'Always' && !isPod) sched.push(['restartPolicy', <span className={MONO}>{String(podSpec.restartPolicy)}</span>])
  sched.push(...affinityRows(podSpec, t))

  const nodeSel = Object.entries((podSpec.nodeSelector as Rec) ?? {})
  const allTol = ((podSpec.tolerations as Rec[]) ?? [])
  const tols = allTol.filter(x => !DEFAULT_TOLERATIONS.has(`${x.key}|${x.operator}|${x.effect}|${x.tolerationSeconds}`))
  const tolHidden = allTol.length - tols.length

  const work: [string, ReactNode][] = []
  if (!isPod) {
    if (spec.replicas !== undefined) work.push(['replicas', <span className={MONO}>{String(spec.replicas)}</span>])
    if (spec.paused === true) work.push(['paused', <span className="font-medium">{t('res:pausedVal')}</span>])
    const st = spec.strategy as Rec | undefined
    if (st) {
      const ru = st.rollingUpdate as Rec | undefined
      work.push(['strategy', <span className={MONO}>{[st.type, ru ? `surge=${ru.maxSurge} unavail=${ru.maxUnavailable}` : '', ru && ru.partition !== undefined ? `partition=${ru.partition}` : ''].filter(Boolean).join(' ')}</span>])
    }
    const us = spec.updateStrategy as Rec | undefined
    if (us) {
      const r = us.rollingUpdate as Rec | undefined
      work.push(['updateStrategy', <span className={MONO}>{[us.type, r && r.partition !== undefined ? `partition=${r.partition}` : ''].filter(Boolean).join(' ')}</span>])
    }
    if (kind === 'StatefulSet' && spec.serviceName) work.push(['serviceName', <span className={MONO}>{String(spec.serviceName)}</span>])
    if (kind === 'StatefulSet' && spec.podManagementPolicy) work.push(['podMgmt', <span className={MONO}>{String(spec.podManagementPolicy)}</span>])
    if (spec.revisionHistoryLimit !== undefined) work.push(['historyLimit', <span className={MONO}>{String(spec.revisionHistoryLimit)}</span>])
    if (spec.completions !== undefined || spec.parallelism !== undefined) work.push(['completions', <span className={MONO}>{`${spec.completions ?? 'auto'} / ${spec.parallelism ?? 1}`}</span>])
    if (spec.backoffLimit !== undefined) work.push(['backoffLimit', <span className={MONO}>{String(spec.backoffLimit)}</span>])
    if (spec.schedule) work.push(['schedule', <span className={MONO}>{String(spec.schedule)}</span>])
    if (spec.suspend === true) work.push(['suspend', <span className="font-medium">{t('res:pausedVal')}</span>])
    const sel = spec.selector as Rec | undefined
    if (sel?.matchLabels) {
      const entries = Object.entries(sel.matchLabels as Rec)
      const sysOnly = entries.length > 0 && entries.every(([k, v]) => SYS_SELECTOR_RE.test(k) || SYS_SELECTOR_RE.test(String(v)))
      work.push(['selector', <span className={MONO} title={entries.map(([k, v]) => `${k}=${v}`).join('\n')}>{sysOnly ? <span className="text-muted-foreground">{t('res:sysTags')}</span> : entries.map(([k, v]) => `${k}=${v}`).join(', ')}</span>])
    }
    const exprs = ((sel?.matchExpressions as Rec[]) ?? []).map(e => `${e.key} ${e.operator} ${((e.values as string[]) ?? []).join('|')}`)
    if (exprs.length) work.push(['matchExpr', <span className={MONO}>{exprs.join(' · ')}</span>])
  }

  return (
    <Card>
      <CardContent className="@container space-y-4 pt-3 text-[13px]">
        <SectionTitle className="mb-0">{t('res:secPodSpec')}</SectionTitle>
        {(cs.length > 0 || inits.length > 0) && (
          <section>
            <SectionHead title={t('res:secContainers')} n={cs.length + inits.length} />
            <div className="space-y-2">
              {[...cs.map(c => ({ c, init: false })), ...inits.map(c => ({ c, init: true }))].map(({ c, init }) => (
                <div key={c.name} className="space-y-0 rounded-md border px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[13px] font-medium">{c.name}</span>
                    {init && <Badge variant="secondary" className="h-4 px-1.5 py-0 text-xs font-normal">{t('res:initTag')}</Badge>}
                    {c.imagePullPolicy && c.imagePullPolicy !== 'IfNotPresent' && <Tag>{c.imagePullPolicy}</Tag>}
                  </div>
                  <ContainerBody c={c} t={t} volType={volType} isPod={isPod} />
                </div>
              ))}
            </div>
          </section>
        )}
        {volumes.length > 0 && !isPod && (
          <section>
            <SectionHead title={t('res:secVolumes')} n={volumes.length} />
            <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 @xl:grid-cols-2">
              {volumes.map(v => {
                const line = `${String(v.name)} · ${volumeSum(v)}`
                return (
                  <div key={String(v.name)} className={`${MONO} break-words [overflow-wrap:anywhere] hover:bg-accent/40`} title={line}>
                    {line}
                  </div>
                )
              })}
            </div>
          </section>
        )}
        {(sched.length > 0 || nodeSel.length > 0 || tols.length > 0 || tolHidden > 0) && (
          <section>
            <SectionHead title={t('res:secScheduling')} />
            {sched.map(([k, v]) => <KV key={k} k={k}>{v}</KV>)}
            {nodeSel.length > 0 && (
              <KV k="nodeSelector">
                <span className="flex flex-wrap gap-1">{nodeSel.map(([k, v]) => <Tag key={k} title={`${k}=${String(v)}`}>{k}={String(v)}</Tag>)}</span>
              </KV>
            )}
            {(tols.length > 0 || tolHidden > 0) && (
              <KV k="tolerations">
                <span className="flex flex-wrap items-center gap-1">
                  {tols.map(x => {
                    const s = `${x.key ?? ''}${x.operator === 'Exists' ? '' : `=${x.value ?? ''}`}${x.effect ? `:${x.effect}` : ''}`
                    return <Tag key={s} title={JSON.stringify(x)}>{s}</Tag>
                  })}
                  {tolHidden > 0 && (
                    <span className="text-xs text-muted-foreground">{(tols.length > 0 ? '· ' : '') + tf('res:sysTolMore', { n: tolHidden })}</span>
                  )}
                </span>
              </KV>
            )}
          </section>
        )}
        {work.length > 0 && (
          <section>
            <SectionHead title={t('res:secWorkload')} />
            {work.map(([k, v]) => (
              <KV key={k} k={k}>
                {v}
              </KV>
            ))}
          </section>
        )}
      </CardContent>
    </Card>
  )
}

/** 容器体（供带外框的容器块内使用；外框/头行由调用方负责） */
function ContainerBody({ c, t, volType, isPod }: { c: Container; t: (k: string) => string; volType: (n: string) => string; isPod?: boolean }) {
  const img = c.image ? imageParts(c.image) : null
  const probes: [string, Probe | undefined][] = [
    [t('res:probeStart'), c.startupProbe],
    [t('res:probeReady'), c.readinessProbe],
    [t('res:probeLive'), c.livenessProbe],
  ]
  return (
    <div className="space-y-1">
      {img && (
        <KV k={t('res:imageLabel')}>
          <span className="break-all font-mono text-[12px]" title={c.image}>
            {img.repo && <span className="text-muted-foreground">{img.repo}</span>}
            <span className="font-medium">{img.last}</span>
          </span>
          <CodeBlockCopyButton value={c.image!} className="ml-1 size-6 align-middle" aria-label={c.image} />
        </KV>
      )}
      {(c.command?.length || c.args?.length) && (
        <KV k={t('res:cmdLabel')}>
          <span className={cn(MONO, 'break-all')}>{joinCmd(c.command, c.args)}</span>
        </KV>
      )}
      {/* Pod 态端口/资源不重复：PortLinks 卡（可点）与 ResourcesCard（含实时用量）更强 */}
      {!isPod && (c.ports?.length ?? 0) > 0 && (
        <KV k={t('res:portsLabel')}>
          <span className={MONO}>{(c.ports ?? []).map(p => `:${p.containerPort}${p.protocol && p.protocol !== 'TCP' ? `/${p.protocol}` : ''}${p.name ? ` (${p.name})` : ''}`).join(' · ')}</span>
        </KV>
      )}
      {!isPod && (Object.keys(c.resources?.requests ?? {}).length > 0 || Object.keys(c.resources?.limits ?? {}).length > 0 || (c.resources?.claims?.length ?? 0) > 0) && (
        <KV k={t('res:resLabel')}>
          <span className={MONO}>{resValue(c, t)}</span>
        </KV>
      )}
      {probes.map(([label, p]) => (p ? <KV key={label} k={label}><span className={MONO}>{probeValue(p)}</span></KV> : null))}
      {(c.env?.length ?? 0) > 0 && (
        <KV k={t('res:envLabel')}>
          <div className="grid grid-cols-1 gap-x-6 @xl:grid-cols-2">
            {c.env!.map(e => {
              const src = envSource(e, t)
              const full = src ?? e.value ?? ''
              return (
                <div key={e.name} className="min-w-0 break-words [overflow-wrap:anywhere] py-0.5 font-mono text-[12px]" title={`${e.name} = ${full}`}>
                  <span className="font-medium">{e.name}</span>
                  {full ? <span className="text-muted-foreground">{src ? ` ${full}` : ` = ${full}`}</span> : ''}
                </div>
              )
            })}
          </div>
        </KV>
      )}
      {(c.envFrom?.length ?? 0) > 0 && (
        <KV k="envFrom">
          <span className={cn(MONO, 'text-muted-foreground')}>{c.envFrom!.map(f => (f.secretRef ? `← secret ${f.secretRef.name}` : `← cm ${f.configMapRef?.name}`) + (f.prefix ? ` (${f.prefix}*)` : '')).join(' · ')}</span>
        </KV>
      )}
      {(c.volumeMounts?.length ?? 0) > 0 && (
        <KV k={t('res:mountsLabel')}>
          <div className="min-w-0">
            {c.volumeMounts!.map(m => {
              const line = `${m.mountPath}${m.subPath ? ` :${m.subPath}` : ''} · ${m.readOnly ? t('res:ro') : t('res:rw')} ← ${m.name}${volType(m.name) ? ` · ${volType(m.name)}` : ''}`
              return (
                <div key={`${m.name}${m.mountPath}`} className={`${MONO} break-words [overflow-wrap:anywhere]`} title={line}>
                  {line}
                </div>
              )
            })}
          </div>
        </KV>
      )}
    </div>
  )
}

// ---- 非工作负载：Service 语义视图 + 通用平铺（折行全文+复制，默认值过滤） ----

const SVC_CONSUMED = new Set(['ports', 'selector', 'type', 'clusterIP', 'clusterIPs', 'externalName', 'sessionAffinity', 'ipFamilyPolicy', 'ipFamilies', 'internalTrafficPolicy', 'externalTrafficPolicy', 'healthCheckNodePort', 'allocateLoadBalancerNodePorts', 'loadBalancerIP', 'publishNotReadyAddresses'])
// 默认值=配置里没有这一行等价：展示它们只是把 YAML 噪声搬进 UI
const DEFAULTS_SKIP: Record<string, unknown> = { sessionAffinity: 'None', ipFamilyPolicy: 'SingleStack', internalTrafficPolicy: 'Cluster', externalTrafficPolicy: 'Cluster', publishNotReadyAddresses: false, allocateLoadBalancerNodePorts: true }

function FlatOrService({ obj, kind, t }: { obj: Rec; kind: string; t: (k: string) => string }) {
  const spec = (obj.spec ?? {}) as Rec
  const entries = Object.entries(spec).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return null

  if (kind === 'Service') {
    const rows: [string, ReactNode][] = []
    const type = String(spec.type ?? 'ClusterIP')
    rows.push([t('res:svcType'), <span className={MONO}>{type}</span>])
    if (spec.clusterIP) {
      const ips = ((spec.clusterIPs as string[]) ?? []).filter(x => x !== spec.clusterIP)
      rows.push(['clusterIP', <span className={MONO} title={String(spec.clusterIP)}>{spec.clusterIP === 'None' ? 'None (headless)' : `${String(spec.clusterIP)}${ips.length ? ` (dual: ${ips.join(', ')})` : ''}`}</span>])
    }
    const ports = ((spec.ports as Rec[]) ?? []).map(p => {
      const src = p.targetPort !== undefined && String(p.targetPort) !== String(p.port) ? `${p.port}→${p.targetPort}` : `${p.port}`
      return `${p.name ? `${p.name} ` : ''}${src}/${p.protocol ?? 'TCP'}${p.nodePort ? ` · node ${p.nodePort}` : ''}`
    })
    if (ports.length > 0)
      rows.push([
        t('res:portsLabel'),
        <div className="min-w-0">
          {ports.map(x => (
            <div key={x} className={`${MONO} break-all`}>
              {x}
            </div>
          ))}
        </div>,
      ])
    if (spec.selector && Object.keys(spec.selector as Rec).length > 0) rows.push(['selector', <span className={MONO}>{Object.entries(spec.selector as Rec).map(([k, v]) => `${k}=${v}`).join(', ')}</span>])
    if (spec.externalName) rows.push(['externalName', <span className={MONO}>{String(spec.externalName)}</span>])
    if (spec.loadBalancerIP) rows.push(['loadBalancerIP', <span className={MONO}>{String(spec.loadBalancerIP)}</span>])
    const rest = entries.filter(([k]) => !SVC_CONSUMED.has(k))
    return <FlatCard rows={rows} rest={rest} title={t('res:secSvcSpec')} />
  }
  return <FlatCard rows={[]} rest={entries} title={t('res:secSpecFields')} />
}

function FlatCard({ rows, rest, title }: { rows: [string, ReactNode][]; rest: [string, unknown][]; title: string }) {
  return (
    <Card>
      <CardContent className="space-y-1 pt-3 text-[13px]">
        <SectionTitle className="mb-0">{title}</SectionTitle>
        {rows.map(([k, v]) => <KV key={k} k={k}>{v}</KV>)}
        {rest.map(([k, v]) => {
          if (DEFAULTS_SKIP[k] !== undefined && v === DEFAULTS_SKIP[k]) return null
          const full = typeof v === 'object' && v !== null ? JSON.stringify(v, null, 1) : String(v)
          const inline = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)
          return (
            <KV key={k} k={k}>
              <span className={cn(MONO, 'break-words [overflow-wrap:anywhere] hover:bg-accent/40')} title={typeof v === 'object' ? full : inline}>
                {inline}
              </span>
              {full.length > 24 && <CodeBlockCopyButton value={full} className="ml-1 size-6 align-middle" aria-label={k} />}
            </KV>
          )
        })}
      </CardContent>
    </Card>
  )
}
