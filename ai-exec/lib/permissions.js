// @ts-check
/**
 * 工具执行权限层（三档，前端输入框可选，随每次 /chat 下发）：
 * - readonly 只读：仅只读工具可执行；写/执行工具直接拒绝（error 结果回给模型，
 *   模型据此改走只读路径或向用户说明）
 * - confirm 写确认（默认）：只读工具直接执行；写/执行工具执行前挂起等用户批准——
 *   经 notify 发 AI SDK 原生 `tool-approval-request` chunk → 前端渲染批准卡
 *   （useChat 原生 addToolApprovalResponse）→ 前端自动重发 /chat 请求
 *   （body 携带 approvals[]）→ server 的续流处理器 resolve 挂起的门，
 *   同一 SSE 协议把工具结果与后续回复流回（见 server.js handleApprovalContinuation）
 * - full 完全权限：全部工具直接执行
 *
 * 挂起语义（spec：AI SDK 原生审批是请求级续流）：
 * - 门挂起时先写 approval-request chunk，再调 onPause：服务端据此提前收尾当前 SSE
 *   （finish 帧 + [DONE]），但 pi run 保持 parked（工具 promise 未决，session 存活）
 * - 写类工具全部 sequential 执行（tools.js），同 session 同时至多一个挂起门，
 *   不存在"多张审批卡同时等待"
 * - 会话释放 / run 中止时未决批准一并拒绝，不留悬挂 promise
 *
 * 执行点 = 每个工具 execute 的包装（pi SDK 的 ToolDefinition 无权限钩子）。
 * 模式是每会话可变状态（server.js 在每次 /chat 前更新，工具执行时读取）；
 * 会话释放 / run 中止时未决批准一并拒绝，不留悬挂 promise。
 */

/** @typedef {'readonly' | 'confirm' | 'full'} PermissionMode */

import { config } from './config.js'
import { effective } from './overrides.js'
import { record as auditRecord } from './audit.js'
import { notify } from './notify.js'

export const PERMISSION_MODES = ['readonly', 'confirm', 'full']

/** 只读工具（任何模式都直接执行）。其余为写/执行工具；
 *  k8s_get/k8s_request 是泛型 API 入口，按「smart 门」管控（用户决策 2026-11）：
 *  非敏感路径的 GET 直接执行，secrets 读取与非 GET 一律走批准门——此前整类
 *  按写管控，实测 confirm 模式下连读一个 Service 都弹批准卡，任务寸步难行。
 *  drain 虽是排障入口，但会驱逐 Pod，走写确认门。 */
export const READ_TOOLS = new Set([
  'cluster_overview',
  'top',
  'list_pods',
  'get_pod',
  'pod_logs',
  'list_events',
  'list_deployments',
  'helm_releases',
  'node_view',
  'diff_yaml',
  'diagnose',
  'inspect_report',
])

/**
 * smart 门：泛型工具（k8s_get/k8s_request）的自动放行判定。
 * 放行 = 该次调用确定是「非敏感路径的只读」：
 * - k8s_get 天然 GET，但 decodeSecret=true 是明示要 Secret 明文，必走门；
 * - k8s_request 仅 GET 可放行（写方法一律走门）；
 * - 路径按完整段命中 secrets 即敏感（k8s 复数资源名；单复数/大小写不敏感，
 *   段精确匹配避免误伤 foo-secrets-x 命名空间名之类合法目标）。
 * serviceaccounts 的 token 读取是 POST 子资源 → 走非 GET 分支被拦，无需单列。
 * @param {string} name
 * @param {unknown} params execute 的 params（形状异常一律保守走门）
 * @returns {boolean}
 */
export function isAutoAllowedGenericRead(name, params) {
  if (name !== 'k8s_get' && name !== 'k8s_request') return false
  const p = /** @type {{ apiPath?: unknown; method?: unknown; decodeSecret?: unknown }} */ (
    params && typeof params === 'object' ? params : {}
  )
  if (typeof p.apiPath !== 'string' || !p.apiPath) return false
  if (name === 'k8s_request' && p.method !== 'GET') return false
  if (p.decodeSecret === true) return false
  const path = p.apiPath.split('?')[0] ?? ''
  return !path.toLowerCase().split('/').includes('secrets')
}

/** @param {string} name @returns {boolean} */
export function isReadTool(name) {
  return READ_TOOLS.has(name)
}

/** 每会话可变权限状态（mode 由 server.js 在每次 /chat 前更新） */
/** @param {PermissionMode} [mode] @returns {{ mode: PermissionMode }} */
export function createPermState(mode = 'confirm') {
  return { mode }
}

/**
 * 会话级同类工具自动放行（批准卡第三键「批准且本会话不再询问该工具」，
 * 用户决策 2026-11——AI 多步写任务逐卡点批准是产品核心卖点反模式）。
 * 边界：confirm 档生效；readonly 一律拒绝不受影响；会话释放即清空；
 * secrets/decodeSecret 在进 gateWriteTool 之前就被 smart 门拦下，autoAllow
 * 放不到 secrets（tools.js 先 smart 后 gate 的顺序即防线）。
 * @type {Map<string, Set<string>>}
 */
const autoAllow = new Map()

/** @param {string} sessionId @param {string} toolName */
export function allowToolForSession(sessionId, toolName) {
  const s = autoAllow.get(sessionId) ?? new Set()
  s.add(toolName)
  autoAllow.set(sessionId, s)
}

/** 某会话当前的同类自动放行清单（前端展示/审计用） */
/** @param {string} sessionId @returns {string[]} */
export function autoAllowedTools(sessionId) {
  return [...(autoAllow.get(sessionId) ?? [])]
}

/** 清空某会话同类自动放行（权限档变更=用户收紧授权动作，白名单随之作废） */
/** @param {string} sessionId */
export function clearAutoAllowForSession(sessionId) {
  autoAllow.delete(sessionId)
}

/**
 * 待批准队列：toolCallId → { sessionId, settle }。
 * settle(approved) 由 decideApproval / 中止 / 会话释放触发（幂等，见 gateWriteTool 内 settled 标记）。
 * 元数据（toolName/cluster/expiresAt）供 FAB 待批准角标与审计 deny 反查——「等你批准」是值班真待办，
 * 不能只活在闭包里（切窗口即从产品消失）。
 * @type {Map<string, { sessionId: string; toolName: string; cluster: string; expiresAt: number; settle: (approved: boolean, note?: string) => void }>}
 */
const pending = new Map()

/** 挂起审批超时（毫秒）：防止无人裁决的 parked run 永久占用会话 */
/** 面板深链（PANEL_BASE_URL 未配时返回 undefined，消息不带链接）：webhook 点击直达裁决现场 */
/** @param {{ cluster?: string, sessionId?: string }} ctx */
function panelDeepLink(ctx) {
  const base = effective('panelBaseUrl')
  if (!base || !ctx.cluster || !ctx.sessionId) return undefined
  return `${base}/c/${encodeURIComponent(ctx.cluster)}/ai?session=${encodeURIComponent(ctx.sessionId)}`
}

export const APPROVAL_TTL_MS = 10 * 60_000

/**
 * 写/执行工具的权限闸门（只读工具调用方跳过，不走这里）。
 * @param {string} toolName
 * @param {{ mode: PermissionMode, sessionId: string, toolCallId: string, input: unknown, cluster?: string,
 *          signal: AbortSignal | undefined,
 *          notify: (chunk: Record<string, unknown>) => void,
 *          onPause?: () => void }} ctx
 * @returns {Promise<{ ok: true } | { ok: false; reason: string }>}
 */
export function gateWriteTool(toolName, ctx) {
  if (ctx.mode === 'full') return Promise.resolve({ ok: true })
  if (ctx.mode === 'readonly') {
    return Promise.resolve({
      ok: false,
      reason: `当前权限模式为「只读」，不允许执行写/执行操作 ${toolName}。只读档可用的查询工具：${[...READ_TOOLS].join('、')}（清单外资源无通用 GET）；如需更多能力请提示用户切换权限模式后重试。`,
    })
  }
  // confirm：先查会话级同类自动放行（批准卡第三键授权过），未命中才发审批帧
  if (autoAllow.get(ctx.sessionId)?.has(toolName)) return Promise.resolve({ ok: true })
  return new Promise((resolve) => {
    /** @type {boolean} */
    let settled = false
    /** @type {NodeJS.Timeout} */
    let ttl
    /** @param {boolean} ok @param {string} [reason] */
    let settle = (ok, reason) => {
      if (settled) return
      settled = true
      clearTimeout(ttl)
      pending.delete(ctx.toolCallId)
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort)
      resolve(ok ? { ok: true } : { ok: false, reason: reason || '操作未执行' })
    }
    const onAbort = () => {
      // 中止同样是审批的结局：FAB 角标无声减一而账面无痕 = 「全账」声明破功
      try {
        auditRecord({ source: 'ai', actor: ctx.sessionId, cluster: ctx.cluster ?? '', verb: 'expired', target: toolName, summary: '运行中止，未决审批作废' })
      } catch { /* 审计失败不拦收敛 */ }
      settle(false, '操作已中止，未执行')
    }
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true })
    // 挂起审批 TTL：用户刷新/关页后无人裁决，run 不能永久 parked 堵死会话——超时按拒绝收敛。
    // 超时也是账面事件（与手动 deny 同权进审计）：交班 MD 预告的「未裁决将自动拒绝」必须可查
    ttl = setTimeout(() => {
      try {
        auditRecord({ source: 'ai', actor: ctx.sessionId, cluster: ctx.cluster ?? '', verb: 'expired', target: toolName, summary: '审批超时（10 分钟未裁决），已自动拒绝' })
      } catch { /* 审计失败不拦收敛 */ }
      notify(`[K8S] ${ctx.cluster ?? ''} 的写审批「${toolName}」10 分钟无人裁决，已自动拒绝`, panelDeepLink(ctx))
      settle(false, '审批超时（10 分钟未裁决），已自动拒绝；如仍需执行请重新发起')
    }, APPROVAL_TTL_MS)
    // 挂起过半（5 分钟）仍无人裁决即提醒：等 TTL 到点才发现 = 值班干预已经失败过一次
    const nudge = setTimeout(() => notify(`[K8S] ${ctx.cluster ?? ''} 的写审批「${toolName}」已挂起 5 分钟，5 分钟后将自动拒绝`, panelDeepLink(ctx)), APPROVAL_TTL_MS / 2)
    nudge.unref()
    const _origSettle = settle
    settle = (/** @type {boolean} */ ok, /** @type {string | undefined} */ reason) => {
      clearTimeout(nudge)
      _origSettle(ok, reason)
    }
    pending.set(ctx.toolCallId, {
      sessionId: ctx.sessionId,
      toolName,
      cluster: ctx.cluster ?? '',
      expiresAt: Date.now() + APPROVAL_TTL_MS,
      // 拒绝理由（「拒绝并说明」）进 tool result：模型据此收敛，不再重提同一写操作
      settle: (approved, note) => settle(approved, approved ? undefined : note ? `用户拒绝了该操作，理由：${note}` : '用户拒绝了该操作'),
    })
    // approvalId 直接用 toolCallId（单一 id 空间：客户端 part.approval.id === part.toolCallId）
    ctx.notify({
      type: 'tool-approval-request',
      approvalId: ctx.toolCallId,
      toolCallId: ctx.toolCallId,
      reason: `写/执行操作 ${toolName} 将直接生效于集群；10 分钟未裁决自动拒绝`,
    })
    // 服务端提前收尾当前 SSE（run 保持 parked，等审批续流请求 resolve 本门）
    ctx.onPause?.()
  })
}

/**
 * 裁决入口（由审批续流请求触发：POST /chat body.approvals[]）。
 * sessionId 必须与挂起项归属一致——toolCallId 可经 GET /ai/sessions* 枚举获得，
 * 不校验归属等于任何能达 /ai 的客户端都能批准他人会话的写操作。
 * @param {string} toolCallId @param {boolean} approved @param {string} sessionId
 * @returns {boolean} false = 无此待批准项（已裁决/已中止/已过期/归属不符）
 */
/** @param {string} toolCallId @param {boolean} approved @param {string} sessionId @param {string} [note] 拒绝理由（「拒绝并说明」） */
export function decideApproval(toolCallId, approved, sessionId, note) {
  const p = pending.get(toolCallId)
  if (!p || p.sessionId !== sessionId) return false
  p.settle(approved, note)
  return true
}

/** 全局待批准项（FAB 角标 / deny 审计反查 toolName 用） */
export function pendingItems() {
  return [...pending.entries()].map(([toolCallId, p]) => ({
    toolCallId,
    sessionId: p.sessionId,
    toolName: p.toolName,
    cluster: p.cluster,
    expiresAt: p.expiresAt,
  }))
}

/**
 * 某会话当前挂起审批的 toolCallId 集合（重开会话时 ui-message 用它把
 * 「已发出但无结果」的 toolCall part 还原成 approval-requested，审批卡可恢复）。
 * @param {string} sessionId @returns {Set<string>}
 */
export function pendingToolCallIds(sessionId) {
  const ids = new Set()
  for (const [id, p] of pending) if (p.sessionId === sessionId) ids.add(id)
  return ids
}

/**
 * 会话释放（LRU 淘汰/进程退出）：拒绝其全部待批准项
 * @param {string} sessionId
 */
export function clearPendingForSession(sessionId) {
  autoAllow.delete(sessionId)
  for (const [id, p] of pending) {
    if (p.sessionId === sessionId) {
      pending.delete(id)
      try {
        auditRecord({ source: 'ai', actor: sessionId, cluster: p.cluster ?? '', verb: 'expired', target: p.toolName ?? '', summary: '会话释放（LRU/退出），未决审批作废' })
      } catch { /* 审计失败不拦收敛 */ }
      p.settle(false)
    }
  }
}
