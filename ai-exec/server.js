// @ts-check
/**
 * K8S Dashboard AI 执行层（ai-exec）入口。
 *
 * 只监听 127.0.0.1:4470；唯一入口是 headlamp-server 的 /ai/* 反代（Go 侧 SSE 透传）。
 *
 * HTTP 契约（流协议映射表见 lib/adapter.js 头部）：
 * - POST /chat           → SSE（UIMessageStream 协议，帧 `data: <UIMessageChunk json>\n\n`，
 *                         结束 `data: [DONE]\n\n`；首帧 start 的 messageMetadata 带 sessionId）
 *                         两种 body 形态：
 *                         (a) 普通 prompt：{ sessionId?, cluster, message, model?, permission? }
 *                         (b) 审批续流（AI SDK 原生审批，请求级续流）：
 *                             { sessionId, messageId, cluster, approvals: [{ toolCallId, approved }] }
 *                             ——resolve 挂起的确认门，续流同一 run（见 handleApprovalContinuation）
 *                         permission: readonly|confirm|full，缺省 confirm（写操作先批准）；
 *                         confirm 模式下写工具执行前发 tool-approval-request chunk 并提前收尾本流，
 *                         run 保持 parked 等审批续流
 * - GET  /sessions       ?cluster= 过滤 → { id, title, cluster, updatedAt }[]（title=首条用户消息截断）
 * - GET  /sessions/:id   → UIMessage[]（跨设备恢复）
 * - POST /sessions/:id/abort → { aborted: boolean }
 * - GET  /models         → { id, name }[]
 *
 * 错误约定：SSE 内 error part（UI 友好文案）；HTTP 4xx 仅协议级错误（参数缺失/会话不存在/模型不可用）。
 * 并发约定：同一 session 正在 run 时，新 prompt 按 pi followUp 语义排队（observer 流转发）。
 */
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { UIMessageStreamAdapter } from './lib/adapter.js'
import { config } from './lib/config.js'
import { listModels, modelRuntime, refreshLlmRuntime, resolveModel } from './lib/model.js'
import { SessionRegistry, readMeta } from './lib/sessions.js'
import { toUIMessages } from './lib/ui-message.js'
import { PERMISSION_MODES, decideApproval, pendingToolCallIds, pendingItems, allowToolForSession, autoAllowedTools, clearAutoAllowForSession } from './lib/permissions.js'
import { record as auditRecord, list as auditList } from './lib/audit.js'
import { notify, lastNotify } from './lib/notify.js'
import { effective, readOverrides, writeOverrides } from './lib/overrides.js'
import { save as handoverSave, get as handoverGet, listRecent as handoverListRecent, listAll as handoverListAll, markAcked as handoverMarkAcked } from './lib/handover.js'
import { listDaily } from './lib/daily.js'
import { record as dispRecord, listLatest as dispList } from './lib/disposition.js'
import { inspectCluster, listReports } from './lib/inspect.js'

const registry = new SessionRegistry()

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

/** 日志前缀（entrypoint 合并两进程日志时区分用） */
/** @param {unknown[]} args */
function log(...args) {
  console.log(`[ai-exec] ${new Date().toISOString()}`, ...args)
}

// ---------- 小工具 ----------

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

/** 协议级错误 */
class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** 读 JSON body（上限 1MB） */
/** @param {import('node:http').IncomingMessage} req @returns {Promise<Record<string, unknown>>} */
async function readJsonBody(req) {
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) throw new HttpError(400, '缺少 JSON 请求体')
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  return parsed
}

/** 面向 UI 的错误文案（SSE error part 用） */
/** @param {unknown} e @returns {string} */
function friendlyError(e) {
  if (!String(effective('llmGatewayBase'))) return 'AI 未配置：请在「设置 → AI 服务」填写模型网关，或注入环境变量 LLM_GATEWAY_BASE'
  if (e instanceof HttpError) return e.message
  const msg = e instanceof Error ? e.message : String(e)
  if (/api key|authentication|auth/i.test(msg)) return `LLM 凭据未配置或失效：${msg}`
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout/i.test(msg)) {
    return `LLM 网关（${effective('llmGatewayBase')}）暂不可达，请检查网络后重试。`
  }
  return `AI 请求失败：${msg}`
}

/** 会话不存在（registry 抛出的自定义错误） */
/** @param {unknown} e @returns {boolean} */
function isNotFound(e) {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === 'NOT_FOUND'
}

// ---------- 端点 ----------

/** 页面行消毒：压成单行、限长（客户端可控输入，仅进 prompt 文本） */
/** @param {string} raw @returns {string} */
function pageSanitize(raw) {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 400)
}

/** POST /chat → SSE（UIMessageStream） */
/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @returns {Promise<void>} */
async function handleChat(req, res) {
  const body = await readJsonBody(req)
  const cluster = typeof body.cluster === 'string' ? body.cluster.trim() : ''
  const message = typeof body.message === 'string' ? body.message : ''
  const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null
  const modelId = typeof body.model === 'string' && body.model ? body.model : undefined
  const permission = typeof body.permission === 'string' && body.permission ? body.permission : null
  // 页面感知：前端随每轮附当前页面语义行（[当前页面] …；地址 …），
  // 拼进用户消息首行 → 入会话历史，AI 按轮知道用户浏览位置（审批续流不带）
  const page = typeof body.page === 'string' ? pageSanitize(body.page) : ''
  const promptText = page && message.trim() ? `${page}\n${message}` : message
  /** 审批续流：前端 addToolApprovalResponse 自动重发时携带（非新一轮 prompt） */
  const approvals = Array.isArray(body.approvals)
    ? body.approvals
        .filter(
          (a) =>
            a &&
            typeof a === 'object' &&
            typeof a.toolCallId === 'string' &&
            typeof a.approved === 'boolean',
        )
        .map((a) => ({ toolCallId: a.toolCallId, approved: a.approved, ...(typeof a.note === 'string' ? { note: a.note } : {}) }))
    : []
  const messageId = typeof body.messageId === 'string' && body.messageId ? body.messageId : null

  if (!cluster) throw new HttpError(400, '缺少 cluster')
  if (approvals.length > 0) {
    if (!sessionId) throw new HttpError(400, '审批请求缺少 sessionId')
  } else if (!message.trim()) {
    throw new HttpError(400, '缺少 message')
  }
  if (sessionId && !SESSION_ID_RE.test(sessionId)) throw new HttpError(400, 'sessionId 格式非法')
  if (permission && !PERMISSION_MODES.includes(permission)) {
    throw new HttpError(400, 'permission 必须是 readonly|confirm|full')
  }
  if (modelId) {
    try {
      await resolveModel(modelId)
    } catch (e) {
      throw new HttpError(400, friendlyError(e))
    }
  }

  /** @type {import('./lib/sessions.js').SessionRecord} */
  let rec
  // 审批续流不是新 prompt：不得改写会话绑定集群/模型——acquire 会无条件改绑
  // clusterRef 并 writeMeta（sessions.js），R1 版把检查放在 acquire 之后读到的是
  // 本次请求携带的 cluster，403 恒不可达（R2 P0-2）。必须在 acquire 前读 bound，
  // 并用 bound 覆盖续流的 acquire 入参（合法用户挂起期间切 UI 集群再批准，同样
  // 静默写错集群——不止攻击者）。
  const isApprovalContinuation = approvals.length > 0
  const bound = sessionId ? readMeta(sessionId) : null
  if (isApprovalContinuation && bound && cluster && bound !== cluster) {
    throw new HttpError(403, '审批续流的集群与会话创建集群不一致，已拒绝')
  }
  try {
    rec = await registry.acquire(
      sessionId,
      isApprovalContinuation && bound ? bound : cluster,
      // 续流不换模型：parked run 的执行语境不由续流请求改写
      isApprovalContinuation ? undefined : modelId,
    )
  } catch (e) {
    if (isNotFound(e)) throw new HttpError(404, friendlyError(e))
    throw new HttpError(500, friendlyError(e))
  }
  // 每轮请求前更新工具执行权限（缺省沿用会话当前值；新会话默认 confirm；
  // 续流冻结——防「续流时提 full 跳后续工具门」）。档位变化=用户收紧/重设授权，
  // 会话级同类自动放行一并作废（批准卡第三键的文案承诺）
  if (permission && !isApprovalContinuation) {
    if (rec.permRef.mode !== permission) clearAutoAllowForSession(rec.id)
    rec.permRef.mode = /** @type {'readonly' | 'confirm' | 'full'} */ (permission)
  }

  // SSE 响应头（Go 反代侧逐帧 flush，这里 Node 端 res.write 即发出）
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')

  const write = /** @param {Record<string, unknown>} chunk */ (chunk) => {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }

  const reqId = randomUUID()
  let ended = false
  const finishResponse = () => {
    if (ended) return
    ended = true
    res.write('data: [DONE]\n\n')
    res.end()
  }

  // 审批续流（AI SDK 原生审批 = 请求级续流）：不是新 prompt，resolve 挂起的确认门，
  // 订阅同一 run 的后续事件续流（见 handleApprovalContinuation）
  if (isApprovalContinuation) {
    return await handleApprovalContinuation(res, write, finishResponse, rec, approvals, messageId)
  }

  // pi 统一处理并发语义（spec：同 session 并发 prompt 排队 followUp）：
  // 会话正在 run 时 prompt() 按 streamingBehavior:'followUp' 入队，否则直接开新 run。
  // preflightResult 回调告诉我们本请求扮演的角色：
  //   'started' → 本次 run 的归属方（随后事件即本 run 的事件，adapter 转为转发）
  //   'queued'  → 排队请求（observer：等本条消息投递后才转发）
  //   'handled' → 被扩展 input 钩子消费
  // 'started' 严格早于本 run 第一个事件（_startRun 先调 onStarted 再 agent.prompt），无竞态。
  const adapter = new UIMessageStreamAdapter({
    write,
    sessionId: rec.id,
    waitForUserText: promptText, // 先按 observer 待命；确认是 run 归属方后 activate()
  })

  adapter.onFinished = () => {
    // 关键：必须在当前事件分发结束后再退订。pi 的 _emit 用 for...of 遍历监听器数组，
    // 若某监听器在回调内退订（splice），其后所有监听器下标前移、迭代器会跳过下一个——
    // 正在收尾的流会把同时投递给其它订阅者的 user message_end 从别人那里"偷走"，
    // 导致排队请求的 adapter 永远收不到激活事件。
    queueMicrotask(unsubscribe)
    if (rec.owner === reqId) rec.owner = null
    if (rec.sseRef.write === write) {
      rec.sseRef.write = null
      rec.sseRef.onPause = null
    }
    finishResponse()
  }

  adapter.begin(randomUUID())
  // 注意：订阅要活到 adapter 收尾（onFinished）——排队请求（queued）的 prompt() 在入队后立即返回，
  // 本条消息的投递（user message_end）与后续 run 事件都在那之后才到，提前退订会永远收不到。
  const unsubscribe = rec.session.subscribe((ev) => adapter.onEvent(ev))

  // 客户端断开（Go 反代透传 abort）：仅 run 归属方触发中止，排队请求不断别人的 run
  res.on('close', () => {
    if (ended) return
    unsubscribe()
    if (rec.owner === reqId && rec.session.isStreaming) {
      void rec.session.abort().catch(() => {})
    }
  })

  let phase = null
  let promptError = null
  rec.owner = reqId
  try {
    await rec.session.prompt(promptText, {
      expandPromptTemplates: false,
      streamingBehavior: 'followUp',
      preflightResult: (p) => {
        phase = p
        if (p === 'started') {
          adapter.activate()
          // 本请求成为 run 归属方：工具执行中的权限通知（写确认帧）走本流；
          // 确认门挂起时经 onPause 提前收尾本流（run 保持 parked，等审批续流）
          rec.sseRef.write = write
          rec.sseRef.onPause = () => adapter.finishEarly()
        } else if (p === 'queued') {
          rec.owner = null
        }
      },
    })
  } catch (e) {
    promptError = e
  }

  if (phase === 'queued' || phase === null) {
    // queued：流继续，adapter 在本条消息投递后转发、agent_settled 收尾（onFinished 关流）。
    // null：agent_settled 广播窗口内被 pi 延迟执行（_deferredSettledActions），
    //       run 稍后照常开始，observer 门会在 user 消息投递时激活。
    return
  }

  if (phase === 'handled') {
    adapter.fail('消息被扩展处理，未生成回复')
  } else if (promptError && !adapter.finished) {
    adapter.fail(friendlyError(promptError))
  } else if (!adapter.finished) {
    adapter.fail('回复生成失败（未知原因）')
  }
  finishResponse()
}

/**
 * POST /chat 审批续流（body.approvals[]）：AI SDK 原生审批的续流端。
 * 不是新一轮 prompt：前端 addToolApprovalResponse 更新 part 状态后自动重发 /chat，
 * 本请求 resolve 挂起的确认门，把同一 run 的后续事件（工具结果 + 模型继续回复）
 * 按同一 UIMessageStream 协议流回。start 帧复用前端 assistant messageId，
 * 客户端把续流合并进同一条消息（不产生新气泡）。
 * 并发语义 = observer：本请求退订/断开不中止 run（结果已落 session JSONL 可恢复）。
 */
/**
 * @param {import('node:http').ServerResponse} res
 * @param {(chunk: Record<string, unknown>) => void} write
 * @param {() => void} finishResponse
 * @param {import('./lib/sessions.js').SessionRecord} rec
 * @param {Array<{ toolCallId: string; approved: boolean; note?: string }>} approvals
 * @param {string | null} messageId 前端 assistant 消息 id（续流合并目标；缺省新造）
 * @returns {Promise<void>}
 */
async function handleApprovalContinuation(res, write, finishResponse, rec, approvals, messageId) {
  const existing = /** @type {Record<string, { toolName: string }>} */ ({})
  const suppressed = new Set()
  for (const a of approvals) {
    // 客户端 part 在前一条流里已流过 input 序列：续流只补 output，不重发 input
    existing[a.toolCallId] = { toolName: '' }
    if (!a.approved) suppressed.add(a.toolCallId) // 被拒绝：part 停 output-denied，isError 结果只给模型
  }

  const adapter = new UIMessageStreamAdapter({
    write,
    sessionId: rec.id,
    existingTools: existing,
    suppressOutputs: suppressed,
  })
  adapter.begin(messageId ?? randomUUID())

  // 订阅必须先于放行门：门 resolve 后工具立即执行，tool_execution_end 不能丢
  const unsubscribe = rec.session.subscribe((ev) => adapter.onEvent(ev))
  // 本续流成为"活跃流"：同一 run 里下一个写工具门（sequential，至多再挂一个）
  // 的 approval-request 帧写本流，onPause 提前收尾本流等下一次审批
  rec.sseRef.write = write
  rec.sseRef.onPause = () => adapter.finishEarly()
  adapter.onFinished = () => {
    // 与 handleChat 同：当前事件分发结束后再退订（pi _emit 的遍历 splice 问题）
    queueMicrotask(unsubscribe)
    if (rec.sseRef.write === write) {
      rec.sseRef.write = null
      rec.sseRef.onPause = null
    }
    finishResponse()
  }

  if (!rec.session.isStreaming) {
    // run 已不存在（超时回收/已中止）：没有可续流的事件源
    adapter.fail('会话已停止，无法继续执行')
    return
  }

  for (const a of approvals) {
    // 先放行门（false = 门已裁决/已失效/归属不符：忽略，run 已自行推进）
    if (!a.approved) {
      // 否决 AI 建议=值班决策：进审计（含理由），与「忽略一条巡检」同等待遇
      const metaItem = pendingItems().find((it) => it.toolCallId === a.toolCallId)
      auditRecord({
        source: 'ai',
        actor: rec.id,
        cluster: rec.clusterRef?.value ?? '',
        verb: 'deny',
        target: metaItem?.toolName ?? a.toolCallId.slice(0, 8),
        ...(typeof a.note === 'string' && a.note ? { summary: a.note.slice(0, 200) } : {}),
      })
    }
    decideApproval(a.toolCallId, a.approved, rec.id, typeof a.note === 'string' ? a.note.slice(0, 200) : undefined)
    // 裁决同步帧：客户端本地已置 approval-responded，此帧对齐状态（幂等）
    write({ type: 'tool-approval-response', approvalId: a.toolCallId, approved: a.approved })
    if (!a.approved) {
      write({ type: 'tool-output-denied', toolCallId: a.toolCallId })
    }
  }

  // 客户端在续流中途断开：observer 语义，不中止 run
  res.on('close', () => {
    if (!adapter.finished) adapter.fail('连接已断开')
  })
}

/** GET /sessions?cluster= */
/** @param {URL} url @param {import('node:http').ServerResponse} res @returns {Promise<void>} */
async function handleSessions(url, res) {
  const clusterFilter = url.searchParams.get('cluster')
  const infos = await SessionManager.list(config.workspaceDir, config.sessionDir)
  let rows = infos.map((info) => ({
    id: info.id,
    title: titleFromFirstMessage(info.firstMessage),
    cluster: readMeta(info.id),
    updatedAt: info.modified.toISOString(),
  }))
  if (clusterFilter) rows = rows.filter((r) => r.cluster === clusterFilter)
  sendJson(res, 200, rows)
}

/** title：首条用户消息首个真实提问行（跳过 context.ts 注入的页面上下文前缀），截断 40 字符 */
/** @param {string} firstMessage @returns {string} */
function titleFromFirstMessage(firstMessage) {
  const line =
    (firstMessage || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('[当前页面]') && !l.startsWith('参考上下文') && !l.startsWith('Reference context')) ?? ''
  const text = line || '（无消息）'
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/** GET /sessions/:id → UIMessage[] */
/** @param {string} sessionId @param {import('node:http').ServerResponse} res @returns {Promise<void>} */
async function handleSessionMessages(sessionId, res) {
  if (!SESSION_ID_RE.test(sessionId)) throw new HttpError(400, 'sessionId 格式非法')
  const rec = registry.peek(sessionId)
  let messages
  if (rec) {
    messages = rec.session.messages
  } else {
    const path = SessionManager.findById(config.workspaceDir, sessionId, config.sessionDir)
    if (!path) throw new HttpError(404, '会话不存在')
    const sm = SessionManager.open(path, config.sessionDir, config.workspaceDir)
    messages = sm.buildSessionContext().messages
  }
  // 内存态会话：把挂起审批的 toolCall 还原为 approval-requested，刷新后审批卡可恢复。
  // 审批/执行中的 toolCall 只活在内存：进程重启、LRU 淘汰、10 分钟 TTL 后恢复出来的
  // 无结果调用必须显式标失效（否则前端按「执行中」渲染，用户无法分辨执行没执行）
  const staleUnresolved = !rec || !rec.session.isStreaming
  // 免询白名单随历史同路回灌（header 不改消息数组的响应形状）：刷新/深链进裁决现场后
  // 「AI 正拿着免死金牌静默写」必须还能在 UI 上看见
  res.setHeader('x-auto-allow', encodeURIComponent((rec ? autoAllowedTools(sessionId) : []).join(',')))
  sendJson(res, 200, toUIMessages(messages, rec ? pendingToolCallIds(sessionId) : new Set(), staleUnresolved))
}

/**
 * POST /autoallow { sessionId, toolName }：批准卡第三键「批准且本会话不再询问
 * 该工具」（permissions.allowToolForSession）。仅登记到存活的会话（peek），
 * 防无效会话把清单撑大；readonly 档拒绝与 secrets smart 门不受影响。
 * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
 */
async function handleAutoAllow(req, res) {
  const body = await readJsonBody(req)
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const toolName = typeof body.toolName === 'string' ? body.toolName : ''
  if (!SESSION_ID_RE.test(sessionId)) throw new HttpError(400, 'sessionId 格式非法')
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(toolName)) throw new HttpError(400, 'toolName 格式非法')
  if (!registry.peek(sessionId)) throw new HttpError(404, '会话不存在或已释放')
  allowToolForSession(sessionId, toolName)
  // 「批准且本会话免询」= 一次性授予后续同类写的权限，必须进账：
  // 否则白名单工具的写以 confirm 档面貌混在逐条批准的条目里，事后无从区分人批过 vs AI 自动写到底
  try {
    const cluster = typeof body.cluster === 'string' ? body.cluster : ''
    auditRecord({ source: 'ui', actor: sessionId, cluster, verb: 'auto_allow', target: toolName, summary: '本会话免询授权（此后同名工具直接执行）' })
  } catch { /* 审计失败不拦授权 */ }
  sendJson(res, 200, { ok: true, autoAllowed: autoAllowedTools(sessionId) })
}

/**
 * POST /audit：UI 写操作上报（client.ts put/post/patch/delete 成功后 fire-and-forget）。
 * AI 工具侧留痕在 tools.js 执行点直写同一 JSONL，两路在此汇合。
 * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
 */
async function handleAudit(req, res) {
  const body = await readJsonBody(req)
  /** @type {Record<string, string>} */
  const entry = {}
  for (const k of ['cluster', 'verb', 'target', 'actor', 'kind', 'ns', 'name', 'summary']) {
    if (typeof body[k] === 'string') entry[k] = body[k].slice(0, 500)
  }
  if (!entry.verb) throw new HttpError(400, 'verb 必填')
  auditRecord({ source: 'ui', ...entry })
  sendJson(res, 200, { ok: true })
}

/**
 * per-cluster 进行中的巡检：多标签页连点不叠加全集群扫描（同一 promise 复用） */
const inspectInflight = new Map()

/** 用户打开过巡检的集群（后台定时扫描的对象；LRU 8 个封顶，从不主动扫没人看的集群） */
const recentClusters = new Map()
/** @param {string} cluster */
function touchRecentCluster(cluster) {
  recentClusters.set(cluster, Date.now())
  if (recentClusters.size > 8) {
    const oldest = [...recentClusters.entries()].sort((a, b) => a[1] - b[1])[0]
    if (oldest) recentClusters.delete(oldest[0])
  }
}
// 重启/换 key 重建后 recentClusters 不再清零：盘上报告出现过的集群回填扫描名单（LRU 8 封顶，最近报告优先）
try {
  for (const r of listReports()) {
    if (r?.cluster) touchRecentCluster(r.cluster)
  }
} catch { /* 盘读失败不拖启动 */ }
// 旧交接档回填：ackedTs 上线前接过的班，从审计账找回凭证——否则深链页/Popover/409 闸门三处口径打架
try {
  for (const h of handoverListAll()) {
    if (h.ackedTs || !h.ackUnknown) continue
    const hit = auditList(1000, { verb: 'handover_ack', target: h.id })[0]
    if (hit) handoverMarkAcked(h.id, typeof hit.actor === 'string' ? hit.actor : '')
  }
} catch { /* 回填失败不拖启动 */ }
{
  // 值班后台心跳：定时重扫近期巡检过的集群（inflight 去重复用，与手动触发同闸口）；unref 不拖住进程退出。
  // 常驻 60s 看门狗而非 setTimeout 自续链：自续链一旦因节奏改 0 终止，UI 再改回 30 也无代码能重新点燃
  // ——「UI 可改节奏」必须是可逆的；看门狗还让 nextScanAt 有唯一权威来源（首页「下一次约 HH:MM」）
  /** @type {{ min: number, nextAt: number } | null} */
  let scanSched = null
  const scanAll = () => {
      for (const c of recentClusters.keys()) {
      if (inspectInflight.has(c)) continue
      const run = inspectCluster(c, AbortSignal.timeout(90_000))
        .then(({ diff }) => {
          // 后台扫描发现节点/负载级新异常必须能叫回离屏的值班（webhook 未配则 no-op）
          // 叫人判据按段枚举（CrashLoop 在 abnormal-pods、批量失败在 failed-jobs——前缀猜会漏叫人）
          const CRIT_SECTIONS = ['node-issues/', 'unready-workloads/', 'abnormal-pods/', 'failed-jobs/']
          const crit = (diff?.added ?? []).filter(k => CRIT_SECTIONS.some(p => String(k).startsWith(p)))
          if (crit.length > 0) {
            // 深链直达首键行（?focus 机制早已存在，此前却只链到报告页让人眼对行）
            notify(`[K8S] ${c} 巡检新增 ${crit.length} 项严重异常：${crit.slice(0, 3).map(String).join('；')}${crit.length > 3 ? ' …' : ''}`, effective('panelBaseUrl') ? `${effective('panelBaseUrl')}/c/${encodeURIComponent(c)}/inspect?view=latest&focus=${encodeURIComponent(String(crit[0]))}` : undefined)
          }
        })
        .catch(() => {})
        .finally(() => inspectInflight.delete(c))
      inspectInflight.set(c, run)
    }
  }
  setInterval(() => {
    const m = Number(effective('inspectIntervalMin'))
    if (!scanSched || scanSched.min !== m) {
      scanSched = m > 0 ? { min: m, nextAt: Date.now() + m * 60_000 } : null
    }
    if (m > 0 && scanSched && Date.now() >= scanSched.nextAt) {
      scanSched.nextAt = Date.now() + m * 60_000
      scanAll()
    }
  }, 60_000).unref()
  // 启动后第一轮不等整周期（与旧行为一致：env/UI 开着就尽快有首份 diff）
  {
    const boot = Number(effective('inspectIntervalMin'))
    if (boot > 0) {
      scanSched = { min: boot, nextAt: Date.now() + boot * 60_000 }
      setTimeout(scanAll, 5_000).unref()
    }
  }
  globalThis.__k8sScanSched = () => scanSched
}

/**
 * GET /inspect?cluster=x：全集群巡检报告（异常工作负载/Pod/节点/Warning Top/失败 Job/暂停 Cron）
 * + 与上次报告的 diff。规则口径复用 diagnose/首页已验证算法，不经 LLM。
 * @param {import('node:http').IncomingMessage & { signal?: AbortSignal }} req
 * @param {URL} url @param {import('node:http').ServerResponse} res
 */
async function handleInspect(req, url, res) {
  const cluster = url.searchParams.get('cluster') ?? 'default'
  touchRecentCluster(cluster)
  // 90s 超时驱动中止。刻意不接 req.signal：run 是 per-cluster 共享的，
  // 发起方 reload/关页若连坐 abort，会让并发等待者集体收到 AbortError
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 90_000)
  try {
    if (!inspectInflight.has(cluster)) {
      const run = inspectCluster(cluster, ac.signal).finally(() => inspectInflight.delete(cluster))
      run.catch(() => {})
      inspectInflight.set(cluster, run)
    }
    const out = await inspectInflight.get(cluster)
    sendJson(res, 200, out)
  } catch (e) {
    sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) })
  } finally {
    clearTimeout(timer)
  }
}

/** POST /sessions/:id/abort */
/** @param {string} sessionId @param {import('node:http').ServerResponse} res @returns {Promise<void>} */
async function handleAbort(sessionId, res) {
  if (!SESSION_ID_RE.test(sessionId)) throw new HttpError(400, 'sessionId 格式非法')
  const rec = registry.peek(sessionId)
  if (rec && rec.session.isStreaming) {
    await rec.session.abort()
    sendJson(res, 200, { aborted: true })
  } else {
    sendJson(res, 200, { aborted: false })
  }
}

/** GET /models */
/** @param {import('node:http').ServerResponse} res @returns {Promise<void>} */
async function handleModels(res) {
  sendJson(res, 200, await listModels())
}

/** GET /status：设置页 AI 服务只读卡的数据源——网关不可达/模型为空时新人没有 UI 线索，
 * 不该被要求去命令行看日志 */
/** @param {import('node:http').ServerResponse} res @returns {Promise<void>} */
async function handleStatus(res) {
  const base = { gateway: String(effective('llmGatewayBase')), llmKeySet: !!effective('llmApiKey'), notifyConfigured: !!effective('notifyWebhookUrl'), inspectIntervalMin: Number(effective('inspectIntervalMin')), notifyLast: lastNotify() }
  try {
    const models = await listModels()
    sendJson(res, 200, { ok: true, ...base, modelCount: models.length, models: models.slice(0, 20) })
  } catch (e) {
    sendJson(res, 200, { ok: false, ...base, error: e instanceof Error ? e.message : String(e) })
  }
}

/** POST /notify-test：设置页「发一条测试」——把人叫回来的生命线通道不能零可观测 */
/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @returns {Promise<void>} */
async function handleNotifyTest(req, res) {
  if (!effective('notifyWebhookUrl')) {
    sendJson(res, 400, { ok: false, error: 'NOTIFY_WEBHOOK_URL 未配置' })
    return
  }
  // notify() 是 fire-and-forget，测试端点要真结果：直接同源探测一次
  try {
    const r = await fetch(String(effective('notifyWebhookUrl')), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '[K8S] 测试通知：通道配置正确' }),
      signal: AbortSignal.timeout(5000),
    })
    sendJson(res, 200, { ok: r.ok, status: r.status })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

/** POST /handover：交班 MD 落盘 + 进审计（「交接发生过」从此有账）。@returns {Promise<void>} */
/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
async function handleHandoverSave(req, res) {
  const body = await readJsonBody(req)
  const md = typeof body.md === 'string' ? body.md.slice(0, 200_000) : ''
  const cluster = typeof body.cluster === 'string' ? body.cluster.slice(0, 100) : ''
  if (md.length < 20) throw new HttpError(400, 'md 过短')
  const { id } = handoverSave({ cluster, md, ...(typeof body.window === 'string' ? { window: body.window.slice(0, 60) } : {}), ...(typeof body.actor === 'string' && body.actor ? { actor: body.actor.slice(0, 60) } : {}) })
  auditRecord({ source: 'ui', ...(typeof body.actor === 'string' && body.actor ? { actor: body.actor.slice(0, 60) } : {}), cluster, verb: 'handover', target: id, summary: typeof body.window === 'string' ? body.window : undefined })
  // 交班的最后一公里：被叫醒 vs 人肉转发链接。通知基建已就位，交接是第四触发点
  notify(`[K8S] ${typeof body.actor === 'string' && body.actor ? body.actor : '有人'} 已交班 ${cluster}${typeof body.window === 'string' ? `（${body.window}）` : ''}`, effective('panelBaseUrl') ? `${effective('panelBaseUrl')}/c/${encodeURIComponent(cluster)}/handover/${id}` : undefined)
  sendJson(res, 200, { ok: true, id })
}

/** GET /handover?id=|?cluster=：交班文档读取（深链渲染）与最近列表 */
/** @param {URL} url @param {import('node:http').ServerResponse} res @returns {void} */
function handleHandoverRead(url, res) {
  const id = url.searchParams.get('id')
  if (id) {
    const doc = handoverGet(id.replace(/[^a-z0-9]/g, ''))
    if (!doc) throw new HttpError(404, '交班文档不存在')
    return sendJson(res, 200, doc)
  }
  const cluster = url.searchParams.get('cluster') ?? ''
  sendJson(res, 200, { items: handoverListRecent(cluster) })
}

/** POST /handover/ack：接班确认进账（交接握手闭环） */
/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
async function handleHandoverAck(req, res) {
  const body = await readJsonBody(req)
  const id = typeof body.id === 'string' ? body.id.slice(0, 30) : ''
  const doc = handoverGet(id.replace(/[^a-z0-9]/g, ''))
  if (!doc) throw new HttpError(404, '交班文档不存在')
  // 服务端闸门：接班状态在文档本体上，第二人重按=409（旧档无字段则放行，靠前端审计兜底显示）
  if (doc.ackedTs) throw new HttpError(409, `该班已由 ${doc.ackedBy || '未署名'} 于 ${doc.ackedTs} 接下`)
  // 无署名也进账：「交接发生过」的凭证不能因没填值班名就静默消失（actor 允许为空）
  const ackActor = typeof body.actor === 'string' ? body.actor.slice(0, 60) : ''
  handoverMarkAcked(id.replace(/[^a-z0-9]/g, ''), ackActor)
  auditRecord({ source: 'ui', ...(ackActor ? { actor: ackActor } : {}), cluster: doc.cluster, verb: 'handover_ack', target: id, summary: `接班确认：交班 ${doc.ts}` })
  // 第五触发点：交班人发出后必然离屏（通知体系的存在前提），「有人接了」不回账=握手只握了一半
  notify(`[K8S] ${ackActor || '有人'} 已接班 ${doc.cluster}（交班 ${doc.ts}）`, effective('panelBaseUrl') ? `${effective('panelBaseUrl')}/c/${encodeURIComponent(doc.cluster)}/handover/${id}` : undefined)
  sendJson(res, 200, { ok: true })
}

// ---------- 路由与启动 ----------

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) {
      sendJson(res, e instanceof HttpError ? e.status : 500, { error: friendlyError(e) })
    } else {
      try {
        res.end()
      } catch {
        /* 已断开 */
      }
    }
  })
})

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
async function route(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const p = url.pathname

  if (req.method === 'POST' && p === '/chat') return await handleChat(req, res)
  if (req.method === 'GET' && p === '/sessions') return await handleSessions(url, res)
  const sessMatch = p.match(/^\/sessions\/([^/]+)$/)
  const sessId = sessMatch ? sessMatch[1] : undefined
  if (req.method === 'GET' && sessId) return await handleSessionMessages(sessId, res)
  const abortMatch = p.match(/^\/sessions\/([^/]+)\/abort$/)
  const abortId = abortMatch ? abortMatch[1] : undefined
  if (req.method === 'POST' && abortId) return await handleAbort(abortId, res)
  if (req.method === 'GET' && p === '/models') return await handleModels(res)
  if (req.method === 'GET' && p === '/status') return await handleStatus(res)
  if (req.method === 'GET' && p === '/inspect/daily') {
    sendJson(res, 200, { items: listDaily(url.searchParams.get('cluster') ?? '') })
    return
  }
  if (req.method === 'POST' && p === '/notify-test') return await handleNotifyTest(req, res)
  if (req.method === 'POST' && p === '/handover') return await handleHandoverSave(req, res)
  if (req.method === 'POST' && p === '/handover/ack') return await handleHandoverAck(req, res)
  if (req.method === 'GET' && p === '/handover') return handleHandoverRead(url, res)
  if (req.method === 'POST' && p === '/autoallow') return await handleAutoAllow(req, res)
  if (req.method === 'GET' && p === '/audit') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000)
    return sendJson(res, 200, { items: auditList(limit, { cluster: url.searchParams.get('cluster') || undefined, since: url.searchParams.get('since') || undefined, target: url.searchParams.get('target') || undefined, verb: url.searchParams.get('verb') || undefined }) })
  }
  if (req.method === 'GET' && p === '/config') {
    // 生效值 + 来源标记：UI 要能区分「env 底座」与「UI 覆盖」，别让人改了 UI 被 env 盖回来还不知道
    const ov = readOverrides()
    // env 底座值一并返回：「UI 覆盖」章旁要能看清回到了哪里，否则唯一退路又是命令行
    sendJson(res, 200, {
      inspectIntervalMin: { value: Number(effective('inspectIntervalMin')), overridden: 'inspectIntervalMin' in ov, env: Number(config.inspectIntervalMin) },
      notifyWebhookUrl: { value: String(effective('notifyWebhookUrl')), overridden: 'notifyWebhookUrl' in ov, env: String(config.notifyWebhookUrl) },
      panelBaseUrl: { value: String(effective('panelBaseUrl')), overridden: 'panelBaseUrl' in ov, env: String(config.panelBaseUrl) },
      llmGatewayBase: { value: String(effective('llmGatewayBase')), overridden: 'llmGatewayBase' in ov, env: String(config.llmGatewayBase) },
      llmModel: { value: String(effective('llmModel')), overridden: 'llmModel' in ov, env: String(config.llmModel) },
      // 密钥明文永不下发浏览器：只回「是否已配置」与来源
      llmApiKey: { overridden: 'llmApiKey' in ov, configured: !!effective('llmApiKey'), envConfigured: !!config.llmApiKey },
    })
    return
  }
  if (req.method === 'PUT' && p === '/config') {
    const body = await readJsonBody(req)
    // actor 是审计署名不是配置键：混在 body 里会被白名单整体拒绝（带署名保存全 400）
    const { actor, ...patch } = body
    // 旧值在写前取：配置改动是全产品此前唯一绕账的变更通道，「谁改了节奏/通知指到哪」必须答得出
    const before = { ...readOverrides() }
    const r = writeOverrides(patch)
    if (r.ok) {
      const after = readOverrides()
      const fmt = (/** @type {string} */ k, /** @type {any} */ v) => {
        if (v === undefined) return 'env'
        if (k === 'llmApiKey') return v ? '已设置' : '(空)'
        if (k === 'notifyWebhookUrl' || k === 'panelBaseUrl') {
          // webhook URL 含 token：账上只记 host，不留全文
          try { return v ? new URL(String(v)).host : '(空)' } catch { return '(非法)' }
        }
        return String(v)
      }
      for (const k of Object.keys(patch)) {
        if (!['inspectIntervalMin', 'notifyWebhookUrl', 'panelBaseUrl', 'llmGatewayBase', 'llmApiKey', 'llmModel'].includes(k)) continue
        if (String(before[k] ?? '') === String(after[k] ?? '')) continue
        auditRecord({
          source: 'ui',
          ...(typeof actor === 'string' && actor ? { actor: actor.slice(0, 60) } : {}),
          cluster: url.searchParams.get('cluster') || 'default',
          verb: 'config',
          target: k,
          summary: `${k}: ${fmt(k, before[k])} → ${k in after ? fmt(k, after[k]) : '还原 env'}`,
        })
      }
      if (['llmGatewayBase', 'llmApiKey', 'llmModel'].some(k => k in patch)) {
        // 热重建模型目录+运行时；失败不吞 200（配置已落盘，下次请求自然报错可见）
        await refreshLlmRuntime().catch(() => {})
      }
    }
    sendJson(res, r.ok ? 200 : 400, r)
    return
  }
  if (req.method === 'GET' && p === '/capacity') {
    const { clusterCapacity } = await import('./lib/capacity.js')
    const c = await clusterCapacity(url.searchParams.get('cluster') || 'default')
    // 失败就是 5xx：包成 200 会让前端 retry:0 + staleTime 组合把失败演成一整班不刷新的「–」
    sendJson(res, c ? 200 : 502, c ?? { error: 'capacity unavailable（后端集群不可达或无权限）' })
    return
  }
  if (req.method === 'POST' && p === '/audit') return await handleAudit(req, res)
  // 待批准写操作清单（FAB 角标：「等你批准」是值班真待办，不能只活在聊天面板里）
  if (req.method === 'GET' && p === '/pending') {
    const cluster = url.searchParams.get('cluster')
    const items = pendingItems().filter((it) => !cluster || it.cluster === cluster)
    return sendJson(res, 200, { items })
  }
  if (req.method === 'GET' && p === '/disposition') {
    return sendJson(res, 200, { items: dispList(url.searchParams.get('cluster') ?? 'default') })
  }
  if (req.method === 'POST' && p === '/disposition') {
    const body = await readJsonBody(req)
    const state = body.state
    if (state !== 'acked' && state !== 'ignored' && state !== 'none') throw new HttpError(400, 'state 须为 acked/ignored/none')
    if (typeof body.key !== 'string' || !body.key) throw new HttpError(400, 'key 必填')
    const cluster = typeof body.cluster === 'string' ? body.cluster : 'default'
    const note = typeof body.note === 'string' ? body.note.slice(0, 200) : undefined
    dispRecord({ cluster, key: body.key.slice(0, 300), state, note })
    // 值班决策也是变更：意图层时间线必须查得到「谁把这条异常判成忽略」
    // kind/ns/name 从处置键解析：审计行可跳详情（与 AI disposition_set 路径同构）
    const [, aNs, aKind, ...aRest] = String(body.key).split('/')
    const dActor = typeof body.actor === 'string' && body.actor ? body.actor.slice(0, 60) : undefined
    auditRecord({
      source: 'ui',
      ...(dActor ? { actor: dActor } : {}),
      cluster,
      verb: state === 'none' ? 'unack' : state,
      target: body.key.slice(0, 300),
      kind: aKind || undefined,
      ns: aNs || undefined,
      name: aRest.join('/').replace(/\|[\s\S]*$/, '') || undefined,
      ...(note ? { summary: note } : {}),
    })
    return sendJson(res, 200, { ok: true })
  }
  // 集群巡检：同步跑全集群规则扫描（秒级），返回报告 + 与上次 diff 并持久化
  if (req.method === 'GET' && p === '/inspect') return await handleInspect(req, url, res)
  // 巡检历史报告（前端「历史」下拉；REPORT_CAP 封顶整份返回）
  if (req.method === 'GET' && p === '/reports') {
    const cluster = url.searchParams.get('cluster') ?? 'default'
    // 首页/巡检页常开 = 集群自动纳管后台扫描（此前只有手动点过「开始巡检」的集群才被扫，冷启动自锁）
    touchRecentCluster(cluster)
    return sendJson(res, 200, { items: listReports(cluster), inspectIntervalMin: Number(effective('inspectIntervalMin')), nextScanAt: globalThis.__k8sScanSched ? globalThis.__k8sScanSched()?.nextAt ?? null : null })
  }

  sendJson(res, 404, { error: `未知端点：${req.method} ${p}` })
}

async function main() {
  if (!effective('llmApiKey')) {
    log('警告：LLM 密钥未设置（env LLM_API_KEY 或「设置 → AI 服务」），网关要求鉴权时 /chat 将不可用')
  }
  await modelRuntime() // 生成 models.json 并初始化运行时（配置错误快速失败）
  server.listen(config.port, config.host, () => {
    log(
      `listening on http://${config.host}:${config.port}` +
        ` | data=${config.dataDir} | llm=${effective('llmGatewayBase') || '(未配置)'} (${effective('llmModel')})` +
        ` | backend=${config.backendBase}`,
    )
  })
}

// 优雅退出：entrypoint 的 SIGTERM 转进来时，关掉监听并释放所有会话
let shuttingDown = false
/** @param {string} sig */
async function shutdown(sig) {
  if (shuttingDown) return
  shuttingDown = true
  log(`${sig} received, shutting down`)
  try {
    server.close()
    for (const rec of registry.records.values()) {
      if (rec.session.isStreaming) {
        try {
          await rec.session.abort()
        } catch {
          /* 忽略 */
        }
      }
    }
    registry.disposeAll()
  } catch (e) {
    log('shutdown error:', e instanceof Error ? e.message : String(e))
  }
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

main().catch((e) => {
  console.error('[ai-exec] fatal:', e)
  process.exit(1)
})
