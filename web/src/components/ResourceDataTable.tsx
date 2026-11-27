"use client"

// shadcn data-table（docs/components/base/data-table）的 k8s 列表实现，样式对齐文档 demo：
// 文档同款可复用组件（列头单击循环排序 asc/desc/无序、DataTablePagination 分页
// footer）+ 行选择 checkbox 首列 + 文档密度（text-sm / h-10 / p-2）。
// 本地差异：
// - 注册表 Col[]（resources/registry.tsx）→ ColumnDef，漏斗列筛选 Popover 保留
//   （多列筛选需求，形态来自 shadcn data-table-with-column-filters 示例）
// - 不用 ui/Table 外层（其 overflow-x-auto 包裹 div 会成为滚动容器、sticky 表头失效），
//   用 shadcn Table 语义子组件 + 裸 <table>，列宽写在各 th/td（隐藏列不渲染即不占宽）
// - v9 注册的 FilterFn/SortFn 是行级签名（row, columnId, filterValue）/（rowA, rowB, columnId）
import * as React from "react"
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  FlexRender,
  filterFn_includesString,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_text,
  tableFeatures,
  useTable,
  type ReactTable,
  type Column,
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table"
import { Link } from "react-router-dom"
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  Columns3,
  Filter,
  FilterX,
  MessageSquareText,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { t, tf } from "@/i18n"
import type { Col } from "@/resources/registry"
import type { K8sObject } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { HScrollFade } from "@/components/HScrollFade"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

// v9：只注册用到的 feature，其余被 tree-shake
const features = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: {
    includesString: filterFn_includesString,
    // 内置 arrIncludesSome 要求行值是数组（facets 场景）；k8s 列值是标量，
    // 这里用「标量 ∈ 选中值数组」的语义
    inSelected: (row, columnId, filterValue) =>
      Array.isArray(filterValue) && filterValue.includes(String(row.getValue(columnId) ?? "")),
  },
  sortFns: {
    text: sortFn_text,
    numeric: (rowA, rowB, columnId) =>
      ((rowA.getValue(columnId) as number | undefined) ?? 0) -
      ((rowB.getValue(columnId) as number | undefined) ?? 0),
  },
})

/** 表头（文档 DataTableColumnHeader 同款）：单击循环排序，右侧漏斗列筛选；列显隐在页脚「列」下拉 */
function ColumnHeader<T extends K8sObject>({
  column,
  col,
  rows,
}: {
  column: Column<typeof features, T, unknown>
  col: Col<T>
  rows: T[]
}) {
  const title = t(col.label)
  if (!column.getCanSort() && !column.getCanFilter()) {
    // 与可排序列(Button sm = text-[0.8rem])同字号:同角色表头 12.8/14 双制式违例
    return <div className={cn('text-[0.8rem]', col.align === "right" && "text-right")}>{title}</div>
  }
  return (
    <div className={cn("flex items-center gap-2", col.align === "right" && "justify-end")}>
      {column.getCanSort() && (
        // 单击直接循环排序：无序 → 升序 → 降序 → 无序
        <Button
          variant="ghost"
          size="sm"
          className="-ml-3 h-8 hover:bg-accent"
          onClick={() => column.toggleSorting()}
        >
          <span className="truncate">{title}</span>
          {column.getIsSorted() === "desc" ? (
            <ArrowDown className="ml-2 size-3.5 shrink-0" />
          ) : column.getIsSorted() === "asc" ? (
            <ArrowUp className="ml-2 size-3.5 shrink-0" />
          ) : (
            <ChevronsUpDown className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
          )}
        </Button>
      )}
      {column.getCanFilter() && <ColumnFilter column={column} col={col} rows={rows} title={title} />}
    </div>
  )
}

/** 列筛选 Popover：select = 取值复选列表（低基数）；text = 子串输入（实时生效） */
function ColumnFilter<T extends K8sObject>({
  column,
  col,
  rows,
  title,
}: {
  column: Column<typeof features, T, unknown>
  col: Col<T>
  rows: T[]
  title: string
}) {
  const active = column.getFilterValue() as string | string[] | null
  // 取值列表：从当前行集实时统计（去重 + 计数，上限 100 项）
  const options = React.useMemo(() => {
    if (col.filter !== "select" || !col.value) return undefined
    const counts = new Map<string, number>()
    for (const r of rows) {
      const v = col.value(r)
      if (v == null || v === "") continue
      const s = String(v)
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 100)
  }, [rows, col])

  const clear = () => column.setFilterValue(null)
  // 受控开合：非模态浮层不随 blur 关闭，Enter 必须显式收尾并回焦（否则 activeElement 掉 body、浮层悬留）
  const [open, setOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          title={title}
          className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-accent"
        >
          <Filter className={cn("size-3.5 text-muted-foreground", active && "fill-primary/20 text-primary")} />
        </button>
      </PopoverTrigger>
      <PopoverContent align={col.align === "right" ? "end" : "start"} className="w-52 p-2">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-medium">{title}</span>
          <Button variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1.5 text-xs" onClick={clear} disabled={!active}>
            <FilterX className="size-3" />
            {t("res:clearFilter")}
          </Button>
        </div>
        {options ? (
          options.length === 0 ? (
            <div className="px-1 py-2 text-[13px] text-muted-foreground">{t("res:noFilterMatch")}</div>
          ) : (
            <div className="max-h-64 space-y-0.5 overflow-auto">
              {options.map(([v, n]) => {
                const arr = Array.isArray(active) ? active : []
                const checked = arr.includes(v)
                return (
                  <label
                    key={v}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[13px] hover:bg-accent"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={c => {
                        const next = c
                          ? [...new Set([...arr, v])]
                          : arr.filter(x => x !== v)
                        column.setFilterValue(next.length ? next : null)
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate" title={v}>{v}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{n}</span>
                  </label>
                )
              })}
            </div>
          )
        ) : (
          <Input
            autoFocus
            placeholder={t("res:filterValuePlaceholder")}
            value={typeof active === "string" ? active : ""}
            onChange={e => column.setFilterValue(e.target.value || null)}
            onKeyDown={e => {
              if (e.key !== "Enter") return
              setOpen(false)
              requestAnimationFrame(() => triggerRef.current?.focus())
            }}
            className="h-7 text-[13px]"
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

/** 文档 DataTablePagination 同款 + 列显隐下拉（回归旧首页表能力）：选中计数 + 列 + 每页行数 + 页码 + 首/上/下/末 */
function Pagination<T extends K8sObject>({
  table,
  labels,
  showSelection,
}: {
  table: ReactTable<typeof features, T>
  /** 列 id → i18n label(列显隐下拉展示名) */
  labels: Record<string, string>
  /** 无选择列(总览页)时「已选 N 行」同步消失:选择框删了计数还挂着是孤儿文案 */
  showSelection?: boolean
}) {
  return (
    // 窄屏:选中计数与分页控件上下堆叠,避免计数被挤成竖排
    <div className="flex flex-col gap-2 px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-3">
        {showSelection && (
          <div className="whitespace-nowrap text-sm text-muted-foreground tabular-nums">
            {tf("res:rowsSelected", {
              a: table.getFilteredSelectedRowModel().rows.length,
              b: table.getFilteredRowModel().rows.length,
            })}
          </div>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <Columns3 className="size-4" />
              {t("ui:columns")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            <DropdownMenuLabel>{t("ui:customizeColumns")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table
              .getAllLeafColumns()
              .filter(c => c.id !== "select")
              .map(col => (
                <DropdownMenuCheckboxItem
                  key={col.id}
                  checked={col.getIsVisible()}
                  onCheckedChange={() => col.toggleVisibility()}
                  // 勾选后菜单保持打开（radix 默认点一次就关，多列开关会反复重开菜单）
                  onSelect={e => e.preventDefault()}
                >
                  {labels[col.id] ? t(labels[col.id]) : col.id}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center space-x-2">
          <p className="text-sm font-medium">{t("res:rowsPerPage")}</p>
          <Select
            value={`${table.state.pagination.pageSize}`}
            onValueChange={value => table.setPageSize(Number(value))}
          >
            <SelectTrigger className="h-8 w-[72px]">
              <SelectValue placeholder={table.state.pagination.pageSize} />
            </SelectTrigger>
            <SelectContent side="top">
              {[10, 20, 25, 30, 40, 50].map(pageSize => (
                <SelectItem key={pageSize} value={`${pageSize}`}>
                  {pageSize}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex w-[100px] items-center justify-center text-sm font-medium tabular-nums">
          {tf("res:pageOf", { a: table.state.pagination.pageIndex + 1, b: table.getPageCount() })}
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            size="icon"
            className="hidden size-8 lg:flex"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">{t("ui:firstPage")}</span>
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">{t("ui:prevPage")}</span>
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">{t("ui:nextPage")}</span>
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="hidden size-8 lg:flex"
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
          >
            <span className="sr-only">{t("ui:lastPage")}</span>
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  )
}

// —— 稳定 cell/header 壳 ——（质量审计18#2）
// flexRender 把 cell/header 的函数按「组件类型」实例化：defs 重建时箭头闭包是全新
// 类型，整棵子树卸载重挂——行内 Pods 弹层被轮询/报告流量杀死。壳函数身份恒定，
// 真正的 col 定义经 columnDef.meta 读取：内容更新照常重渲染，组件状态保留。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ColCellShell({ column, row }: any) {
  const col = column.columnDef.meta?.col as Col<any> | undefined
  return <span className="block min-w-0">{col?.render(row.original)}</span>
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ColHeaderShell({ column, table }: any) {
  const col = column.columnDef.meta?.col as Col<any> | undefined
  if (!col) return null
  return <ColumnHeader column={column} col={col} rows={(table.options.data ?? []) as any} />
}
// 选择列同理：壳稳定 + Enter 不穿透行导航（此前只堵了 click，Enter 触发跳详情）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function SelectCell({ row }: any) {
  return (
    <span onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value: boolean) => row.toggleSelected(!!value)}
        aria-label={t("ui:selectRow")}
      />
    </span>
  )
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function SelectHeader({ table }: any) {
  return (
    <Checkbox
      checked={table.getIsAllPageRowsSelected()}
      aria-checked={table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected() ? "mixed" : undefined}
      onCheckedChange={(value: boolean) => table.toggleAllPageRowsSelected(!!value)}
      aria-label={t("ui:selectAll")}
    />
  )
}

export function ResourceDataTable<T extends K8sObject>({
  columns,
  rows,
  rowKey,
  onRowClick,
  getRowClassName,
  onFilteredCount,
  filteredRowsRef,
  onSelectionChange,
  askRow,
  nameHref,
}: {
  columns: Col<T>[]
  rows: T[]
  rowKey: (o: T) => string
  onRowClick?: (o: T) => void
  getRowClassName?: (o: T) => string | undefined
  /** 列筛选后的总行数回传（页面头部计数用） */
  onFilteredCount?: (n: number) => void
  /** 列筛选后的行对象写入该 ref（导出等在点击时刻消费；ref 写入不触发渲染，避免
   *  setState 回环——rows prop 每渲染都是新数组，行模型也随之重建） */
  filteredRowsRef?: React.RefObject<T[] | null>
  /** 选中行回传（批量操作工具条用；数据收缩后自动剔除已不存在的行） */
  onSelectionChange?: (rows: T[]) => void
  /** 行级「问 AI」：传入则在行尾渲染低调提问按钮（列表页无路由上下文，文本需自带资源名） */
  askRow?: (o: T) => void
  /** 名称格详情链接：传入则名称渲染为真 <a href>（键盘/中键/Cmd-点可用） */
  nameHref?: (o: T) => string
}) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = React.useState<ColumnVisibilityState>({})
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})
  // 每页行数跨会话持久化（参考 CLI）：全局一个值，切 kind/集群都沿用
  const [pagination, setPagination] = React.useState<PaginationState>(() => ({
    pageIndex: 0,
    pageSize: Number(localStorage.getItem('k8s.pageSize')) || 10,
  }))
  React.useEffect(() => {
    if (pagination.pageSize) localStorage.setItem('k8s.pageSize', String(pagination.pageSize))
  }, [pagination.pageSize])

  // 注册表 Col（对齐/宽度）+ 文档同款行选择首列
  const regCol = React.useMemo(() => new Map(columns.map(c => [c.key, c])), [columns])

  // ⚠ defs 不能依赖 rows：refetch（± 伸缩/巡检 join/30s 轮询）每次都会产出新数组，
  // memo 重建 → cell 函数换引用 → flexRender 把每个行内组件（Pods 弹层/问 AI 钮）整棵
  // 卸载重挂——伸缩点一下弹层就被自己打断。rows 只被两处「值派生」用到：筛选选项与
  // sortFn 数值采样，走 ref 读最新即可；身份签名变化（增删行/换集群）才重建 defs。
  const rowsRef = React.useRef(rows)
  rowsRef.current = rows
  const rowKeyRef = React.useRef(rowKey)
  rowKeyRef.current = rowKey
  const rowsSig = React.useMemo(
    () => rows.map(r => rowKeyRef.current(r)).join('|'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  )

  // askRow 同理是内联箭头：每次 render 换引用会把整个 defs 打碎重建（cell 全重挂）
  const askRowRef = React.useRef(askRow)
  askRowRef.current = askRow
  const hasAsk = askRow !== undefined
  // 无消费者的选择框列整个不拼入(审计 high):总览页没接 onSelectionChange,选中只换
  // 一层近隐形行底色——纯装饰控件还白占 40px;列表页有批量操作,onSelectionChange 在,照常出
  const hasSelect = onSelectionChange !== undefined

  const defs = React.useMemo<ColumnDef<typeof features, T>[]>(() => {
    const selectDef: ColumnDef<typeof features, T> = {
      id: "select",
      cell: SelectCell as ColumnDef<typeof features, T>["cell"],
      header: SelectHeader as ColumnDef<typeof features, T>["header"],
      enableSorting: false,
      enableHiding: false,
      enableColumnFilter: false,
    }
    const colDefs: ColumnDef<typeof features, T>[] = columns.map(col => {
      const def: ColumnDef<typeof features, T> = {
        id: col.key,
        accessorFn: col.value ? (row: T) => col.value!(row) : () => null,
        cell: ColCellShell as ColumnDef<typeof features, T>["cell"],
        header: ColHeaderShell as ColumnDef<typeof features, T>["header"],
        meta: { col },
        enableSorting: !!col.value,
        enableColumnFilter: !!col.filter,
      }
      if (col.value) {
        // 按首个非空值判定数字/文本排序（v9：字段名 sortFn）
        const sample = rowsRef.current.find(r => col.value!(r) != null)
        def.sortFn = sample != null && typeof col.value!(sample) === "number" ? "numeric" : "text"
        if (col.filter) def.filterFn = col.filter === "select" ? "inSelected" : "includesString"
      }
      return def
    })
    // 行级「问 AI」尾列（仅列表页传入时存在；不参与列显隐/排序/筛选）
    const askDefs: ColumnDef<typeof features, T>[] = hasAsk
      ? [
          {
            id: "ask",
            header: () => null,
            cell: ({ row }) => (
              <span className="flex justify-end" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-foreground"
                  title={t("res:askAi")}
                  onClick={() => askRowRef.current?.(row.original)}
                >
                  <MessageSquareText className="size-3.5" />
                  <span className="sr-only">{t("res:askAi")}</span>
                </Button>
              </span>
            ),
            enableSorting: false,
            enableHiding: false,
            enableColumnFilter: false,
          },
        ]
      : []
    return [...(hasSelect ? [selectDef] : []), ...colDefs, ...askDefs]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, rowsSig, hasAsk, hasSelect])

  const table = useTable({
    features,
    data: rows,
    columns: defs,
    getRowId: row => rowKey(row),
    state: { sorting, columnFilters, columnVisibility, rowSelection, pagination },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: setPagination,
  })

  const filteredCount = table.getFilteredRowModel().rows.length
  // 导出等消费方要「列筛选后的行对象」：每次提交后写 ref（不用 state 回传——rows prop 每
  // 渲染都是新数组，setState 会触发渲染死循环）；卸载时清 null，防止表格消失后留旧快照
  React.useEffect(() => {
    if (filteredRowsRef) filteredRowsRef.current = table.getFilteredRowModel().rows.map(r => r.original)
    return () => {
      if (filteredRowsRef) filteredRowsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })
  React.useEffect(() => {
    onFilteredCount?.(filteredCount)
  }, [filteredCount, onFilteredCount])

  // 选中行 → 原始对象（rowSelection 按 rowId 存；rows 变化后残留 id 自动被 filter 掉）。
  // 仅在「选中集」实际变化时回传：rows 每次 render 都是新数组（父层 filter 产物），
  // 无条件回传会让父层 setState 触发重渲染 → 新 rows → 再回传 = 死循环（React #185）。
  const selectedKeys = Object.keys(rowSelection).filter(k => rowSelection[k])
  const selectedSig = selectedKeys.join('|')
  const lastEmitRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!onSelectionChange) return
    // 走「筛选后可见选中集」而非筛选前的 rows：漏斗筛掉的隐藏行不得混入
    // 批量删除/重启执行集（footer 计数一直用的 filtered model，此处对齐）
    const picked = table.getFilteredSelectedRowModel().rows.map(r => r.original)
    const keys = picked.map(rowKey).join('|')
    if (keys === lastEmitRef.current) return
    lastEmitRef.current = keys
    onSelectionChange(picked)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSig, rows])

  // 数据/筛选收缩后当前页可能真越界 → 回第一页。
  // 判据必须是 pageIndex > 最大页码：旧写法 !getCanNextPage() 把「合法停在末页」
  // 也算越界，watch 一帧就弹回第 1 页，live 集群上末页根本没法阅读
  React.useEffect(() => {
    const maxPage = Math.max(0, table.getPageCount() - 1)
    if (table.state.pagination.pageIndex > maxPage) table.setPageIndex(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columnFilters])

  const widthOf = (id: string) => (id === "select" ? "40px" : regCol.get(id)?.width)
  const visibleCount =
    1 + columns.filter(c => table.getColumn(c.key)?.getIsVisible() ?? true).length

  // sticky 表头与 HScrollFade 互斥(审计 high):HScrollFade 的 overflow-y-hidden 把
  // 表格关进零纵向滚动余量的 scrollport,sticky top-0 整体失效——正是本文件头弃用
  // ui/Table 内滚容器时写明的同一失效原因被渐隐提示原样复活。窄屏真横滚时渐隐提示
  // 优先(它要求滚动口);宽屏不横滚时裸出表格,sticky 对页面滚动口生效。
  const probeRef = React.useRef<HTMLDivElement>(null)
  const tableRef = React.useRef<HTMLTableElement>(null)
  // 测量值进 state:重挂时 React 保留 state 值,首帧形态直接正确,不必再测一遍
  const [hOverflow, setHOverflow] = React.useState(false)
  // 必须 useLayoutEffect(绘制前):旧实现 useEffect 首帧裸表、次帧才包 HScrollFade,
  // 窄窗口实测 868px 裸表→1260px 横滚表 + top 跳 40px(用户「还是有闪动」)
  React.useLayoutEffect(() => {
    const probe = probeRef.current
    const tbl = tableRef.current
    if (probe && tbl) {
      const over = tbl.getBoundingClientRect().width > probe.clientWidth + 1
      // 相等不 set:ResizeObserver 回调进 useLayoutEffect 会连环,自激环就此掐断
      setHOverflow(prev => (prev === over ? prev : over))
    }
  })
  React.useEffect(() => {
    const probe = probeRef.current
    if (!probe || !tableRef.current) return
    const ro = new ResizeObserver(() => {
      const p = probeRef.current
      const tb = tableRef.current
      if (!p || !tb) return
      const over = tb.getBoundingClientRect().width > p.clientWidth + 1
      setHOverflow(prev => (prev === over ? prev : over))
    })
    ro.observe(probe)
    ro.observe(tableRef.current)
    return () => ro.disconnect()
  }, [])

  const tableEl = (
    <table ref={tableRef} className="w-full caption-bottom text-sm">
          <TableHeader>
            {table.getHeaderGroups().map(hg => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map(h => (
                  <TableHead
                    key={h.id}
                    style={{ width: widthOf(h.column.id) }}
                    className={cn(
                      "sticky top-0 z-10 h-10 bg-card px-3",
                      h.column.id === "name" && "min-w-[200px]",
                      regCol.get(h.column.id)?.align === "right" && "text-right tabular-nums",
                    )}
                  >
                    {h.isPlaceholder ? null : <FlexRender header={h} />}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={visibleCount} className="h-24 text-center text-muted-foreground">
                  {/* 没数据不能读成「没筛掉」:零行且无筛选激活时如实说暂无数据 */}
                  {columnFilters.some(
                    f => f.value != null && f.value !== "" && !(Array.isArray(f.value) && f.value.length === 0),
                  )
                    ? t("res:noFilterMatch")
                    : t("res:noRows")}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map(row => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  className={cn(
                    // 行不再是 role=link + tabIndex：行内含选择框与「问 AI」按钮，link
                    // 语义会把它们从可聚焦控件里吞掉。行只保留鼠标点击导航的便利，
                    // 键盘可达性由名称格的真链接承担（自带 Enter/焦点环/新标签页）
                    "cursor-pointer",
                    "data-[state=selected]:bg-accent data-[state=selected]:hover:bg-accent",
                    getRowClassName?.(row.original),
                  )}
                >
                  {row.getVisibleCells().map(c => (
                    <TableCell
                      key={c.id}
                      style={{ width: widthOf(c.column.id) }}
                      className={cn(
                        "px-3",
                        c.column.id === "name" && "min-w-[200px]",
                        regCol.get(c.column.id)?.align === "right" && "text-right tabular-nums",
                      )}
                    >
                      {c.column.id === "name" && nameHref ? (
                        <Link
                          to={nameHref(row.original)}
                          onClick={e => e.stopPropagation()}
                          className="block min-w-0 rounded text-foreground outline-none hover:underline hover:decoration-foreground/40 hover:underline-offset-3 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring/60"
                        >
                          <FlexRender cell={c} />
                        </Link>
                      ) : (
                        <FlexRender cell={c} />
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
    </table>
  )

  return (
    <div ref={probeRef}>
      {/* 官方 data-table 观感:无外框。窄屏列宽总和超出容器时表体在 HScrollFade 内横向
          滚动(右缘渐隐提示);宽屏不横滚则裸出表格,sticky 表头对页面滚动口生效 */}
      {hOverflow ? <HScrollFade>{tableEl}</HScrollFade> : tableEl}
      <div className="pt-2">
        <Pagination table={table} labels={Object.fromEntries(columns.map(c => [c.key, c.label]))} showSelection={hasSelect} />
      </div>
    </div>
  )
}
