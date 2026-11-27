// pf 字典：Pod 端口转发面板 + api/portforward.ts。ns = pf
import type { Entry } from './strings'

export const STRINGS_PF: Record<string, Entry> = {
  // ---- PodDetailPage tab ----
  'pf:tabPortForward': { zh: '端口转发', en: 'Port-forward' },
  'pf:proxyFallbackHint': { zh: '打不开？改用端口转发（TCP）', en: 'Not working? Use port-forward (TCP)' },

  // ---- PortForwardPanel：创建区 ----
  'pf:listenHint': {
    zh: '转发端口监听在运行 headlamp-server 的主机（{host}）的 localhost 上，并非浏览器所在机器；能否访问取决于你到该主机的网络可达性。',
    en: 'Forwarded ports listen on localhost of the machine running headlamp-server ({host}), not on your browser machine; access depends on your network reach to that host.',
  },
  'pf:targetPort': { zh: '目标端口', en: 'Target port' },
  'pf:selectPort': { zh: '选择 Pod 声明端口', en: 'Select a declared port' },
  'pf:customPort': { zh: '手动输入端口…', en: 'Custom port…' },
  'pf:customPortPlaceholder': { zh: '如 8080 或 http', en: 'e.g. 8080 or http' },
  'pf:start': { zh: '开始转发', en: 'Start' },
  'pf:starting': { zh: '启动中…', en: 'Starting…' },
  'pf:started': { zh: '已启动转发，服务器端口 {port}', en: 'Forward started, server port {port}' },

  // ---- PortForwardPanel：列表 ----
  'pf:colTarget': { zh: 'Pod 端口', en: 'Pod port' },
  'pf:colServer': { zh: '服务器端口', en: 'Server port' },
  'pf:colStatus': { zh: '状态', en: 'Status' },
  'pf:colAction': { zh: '操作', en: 'Actions' },
  'pf:statusRunning': { zh: '运行中', en: 'Running' },
  'pf:statusReconnecting': { zh: '重连中', en: 'Reconnecting' },
  'pf:statusStopped': { zh: '已停止', en: 'Stopped' },
  'pf:open': { zh: '打开', en: 'Open' },
  'pf:stop': { zh: '停止', en: 'Stop' },
  'pf:empty': { zh: '当前 Pod 没有端口转发。', en: 'No port-forwards for this pod.' },
  'pf:loadFailed': { zh: '加载转发列表失败：{error}', en: 'Failed to load port-forwards: {error}' },
  'pf:autoCleanup': {
    zh: '已停止的记录会保留在服务端缓存中，直到被删除或 headlamp-server 重启；此处「停止」会直接删除记录。',
    en: 'Stopped records stay in the server cache until deleted or headlamp-server restarts; "Stop" here deletes the record outright.',
  },

  // ---- PortForwardPanel：停止确认 ----
  'pf:stopTitle': { zh: '停止此端口转发？', en: 'Stop this port-forward?' },
  'pf:stopDesc': {
    zh: '将停止 {pod}:{targetPort} → :{port} 的转发并删除记录。',
    en: 'Stops forwarding {pod}:{targetPort} → :{port} and deletes the record.',
  },
  'pf:stopConfirm': { zh: '停止并删除', en: 'Stop & delete' },
  'pf:stoppedToast': { zh: '转发已停止', en: 'Port-forward stopped' },
  'pf:stopFailed': { zh: '停止失败：{error}', en: 'Failed to stop: {error}' },
}
