// CRD additionalPrinterColumns → 列表自定义列（参考 kubectl 的 printer columns）：
// 发现时一次性拉 apiextensions CRD 清单，按 kind 匹配（版本优先取与 APIResourceList 选中一致的）。
// jsonPath 子集：`.a.b[0].c`；不支持的表达式（通配 []、过滤、字面量 {..}）→ 值恒为 '-'，
// 与 kubectl 对非法表达式的行为一致（fail safe，不报错）。
import type { K8sObject } from '@/api/types'
import type { Col } from '@/resources/registry'

export interface PrinterColumn {
  name: string
  type: string
  jsonPath: string
  /** 1 = 仅 -o wide 显示 → 我们的列表默认隐藏 */
  priority?: number
  description?: string
}

/** jsonPath 子集求值；解析失败/缺字段 → undefined */
function getJsonPath(o: unknown, jp: string): unknown {
  if (!jp.startsWith('.')) return undefined
  let cur: unknown = o
  for (const seg of jp.slice(1).split('.')) {
    // key + 尾随 [n][m] 索引；key 段带 [ （如 a['b'] 或通配 a[]）不支持
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg)
    if (!m || cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[m[1]!]
    for (const idx of m[2]?.match(/\d+/g) ?? []) {
      if (!Array.isArray(cur)) return undefined
      cur = cur[Number(idx)]
    }
    if (cur === undefined) return undefined
  }
  return cur
}

function asText(v: unknown): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** printer columns（priority=0）→ 注册表 Col[]；不可排序列自动获得 value（原值供排序/筛选） */
export function printerCols(cols: PrinterColumn[] | undefined): Col<K8sObject>[] {
  const visible = (cols ?? []).filter(c => !c.priority && c.name && c.jsonPath)
  return visible.map(c => {
    const get = (o: K8sObject) => asText(getJsonPath(o, c.jsonPath))
    return {
      key: `pc:${c.jsonPath}`,
      label: c.name,
      width: '110px',
      value: get,
      render: (o: K8sObject) => {
        const v = get(o)
        if (v == null || v === '') return <span className="text-muted-foreground">-</span>
        return (
          <span className="min-w-0 truncate font-mono text-xs" title={c.description || v}>
            {v}
          </span>
        )
      },
    }
  })
}
