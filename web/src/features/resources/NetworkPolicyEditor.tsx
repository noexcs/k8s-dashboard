// NetworkPolicy 表单编辑器：把「podSelector / policyTypes / ingress|egress rules」这类
// 高频但手写 YAML 极易写错的结构做成表单 + 实时 YAML 预览。复杂字段（matchExpressions、
// endPort…）不支持编辑，打开时列成「有损告警」引导用户改走 YAML 页，避免保存时静默丢字段。
// 语义要点（NetworkPolicy 是白名单叠加，不是与现状取并集）：
//   - 空 selector = `{}`（匹配全部），与「不写该字段」在 API 上等价，预览里显式写出；
//   - 勾选了某方向但规则列表为空 = 该方向全拒 → 生成时写出 `xxxRules: []` 而非省略，
//     让「拒绝全部」这个意图在 YAML 里可见；未勾选的方向则完全不写该字段；
//   - 规则内 from/to 缺省 = 放行全部来源（与「一条规则都没有」相反），UI 单独提示。
// 保存：编辑先 GET 最新 resourceVersion 再 PUT（乐观锁，409 明确提示重开）；新建 POST collection。
// YAML 生成器自带（YamlTab 只导出 load/parse，没有 dump），输出 block 风格，可被 yaml 包往返。
import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, Plus, ShieldCheck, Wand2, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, get, postObject, putObject } from '@/api/client'
import type { K8sObject } from '@/api/types'
import { tf, useT } from '@/i18n'
import { itemPath, listPath } from '@/resources/registry'
import { GatedButton } from '@/components/GatedButton'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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

type PolicyType = 'Ingress' | 'Egress'
type Direction = 'from' | 'to'
type Protocol = 'TCP' | 'UDP'
/** 规则来源种类：全部 / 同 ns pod 标签 / 命名空间标签 / 跨 ns（ns+pod 标签）/ ipBlock */
type PeerKind = 'all' | 'pods' | 'namespaces' | 'nsPods' | 'ipBlock'

interface LabelRow {
  key: string
  value: string
}
interface PortRow {
  protocol: Protocol
  port: string
}
interface Peer {
  kind: PeerKind
  podLabels: LabelRow[]
  nsLabels: LabelRow[]
  cidr: string
  except: string[]
}
interface Rule {
  ports: PortRow[]
  peers: Peer[]
}
interface FormState {
  name: string
  /** podSelector 选「全部 Pod」：true 时忽略 podLabels */
  podAll: boolean
  podLabels: LabelRow[]
  policyTypes: PolicyType[]
  ingress: Rule[]
  egress: Rule[]
}

const POLICY_TYPES: PolicyType[] = ['Ingress', 'Egress']
const SOURCE_KINDS: PeerKind[] = ['all', 'pods', 'namespaces', 'nsPods', 'ipBlock']
/** 预设「放行来自 ingress-controller ns」：K8s 1.21+ 给每个 ns 自动注入 metadata.name 标签 */
const INGRESS_NS = 'ingress-nginx'
const NS_LABEL_KEY = 'kubernetes.io/metadata.name'
/** 表单能识别的字段，其余算「有损」并告警（Ingress 规则带 `to` / Egress 规则带 `from` 也是不认识的） */
const KNOWN_SPEC_KEYS = ['podSelector', 'policyTypes', 'ingressRules', 'egressRules']
const KNOWN_RULE_KEYS: Record<Direction, string[]> = { from: ['from', 'ports'], to: ['to', 'ports'] }
/** 对象名（DNS subdomain）与命名端口（宽松版 IANA_SVC_NAME） */
const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
const NP_DEF = { group: 'networking.k8s.io', version: 'v1', resource: 'networkpolicies', scope: 'namespaced' } as const

const emptyPeer = (kind: PeerKind): Peer => ({ kind, podLabels: [], nsLabels: [], cidr: '', except: [] })
const emptyRule = (peer?: PeerKind): Rule => ({ ports: [], peers: peer ? [emptyPeer(peer)] : [] })
/** 新建默认：选中全部 pod + 放行全部入站 —— 策略先「存在但不改变现状」，比默认全拒安全 */
const defaultForm = (): FormState => ({
  name: '',
  podAll: true,
  podLabels: [],
  policyTypes: ['Ingress'],
  ingress: [emptyRule('all')],
  egress: [],
})

// ---------- 最小 YAML 生成器 ----------

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** 需要引号的标量：空串/首尾空格/会被误解析的保留字与数字形态/YAML 起首控制符/含 `: ` 或 ` #` */
function needsQuote(s: string): boolean {
  if (s === '' || s !== s.trim()) return true
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true
  if (/^[-?:,[\]{}#&*!|>%@`]/.test(s)) return true
  if (/:\s|\s#/.test(s)) return true
  return /^[-+]?(\d[\d_]*\.?[\d_]*|\.\d+)([eE][-+]?\d+)?$/.test(s)
}
function scalar(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const s = String(v)
  if (!needsQuote(s)) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
/**
 * block 风格 dump：inline = 可跟在父 key 后的单行值（容器为空串），block = 需另起行的行（含缩进）。
 * 只需覆盖本文件生成的结构：字符串/数字键 map、数组、标量，缩进 2 空格。
 */
function dumpNode(v: unknown, indent: string): { inline: string; block: string[] } {
  const map = asRecord(v)
  if (map) {
    const keys = Object.keys(map)
    if (!keys.length) return { inline: '{}', block: [] }
    const block: string[] = []
    for (const k of keys) {
      const child = dumpNode(map[k], indent + '  ')
      // 键同样过 needsQuote（标签键可能是 `on` / `x: y` 这类会被误解析的形态）；
      // `k: v`（标量或空容器，冒号后必须有空格）vs `k:` 换行（非空容器）
      block.push(`${indent}${scalar(k)}:${child.inline ? ` ${child.inline}` : ''}`, ...child.block)
    }
    return { inline: '', block }
  }
  if (Array.isArray(v)) {
    if (!v.length) return { inline: '[]', block: [] }
    const block: string[] = []
    for (const it of v) {
      const child = dumpNode(it, indent + '  ')
      if (child.block.length === 0) block.push(`${indent}- ${child.inline}`)
      // 对象元素：首个 key 提到 `- ` 同行，其余行保持子缩进（kubectl 同款排版）
      else block.push(`${indent}- ${(child.block[0] ?? '').trimStart()}`, ...child.block.slice(1))
    }
    return { inline: '', block }
  }
  return { inline: scalar(v), block: [] }
}

// ---------- obj → 表单（回填） ----------

function labelsToRows(v: unknown): LabelRow[] {
  const m = asRecord(v)
  if (!m) return []
  return Object.entries(m)
    .filter(([, val]) => typeof val === 'string' || typeof val === 'number')
    .map(([key, val]) => ({ key, value: String(val) }))
}
/** 端口输入 → number 或命名端口字符串；非法返回 null（表单侧就地报错） */
function portValue(raw: string): number | string | null {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    return n >= 1 && n <= 65535 ? n : null
  }
  return NAME_RE.test(raw) ? raw : null
}
function portRowsFrom(v: unknown): PortRow[] {
  return asArray(v).map(it => {
    const rec = asRecord(it) ?? {}
    const port = typeof rec.port === 'number' ? String(rec.port) : typeof rec.port === 'string' ? rec.port : ''
    return { protocol: rec.protocol === 'UDP' ? 'UDP' : 'TCP', port }
  })
}
/** from/to 数组条目 = NetworkPolicyPeer 本身；无法表达的部分由 collectLossy 告警 */
function peerToForm(entry: unknown): Peer {
  const rec = asRecord(entry) ?? {}
  const ip = asRecord(rec.ipBlock)
  if (ip) {
    return {
      kind: 'ipBlock',
      podLabels: [],
      nsLabels: [],
      cidr: typeof ip.cidr === 'string' ? ip.cidr : '',
      except: asArray(ip.except).map(x => (typeof x === 'string' ? x : '')),
    }
  }
  const podSelector = asRecord(rec.podSelector)
  const nsSelector = asRecord(rec.namespaceSelector)
  // 空条目（`- {}`）与两个 selector 都缺省同义：放行全部来源
  if (!podSelector && !nsSelector) return emptyPeer('all')
  const podLabels = labelsToRows(podSelector?.matchLabels)
  const nsLabels = labelsToRows(nsSelector?.matchLabels)
  // 有 namespaceSelector 且带 pod 标签 = 跨 ns；只有 podSelector = 同 ns
  const kind: PeerKind = nsSelector ? (podLabels.length ? 'nsPods' : 'namespaces') : 'pods'
  return { kind, podLabels, nsLabels, cidr: '', except: [] }
}
function rulesFrom(v: unknown, dir: Direction): Rule[] {
  return asArray(v).map(it => ({
    ports: portRowsFrom(asRecord(it)?.ports),
    peers: asArray(asRecord(it)?.[dir]).map(peerToForm),
  }))
}
/** 解析既有对象 → 表单（不支持的字段交给 collectLossy 告警，不静默改写） */
function parseObj(obj: Record<string, unknown>): FormState {
  const metaName = asRecord(obj.metadata)?.name
  const spec = asRecord(obj.spec) ?? {}
  const selector = asRecord(spec.podSelector) ?? {}
  const declared = asArray(spec.policyTypes).filter((x): x is PolicyType => x === 'Ingress' || x === 'Egress')
  // policyTypes 在 API 里可省略（由 rules 是否存在推断）：省略时按规则回填勾选，否则保存会把规则丢掉
  const policyTypes = POLICY_TYPES.filter(
    pt => declared.includes(pt) || asArray(spec[`${pt.toLowerCase()}Rules`]).length > 0,
  )
  return {
    name: typeof metaName === 'string' ? metaName : '',
    podAll: Object.keys(selector).length === 0,
    podLabels: labelsToRows(selector.matchLabels),
    policyTypes,
    ingress: rulesFrom(spec.ingressRules, 'from'),
    egress: rulesFrom(spec.egressRules, 'to'),
  }
}
/** 列出表单不支持、保存会被覆盖丢失的字段（返回 i18n key，渲染时再翻译） */
function collectLossy(obj: Record<string, unknown>): string[] {
  const set = new Set<string>()
  const selector = (v: unknown) => {
    const s = asRecord(v)
    if (s && Object.keys(s).some(k => k !== 'matchLabels')) set.add('np:lossMatchExpressions')
  }
  const ports = (v: unknown) => {
    for (const it of asArray(v)) {
      const rec = asRecord(it)
      if (!rec || (typeof rec.port !== 'number' && typeof rec.port !== 'string')) set.add('np:lossPorts')
      else if (rec.endPort !== undefined) set.add('np:lossEndPort')
    }
  }
  const peers = (v: unknown) => {
    for (const it of asArray(v)) {
      const peer = asRecord(it)
      if (!peer) {
        set.add('np:lossUnknownPeer')
        continue
      }
      // ipBlock 与两个 selector 互斥；混用或出现别的关键字（或 selector 里非 matchLabels）表单都表达不了
      const keys = Object.keys(peer)
      const unsupported = peer.ipBlock ? keys.filter(k => k !== 'ipBlock') : keys.filter(k => k !== 'podSelector' && k !== 'namespaceSelector')
      if (unsupported.length) set.add('np:lossUnknownPeer')
      selector(peer.podSelector)
      selector(peer.namespaceSelector)
    }
  }
  const spec = asRecord(obj.spec) ?? {}
  if (Object.keys(spec).some(k => !KNOWN_SPEC_KEYS.includes(k))) set.add('np:lossUnknownRule')
  selector(spec.podSelector)
  for (const pt of POLICY_TYPES) {
    const dir: Direction = pt === 'Ingress' ? 'from' : 'to'
    for (const it of asArray(spec[`${pt.toLowerCase()}Rules`])) {
      const rec = asRecord(it)
      if (!rec) {
        set.add('np:lossUnknownRule')
        continue
      }
      if (Object.keys(rec).some(k => !KNOWN_RULE_KEYS[dir].includes(k))) set.add('np:lossUnknownRule')
      ports(rec.ports)
      peers(rec[dir])
    }
  }
  return [...set]
}

// ---------- 表单 → k8s 对象 ----------

/** 空标签行 → `{}`（matchLabels 缺省 = 匹配全部，与显式空 map 等价） */
function selectorOf(rows: LabelRow[]): Record<string, unknown> {
  const entries = rows.map(r => [r.key.trim(), r.value.trim()] as const).filter(([k]) => k !== '')
  return entries.length ? { matchLabels: Object.fromEntries(entries) } : {}
}
/** 端口行 → ports；留空的行跳过（= 全端口），非法值收进 invalid 供就地报错 */
function portsOf(rows: PortRow[]): { ports: Record<string, unknown>[]; invalid: string[] } {
  const ports: Record<string, unknown>[] = []
  const invalid: string[] = []
  for (const r of rows) {
    const raw = r.port.trim()
    if (!raw) continue
    const v = portValue(raw)
    if (v === null) invalid.push(raw)
    else ports.push({ port: v, protocol: r.protocol })
  }
  return { ports, invalid }
}
function peerOf(p: Peer): Record<string, unknown> | null {
  if (p.kind === 'ipBlock') {
    const cidr = p.cidr.trim()
    if (!cidr) return null // CIDR 没填的来源条目不生成（否则写出非法 ipBlock）
    const except = p.except.map(x => x.trim()).filter(Boolean)
    return { ipBlock: except.length ? { cidr, except } : { cidr } }
  }
  // NetworkPolicyPeer 就是数组条目本身，不再包一层 from/to
  if (p.kind === 'all') return {}
  if (p.kind === 'pods') return { podSelector: selectorOf(p.podLabels) }
  if (p.kind === 'namespaces') return { namespaceSelector: selectorOf(p.nsLabels) }
  return { namespaceSelector: selectorOf(p.nsLabels), podSelector: selectorOf(p.podLabels) }
}
/** 表单 → 请求体 + 校验问题（invalidPorts 为原始输入，调用方翻译） */
function buildBody(form: FormState, ns: string): { body: Record<string, unknown>; invalidPorts: string[] } {
  const spec: Record<string, unknown> = {}
  if (form.policyTypes.length) spec.policyTypes = [...form.policyTypes]
  spec.podSelector = form.podAll ? {} : selectorOf(form.podLabels)
  const invalidPorts: string[] = []
  for (const pt of POLICY_TYPES) {
    if (!form.policyTypes.includes(pt)) continue
    const dir: Direction = pt === 'Ingress' ? 'from' : 'to'
    spec[`${pt.toLowerCase()}Rules`] = (pt === 'Ingress' ? form.ingress : form.egress).map(r => {
      const rule: Record<string, unknown> = {}
      const { ports, invalid } = portsOf(r.ports)
      invalidPorts.push(...invalid)
      if (ports.length) rule.ports = ports
      const peers = r.peers
        .map(peerOf)
        .filter((p): p is Record<string, unknown> => p !== null)
      if (peers.length) rule[dir] = peers
      return rule
    })
  }
  return {
    body: {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: form.name.trim(), namespace: ns },
      spec,
    },
    invalidPorts,
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
      title={t('np:removeRow')}
      onClick={onClick}
      className={className ?? 'text-muted-foreground hover:text-destructive'}
    >
      <X />
    </Button>
  )
}

function LabelsEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  rows: LabelRow[]
  onChange: (next: LabelRow[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
}) {
  const t = useT()
  const set = (i: number, patch: Partial<LabelRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input
            className="min-w-0 flex-1 font-mono text-[13px]"
            value={r.key}
            placeholder={keyPlaceholder}
            onChange={e => set(i, { key: e.target.value })}
          />
          <span className="text-muted-foreground">=</span>
          <Input
            className="min-w-0 flex-1 font-mono text-[13px]"
            value={r.value}
            placeholder={valuePlaceholder}
            onChange={e => set(i, { value: e.target.value })}
          />
          <RemoveButton onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <RowButton label={t('np:addLabel')} onClick={() => onChange([...rows, { key: '', value: '' }])} />
    </div>
  )
}

const PEER_LABEL: Record<PeerKind, string> = {
  all: 'np:peerAll',
  pods: 'np:peerPods',
  namespaces: 'np:peerNamespaces',
  nsPods: 'np:peerNsPods',
  ipBlock: 'np:peerIpBlock',
}
const PEER_ADD_LABEL: Record<PeerKind, string> = {
  all: 'np:srcAll',
  pods: 'np:srcPods',
  namespaces: 'np:srcNamespaces',
  nsPods: 'np:srcNsPods',
  ipBlock: 'np:srcIpBlock',
}

function PeersEditor({
  title,
  emptyHint,
  peers,
  onChange,
}: {
  title: string
  emptyHint: string
  peers: Peer[]
  onChange: (next: Peer[]) => void
}) {
  const t = useT()
  const set = (i: number, patch: Partial<Peer>) => onChange(peers.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[13px] text-muted-foreground">{title}</span>
        {SOURCE_KINDS.map(k => (
          <RowButton key={k} label={t(PEER_ADD_LABEL[k])} onClick={() => onChange([...peers, emptyPeer(k)])} />
        ))}
      </div>
      {peers.length === 0 && <p className="text-[13px] text-muted-foreground">{emptyHint}</p>}
      {peers.map((p, i) => (
        <div key={i} className="space-y-1 rounded-md border border-dashed bg-muted/20 p-2">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium">{t(PEER_LABEL[p.kind])}</span>
            <RemoveButton className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => onChange(peers.filter((_, j) => j !== i))} />
          </div>
          {p.kind === 'all' && <p className="text-[13px] text-muted-foreground">{t('np:peerAllDesc')}</p>}
          {(p.kind === 'pods' || p.kind === 'nsPods') && (
            <LabelsEditor
              rows={p.podLabels}
              onChange={podLabels => set(i, { podLabels })}
              keyPlaceholder={t('np:labelKey')}
              valuePlaceholder={t('np:labelValue')}
            />
          )}
          {(p.kind === 'namespaces' || p.kind === 'nsPods') && (
            <LabelsEditor
              rows={p.nsLabels}
              onChange={nsLabels => set(i, { nsLabels })}
              keyPlaceholder={t('np:nsLabelKey')}
              valuePlaceholder={t('np:labelValue')}
            />
          )}
          {p.kind === 'ipBlock' && (
            <div className="space-y-1">
              <div className="flex items-center gap-1">
                <span className="shrink-0 text-[13px] text-muted-foreground">{t('np:cidr')}</span>
                <Input
                  className="min-w-0 flex-1 font-mono text-[13px]"
                  value={p.cidr}
                  placeholder={t('np:cidrPlaceholder')}
                  onChange={e => set(i, { cidr: e.target.value })}
                />
              </div>
              {p.except.map((x, j) => (
                <div key={j} className="flex items-center gap-1">
                  {j === 0 && <span className="shrink-0 text-[13px] text-muted-foreground">{t('np:except')}</span>}
                  <Input
                    className="min-w-0 flex-1 font-mono text-[13px]"
                    value={x}
                    placeholder={t('np:exceptPlaceholder')}
                    onChange={e => set(i, { except: p.except.map((v, m) => (m === j ? e.target.value : v)) })}
                  />
                  <RemoveButton onClick={() => set(i, { except: p.except.filter((_, m) => m !== j) })} />
                </div>
              ))}
              <RowButton label={t('np:addExcept')} onClick={() => set(i, { except: [...p.except, ''] })} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function PortsEditor({ rows, onChange }: { rows: PortRow[]; onChange: (next: PortRow[]) => void }) {
  const t = useT()
  const set = (i: number, patch: Partial<PortRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[13px] text-muted-foreground">{t('np:ports')}</span>
        <RowButton label={t('np:addPort')} onClick={() => onChange([...rows, { protocol: 'TCP', port: '' }])} />
        <span className="ml-1 text-[13px] text-muted-foreground">{t('np:portAllHint')}</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1">
          <Select value={r.protocol} onValueChange={v => set(i, { protocol: v as Protocol })}>
            <SelectTrigger className="w-[72px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="TCP">TCP</SelectItem>
              <SelectItem value="UDP">UDP</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="w-40 font-mono text-[13px] tabular-nums"
            value={r.port}
            placeholder={t('np:portPlaceholder')}
            onChange={e => set(i, { port: e.target.value })}
          />
          <RemoveButton onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
    </div>
  )
}

function RuleSection({
  title,
  denyHint,
  peerTitle,
  peerEmptyHint,
  rules,
  onChange,
}: {
  title: string
  /** 无规则 = 该方向全拒的红色提示 */
  denyHint: string
  peerTitle: string
  peerEmptyHint: string
  rules: Rule[]
  onChange: (next: Rule[]) => void
}) {
  const t = useT()
  const set = (i: number, patch: Partial<Rule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium">{title}</span>
        <RowButton label={t('np:addRule')} onClick={() => onChange([...rules, emptyRule()])} />
      </div>
      {rules.length === 0 && <p className="text-[13px] text-destructive">{denyHint}</p>}
      {rules.map((r, i) => (
        <div key={i} className="space-y-2 rounded-md border p-2">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-muted-foreground">{tf('np:ruleN', { n: i + 1 })}</span>
            <Button
              variant="ghost"
              className="ml-auto text-muted-foreground hover:text-destructive"
              onClick={() => onChange(rules.filter((_, j) => j !== i))}
            >
              {t('np:deleteRule')}
            </Button>
          </div>
          <PortsEditor rows={r.ports} onChange={ports => set(i, { ports })} />
          <PeersEditor
            title={peerTitle}
            emptyHint={peerEmptyHint}
            peers={r.peers}
            onChange={peers => set(i, { peers })}
          />
        </div>
      ))}
    </section>
  )
}

// ---------- 主组件 ----------

export function NetworkPolicyEditor({
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
  /** 既有 NetworkPolicy 裸对象；缺省 = 新建模式 */
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

  const { body, invalidPorts } = useMemo(() => buildBody(form, ns), [form, ns])
  const yamlText = useMemo(() => {
    const { inline, block } = dumpNode(body, '')
    return [...(inline ? [inline] : []), ...block].join('\n') + '\n'
  }, [body])
  const warnings = useMemo(() => (obj ? collectLossy(obj) : []), [obj])

  const errors = [
    ...(!NAME_RE.test(form.name.trim()) || form.name.trim().length > 253 ? [t('np:invalidName')] : []),
    ...invalidPorts.map(v => tf('np:invalidPort', { value: v })),
  ]
  const path = itemPath(NP_DEF, ns, form.name.trim() || '-')

  // 预设都只改 podSelector + policyTypes + ingress，命名空间/名称留给用户
  const presets: { label: string; apply: (f: FormState) => FormState }[] = [
    { label: t('np:presetDeny'), apply: f => ({ ...f, podAll: true, podLabels: [], policyTypes: ['Ingress'], ingress: [], egress: [] }) },
    // 「放行同 ns」用 pods 种类 + 零标签行 → `{ podSelector: {} }`（本 ns 全部 pod）；
    // 注意不能用 all（`from: [{}]` 语义是全集群任意来源）
    { label: t('np:presetSameNs'), apply: f => ({ ...f, podAll: true, podLabels: [], policyTypes: ['Ingress'], ingress: [emptyRule('pods')], egress: [] }) },
    {
      label: t('np:presetIngressNs'),
      apply: f => ({
        ...f,
        podAll: true,
        podLabels: [],
        policyTypes: ['Ingress'],
        ingress: [
          { ports: [], peers: [{ ...emptyPeer('namespaces'), nsLabels: [{ key: NS_LABEL_KEY, value: INGRESS_NS }] }] },
        ],
        egress: [],
      }),
    },
  ]

  const save = async () => {
    setBusy(true)
    try {
      if (isEdit) {
        // 表单不带 resourceVersion：保存前取服务端最新值，避免覆盖他人刚做的改动；
        // PUT 是整体替换，labels/annotations 表单不管 → 从服务端现值带过去，不静默丢
        const cur = await get<K8sObject>(cluster, path)
        const { labels, annotations } = cur.metadata
        await putObject(cluster, path, {
          ...body,
          metadata: {
            ...(labels ? { labels } : {}),
            ...(annotations ? { annotations } : {}),
            name: cur.metadata.name,
            namespace: ns,
            resourceVersion: cur.metadata.resourceVersion,
          },
        } as unknown as K8sObject, 'NetworkPolicy 表单保存')
        toast.success(tf('np:savedUpdate', { name: cur.metadata.name }))
      } else {
        await postObject(cluster, listPath(NP_DEF, ns), body as unknown as K8sObject, 'NetworkPolicy 表单创建')
        toast.success(tf('np:savedCreate', { name: form.name.trim() }))
      }
      queryClient.invalidateQueries({ queryKey: ['yaml', cluster, path] })
      setConfirm(false)
      setOpen(false)
      onSaved?.()
    } catch (e) {
      const detail = e instanceof ApiError && e.isConflict ? t('np:conflict') : e instanceof Error ? e.message : String(e)
      toast.error(tf('np:saveFailed', { error: detail }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <GatedButton allowed={allowed} variant="outline" onClick={openEditor}>
        <ShieldCheck />
        {isEdit ? t('np:edit') : t('np:create')}
      </GatedButton>

      <Dialog open={open} onOpenChange={v => !busy && setOpen(v)}>
        <DialogContent className="max-w-3xl sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {isEdit ? tf('np:titleEdit', { name: name ?? form.name }) : t('np:titleCreate')}
            </DialogTitle>
            <DialogDescription className="text-[13px]">
              {t('np:desc')} · {tf('np:namespaceLabel', { ns })}
            </DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[70vh] min-h-0 gap-3 overflow-y-auto md:grid-cols-[minmax(0,1fr)_288px]">
            <div className="space-y-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-1">
                <span className="mr-1 text-[13px] text-muted-foreground">{t('np:presets')}</span>
                {presets.map(p => (
                  <Button
                    key={p.label}
                    variant="outline"
                    onClick={() => {
                      setForm(f => p.apply(f))
                      toast.info(tf('np:presetApplied', { name: p.label }))
                    }}
                  >
                    <Wand2 />
                    {p.label}
                  </Button>
                ))}
              </div>

              {!isEdit && (
                <label className="block space-y-1">
                  <span className="text-[13px] font-medium">{t('np:name')}</span>
                  <Input
                    className="font-mono text-[13px]"
                    value={form.name}
                    placeholder={t('np:namePlaceholder')}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  />
                </label>
              )}

              <section className="space-y-2">
                <span className="block text-[13px] font-medium">{t('np:podSelector')}</span>
                <div className="flex items-center gap-1">
                  {[
                    { all: true, label: t('np:selAll') },
                    { all: false, label: t('np:selLabels') },
                  ].map(o => (
                    <Button
                      key={o.label}
                      variant={form.podAll === o.all ? 'secondary' : 'outline'}
                      onClick={() => setForm(f => ({ ...f, podAll: o.all }))}
                    >
                      {o.label}
                    </Button>
                  ))}
                </div>
                {!form.podAll && (
                  <>
                    <LabelsEditor
                      rows={form.podLabels}
                      onChange={podLabels => setForm(f => ({ ...f, podLabels }))}
                      keyPlaceholder={t('np:labelKey')}
                      valuePlaceholder={t('np:labelValue')}
                    />
                    <p className="text-[13px] text-muted-foreground">{t('np:labelsHint')}</p>
                  </>
                )}
              </section>

              <section className="space-y-2">
                <span className="block text-[13px] font-medium">{t('np:policyTypes')}</span>
                <div className="flex items-center gap-4">
                  {POLICY_TYPES.map(pt => (
                    <label key={pt} className="flex items-center gap-1.5">
                      <Checkbox
                        checked={form.policyTypes.includes(pt)}
                        onCheckedChange={v =>
                          setForm(f => ({
                            ...f,
                            policyTypes: v === true ? [...f.policyTypes, pt] : f.policyTypes.filter(x => x !== pt),
                          }))
                        }
                      />
                      {pt}
                    </label>
                  ))}
                </div>
                <p className="text-[13px] text-muted-foreground">{t('np:typesHint')}</p>
              </section>

              {form.policyTypes.includes('Ingress') && (
                <RuleSection
                  title={t('np:ingressRules')}
                  denyHint={tf('np:rulesEmptyDeny', { dir: t('np:dirIngress') })}
                  peerTitle={t('np:sourcesFrom')}
                  peerEmptyHint={t('np:noSourceHint')}
                  rules={form.ingress}
                  onChange={ingress => setForm(f => ({ ...f, ingress }))}
                />
              )}
              {form.policyTypes.includes('Egress') && (
                <RuleSection
                  title={t('np:egressRules')}
                  denyHint={tf('np:rulesEmptyDeny', { dir: t('np:dirEgress') })}
                  peerTitle={t('np:sourcesTo')}
                  peerEmptyHint={t('np:noSourceHint')}
                  rules={form.egress}
                  onChange={egress => setForm(f => ({ ...f, egress }))}
                />
              )}
            </div>

            <div className="flex min-h-0 flex-col gap-2 md:sticky md:top-0">
              <span className="text-[13px] font-medium text-muted-foreground">{t('np:preview')}</span>
              {warnings.length > 0 && (
                <p className="flex gap-1.5 rounded-md border border-caution/40 bg-caution/10 p-2 text-[13px] text-caution">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{tf('np:lossyWarning', { fields: warnings.map(w => t(w)).join(', ') })}</span>
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
              {t('np:save')}
            </GatedButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 白名单叠加语义最容易锁死集群，保存前强制二次确认 */}
      <AlertDialog open={confirm} onOpenChange={v => !busy && setConfirm(v)}>
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{t('np:confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription className="text-[13px] leading-5">{t('np:confirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('res:cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void save()}>
              {t('np:confirmSave')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
