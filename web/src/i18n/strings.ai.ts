// ai 字典：AI 助手（AiChat/AiChatFab/AiPage/server-transport）+ api/ai.ts。ns = ai
// 特殊文案：工具名/模型名/工具标签里的英文专名两种语言同值。
import type { Entry } from './strings'

export const STRINGS_AI: Record<string, Entry> = {
  // ---- 通用 ----
  'ai:assistant': { zh: 'AI 助手', en: 'AI Assistant' },
  'ai:thinking': { zh: '思考中…', en: 'Thinking…' },
  'ai:traceSummary': { zh: '已完成 {n} 步', en: 'Completed {n} steps' },
  'ai:traceFails': { zh: '{n} 失败', en: '{n} failed' },
  'ai:retryRefill': { zh: '取回重发', en: 'Refill to retry' },
  'ai:scrollToEnd': { zh: '滚动到底部', en: 'Scroll to end' },
  'ai:thinkingDone': { zh: '已思考', en: 'Reasoned' },
  'ai:loading': { zh: '加载中…', en: 'Loading…' },
  'ai:close': { zh: '关闭', en: 'Close' },
  'ai:autoAllowedHint': { zh: '这些工具已获本会话免询授权，后续直接执行；授权事件已进审计。换权限档即失效。', en: 'These tools run without approval in this session. The grant is audited; switching permission mode revokes it.' },
  'ai:autoAllowedSuffix': { zh: '本会话免询', en: 'no-approval this session' },
  'ai:autoAllowFail': { zh: '免询授权登记失败，同名工具仍会逐次询问', en: 'Auto-allow registration failed; this tool will keep asking' },
  'ai:inboxTitle': { zh: '待批准收件箱', en: 'Approval inbox' },
  'ai:inboxExpire': { zh: '{min} 分钟后自动拒绝', en: 'auto-denies in {min} min' },
  'ai:fabPendingByCluster': { zh: '等 {list} 集群的写操作待你批准（10 分钟未裁决自动拒绝）', en: 'Writes awaiting your approval on {list} (auto-denied after 10 minutes)' },
  'ai:running': { zh: 'AI 正在工作', en: 'AI is working' },
  // ---- 工具标签（TOOL_META 的 label 存 i18n key，渲染处经 t() 取值） ----
  'ai:toolClusterOverview': { zh: '集群概览', en: 'Cluster overview' },
  'ai:toolTop': { zh: '资源水位', en: 'Resource usage (top)' },
  'ai:toolListPods': { zh: '查询 Pod 列表', en: 'List pods' },
  'ai:toolGetPod': { zh: '查看 Pod 详情', en: 'Get pod details' },
  'ai:toolPodLogs': { zh: '查看日志', en: 'View logs' },
  'ai:toolListEvents': { zh: '查询事件', en: 'List events' },
  'ai:toolListDeployments': { zh: '查询 Deployment', en: 'List deployments' },
  'ai:toolHelmReleases': { zh: '查询 Helm 发布', en: 'List Helm releases' },
  'ai:toolK8sGet': { zh: '泛型读取', en: 'Generic read' },
  'ai:toolK8sRequest': { zh: '泛型请求', en: 'Generic request' },
  'ai:toolApplyYaml': { zh: '应用 YAML', en: 'Apply YAML' },
  'ai:toolDeleteResource': { zh: '删除资源', en: 'Delete resource' },
  'ai:toolScale': { zh: '扩缩容', en: 'Scale resource' },
  'ai:toolRollout': { zh: '发布管理', en: 'Manage rollout' },
  'ai:toolWaitRollout': { zh: '等发布收敛', en: 'Await rollout convergence' },
  'ai:toolPatchResource': { zh: '补丁资源', en: 'Patch resource' },
  'ai:toolHelmInstall': { zh: '安装 Helm', en: 'Install Helm' },
  'ai:toolHelmUpgrade': { zh: '升级 Helm', en: 'Upgrade Helm' },
  'ai:toolHelmUninstall': { zh: '卸载 Helm', en: 'Uninstall Helm' },
  'ai:toolHelmRollback': { zh: '回滚 Helm', en: 'Rollback Helm' },
  'ai:toolExecPod': { zh: '容器执行', en: 'Exec in pod' },
  'ai:toolNodeView': { zh: '节点视图', en: 'Node view' },
  'ai:toolDrain': { zh: '排空节点', en: 'Drain node' },
  'ai:toolDiffYaml': { zh: 'YAML 差异预览', en: 'Diff YAML' },
  'ai:toolDiagnose': { zh: '命名空间诊断', en: 'Diagnose namespace' },
  'ai:toolInspectReport': { zh: '巡检报告', en: 'Inspect report' },
  'ai:toolDispositionSet': { zh: '标记处置', en: 'Set disposition' },
  // ---- 工具执行状态 ----
  'ai:approvedRunning': { zh: '已批准，执行中…', en: 'approved, running…' },
  'ai:approveSession': { zh: '批准（本会话同类）', en: 'Approve (session)' },
  'ai:approveSessionHint': {
    zh: '本会话内该工具的后续操作不再询问（新会话或切换权限档后失效）',
    en: 'Stop asking for this tool in this session (resets on new session or permission change)',
  },
  'ai:approvalStalled': {
    zh: '已裁决，等待续流；若长时间无响应（审批过期/集群切换），请重新提问',
    en: 'decided, awaiting resume; if it stalls (approval expired / cluster switched), ask again',
  },
  'ai:denied': { zh: '已拒绝', en: 'Denied' },
  'ai:deniedBody': { zh: '用户拒绝了该操作，未执行', en: 'Denied by the user; not executed.' },
  'ai:failedLabel': { zh: '{label}失败', en: '{label} failed' },
  'ai:params': { zh: '参数', en: 'Parameters' },
  'ai:error': { zh: '错误', en: 'Error' },
  'ai:result': { zh: '结果', en: 'Result' },
  'ai:denyWithNote': { zh: '拒绝并说明', en: 'deny with reason' },
  'ai:denyNotePh': { zh: '为什么否决（给 AI 和交班看）', en: 'why denied (for the AI & handover)' },
  'ai:staleLabel': { zh: '{label} · 中断未生效', en: '{label} · voided' },
  'ai:staleRefill': { zh: '把原请求填回输入框', en: 'refill original request' },
  'ai:noOutput': { zh: '无输出', en: 'No output' },
  // ---- 写确认批准卡 ----
  'ai:approvalTitle': { zh: '写操作需要批准：', en: 'Write operation requires approval: ' },
  'ai:approvalWarning': {
    zh: '批准后操作将直接生效于集群',
    en: 'Once approved, the operation takes effect on the cluster directly.',
  },
  'ai:deny': { zh: '拒绝', en: 'Deny' },
  'ai:approve': { zh: '批准执行', en: 'Approve' },
  // ---- 附件（拼进用户消息，经 tf() 取值） ----
  'ai:attachmentContent': {
    zh: '\n\n附件：\n\n### {name}\n```\n{content}\n```',
    en: '\n\nAttachment:\n\n### {name}\n```\n{content}\n```',
  },
  'ai:attachmentBinary': {
    zh: '\n\n附件：{name}（二进制或超过 50KB，未附内容）',
    en: '\n\nAttachment: {name} (binary or over 50KB, content not included)',
  },
  // ---- 会话历史 ----
  'ai:history': { zh: '历史会话', en: 'History' },
  'ai:noSessions': { zh: '暂无历史会话', en: 'No past sessions' },
  'ai:unnamedSession': { zh: '（未命名会话）', en: '(Unnamed session)' },
  'ai:currentSession': { zh: ' · 当前会话', en: ' · current' },
  'ai:newSession': { zh: '新会话', en: 'New session' },
  'ai:restoringSession': { zh: '恢复会话…', en: 'Restoring session…' },
  // ---- 加载 / 空态 ----
  'ai:loadingModels': { zh: '加载模型列表…', en: 'Loading models…' },
  'ai:serviceNotReady': { zh: 'AI 执行服务未就绪', en: 'AI exec service not ready' },
  'ai:serviceNotReadyDesc': {
    zh: 'AI 执行服务未启动或模型列表为空，请检查容器内 ai-exec 进程与 /ai 反向代理。',
    en: 'The AI exec service is not running or the model list is empty. Check the ai-exec process in the container and the /ai reverse proxy.',
  },
  'ai:emptyDesc': {
    // 主语前缀删（页头已说明是谁）；安全披露保留
    zh: '查询 / 变更 / 容器执行，操作直接生效；重大变更前先说明并预览',
    en: 'Query / modify / exec — changes take effect directly; major changes are explained and previewed first',
  },
  // ---- 错误（server-transport / api 执行期 t()、tf() 取值） ----
  'ai:unreachable': {
    zh: 'AI 执行服务不可达，请检查服务状态后重试。',
    en: 'AI exec service unreachable. Please check the service status and retry.',
  },
  'ai:unreachableShort': { zh: 'AI 执行服务不可达', en: 'AI exec service unreachable' },
  'ai:serverError': { zh: 'AI 执行服务异常（HTTP {status}）', en: 'AI exec service error (HTTP {status})' },
  'ai:apiError': { zh: 'AI 执行服务错误（HTTP {status}）', en: 'AI exec service error (HTTP {status})' },
}
