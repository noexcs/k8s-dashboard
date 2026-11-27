// ConfigMap/Secret 键值编辑器：两者结构同构（data 是 string→string map），做成同一个表格表单。
// 形态照抄 NetworkPolicyEditor：自带触发按钮（kind 非 ConfigMap/Secret → 渲染 null，调用方免判）、
// Dialog 内行编辑 + 底部折叠只读 YAML 预览、编辑保存 = GET 最新对象 merge 后 PUT（409 提示重开）。
// 语义要点：
//   - ConfigMap 的 data 就是明文，直接编辑；Secret 的 data 是 base64（必填合法），编辑时解码回填，
//     提交走 stringData —— 服务端自动 base64 合入 data，避免前端自己编码出错；
//   - PUT 是整体替换：Secret 只写 stringData、data 仅带「解码不了必须原样保留」的条目，
//     这样表格里删掉的键才真的被删（若把旧 data 整个带过，删掉的键会复活）；
//   - binaryData（ConfigMap 常见）与 Secret 里解不出文本的条目（证书 DER、gzip、非法 base64）
//     表单表达不了 → 只读行（key + 字节数），保存时原样带过不丢；
//   - 除 data/binaryData/stringData 外的所有字段（type、labels、annotations、immutable…）
//     从服务端最新对象原样 merge，表单不碰不丢；
//   - immutable=true 的资源 API 上就拒改，编辑无意义 → 触发按钮禁用并说明要先删重建。
import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, FileText, Lock, Loader2, Plus, X } from 'lucide-react'
import { stringify } from 'yaml'
import { toast } from 'sonner'
import { ApiError, get, putObject } from '@/api/client'
import type { K8sObject } from '@/api/types'
import { tf, useT } from '@/i18n'
import { itemPath } from '@/resources/registry'
import { GatedButton } from '@/components/GatedButton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
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

// ---------- 常量与解析模型 ----------

const CM_DEF = { group: '', version: 'v1', resource: 'configmaps', scope: 'namespaced' } as const
const SECRET_DEF = { group: '', version: 'v1', resource: 'secrets', scope: 'namespaced' } as const
/** RFC1123 label：ConfigMap/Secret 的键名规则（长度上限 63 另判） */
const KEY_RE = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/
const KEY_MAX = 63
/** textarea 自适应行数上下限：单行值也留 2 行方便贴多行，超长值内部滚动 */
const MIN_ROWS = 2
const MAX_ROWS = 16

/** 可编辑行：ConfigMap = data 明文；Secret = data 解码出的文本（提交进 stringData） */
interface KvRow {
  id: number
  key: string
  value: string
}
/** 只读行：表单表达不了的条目（binaryData / Secret 里解不出文本的 data），保存时按 raw 原样带过 */
interface RoRow {
  key: string
  /** 写回时的原始值（Secret 只读行 = 原 base64，绝不重新编码，避免往返损坏） */
  raw: string
  /** 解码后字节数；非法 base64 无法计算 → null（不显示字节数） */
  bytes: number | null
}

let rowSeq = 1
const newRow = (key = '', value = ''): KvRow => ({ id: rowSeq++, key, value })

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const strMap = (v: unknown): [string, string][] =>
  Object.entries(asRecord(v) ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string')

/**
 * Secret data 值 → 可编辑文本；解不出（非法 base64 / 二进制）返回 null 转只读行。
 * 解码思路同 SecretValues：atob 得 binary string，必须逐字节转 Uint8Array 再 UTF-8 解码，
 * 否则中文密码这类非 ASCII 值会乱码；含 NUL 或控制字符/U+FFFD 成规模判二进制。
 */
function decodeText(raw: string): { text: string; bytes: number } | { bytes: number | null } {
  if (raw === '') return { text: '', bytes: 0 }
  let bin: string
  try {
    bin = atob(raw)
  } catch {
    return { bytes: null }
  }
  const buf = Uint8Array.from(bin, c => c.charCodeAt(0))
  if (buf.includes(0)) return { bytes: buf.length }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  let bad = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    // U+FFFD（非法 UTF-8 序列）+ 除 \t\n\r 外的 C0/C1 控制字符
    if (cp === 0xfffd || (cp < 32 && cp !== 9 && cp !== 10 && cp !== 13) || (cp >= 0x7f && cp <= 0x9f)) bad++
  }
  // 双条件：少量 U+FFFD 不算二进制（正常文本里也可能混一个），成规模的乱码才判二进制
  if (bad >= 3 && bad / text.length > 0.1) return { bytes: buf.length }
  return { text, bytes: buf.length }
}

/** obj → 可编辑行 + 只读行（Secret 的 stringData 若存在按写端语义覆盖同名 data 键） */
function parseObj(kind: 'ConfigMap' | 'Secret', obj: Record<string, unknown>): { rows: KvRow[]; roData: RoRow[]; roBinary: RoRow[] } {
  const binary: RoRow[] = strMap(obj.binaryData).map(([key, raw]) => {
    let bytes: number | null = null
    try {
      bytes = atob(raw).length
    } catch {
      /* 服务端不会产出非法 base64，防御性留 null */
    }
    return { key, raw, bytes }
  })
  if (kind === 'ConfigMap') {
    // ConfigMap data 即明文，全部可编辑
    return { rows: strMap(obj.data).map(([key, value]) => newRow(key, value)), roData: [], roBinary: binary }
  }
  const rows: KvRow[] = []
  const roData: RoRow[] = []
  for (const [key, raw] of strMap(obj.data)) {
    const d = decodeText(raw)
    if ('text' in d) rows.push(newRow(key, d.text))
    else roData.push({ key, raw, bytes: d.bytes })
  }
  const sd = new Map(strMap(obj.stringData))
  for (const r of rows) {
    if (sd.has(r.key)) {
      r.value = sd.get(r.key)!
      sd.delete(r.key)
    }
  }
  // stringData 独有的键（正常读回不会出现，防御刚 POST 未刷新的对象）追加为可编辑行
  for (const [key, value] of sd) rows.push(newRow(key, value))
  return { rows, roData, roBinary: binary }
}

/** 当前行 + 只读行 → 合并进基准对象后的请求体（PUT 整体替换，其余字段由 base 原样带过） */
function buildBody(
  base: Record<string, unknown>,
  kind: 'ConfigMap' | 'Secret',
  rows: KvRow[],
  roData: RoRow[],
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...base }
  const editable = rows.map(r => ({ key: r.key.trim(), value: r.value })).filter(r => !(r.key === '' && r.value === '')) // 全空行 = 占位行，跳过
  const data: Record<string, string> = {}
  for (const r of editable) data[r.key] = r.value
  if (kind === 'ConfigMap') {
    // data 由表单完全表达：有行或原本就有 data（表达「清空」意图）才写；stringData 从不写
    if (editable.length > 0 || base.data !== undefined) body.data = data
    else delete body.data
    delete body.stringData
  } else {
    // Secret：明文走 stringData（服务端转 base64 合入 data）；data 只保留解码不了的条目 ——
    // 若把旧 data 整个带过，表格里删掉的键会被旧值复活
    if (editable.length > 0) body.stringData = data
    else delete body.stringData
    if (roData.length > 0) body.data = Object.fromEntries(roData.map(r => [r.key, r.raw]))
    else delete body.data
  }
  // binaryData 表单只读，存在即原样带过
  if (base.binaryData === undefined) delete body.binaryData
  return body
}

// ---------- 主组件 ----------

export function KeyValueEditor({
  cluster,
  ns,
  name,
  obj,
  allowed,
  onSaved,
}: {
  cluster: string
  ns: string
  /** 对象名（仅编辑既有对象，无新建模式） */
  name: string
  /** ConfigMap/Secret 裸对象；其他 kind → 组件渲染 null */
  obj: Record<string, unknown>
  allowed: boolean
  onSaved?: () => void
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const kind = obj.kind === 'ConfigMap' || obj.kind === 'Secret' ? obj.kind : null
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState<KvRow[]>([])
  const [roData, setRoData] = useState<RoRow[]>([])
  const [roBinary, setRoBinary] = useState<RoRow[]>([])

  // immutable 资源 PUT 必被 API 拒绝（要先删重建），禁用入口而不是让用户撞 422
  const immutable = obj.immutable === true
  const def = kind === 'Secret' ? SECRET_DEF : CM_DEF
  const path = itemPath(def, ns, name)

  // 打开瞬间才回填（不用 effect 跟随 obj 身份变化）：编辑中途 watch/refetch 不能把用户已改的表单冲掉
  const openEditor = () => {
    if (!kind) return
    const parsed = parseObj(kind, obj)
    setRows(parsed.rows)
    setRoData(parsed.roData)
    setRoBinary(parsed.roBinary)
    setConfirm(false)
    setOpen(true)
  }

  const errors = useMemo(() => {
    // 查重按 trim 后的键名：与写回（buildBody 同样 trim）保持同一口径
    const roKeys = new Set([...roData, ...roBinary].map(r => r.key))
    const list: string[] = []
    const count = new Map<string, number>()
    for (const r of rows) {
      const key = r.key.trim()
      if (key === '') {
        // 空键但有值 = 半填的行，必须提示；全空行按「添加条目」占位处理
        if (r.value !== '') list.push(t('kv:keyRequired'))
        continue
      }
      if (!KEY_RE.test(key) || key.length > KEY_MAX) {
        list.push(`${t('kv:keyInvalid')} (${key})`)
        continue
      }
      count.set(key, (count.get(key) ?? 0) + 1)
      // 与只读键同名 = 写回时会被只读原值顶掉/422，就地报错
      if (roKeys.has(key)) list.push(tf('kv:keyDuplicate', { key }))
    }
    for (const [key, n] of count) if (n > 1) list.push(tf('kv:keyDuplicate', { key }))
    return [...new Set(list)]
  }, [rows, roData, roBinary, t])

  // 只读 YAML 预览：与表格实时同步，所见即将要 PUT 的 body（status 是只读汇总字段，不显示也不回传）
  const yamlText = useMemo(() => {
    if (!kind) return ''
    const base = { ...obj }
    delete base.status
    return stringify(buildBody(base, kind, rows, roData), { lineWidth: 0 })
  }, [kind, obj, rows, roData])

  const save = async () => {
    if (!kind) return
    setBusy(true)
    try {
      // 表单只管 data/binaryData/stringData：先 GET 最新对象，type/labels/annotations/其他键
      // 连同最新 resourceVersion 从服务端现值带过去，PUT 不静默丢字段、不吃陈旧 RV
      const cur = await get<K8sObject>(cluster, path)
      const base = { ...(cur as unknown as Record<string, unknown>) }
      delete base.status // 只读汇总字段，不必回传
      await putObject(cluster, path, buildBody(base, kind, rows, roData) as unknown as K8sObject, `${kind} 键值编辑保存`)
      toast.success(tf('kv:saved', { name }))
      queryClient.invalidateQueries({ queryKey: ['yaml', cluster, path] })
      setConfirm(false)
      setOpen(false)
      onSaved?.()
    } catch (e) {
      const detail = e instanceof ApiError && e.isConflict ? t('kv:conflict') : e instanceof Error ? e.message : String(e)
      toast.error(tf('kv:saveFailed', { error: detail }))
    } finally {
      setBusy(false)
    }
  }

  if (!kind) return null

  const Icon = kind === 'Secret' ? Lock : FileText
  const saveClick = () => {
    if (errors.length) {
      toast.error(errors[0]!)
      return
    }
    // Secret 明文上传 + 集群内可见（base64 非加密）值得一次显式确认；ConfigMap 本无秘密性
    if (kind === 'Secret') setConfirm(true)
    else void save()
  }

  // 权限门控交给 GatedButton；immutable 时按钮已 disabled 不再渲染，禁用原因自挂 tooltip
  //（disabled 按钮不吃 hover 事件，同 GatedButton 的内部处理）
  const trigger = immutable ? (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button variant="outline" disabled>
              <Icon />
              {t('kv:edit')}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{tf('kv:immutableTitle', { kind })}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : (
    <GatedButton allowed={allowed} onClick={openEditor}>
      <Icon />
      {t('kv:edit')}
    </GatedButton>
  )

  return (
    <>
      {trigger}

      <Dialog open={open} onOpenChange={v => !busy && setOpen(v)}>
        <DialogContent className="max-w-3xl sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{tf('kv:titleEdit', { kind, name })}</DialogTitle>
            <DialogDescription className="text-[13px]">{t('kv:desc')}</DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[70vh] min-h-0 gap-3 overflow-y-auto text-[13px]">
            <div className="space-y-2">
              {rows.length === 0 && <p className="text-[13px] text-muted-foreground">{t('kv:noRows')}</p>}
              {rows.map(r => (
                <div key={r.id} className="grid grid-cols-[minmax(120px,220px)_1fr_auto] items-start gap-2">
                  <Input
                    className="font-mono text-[13px]"
                    value={r.key}
                    placeholder={t('kv:keyPlaceholder')}
                    onChange={e => setRows(xs => xs.map(x => (x.id === r.id ? { ...x, key: e.target.value } : x)))}
                  />
                  <Textarea
                    // 行数随行内实际行数伸缩：单键配置文件一行，整份 nginx.conf 直接给到 16 行
                    rows={Math.min(MAX_ROWS, Math.max(MIN_ROWS, r.value.split('\n').length))}
                    className="min-h-8 font-mono text-[13px]"
                    value={r.value}
                    placeholder={t('kv:valuePlaceholder')}
                    onChange={e => setRows(xs => xs.map(x => (x.id === r.id ? { ...x, value: e.target.value } : x)))}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    title={t('kv:removeRow')}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setRows(xs => xs.filter(x => x.id !== r.id))}
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <Button variant="outline" onClick={() => setRows(xs => [...xs, newRow()])}>
                <Plus />
                {t('kv:addRow')}
              </Button>
            </div>

            {(roData.length > 0 || roBinary.length > 0) && (
              <section className="space-y-2">
                <span className="block text-[13px] font-medium">{t('kv:binarySection')}</span>
                {[...roData, ...roBinary].map(r => (
                  <div key={r.key} className="grid grid-cols-[minmax(120px,220px)_1fr] items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
                    <span className="truncate font-mono text-[13px]">{r.key}</span>
                    <span className="text-[13px] text-muted-foreground tabular-nums">
                      {r.bytes != null ? tf('kv:binaryBytes', { n: r.bytes }) : '—'} · {t('kv:binaryReadonly')}
                    </span>
                  </div>
                ))}
              </section>
            )}

            {errors.length > 0 && (
              <ul className="space-y-0.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[13px] text-destructive">
                {errors.map(e => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}

            {/* 折叠在底部的只读预览：结构改动（type、annotations…）引导去 YAML 页，避免表单假装支持 */}
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground">
                <ChevronDown className="size-3.5" />
                {t('kv:yamlView')}
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-1">
                <p className="text-[13px] text-muted-foreground">{t('kv:yamlHint')}</p>
                <pre className="max-h-[36vh] overflow-auto rounded-md bg-muted p-2 font-mono text-[13px]">
                  {yamlText}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t('res:cancel')}
            </Button>
            <Button disabled={!allowed || busy} onClick={saveClick}>
              {busy && <Loader2 className="animate-spin" />}
              {t('kv:save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Secret 明文 value 的暴露面（TLS 传输 + 集群内 base64 可读）保存前强制确认一次 */}
      <AlertDialog open={confirm} onOpenChange={v => !busy && setConfirm(v)}>
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{t('kv:secretWarnTitle')}</AlertDialogTitle>
            <AlertDialogDescription className="text-[13px] leading-5">{t('kv:secretWarnDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('res:cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void save()}>
              {t('kv:secretWarnConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
