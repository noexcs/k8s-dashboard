// ui 字典：components/（AppLayout 除外）+ components/dashboard/* + ai-elements + components/ui + lib/version。ns = ui
import type { Entry } from './strings'

export const STRINGS_UI: Record<string, Entry> = {
  // app-sidebar
  'ui:copy': { zh: '复制', en: 'Copy' },
  'ui:copied': { zh: '已复制', en: 'Copied' },
  'ui:kbdSend': { zh: '发送', en: 'to send' },
  'ui:kbdNewline': { zh: '换行', en: 'for newline' },
  'ui:permFullConfirm': { zh: '确认开启：写操作不再逐个批准', en: 'Confirm: writes run without approval' },
  'ui:copyFailed': { zh: '复制失败', en: 'Copy failed' },
  'ui:customResources': { zh: '自定义资源', en: 'Custom Resources' },
  'ui:settings': { zh: '设置', en: 'Settings' },
  // nav-main
  'ui:overview': { zh: '总览', en: 'Overview' },
  'ui:aiAssistant': { zh: 'AI 助手', en: 'AI Assistant' },
  'ui:navOps': { zh: '运维', en: 'Operations' },
  // site-header
  'ui:toggleTheme': { zh: '切换主题', en: 'Toggle theme' },
  'ui:switchToLight': { zh: '切换到浅色', en: 'Switch to light theme' },
  'ui:switchToDark': { zh: '切换到深色', en: 'Switch to dark theme' },
  // data-table
  'ui:columns': { zh: '列', en: 'Columns' },
  'ui:customizeColumns': { zh: '自定义列', en: 'Customize Columns' },
  'ui:selectAll': { zh: '全选', en: 'Select all' },
  'ui:selectRow': { zh: '选择行', en: 'Select row' },
  'ui:firstPage': { zh: '第一页', en: 'First page' },
  'ui:prevPage': { zh: '上一页', en: 'Previous page' },
  'ui:nextPage': { zh: '下一页', en: 'Next page' },
  'ui:lastPage': { zh: '末页', en: 'Last page' },
  'ui:colKind': { zh: '类型', en: 'Type' },
  'ui:workloads': { zh: '工作负载', en: 'Workloads' },
  'ui:cancel': { zh: '取消', en: 'Cancel' },
  // chart-area-interactive
  'ui:clusterResourceTrend': { zh: '集群资源趋势', en: 'Cluster Resource Trends' },
  'ui:chartDescFull': { zh: 'CPU / 内存利用率 · 15s 采样滚动窗口', en: 'CPU / memory utilization · 15s sampling rolling window' },
  'ui:chartDescMobile': { zh: '15s 采样滚动窗口', en: '15s sampling rolling window' },
  'ui:range30m': { zh: '近 30 分钟', en: 'Last 30 minutes' },
  'ui:range15m': { zh: '近 15 分钟', en: 'Last 15 minutes' },
  'ui:range5m': { zh: '近 5 分钟', en: 'Last 5 minutes' },
  'ui:selectTimeRange': { zh: '选择时间范围', en: 'Select time range' },
  'ui:sampling': { zh: '采样中（15s 一次，至少 2 个点后出图）', en: 'Sampling (every 15s; chart appears after at least 2 points)' },
  'ui:mem': { zh: '内存', en: 'Memory' },
  // prompt-input
  'ui:permReadonly': { zh: '只读', en: 'Read-only' },
  'ui:permConfirm': { zh: '写确认', en: 'Confirm writes' },
  'ui:permFull': { zh: '完全权限', en: 'Full access' },
  'ui:permissionAria': { zh: '权限：{v}', en: 'Permission: {v}' },
  'ui:modelAria': { zh: '模型：{v}', en: 'Model: {v}' },
  'ui:promptPlaceholder': { zh: '输入问题', en: 'Ask a question' },
  'ui:attachFile': { zh: '附加文件', en: 'Attach file' },
  'ui:attachNoContent': { zh: '未附内容（二进制文件，或超过 50KB）', en: 'No content attached (binary file, or over 50KB)' },
  'ui:removeFile': { zh: '移除 {name}', en: 'Remove {name}' },
  'ui:message': { zh: '消息', en: 'Message' },
  'ui:stopGeneration': { zh: '停止生成', en: 'Stop generating' },
  'ui:send': { zh: '发送', en: 'Send' },
  // command
  'ui:searchResources': { zh: '搜索资源', en: 'Search resources' },
  'ui:searchResourcesHint': { zh: '输入资源名称、Kind 或集群', en: 'Enter a resource name, Kind or cluster' },
}
