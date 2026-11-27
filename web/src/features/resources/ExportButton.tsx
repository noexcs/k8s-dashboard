// 列表工具栏导出按钮：CSV（按资源列定义）+ YAML（完整对象清单）。
// CSV 只用 Col.value（value 返回原始值；render 返回 JSX 无法转文本），无 value 列的 kind
// （CRD 无 printer columns 时的通用列）退回「名称/命名空间/Age」最小列，保证不导出空表。
import { FileCode, Table2 } from 'lucide-react'
import { toast } from 'sonner'
import { stringify as yamlStringify } from 'yaml'
import { tf, useT } from '@/i18n'
import type { K8sObject } from '@/api/types'
import { colsFor, type AnyResourceDef, type Col } from '@/resources/registry'
import { Button } from '@/components/ui/button'

// 软阈值：超过只提示不拦截（导出是本地序列化，量大只是浏览器慢，不是错误）
const SOFT_MAX_ROWS = 5000

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** CSV 单元格：对象/数组 JSON 化（避免 [object Object]），含分隔符/引号/换行的加引号且引号双写（RFC 4180） */
function csvCell(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function buildCsv(cols: Col<K8sObject>[], rows: K8sObject[], tr: (k: string) => string): string {
  const head = cols.map(c => csvCell(tr(c.label))).join(',')
  const body = rows.map(o => cols.map(c => csvCell(c.value?.(o) ?? '')).join(','))
  // BOM：Excel 按 UTF-8 解码需要，否则中文列乱码
  return '\uFEFF' + [head, ...body].join('\r\n')
}

/** CSV 列：取资源定义里带 value 的列；name/ns/age 无 value（CRD 通用列只给 render）时
 *  从 metadata 现取，保证 Name 永远在导出里；其余无 value 列无法转文本，跳过 */
function exportCols(def: AnyResourceDef): Col<K8sObject>[] {
  const meta: Record<string, (o: K8sObject) => string | number | undefined> = {
    name: o => o.metadata.name,
    ns: o => o.metadata.namespace,
    age: o => o.metadata.creationTimestamp,
  }
  return colsFor(def)
    .map(c => (c.value ? c : meta[c.key] ? { ...c, value: meta[c.key] } : null))
    .filter((c): c is Col<K8sObject> => c !== null)
}

function download(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // click 后立即 revoke 在部分浏览器会掐断下载，延迟一拍让浏览器取件
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ExportButton({
  items,
  def,
  cluster,
  ns,
  selected,
}: {
  /** 无勾选时的导出集；传函数则在点击时刻取最新快照（列筛选态在 ResourceDataTable 内部，
   *  经父层 ref 回传，避免把表格状态提升到页面或让父层持有过期数组） */
  items: K8sObject[] | (() => K8sObject[])
  def: AnyResourceDef
  cluster: string
  ns?: string
  /** 勾选行：非空时只导选中（未选中 = 导全量，与批量删除按钮的选中语义互不冲突） */
  selected: K8sObject[]
}) {
  const t = useT()
  // 点击时刻重新取快照：列筛选是表格内部 state、不触发页面重渲染，渲染期闭包会拿过期数据；
  // 局部绑定同时让 length>0 把 ref 的 `T[] | null` 收窄成数组
  const snap = (): K8sObject[] => {
    const all = typeof items === 'function' ? items() : items
    return selected.length > 0 ? selected : all
  }
  // 渲染快照：仅用于禁用态与 title 计数
  const rows = snap()
  const empty = rows.length === 0

  const guard = (list: K8sObject[]): boolean => {
    if (list.length === 0) {
      // 按钮已禁用，这里兜底 disabled 生效前的瞬态点击
      toast.info(t('exp:emptyTip'))
      return false
    }
    if (list.length > SOFT_MAX_ROWS) toast.info(tf('exp:manyRows', { n: list.length }))
    return true
  }

  const onCsv = () => {
    const list = snap()
    if (!guard(list)) return
    const name = `${def.kind}-${ns || 'cluster'}-${stamp()}.csv`
    download(name, buildCsv(exportCols(def), list, t), 'text/csv;charset=utf-8')
  }

  const onYaml = () => {
    const list = snap()
    if (!guard(list)) return
    const name = `${def.kind}-${ns || 'cluster'}-${stamp()}.yaml`
    // v1/List 是 kubectl 可直接消费的最小清单信封；lineWidth:0 防长字段被折行
    download(
      name,
      yamlStringify({ apiVersion: 'v1', kind: 'List', items: list }, { lineWidth: 0 }),
      'text/yaml;charset=utf-8',
    )
  }

  return (
    <div className="flex items-center gap-1.5">
      {/* title 挂外层 span：Button disabled 时 pointer-events-none，挂按钮上不显示提示 */}
      <span title={empty ? t('exp:emptyTip') : tf('exp:csvTip', { n: rows.length, cluster })}>
        <Button variant="outline" disabled={empty} onClick={onCsv}>
          <Table2 className="size-3.5" />
          CSV
        </Button>
      </span>
      <span title={empty ? t('exp:emptyTip') : tf('exp:yamlTip', { n: rows.length, cluster })}>
        <Button variant="outline" disabled={empty} onClick={onYaml}>
          <FileCode className="size-3.5" />
          YAML
        </Button>
      </span>
    </div>
  )
}
