/**
 * 非资源列表（Helm release/chart/repo、其他合成行列表）用 grid 排布时，
 * 必须消费这两个常量——取值与 ui/table 的 TableHead/TableRow 对齐
 * （ResourceDataTable 底座），布局专属、样式同源，禁止各页再自带
 * h-8/muted/40/accent 之类私有表头行样式。
 */
export const LIST_GRID_HEADER =
  'sticky top-0 z-10 h-10 items-center gap-2 border-b bg-card px-3 text-sm font-medium'

export const LIST_GRID_ROW =
  'h-10 items-center gap-2 border-b border-border px-3 text-sm transition-colors hover:bg-muted/50'
