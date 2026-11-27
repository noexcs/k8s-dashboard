// exp 字典：通用资源列表导出（CSV/YAML，features/resources/ExportButton.tsx）。ns = exp
import type { Entry } from './strings'

export const STRINGS_EXPORT: Record<string, Entry> = {
  'exp:csvTip': { zh: '导出 {n} 行为 CSV（集群 {cluster}）', en: 'Export {n} rows as CSV (cluster {cluster})' },
  'exp:yamlTip': { zh: '导出 {n} 个对象的完整 YAML（集群 {cluster}）', en: 'Export {n} objects as full YAML (cluster {cluster})' },
  'exp:emptyTip': { zh: '当前没有可导出的数据', en: 'Nothing to export' },
  'exp:manyRows': { zh: '导出行数较多（{n} 行），生成可能需要一点时间', en: 'Large export ({n} rows); generating may take a moment' },
}
