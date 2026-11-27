// HorizontalPodAutoscaler 表单编辑器：把「scaleTargetRef / min|maxReplicas / Resource 指标 /
// 常用 behavior」这类高频但手写 YAML 易错的配置做成表单 + 实时 YAML 预览（形态对齐 NetworkPolicyEditor）。
// 语义要点：
//   - 目标工作负载下拉列同 ns 的 Deployment/StatefulSet；列表加载失败（RBAC 缺 list 权限很常见）
//     或编辑回填的目标名不在列表里时，退化为手输，不阻塞保存；
//   - minReplicas 可缺省（留空 = 不写该字段，服务端按 1 处理）；maxReplicas 必填 ≥1；min>max 拒绝提交；
//   - 指标只支持 Resource 类型；Utilization（百分比）与 AverageValue（Quantity）二选一；
//   - behavior 只生成 stabilizationWindowSeconds：填了才写，编辑时 behavior 的其他子字段
//     （policies、selectPolicy…）原样保留，只 patch 表单负责的部分；
//   - 有损信号（apiVersion≠autoscaling/v2、Object/Pods/External 指标、未知 behavior 子字段、
//     非 Deployment/StatefulSet 目标）→ 琥珀告警引导核对 YAML，但不拒存：旧版 apiVersion 原样提交
//     （连路径版本一起沿用，不强升到 v2，避免把 v1 对象改写成 v2 存储版本）。
// 保存：编辑先 GET 最新 resourceVersion 再 PUT（乐观锁，409 明确提示重开）；新建 POST collection。
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { stringify } from 'yaml'
import { AlertTriangle, Gauge, Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, get, list, postObject, putObject } from '@/api/client'
import type { K8sObject } from '@/api/types'
import { tf, useT } from '@/i18n'
import { itemPath, listPath } from '@/resources/registry'
import { GatedButton } from '@/components/GatedButton'
import { Button } from '@/components/ui/button'
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

type TargetType = 'Utilization' | 'AverageValue'
interface MetricRow {
  /** cpu/memory 之外的名字视为自定义指标（有损信号，但仍可原样往返） */
  name: string
  targetType: TargetType
  utilization: string
  averageValue: string
}
interface FormState {
  name: string
  /** 编辑时可能回填出 Deployment/StatefulSet 之外的 kind（字符串承载，下拉里额外显示） */
  targetKind: string
  /** 非预置 kind 的 apiVersion 回填值：保存原样带回去，防止跨组目标（如 DeploymentConfig）被改坏 */
  targetApiVersion: string
  targetName: string
  minReplicas: string
  maxReplicas: string
  metrics: MetricRow[]
  downWindow: string
  upWindow: string
}

const TARGET_KINDS = ['Deployment', 'StatefulSet']
/** 常见指标名；下拉里之外的都走自定义输入（requests.cpu 等也合法） */
const METRIC_NAMES = ['cpu', 'memory']
const CUSTOM = '__custom__'
/** spec.behavior 里本表单生成的部分之外都算「其他子字段」：编辑时原样保留 */
const KNOWN_SPEC_KEYS = ['scaleTargetRef', 'minReplicas', 'maxReplicas', 'metrics', 'behavior']
const KNOWN_BEHAVIOR_KEYS = ['scaleDown', 'scaleUp']
const KNOWN_WINDOW_KEYS = ['stabilizationWindowSeconds']
/** 对象名（DNS subdomain，与 NetPol 同款宽松校验） */
const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
const HPA_DEF = { group: 'autoscaling', version: 'v2', resource: 'horizontalpodautoscalers', scope: 'namespaced' } as const
const WL_DEF = {
  Deployment: { group: 'apps', version: 'v1', resource: 'deployments', scope: 'namespaced' },
  StatefulSet: { group: 'apps', version: 'v1', resource: 'statefulsets', scope: 'namespaced' },
} as const

const emptyMetric = (): MetricRow => ({ name: 'cpu', targetType: 'Utilization', utilization: '80', averageValue: '' })
/** 新建默认：cpu Utilization 80%、区间 1~10 —— 开箱即用一个最常见的 HPA */
const defaultForm = (): FormState => ({
  name: '',
  targetKind: 'Deployment',
  targetApiVersion: 'apps/v1',
  targetName: '',
  minReplicas: '1',
  maxReplicas: '10',
  metrics: [emptyMetric()],
  downWindow: '',
  upWindow: '',
})

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const numStr = (v: unknown): string => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '')
/** 整数输入：空串 = null(缺省)，非纯数字 = undefined(非法) —— 调用方据此区分「没填」和「填错」 */
const intOf = (raw: string): number | null | undefined => {
  const s = raw.trim()
  if (s === '') return null
  return /^\d+$/.test(s) ? Number(s) : undefined
}
/** 编辑 v1 等旧对象时路径版本跟着 apiVersion 走，避免 PUT 到 v2 端点被服务端转存成新版本 */
const hpaPath = (ns: string, name: string, apiVersion?: string) => {
  const version = apiVersion?.startsWith('autoscaling/') ? (apiVersion.split('/')[1] ?? 'v2') : 'v2'
  return itemPath({ ...HPA_DEF, version }, ns, name)
}

// ---------- obj → 表单（回填） ----------

/** 解析既有对象 → 表单（不支持的字段交给 collectLossy 告警，不静默改写） */
function parseObj(obj: Record<string, unknown>): FormState {
  const metaName = asRecord(obj.metadata)?.name
  const spec = asRecord(obj.spec) ?? {}
  const ref = asRecord(spec.scaleTargetRef) ?? {}
  const behavior = asRecord(spec.behavior)
  const metrics: MetricRow[] = []
  for (const it of asArray(spec.metrics)) {
    const rec = asRecord(it)
    if (!rec || rec.type !== 'Resource') continue // 非 Resource 指标表单表达不了，由告警提示会被移除
    const res = asRecord(rec.resource)
    if (!res) continue
    const target = asRecord(res.target)
    const isAvg = target?.type === 'AverageValue'
    metrics.push({
      name: typeof res.name === 'string' ? res.name : '',
      targetType: isAvg ? 'AverageValue' : 'Utilization',
      utilization: isAvg ? '' : numStr(target?.averageUtilization),
      averageValue: isAvg ? numStr(target?.averageValue) : '',
    })
  }
  return {
    name: typeof metaName === 'string' ? metaName : '',
    // 未知 kind 原样回填（下拉里追加显示），保存不会把 DaemonSet 悄悄改成 Deployment
    targetKind: typeof ref.kind === 'string' && ref.kind !== '' ? ref.kind : 'Deployment',
    targetApiVersion: typeof ref.apiVersion === 'string' && ref.apiVersion !== '' ? ref.apiVersion : 'apps/v1',
    targetName: typeof ref.name === 'string' ? ref.name : '',
    minReplicas: numStr(spec.minReplicas),
    maxReplicas: numStr(spec.maxReplicas),
    metrics,
    downWindow: numStr(asRecord(behavior?.scaleDown)?.stabilizationWindowSeconds),
    upWindow: numStr(asRecord(behavior?.scaleUp)?.stabilizationWindowSeconds),
  }
}

interface Warning {
  key: string
  vars?: Record<string, string | number>
}
/** 列出表单不支持/保存语义有变化的字段（返回 i18n key + 插值，渲染时再翻译） */
function collectLossy(obj: Record<string, unknown>): Warning[] {
  const out: Warning[] = []
  const apiVersion = typeof obj.apiVersion === 'string' ? obj.apiVersion : ''
  if (apiVersion !== 'autoscaling/v2') out.push({ key: 'hpa:lossApiVersion', vars: { apiVersion } })
  const spec = asRecord(obj.spec) ?? {}
  if (Object.keys(spec).some(k => !KNOWN_SPEC_KEYS.includes(k))) out.push({ key: 'hpa:lossUnknownSpec' })
  const ref = asRecord(spec.scaleTargetRef)
  if (ref?.kind && !TARGET_KINDS.includes(String(ref.kind))) out.push({ key: 'hpa:lossTargetKind', vars: { kind: String(ref.kind) } })
  let hasNonResource = false
  let hasCustomName = false
  for (const it of asArray(spec.metrics)) {
    const rec = asRecord(it)
    if (!rec || rec.type !== 'Resource') hasNonResource = true
    else if (rec.resource && !METRIC_NAMES.includes(String(asRecord(rec.resource)?.name))) hasCustomName = true
  }
  if (hasNonResource) out.push({ key: 'hpa:lossMetricType' })
  if (hasCustomName) out.push({ key: 'hpa:lossCustomMetric' })
  const behavior = asRecord(spec.behavior)
  if (behavior) {
    const hasExtra =
      Object.keys(behavior).some(k => !KNOWN_BEHAVIOR_KEYS.includes(k)) ||
      KNOWN_BEHAVIOR_KEYS.some(k => {
        const side = asRecord(behavior[k])
        return side !== null && Object.keys(side).some(x => !KNOWN_WINDOW_KEYS.includes(x))
      })
    // 表单只 patch stabilizationWindowSeconds，其他子字段原样保留 —— 提示但不算丢数据
    if (hasExtra) out.push({ key: 'hpa:lossBehavior' })
  }
  return out
}

// ---------- 表单 → k8s 对象 ----------

/**
 * behavior：填了才写；编辑时以对象现值为底（含 policies 等子字段），只覆盖对应方向的
 * stabilizationWindowSeconds —— 空输入完全不碰，避免把别人配置的 behavior 子字段抹掉。
 */
function behaviorOf(form: FormState, base: Record<string, unknown> | null): Record<string, unknown> | undefined {
  const down = intOf(form.downWindow)
  const up = intOf(form.upWindow)
  if (down === null && up === null) return base ?? undefined
  const behavior: Record<string, unknown> = { ...base }
  if (down !== null) behavior.scaleDown = { ...(asRecord(base?.scaleDown) ?? {}), stabilizationWindowSeconds: down }
  if (up !== null) behavior.scaleUp = { ...(asRecord(base?.scaleUp) ?? {}), stabilizationWindowSeconds: up }
  return Object.keys(behavior).length ? behavior : undefined
}

/** 表单 → 请求体 + 校验问题（返回 i18n key，调用方翻译）；非法字段不进 body（错误会挡住保存） */
function buildBody(
  form: FormState,
  ns: string,
  keep: { apiVersion: string; baseBehavior: Record<string, unknown> | null },
): { body: Record<string, unknown>; issues: string[] } {
  const issues: string[] = []
  const spec: Record<string, unknown> = {}
  const targetName = form.targetName.trim()
  if (!targetName) issues.push('hpa:errTargetName')
  // 预置 kind 归一到 apps/v1（用户改了 kind 就该换组）；其余 kind 用回填的 apiVersion 原样提交
  const targetApiVersion = TARGET_KINDS.includes(form.targetKind) ? 'apps/v1' : form.targetApiVersion || 'apps/v1'
  spec.scaleTargetRef = { apiVersion: targetApiVersion, kind: form.targetKind, name: targetName }

  const min = intOf(form.minReplicas)
  const max = intOf(form.maxReplicas)
  if (min === undefined) issues.push('hpa:errMinInvalid')
  else if (min !== null) spec.minReplicas = min
  if (max === undefined || max === null) issues.push(max === null ? 'hpa:errMaxRequired' : 'hpa:errMaxInvalid')
  else if (max >= 1) spec.maxReplicas = max
  else issues.push('hpa:errMaxInvalid')
  // 两端都合法才比较，否则错误信息重复
  if (typeof min === 'number' && typeof max === 'number' && max >= 1 && min > max) issues.push('hpa:errMinGtMax')

  const metrics: Record<string, unknown>[] = []
  for (const m of form.metrics) {
    const name = m.name.trim()
    if (name === '' || /\s/.test(name)) {
      issues.push('hpa:errMetricName')
      continue
    }
    if (m.targetType === 'Utilization') {
      const pct = intOf(m.utilization)
      if (pct === undefined || pct === null || pct < 1) issues.push('hpa:errUtilization')
      else metrics.push({ type: 'Resource', resource: { name, target: { type: 'Utilization', averageUtilization: pct } } })
    } else {
      const qty = m.averageValue.trim()
      if (!qty) issues.push('hpa:errAverageValue')
      else metrics.push({ type: 'Resource', resource: { name, target: { type: 'AverageValue', averageValue: qty } } })
    }
  }
  if (metrics.length) spec.metrics = metrics

  const down = intOf(form.downWindow)
  const up = intOf(form.upWindow)
  if (down === undefined) issues.push('hpa:errWindow')
  if (up === undefined) issues.push('hpa:errWindow')
  const behavior = behaviorOf(form, keep.baseBehavior)
  if (behavior) spec.behavior = behavior

  return {
    body: {
      apiVersion: keep.apiVersion,
      kind: 'HorizontalPodAutoscaler',
      metadata: { name: form.name.trim(), namespace: ns },
      spec,
    },
    issues,
  }
}

// ---------- 子组件 ----------

function RemoveButton({ onClick }: { onClick: () => void }) {
  const t = useT()
  return (
    <Button size="icon" variant="ghost" title={t('hpa:removeRow')} onClick={onClick} className="text-muted-foreground hover:text-destructive">
      <X />
    </Button>
  )
}

function MetricRowEditor({ row, onChange, onRemove }: { row: MetricRow; onChange: (next: MetricRow) => void; onRemove: () => void }) {
  const t = useT()
  const set = (patch: Partial<MetricRow>) => onChange({ ...row, ...patch })
  const custom = !METRIC_NAMES.includes(row.name)
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="shrink-0 text-[13px] text-muted-foreground">Resource</span>
      <Select
        value={custom ? CUSTOM : row.name}
        onValueChange={v => set({ name: v === CUSTOM ? '' : v })}
      >
        <SelectTrigger className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {METRIC_NAMES.map(n => (
            <SelectItem key={n} value={n}>
              {n}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>{t('hpa:metricCustom')}</SelectItem>
        </SelectContent>
      </Select>
      {custom && (
        <Input
          className="w-36 min-w-0 font-mono text-[13px]"
          value={row.name}
          placeholder={t('hpa:metricNamePlaceholder')}
          onChange={e => set({ name: e.target.value })}
        />
      )}
      <Select value={row.targetType} onValueChange={v => set({ targetType: v as TargetType })}>
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="Utilization">{t('hpa:targetUtilization')}</SelectItem>
          <SelectItem value="AverageValue">{t('hpa:targetAverageValue')}</SelectItem>
        </SelectContent>
      </Select>
      <Input
        className="w-36 min-w-0 flex-1 font-mono text-[13px] tabular-nums"
        value={row.targetType === 'Utilization' ? row.utilization : row.averageValue}
        placeholder={row.targetType === 'Utilization' ? t('hpa:utilizationPlaceholder') : t('hpa:averageValuePlaceholder')}
        onChange={e => set(row.targetType === 'Utilization' ? { utilization: e.target.value } : { averageValue: e.target.value })}
      />
      <RemoveButton onClick={onRemove} />
    </div>
  )
}

// ---------- 主组件 ----------

export function HpaEditor({
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
  /** 既有 HPA 裸对象；缺省 = 新建模式 */
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

  // 目标工作负载下拉数据：只列当前 kind、同 ns；对话框打开才请求，
  // 非预置 kind（编辑回填的旧目标）没有对应列表端点，直接不发请求、走手输
  const wlDef: (typeof WL_DEF)[keyof typeof WL_DEF] | undefined = WL_DEF[form.targetKind as keyof typeof WL_DEF]
  const targets = useQuery({
    queryKey: ['hpa-workloads', cluster, ns, form.targetKind],
    queryFn: () => list<K8sObject>(cluster, listPath(wlDef ?? WL_DEF.Deployment, ns)),
    enabled: open && wlDef !== undefined,
    staleTime: 30_000,
  })
  const targetNames = useMemo(() => (targets.data?.items ?? []).map(x => x.metadata?.name ?? ''), [targets.data])
  // 手输模式 = 非预置 kind（没得列）/ 列表加载失败（RBAC 常见）/ 回填的目标不在列表里（目标已删或列表未就绪）。
  // 最后一种必须允许保留原名，否则 Select 显示不出既有值、一保存就改错目标；清空名称后回到下拉模式
  const manualTarget =
    wlDef === undefined || !!targets.error || (form.targetName !== '' && !targetNames.includes(form.targetName))

  // 旧版 apiVersion 原样保留（含路径版本），新建固定 v2
  const apiVersion = typeof obj?.apiVersion === 'string' ? obj.apiVersion : 'autoscaling/v2'
  const editBehavior = useMemo(() => (obj ? asRecord(asRecord(obj.spec)?.behavior) : null), [obj])
  const { body, issues } = useMemo(
    () => buildBody(form, ns, { apiVersion, baseBehavior: editBehavior }),
    [form, ns, apiVersion, editBehavior],
  )
  const yamlText = useMemo(() => stringify(body), [body])
  const warnings = useMemo(() => (obj ? collectLossy(obj) : []), [obj])

  const errors = [
    ...(!isEdit && (!NAME_RE.test(form.name.trim()) || form.name.trim().length > 253) ? [t('hpa:invalidName')] : []),
    ...[...new Set(issues)].map(k => t(k)),
  ]
  const path = hpaPath(ns, form.name.trim() || (name ?? '-'), apiVersion)

  // kind 下拉选项 = 预置两类 ∪ 编辑回填出的其他 kind（保证旧对象目标类型不被静默改写）
  const kindOptions = TARGET_KINDS.includes(form.targetKind) ? TARGET_KINDS : [form.targetKind, ...TARGET_KINDS]

  const save = async () => {
    setBusy(true)
    try {
      if (isEdit) {
        // 表单不带 resourceVersion：保存前取服务端最新值，避免覆盖他人刚做的改动；
        // PUT 是整体替换，labels/annotations 表单不管 → 从服务端现值带过去，不静默丢；
        // behavior 以现值打底（只 patch stabilizationWindowSeconds），apiVersion 沿用现值（不强升 v2）
        const cur = await get<K8sObject>(cluster, path)
        const raw = cur as unknown as Record<string, unknown>
        const curApi = typeof raw.apiVersion === 'string' ? raw.apiVersion : apiVersion
        const built = buildBody(form, ns, {
          apiVersion: curApi,
          baseBehavior: asRecord(asRecord(raw.spec)?.behavior) ?? editBehavior,
        })
        const savePath = hpaPath(ns, cur.metadata.name, curApi)
        const { labels, annotations } = cur.metadata
        await putObject(cluster, savePath, {
          ...built.body,
          metadata: {
            ...(labels ? { labels } : {}),
            ...(annotations ? { annotations } : {}),
            name: cur.metadata.name,
            namespace: ns,
            resourceVersion: cur.metadata.resourceVersion,
          },
        } as unknown as K8sObject, 'HPA 表单保存（min/max 或阈值）')
        queryClient.invalidateQueries({ queryKey: ['yaml', cluster, savePath] })
        toast.success(tf('hpa:savedUpdate', { name: cur.metadata.name }))
      } else {
        await postObject(cluster, listPath(HPA_DEF, ns), body as unknown as K8sObject, 'HPA 表单创建')
        queryClient.invalidateQueries({ queryKey: ['yaml', cluster, path] })
        toast.success(tf('hpa:savedCreate', { name: form.name.trim() }))
      }
      setConfirm(false)
      setOpen(false)
      onSaved?.()
    } catch (e) {
      const detail = e instanceof ApiError && e.isConflict ? t('hpa:conflict') : e instanceof Error ? e.message : String(e)
      toast.error(tf('hpa:saveFailed', { error: detail }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <GatedButton allowed={allowed} variant="outline" onClick={openEditor}>
        <Gauge />
        {isEdit ? t('hpa:edit') : t('hpa:create')}
      </GatedButton>

      <Dialog open={open} onOpenChange={v => !busy && setOpen(v)}>
        <DialogContent className="max-w-3xl sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {isEdit ? tf('hpa:titleEdit', { name: name ?? form.name }) : t('hpa:titleCreate')}
            </DialogTitle>
            <DialogDescription className="text-[13px]">
              {t('hpa:desc')} · {tf('hpa:namespaceLabel', { ns })}
            </DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[70vh] min-h-0 gap-3 overflow-y-auto md:grid-cols-[minmax(0,1fr)_288px]">
            <div className="space-y-3 text-[13px]">
              {!isEdit && (
                <label className="block space-y-1">
                  <span className="text-[13px] font-medium">{t('hpa:name')}</span>
                  <Input
                    className="font-mono text-[13px]"
                    value={form.name}
                    placeholder={t('hpa:namePlaceholder')}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  />
                </label>
              )}

              <section className="space-y-2">
                <span className="block text-[13px] font-medium">{t('hpa:targetTitle')}</span>
                <div className="flex items-center gap-1">
                  <Select value={form.targetKind} onValueChange={v => setForm(f => ({ ...f, targetKind: v }))}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {kindOptions.map(k => (
                        <SelectItem key={k} value={k}>
                          {k}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {manualTarget ? (
                    <Input
                      className="min-w-0 flex-1 font-mono text-[13px]"
                      value={form.targetName}
                      placeholder={t('hpa:targetNamePlaceholder')}
                      onChange={e => setForm(f => ({ ...f, targetName: e.target.value }))}
                    />
                  ) : (
                    <Select
                      value={targetNames.includes(form.targetName) ? form.targetName : ''}
                      onValueChange={v => setForm(f => ({ ...f, targetName: v }))}
                    >
                      <SelectTrigger className="min-w-0 flex-1">
                        <SelectValue placeholder={t('hpa:targetSelectPlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {targetNames.map(n => (
                          <SelectItem key={n} value={n}>
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {targets.error && <p className="text-[13px] text-caution">{t('hpa:targetLoadFailed')}</p>}
              </section>

              <section className="space-y-2">
                <span className="block text-[13px] font-medium">{t('hpa:replicasTitle')}</span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5">
                    <span className="text-[13px] text-muted-foreground">{t('hpa:minReplicas')}</span>
                    <Input
                      className="w-24 font-mono text-[13px] tabular-nums"
                      value={form.minReplicas}
                      placeholder={t('hpa:minPlaceholder')}
                      onChange={e => setForm(f => ({ ...f, minReplicas: e.target.value }))}
                    />
                  </label>
                  <label className="flex items-center gap-1.5">
                    <span className="text-[13px] text-muted-foreground">{t('hpa:maxReplicas')}</span>
                    <Input
                      className="w-24 font-mono text-[13px] tabular-nums"
                      value={form.maxReplicas}
                      placeholder={t('hpa:maxPlaceholder')}
                      onChange={e => setForm(f => ({ ...f, maxReplicas: e.target.value }))}
                    />
                  </label>
                </div>
                <p className="text-[13px] text-muted-foreground">{t('hpa:replicasHint')}</p>
              </section>

              <section className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium">{t('hpa:metricsTitle')}</span>
                  <Button variant="outline" onClick={() => setForm(f => ({ ...f, metrics: [...f.metrics, emptyMetric()] }))}>
                    <Plus />
                    {t('hpa:addMetric')}
                  </Button>
                </div>
                {form.metrics.length === 0 && <p className="text-[13px] text-muted-foreground">{t('hpa:metricsEmptyHint')}</p>}
                {form.metrics.map((m, i) => (
                  <MetricRowEditor
                    key={i}
                    row={m}
                    onChange={next => setForm(f => ({ ...f, metrics: f.metrics.map((x, j) => (j === i ? next : x)) }))}
                    onRemove={() => setForm(f => ({ ...f, metrics: f.metrics.filter((_, j) => j !== i) }))}
                  />
                ))}
              </section>

              <section className="space-y-2">
                <span className="block text-[13px] font-medium">{t('hpa:behaviorTitle')}</span>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5">
                    <span className="text-[13px] text-muted-foreground">{t('hpa:scaleDownWindow')}</span>
                    <Input
                      className="w-24 font-mono text-[13px] tabular-nums"
                      value={form.downWindow}
                      placeholder="—"
                      onChange={e => setForm(f => ({ ...f, downWindow: e.target.value }))}
                    />
                  </label>
                  <label className="flex items-center gap-1.5">
                    <span className="text-[13px] text-muted-foreground">{t('hpa:scaleUpWindow')}</span>
                    <Input
                      className="w-24 font-mono text-[13px] tabular-nums"
                      value={form.upWindow}
                      placeholder="—"
                      onChange={e => setForm(f => ({ ...f, upWindow: e.target.value }))}
                    />
                  </label>
                </div>
                <p className="text-[13px] text-muted-foreground">{t('hpa:behaviorHint')}</p>
              </section>
            </div>

            <div className="flex min-h-0 flex-col gap-2 md:sticky md:top-0">
              <span className="text-[13px] font-medium text-muted-foreground">{t('hpa:preview')}</span>
              {warnings.length > 0 && (
                <p className="flex gap-1.5 rounded-md border border-caution/40 bg-caution/10 p-2 text-[13px] text-caution">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{tf('hpa:lossyWarning', { fields: warnings.map(w => tf(w.key, w.vars)).join(', ') })}</span>
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
              {t('hpa:save')}
            </GatedButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* HPA 持续接管副本数，阈值写错会造成反复震荡或雪崩式缩容，保存前强制二次确认 */}
      <AlertDialog open={confirm} onOpenChange={v => !busy && setConfirm(v)}>
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{t('hpa:confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription className="text-[13px] leading-5">{t('hpa:confirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('res:cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void save()}>
              {t('hpa:confirmSave')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
