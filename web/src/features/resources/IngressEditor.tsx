// Ingress 表单编辑器：把「ingressClassName / rules(host+paths+backend) / tls / defaultBackend」
// 这类高频但手写 YAML 极易写错（pathType 漏写、port.number 写成字符串）的结构做成
// 表单 + 实时 YAML 预览。表单不认识的字段（backend.resource、service.port.namedPort、
// tls[].certificateKeySecretRef…）打开时列成「有损告警」引导走 YAML 页，避免静默丢字段；
// labels/annotations 与表单未涉及的 spec 键在 PUT 前从服务端现值合并带过。
// 后端语义要点：
//   - pathType 必填（HTTPIngressPath 无默认值），生成器永远显式写出；
//   - 端口选数字生成 port.number（number 类型），选名称生成 port.name，二者互斥；
//   - rule.host 留空 = 匹配所有 host（仅按 path 转发），预览里不写 host 键；
//   - defaultBackend 与 rules 可共存（未命中规则的请求兜底），不是二选一。
// 保存：编辑先 GET 最新 resourceVersion 再 PUT（乐观锁，409 明确提示重开）；新建 POST collection。
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { stringify as yamlStringify } from 'yaml'
import { AlertTriangle, Globe, Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, get, list, postObject, putObject } from '@/api/client'
import type { K8sObject } from '@/api/types'
import { tf, useT } from '@/i18n'
import { itemPath, listPath } from '@/resources/registry'
import { GatedButton } from '@/components/GatedButton'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// ---------- 表单模型 ----------

type PathType = 'Prefix' | 'Exact' | 'ImplementationSpecific'

const PATH_TYPES: PathType[] = ['Prefix', 'Exact', 'ImplementationSpecific']
/** Radix Select 不允许空串 value，「未选择」用哨兵值 */
const NONE = '__none__'
/** 对象名（DNS subdomain）与命名端口（宽松版 IANA_SVC_NAME），与 NetPol 编辑器同款 */
const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
const ING_DEF = { group: 'networking.k8s.io', version: 'v1', resource: 'ingresses', scope: 'namespaced' } as const
/** 表单全权生成（保存即覆盖）的 spec 键；其余 spec 键 PUT 前从服务端现值合并带过 */
const FORM_SPEC_KEYS = ['ingressClassName', 'rules', 'tls', 'defaultBackend']

interface PathRow {
  path: string
  pathType: PathType
  service: string
  /** 端口号或端口名的原始输入；数字 → port.number，其余 → port.name */
  port: string
}
interface Rule {
  host: string
  paths: PathRow[]
}
interface TlsEntry {
  secretName: string
  /** 逗号分隔输入串；生成时 split + 去重 */
  hosts: string
}
interface FormState {
  name: string
  /** '' = 不指定 ingressClassName */
  className: string
  rules: Rule[]
  tls: TlsEntry[]
  hasDefault: boolean
  defService: string
  defPort: string
}

const emptyPath = (): PathRow => ({ path: '/', pathType: 'Prefix', service: '', port: '' })
const emptyRule = (): Rule => ({ host: '', paths: [emptyPath()] })
const defaultForm = (): FormState => ({
  name: '',
  className: '',
  rules: [emptyRule()],
  tls: [],
  hasDefault: false,
  defService: '',
  defPort: '',
})

// ---------- 解析工具 ----------

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
/** 端口输入 → number 或命名端口字符串；非法返回 null（表单侧就地报错） */
function portValue(raw: string): number | string | null {
  const s = raw.trim()
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n >= 1 && n <= 65535 ? n : null
  }
  return s && NAME_RE.test(s) ? s : null
}
const splitHosts = (s: string): string[] => [...new Set(s.split(/[\s,]+/).map(x => x.trim()).filter(Boolean))]

/** 同 ns Service 及其可选端口（number 与 name 都可选，合并进一个下拉） */
interface ServicePort {
  name?: string
  port: number
}
interface ServiceOpt {
  name: string
  ports: ServicePort[]
}
function serviceOpts(items: K8sObject[], ns: string): ServiceOpt[] {
  return items
    .filter(i => i.metadata.namespace === ns)
    .map(i => ({
      name: i.metadata.name,
      ports: asArray(asRecord(asRecord(i)?.spec)?.ports)
        .map(asRecord)
        .filter((p): p is Record<string, unknown> => !!p && typeof p.port === 'number')
        .map(p => ({ ...(typeof p.name === 'string' ? { name: p.name } : {}), port: p.port as number })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ---------- obj → 表单（回填） ----------

/** backend.service.port → 表单端口输入串；namedPort 等不支持形态回填空串（由 collectLossy 告警） */
function portFromBackend(entry: unknown): string {
  const svc = asRecord(asRecord(entry)?.service)
  const port = asRecord(svc?.port)
  if (!port) return ''
  if (typeof port.number === 'number') return String(port.number)
  if (typeof port.name === 'string') return port.name
  return ''
}
function serviceFromBackend(entry: unknown): string {
  return str(asRecord(asRecord(entry)?.service)?.name)
}
function parseObj(obj: Record<string, unknown>): FormState {
  const spec = asRecord(obj.spec) ?? {}
  return {
    name: str(asRecord(obj.metadata)?.name),
    className: str(spec.ingressClassName),
    rules: asArray(spec.rules).map(r => {
      const rec = asRecord(r) ?? {}
      return {
        host: str(rec.host),
        paths: asArray(asRecord(rec.http)?.paths).map(p => {
          const prec = asRecord(p) ?? {}
          const pt = str(prec.pathType)
          return {
            path: str(prec.path),
            pathType: PATH_TYPES.includes(pt as PathType) ? (pt as PathType) : 'Prefix',
            service: serviceFromBackend(prec.backend),
            port: portFromBackend(prec.backend),
          }
        }),
      }
    }),
    tls: asArray(spec.tls).map(x => {
      const rec = asRecord(x) ?? {}
      return { secretName: str(rec.secretName), hosts: asArray(rec.hosts).map(str).join(', ') }
    }),
    hasDefault: !!asRecord(asRecord(spec.defaultBackend)?.service),
    defService: serviceFromBackend(spec.defaultBackend),
    defPort: portFromBackend(spec.defaultBackend),
  }
}

// ---------- 有损字段检测（返回 i18n key，渲染时再翻译） ----------

/** backend 是否表单可完整表达：仅 service{name, port{number|name}}；resource/namedPort 都是丢失项 */
function checkBackend(entry: unknown, add: (key: string) => void): void {
  const rec = asRecord(entry)
  if (!rec) return add('ing:lossUnknown')
  if (rec.resource !== undefined) add('ing:lossBackendResource')
  const svc = asRecord(rec.service)
  if (!svc) {
    if (rec.service !== undefined) add('ing:lossUnknown')
    return
  }
  if (Object.keys(svc).some(k => k !== 'name' && k !== 'port')) add('ing:lossUnknown')
  const port = asRecord(svc.port)
  // port 缺省在 API 上=全端口，表单必须显式端口，回填会静默补值 → 也算有损
  if (!port) add('ing:lossUnknown')
  else {
    if (port.namedPort !== undefined) add('ing:lossNamedPort')
    if (port.number === undefined && port.name === undefined) add('ing:lossUnknown')
  }
}
/** 列出表单不支持、保存会被覆盖丢失的字段（返回 i18n key，渲染时再翻译） */
function collectLossy(obj: Record<string, unknown>): string[] {
  const set = new Set<string>()
  const add = (k: string) => set.add(k)
  const spec = asRecord(obj.spec) ?? {}
  // 只扫表单全权重写的结构；spec 上其他未知键（如 loadBalancerClass）保存时原样带过，不算有损
  for (const r of asArray(spec.rules)) {
    const rec = asRecord(r)
    if (!rec || Object.keys(rec).some(k => k !== 'host' && k !== 'http')) add('ing:lossUnknown')
    for (const p of asArray(asRecord(rec?.http)?.paths)) {
      const prec = asRecord(p)
      if (!prec || Object.keys(prec).some(k => k !== 'path' && k !== 'pathType' && k !== 'backend')) add('ing:lossUnknown')
      else checkBackend(prec.backend, add)
    }
  }
  for (const x of asArray(spec.tls)) {
    const rec = asRecord(x)
    // Gateway API 风格的 certificateKeySecretRef / caCertificateSecretRef 表单不生成
    if (rec?.certificateKeySecretRef !== undefined || rec?.caCertificateSecretRef !== undefined) add('ing:lossCertKeyRef')
    if (!rec || Object.keys(rec).some(k => k !== 'hosts' && k !== 'secretName' && k !== 'certificateKeySecretRef' && k !== 'caCertificateSecretRef'))
      add('ing:lossUnknown')
  }
  const db = asRecord(spec.defaultBackend)
  if (db) {
    if (Object.keys(db).some(k => k !== 'service' && k !== 'resource')) add('ing:lossUnknown')
    // externalName 型 defaultBackend 是表单表达不了的后端形态
    if (str(asRecord(db.service)?.externalName)) add('ing:lossExternalName')
    // defaultBackend 本身就是 backend 条目（service/port/resource 在其顶层），直接整体检查
    else checkBackend(db, add)
  }
  return [...set]
}

// ---------- 表单 → k8s 对象（+ 就地校验问题） ----------

interface Issues {
  invalidPaths: string[]
  invalidPorts: string[]
  /** {n, m} = 规则序号/路径序号（均 1 起），供翻译 */
  missingBackend: { n: number; m: number }[]
  missingPort: { n: number; m: number }[]
  emptyRules: number[]
  emptyTls: number[]
  /** 勾选了 defaultBackend 但服务/端口不全 */
  defaultIncomplete: boolean
}
/** 单端口输入 → port 对象；null = 非法（收进 invalidPorts） */
function portOf(raw: string, invalid: string[]): { number: number } | { name: string } | null {
  const v = portValue(raw)
  if (v === null) {
    if (raw.trim()) invalid.push(raw.trim())
    return null
  }
  return typeof v === 'number' ? { number: v } : { name: v }
}
function buildBody(form: FormState, ns: string): { body: Record<string, unknown>; issues: Issues } {
  const issues: Issues = {
    invalidPaths: [],
    invalidPorts: [],
    missingBackend: [],
    missingPort: [],
    emptyRules: [],
    emptyTls: [],
    defaultIncomplete: false,
  }
  const spec: Record<string, unknown> = {}
  if (form.className.trim()) spec.ingressClassName = form.className.trim()

  if (form.rules.length) {
    spec.rules = form.rules.map((r, i) => {
      if (!r.paths.length) issues.emptyRules.push(i + 1)
      const paths = r.paths.map((p, j) => {
        const path = p.path.trim()
        if (!path.startsWith('/')) issues.invalidPaths.push(path)
        if (!p.service.trim()) issues.missingBackend.push({ n: i + 1, m: j + 1 })
        const port = portOf(p.port, issues.invalidPorts)
        if (port === null) issues.missingPort.push({ n: i + 1, m: j + 1 })
        const node: Record<string, unknown> = { path, pathType: p.pathType }
        if (p.service.trim() && port) {
          node.backend = { service: { name: p.service.trim(), port } }
        }
        return node
      })
      // host 缺省 = 匹配所有 host，不写该键
      return { ...(r.host.trim() ? { host: r.host.trim() } : {}), http: { paths } }
    })
  }
  if (form.tls.length) {
    spec.tls = form.tls.map((x, i) => {
      const secretName = x.secretName.trim()
      if (!secretName) issues.emptyTls.push(i + 1)
      const hosts = splitHosts(x.hosts)
      return { ...(secretName ? { secretName } : {}), ...(hosts.length ? { hosts } : {}) }
    })
  }
  if (form.hasDefault) {
    const name = form.defService.trim()
    const port = portOf(form.defPort, issues.invalidPorts)
    if (!name || port === null) issues.defaultIncomplete = true
    if (name && port) spec.defaultBackend = { service: { name, port } }
  }
  return {
    body: {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: { name: form.name.trim(), namespace: ns },
      spec,
    },
    issues,
  }
}

// ---------- 子组件 ----------

function RowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="outline" onClick={onClick}>
      <Plus />
      {label}
    </Button>
  )
}

function RemoveButton({ onClick, className }: { onClick: () => void; className?: string }) {
  const t = useT()
  return (
    <Button
      size="icon"
      variant="ghost"
      title={t('ing:removeRow')}
      onClick={onClick}
      className={className ?? 'text-muted-foreground hover:text-destructive'}
    >
      <X />
    </Button>
  )
}

/**
 * 后端 Service+端口选择：Service 列表加载失败退化为手输名称 + 手输端口；
 * 端口下拉合并该 Service spec.ports 的 number 与 name（选 name 则生成 port.name），
 * 已选值不在列表里（服务被改过端口/列表缺失）时保留为「原值」选项，不静默清空。
 */
function BackendFields({
  services,
  servicesFailed,
  service,
  port,
  onService,
  onPort,
}: {
  services: ServiceOpt[]
  servicesFailed: boolean
  service: string
  port: string
  onService: (v: string) => void
  onPort: (v: string) => void
}) {
  const t = useT()
  // 数字端口用 `number:` 前缀、命名端口 `name:` 前缀做选项 value，避免同名/同值歧义；回填时同样编码
  const encode = (v: string) => (/^\d+$/.test(v.trim()) ? `number:${v.trim()}` : `name:${v.trim()}`)
  const svc = services.find(s => s.name === service)
  const options = svc
    ? svc.ports.flatMap(p => [
        { value: `number:${p.port}`, label: String(p.port) },
        ...(p.name ? [{ value: `name:${p.name}`, label: tf('ing:portOptionNamed', { port: p.name }) }] : []),
      ])
    : []
  // 已选端口不在当前 Service 的端口列表里：保留可见可删，不强迫用户先改回
  if (port.trim() && !options.some(o => o.value === encode(port))) {
    options.unshift({ value: encode(port), label: tf('ing:portStale', { port: port.trim() }) })
  }
  // 已选服务不在列表里（服务已删/加载不全）：同样保留
  const serviceOptions = service && !services.some(s => s.name === service) ? [service, ...services.map(s => s.name)] : services.map(s => s.name)
  return (
    <div className="flex flex-wrap items-center gap-1">
      {servicesFailed ? (
        <Input
          className="w-36 font-mono text-[13px]"
          value={service}
          placeholder={t('ing:serviceManualPlaceholder')}
          onChange={e => onService(e.target.value)}
        />
      ) : (
        <Select
          value={service || NONE}
          onValueChange={v => {
            // 换服务后旧端口对新服务大概率无效，重置让用户重选
            if (v !== service) onPort('')
            onService(v === NONE ? '' : v)
          }}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder={t('ing:servicePlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('ing:servicePlaceholder')}</SelectItem>
            {serviceOptions.map(n => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {servicesFailed ? (
        <Input
          className="w-32 font-mono text-[13px] tabular-nums"
          value={port}
          placeholder={t('ing:portManualPlaceholder')}
          onChange={e => onPort(e.target.value)}
        />
      ) : (
        <Select value={port ? encode(port) : NONE} onValueChange={v => onPort(v === NONE ? '' : v.slice(v.indexOf(':') + 1))}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder={t('ing:portPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('ing:portPlaceholder')}</SelectItem>
            {options.map(o => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}

function RuleSection({
  rules,
  onChange,
  services,
  servicesFailed,
}: {
  rules: Rule[]
  onChange: (next: Rule[]) => void
  services: ServiceOpt[]
  servicesFailed: boolean
}) {
  const t = useT()
  const set = (i: number, patch: Partial<Rule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const setPath = (i: number, j: number, patch: Partial<PathRow>) =>
    set(i, { paths: rules[i]!.paths.map((p, m) => (m === j ? { ...p, ...patch } : p)) })
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium">{t('ing:rules')}</span>
        <RowButton label={t('ing:addRule')} onClick={() => onChange([...rules, emptyRule()])} />
      </div>
      {rules.map((r, i) => (
        <div key={i} className="space-y-2 rounded-md border p-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[13px] font-medium text-muted-foreground">{tf('ing:ruleN', { n: i + 1 })}</span>
            <Input
              className="min-w-0 flex-1 font-mono text-[13px]"
              value={r.host}
              placeholder={t('ing:hostPlaceholder')}
              onChange={e => set(i, { host: e.target.value })}
            />
            <Button
              variant="ghost"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => onChange(rules.filter((_, j) => j !== i))}
            >
              {t('ing:deleteRule')}
            </Button>
          </div>
          <p className="text-[13px] text-muted-foreground">{t('ing:hostHint')}</p>
          {r.paths.map((p, j) => (
            <div key={j} className="space-y-1 rounded-md border border-dashed bg-muted/20 p-2">
              <div className="flex flex-wrap items-center gap-1">
                <Input
                  className="w-40 font-mono text-[13px]"
                  value={p.path}
                  placeholder={t('ing:pathPlaceholder')}
                  onChange={e => setPath(i, j, { path: e.target.value })}
                />
                <Select value={p.pathType} onValueChange={v => setPath(i, j, { pathType: v as PathType })}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PATH_TYPES.map(pt => (
                      <SelectItem key={pt} value={pt}>
                        {pt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <RemoveButton className="ml-auto shrink-0 text-muted-foreground hover:text-destructive" onClick={() => set(i, { paths: r.paths.filter((_, m) => m !== j) })} />
              </div>
              <BackendFields
                services={services}
                servicesFailed={servicesFailed}
                service={p.service}
                port={p.port}
                onService={v => setPath(i, j, { service: v })}
                onPort={v => setPath(i, j, { port: v })}
              />
            </div>
          ))}
          <RowButton label={t('ing:addPath')} onClick={() => set(i, { paths: [...r.paths, emptyPath()] })} />
        </div>
      ))}
    </section>
  )
}

function TlsSection({
  tls,
  hostCandidates,
  onChange,
}: {
  tls: TlsEntry[]
  hostCandidates: string[]
  onChange: (next: TlsEntry[]) => void
}) {
  const t = useT()
  const set = (i: number, patch: Partial<TlsEntry>) => onChange(tls.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium">{t('ing:tls')}</span>
        <RowButton label={t('ing:addTls')} onClick={() => onChange([...tls, { secretName: '', hosts: '' }])} />
      </div>
      {tls.map((x, i) => (
        <div key={i} className="space-y-1 rounded-md border p-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[13px] font-medium text-muted-foreground">{tf('ing:tlsN', { n: i + 1 })}</span>
            <span className="shrink-0 text-[13px] text-muted-foreground">{t('ing:secretName')}</span>
            <Input
              className="min-w-0 flex-1 font-mono text-[13px]"
              value={x.secretName}
              placeholder={t('ing:secretNamePlaceholder')}
              onChange={e => set(i, { secretName: e.target.value })}
            />
            <RemoveButton className="shrink-0" onClick={() => onChange(tls.filter((_, j) => j !== i))} />
          </div>
          <div className="flex items-center gap-1">
            <span className="shrink-0 text-[13px] text-muted-foreground">{t('ing:tlsHosts')}</span>
            <Input
              className="min-w-0 flex-1 font-mono text-[13px]"
              value={x.hosts}
              placeholder={t('ing:tlsHostsPlaceholder')}
              onChange={e => set(i, { hosts: e.target.value })}
            />
          </div>
          {hostCandidates.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[13px] text-muted-foreground">{t('ing:tlsHostCandidates')}</span>
              {hostCandidates.map(h => {
                const picked = splitHosts(x.hosts).includes(h)
                return (
                  <Button
                    key={h}
                    variant={picked ? 'secondary' : 'outline'}
                    onClick={() =>
                      set(i, {
                        hosts: picked ? splitHosts(x.hosts).filter(v => v !== h).join(', ') : [...splitHosts(x.hosts), h].join(', '),
                      })
                    }
                  >
                    {h}
                  </Button>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </section>
  )
}

// ---------- 主组件 ----------

export function IngressEditor({
  cluster,
  ns,
  name,
  obj,
  allowed,
  onSaved,
}: {
  cluster: string
  ns: string
  /** 编辑既有对象时的资源名（新建模式用表单输入，可省略） */
  name?: string
  /** 既有 Ingress 裸对象；缺省 = 新建模式 */
  obj?: Record<string, unknown>
  allowed: boolean
  onSaved?: () => void
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<FormState>(defaultForm)

  const isEdit = obj !== undefined

  // 打开瞬间才回填（不用 effect 跟随 obj 身份变化）：编辑中途 watch/refetch 不能把用户已改的表单冲掉
  const openEditor = () => {
    const next = obj ? parseObj(obj) : defaultForm()
    if (obj && name) next.name = name
    setForm(next)
    setConfirm(false)
    setOpen(true)
  }

  // class / service 候选：仅打开时拉取，加载失败各自退化为手输
  const classQuery = useQuery({
    queryKey: ['ing-editor-ingressclasses', cluster],
    queryFn: () => list<K8sObject>(cluster, '/apis/networking.k8s.io/v1/ingressclasses'),
    enabled: open,
    staleTime: 60_000,
    retry: 1,
  })
  const serviceQuery = useQuery({
    queryKey: ['ing-editor-services', cluster, ns],
    queryFn: () => list<K8sObject>(cluster, '/api/v1/services'),
    enabled: open,
    staleTime: 60_000,
    retry: 1,
  })
  const classes = useMemo(() => (classQuery.data?.items ?? []).map(i => i.metadata.name).sort(), [classQuery.data])
  const classesFailed = !classQuery.isPending && !!classQuery.error
  const services = useMemo(() => serviceOpts(serviceQuery.data?.items ?? [], ns), [serviceQuery.data, ns])
  const servicesFailed = !serviceQuery.isPending && !!serviceQuery.error

  const { body, issues } = useMemo(() => buildBody(form, ns), [form, ns])
  const yamlText = useMemo(() => yamlStringify(body, { lineWidth: 0 }), [body])
  const warnings = useMemo(() => (obj ? collectLossy(obj) : []), [obj])
  const hostCandidates = useMemo(() => [...new Set(form.rules.map(r => r.host.trim()).filter(Boolean))], [form.rules])

  const nameTrimmed = form.name.trim()
  const errors = [
    ...(!isEdit && (!NAME_RE.test(nameTrimmed) || nameTrimmed.length > 253) ? [t('ing:invalidName')] : []),
    ...issues.emptyRules.map(n => tf('ing:pathsRequired', { n })),
    ...issues.invalidPaths.map(v => tf('ing:invalidPath', { value: v })),
    ...issues.invalidPorts.map(v => tf('ing:invalidPort', { value: v })),
    ...issues.missingBackend.map(({ n, m }) => tf('ing:backendRequired', { n, m })),
    ...issues.missingPort.map(({ n, m }) => tf('ing:portRequired', { n, m })),
    ...issues.emptyTls.map(n => tf('ing:secretRequired', { n })),
    ...(issues.defaultIncomplete ? [t('ing:defaultBackendMissing')] : []),
  ]
  const path = itemPath(ING_DEF, ns, isEdit ? (name ?? nameTrimmed) : nameTrimmed || '-')

  const save = async () => {
    setBusy(true)
    try {
      if (isEdit) {
        // 表单不带 resourceVersion：保存前取服务端最新值，避免覆盖他人刚做的改动；
        // PUT 是整体替换，labels/annotations/表单未涉及的 spec 键（如未来新增字段）从现值带过去
        const cur = await get<K8sObject>(cluster, path)
        const { labels, annotations } = cur.metadata
        const curSpec = asRecord(asRecord(cur)?.spec) ?? {}
        const passthrough = Object.fromEntries(Object.entries(curSpec).filter(([k]) => !FORM_SPEC_KEYS.includes(k)))
        await putObject(cluster, path, {
          ...body,
          metadata: {
            ...(labels ? { labels } : {}),
            ...(annotations ? { annotations } : {}),
            name: cur.metadata.name,
            namespace: ns,
            resourceVersion: cur.metadata.resourceVersion,
          },
          spec: { ...passthrough, ...(asRecord(body.spec) ?? {}) },
        } as unknown as K8sObject, 'Ingress 表单保存')
        toast.success(tf('ing:savedUpdate', { name: cur.metadata.name }))
      } else {
        await postObject(cluster, listPath(ING_DEF, ns), body as unknown as K8sObject, 'Ingress 表单创建')
        toast.success(tf('ing:savedCreate', { name: nameTrimmed }))
      }
      queryClient.invalidateQueries({ queryKey: ['yaml', cluster, path] })
      setConfirm(false)
      setOpen(false)
      onSaved?.()
    } catch (e) {
      const detail = e instanceof ApiError && e.isConflict ? t('ing:conflict') : e instanceof Error ? e.message : String(e)
      toast.error(tf('ing:saveFailed', { error: detail }))
    } finally {
      setBusy(false)
    }
  }

  // class 输入区：加载成功=下拉（可空），失败=手输退化
  const classField = classesFailed ? (
    <div className="space-y-1">
      <Input
        className="w-56 font-mono text-[13px]"
        value={form.className}
        placeholder={t('ing:classPlaceholder')}
        onChange={e => setForm(f => ({ ...f, className: e.target.value }))}
      />
      <p className="text-[13px] text-caution">{t('ing:classLoadFailed')}</p>
    </div>
  ) : (
    <div className="flex items-center gap-2">
      <Select value={form.className || NONE} onValueChange={v => setForm(f => ({ ...f, className: v === NONE ? '' : v }))}>
        <SelectTrigger className="w-56">
          {classQuery.isPending ? <span className="text-muted-foreground">{t('ing:loading')}</span> : <SelectValue />}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('ing:classUnset')}</SelectItem>
          {classes.map(c => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <>
      <GatedButton allowed={allowed} variant="outline" onClick={openEditor}>
        <Globe />
        {isEdit ? t('ing:edit') : t('ing:create')}
      </GatedButton>

      <Dialog open={open} onOpenChange={v => !busy && setOpen(v)}>
        <DialogContent className="max-w-3xl sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {isEdit ? tf('ing:titleEdit', { name: name ?? form.name }) : t('ing:titleCreate')}
            </DialogTitle>
            <DialogDescription className="text-[13px]">
              {t('ing:desc')} · {tf('ing:namespaceLabel', { ns })}
            </DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[70vh] min-h-0 gap-3 overflow-y-auto md:grid-cols-[minmax(0,1fr)_288px]">
            <div className="space-y-3 text-[13px]">
              {!isEdit && (
                <label className="block space-y-1">
                  <span className="text-[13px] font-medium">{t('ing:name')}</span>
                  <Input
                    className="font-mono text-[13px]"
                    value={form.name}
                    placeholder={t('ing:namePlaceholder')}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  />
                </label>
              )}

              <section className="space-y-2">
                <span className="block text-[13px] font-medium">{t('ing:class')}</span>
                {classField}
              </section>

              <RuleSection
                rules={form.rules}
                onChange={rules => setForm(f => ({ ...f, rules }))}
                services={services}
                servicesFailed={servicesFailed}
              />
              {servicesFailed && <p className="text-[13px] text-caution">{t('ing:serviceLoadFailed')}</p>}

              <TlsSection tls={form.tls} hostCandidates={hostCandidates} onChange={tls => setForm(f => ({ ...f, tls }))} />

              <Collapsible className="space-y-2">
                <CollapsibleTrigger asChild>
                  <Button variant="outline">
                    <Plus />
                    {t('ing:defaultBackend')}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2 rounded-md border p-2">
                  <label className="flex items-center gap-1.5">
                    <Checkbox
                      checked={form.hasDefault}
                      onCheckedChange={v => setForm(f => ({ ...f, hasDefault: v === true }))}
                    />
                    {t('ing:defaultBackendEnable')}
                  </label>
                  {form.hasDefault && (
                    <>
                      <BackendFields
                        services={services}
                        servicesFailed={servicesFailed}
                        service={form.defService}
                        port={form.defPort}
                        onService={v => setForm(f => ({ ...f, defService: v }))}
                        onPort={v => setForm(f => ({ ...f, defPort: v }))}
                      />
                      <p className="text-[13px] text-muted-foreground">{t('ing:defaultBackendHint')}</p>
                    </>
                  )}
                </CollapsibleContent>
              </Collapsible>

              {form.rules.length === 0 && !form.hasDefault && <p className="text-[13px] text-muted-foreground">{t('ing:noRoutingHint')}</p>}
            </div>

            <div className="flex min-h-0 flex-col gap-2 md:sticky md:top-0">
              <span className="text-[13px] font-medium text-muted-foreground">{t('ing:preview')}</span>
              {warnings.length > 0 && (
                <p className="flex gap-1.5 rounded-md border border-caution/40 bg-caution/10 p-2 text-[13px] text-caution">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{tf('ing:lossyWarning', { fields: warnings.map(w => t(w)).join(', ') })}</span>
                </p>
              )}
              {errors.length > 0 && (
                <ul className="space-y-0.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[13px] text-destructive">
                  {errors.map(e => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
              <pre className="max-h-[46vh] overflow-auto rounded-md bg-muted p-2 font-mono text-[13px]">
                {yamlText}
              </pre>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t('res:cancel')}
            </Button>
            <GatedButton
              allowed={allowed}
              variant="default"
              busy={busy}
              onClick={() => (errors.length ? toast.error(errors[0]!) : setConfirm(true))}
            >
              {busy && <Loader2 className="animate-spin" />}
              {t('ing:save')}
            </GatedButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Ingress 直接决定线上流量入口，保存前强制二次确认 */}
      <AlertDialog open={confirm} onOpenChange={v => !busy && setConfirm(v)}>
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{t('ing:confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription className="text-[13px] leading-5">{t('ing:confirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('res:cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void save()}>
              {t('ing:confirmSave')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
