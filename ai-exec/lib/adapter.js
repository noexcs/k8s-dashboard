// @ts-check
/**
 * 核心映射层（adapter）：pi AgentSessionEvent → AI SDK v7 UIMessageStream chunks。
 * 全系统唯一的 pi→前端协议转换点（spec 风险节：adapter 层薄）。
 *
 * 输出协议 = AI SDK v7 客户端（web/node_modules/ai: src/ui-message-stream/ui-message-chunks.ts
 * + src/ui/process-ui-message-stream.ts）可解析的 UIMessageChunk 联合，SSE 帧格式
 * `data: <json>\n\n`、结束帧 `data: [DONE]\n\n`（与 createUIMessageStream 一致）。
 *
 * ## 映射表（pi 事件 → chunk）
 * | pi 事件 | chunk | 说明 |
 * |---|---|---|
 * | （run 开始前，服务端主动） | `start` { messageId, messageMetadata: { sessionId } } | 首帧带 sessionId（spec 契约） |
 * | `turn_start` | `start-step` | 一个 turn（assistant 响应+其工具调用）= 客户端一个 step |
 * | `turn_end` | `finish-step` | |
 * | `message_start`（role=assistant） | —（内部：开新消息序号，清活动块） | user/system/toolResult 的 message_* 不映射 |
 * | `message_update` + `text_start` | `text-start` { id } | id 按 (消息序号, contentIndex) 生成 |
 * | `message_update` + `text_delta` | `text-delta` { id, delta } | 客户端要求先有 text-start |
 * | `message_update` + `text_end` | `text-end` { id } | |
 * | `message_update` + `thinking_*` | `reasoning-start/delta/end` { id… } | 思考块（reasoning-end 在首个 text_start/toolcall_start 提前 flush，见 `_closeOpenReasoning`） |
 * | `message_update` + `toolcall_start` | `tool-input-start` { toolCallId, toolName } | id 未到（空串）时延迟到 end 再发 |
 * | `message_update` + `toolcall_delta` | `tool-input-delta` { toolCallId, inputTextDelta } | 参数 JSON 流式片段 |
 * | `message_update` + `toolcall_end` | `tool-input-available` { toolCallId, toolName, input } | 完整参数 |
 * | `tool_execution_end`（isError=false） | `tool-output-available` { toolCallId, output } | output 取 details（结构化），无 details 退化为文本 |
 * | `tool_execution_end`（isError=true） | `tool-output-error` { toolCallId, errorText } | |
 * | `message_end`（stopReason=error） | 暂存错误文案；willRetry 期间不发 | pi 会对可重试错误自动重跑 |
 * | `agent_end` { willRetry } | —（内部：记录是否还会重试） | |
 * | `agent_settled` { aborted } | `finish` { finishReason } + （若有错误）`error` | settled = 本 session 级 run 无自动后续 |
 * | 其余（queue_update、compaction 系列、auto_retry 系列、entry_appended 等） | — | P1 不映射（重试/压缩对用户透明） |
 *
 * stopReason 映射（pi → AI SDK FinishReason）：
 *   stop→stop  length→length  toolUse→stop  error→error  aborted→interrupted  deferred→other
 *
 * ## 并发排队（observer 模式）
 * 同 session 第二个 prompt：服务端按 spec 以 followUp 排队。本 adapter 支持
 * waitForUserText：在排队消息被 pi 投递（收到同文本的 user message_end）前抑制全部输出，
 * 投递后从该轮开始转发（补发首步 start-step），直到 agent_settled 或另一条排队消息
 * 接管（其 user 消息被投递）为止。
 *
 * ## 审批续流（continuation 模式）
 * 确认模式写操作挂起时，归属流收到 `tool-approval-request` chunk（permissions.gateWriteTool
 * 经 notify 写入）后调 finishEarly() 提前收尾 SSE，pi run 保持 parked。
 * 前端审批后重发 /chat（body.approvals[]）：server 新建本 adapter 并传
 * existingTools（客户端已有 input 序列的 toolCallId）+ suppressOutputs（被拒绝的，
 * 其 tool_execution_end 只给模型、不给前端），订阅同一 run 的后续事件续流。
 */

/** @typedef {'stop'|'length'|'content-filter'|'tool-calls'|'error'|'interrupted'|'other'} FinishReason */
/** @typedef {import('@earendil-works/pi-coding-agent').AgentSessionEvent} PiSessionEvent */
/** @typedef {import('@earendil-works/pi-ai').AssistantMessageEvent} PiAssistantEvent */
/** @typedef {import('@earendil-works/pi-agent-core').AgentMessage} AgentMessage */

/** 把 pi 的 stopReason 映射为 AI SDK FinishReason */
/** @param {string} stopReason @returns {FinishReason} */
function mapStopReason(stopReason) {
  switch (stopReason) {
    case 'length':
      return 'length'
    case 'error':
      return 'error'
    case 'aborted':
      return 'interrupted'
    case 'deferred':
      return 'other'
    default:
      return 'stop' // stop / toolUse / pending
  }
}

/** 提取 user/assistant 消息的纯文本（content 可能是 string 或内容块数组） */
/** @param {AgentMessage} message @returns {string} */
function messageText(message) {
  if (message.role !== 'user' && message.role !== 'assistant') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text)
      .join('\n')
  }
  return ''
}

/** 从 tool_execution_end 的 result（AgentToolResult）里取展示用输出/错误文本 */
/** @param {unknown} result @returns {string} */
function resultText(result) {
  if (!result || typeof result !== 'object') return ''
  const r = /** @type {{ content?: unknown }} */ (result)
  if (!Array.isArray(r.content)) return ''
  return r.content
    .filter((c) => c && typeof c === 'object' && c.type === 'text')
    .map((c) => {
      const cc = /** @type {{ text?: unknown }} */ (c)
      return typeof cc.text === 'string' ? cc.text : ''
    })
    .join('\n')
}

/**
 * @typedef {object} ToolPartState 一个工具调用的流式状态
 * @property {string} toolCallId
 * @property {string} toolName
 * @property {boolean} started  是否已发 tool-input-start
 * @property {boolean} inputSent  是否已发 tool-input-available
 * @property {string} deltaBuffer  已收到但尚未发出的参数片段（start 延迟时缓冲）
 * @property {Record<string, unknown>} [args]  来自 toolcall_end/tool_execution_start 的参数（兜底重建 part 用）
 */

export class UIMessageStreamAdapter {
  /**
   * @param {object} opts
   * @param {(chunk: Record<string, unknown>) => void} opts.write  写一个 UIMessageChunk（SSE 帧由调用方负责）
   * @param {string} opts.sessionId  会话 id（放入 start 帧 messageMetadata）
   * @param {string} [opts.waitForUserText]  observer 模式：等待该用户消息被投递后才开始转发
   * @param {Record<string, { toolName: string }>} [opts.existingTools]  续流模式：客户端已有这些
   *   toolCallId 的 part（前一条流里已流过 input 序列）→ tool_execution_end 只发 output，不补发 input
   * @param {Set<string>} [opts.suppressOutputs]  续流模式：这些 toolCallId 的输出不发
   *   （审批被拒绝：客户端已收 tool-output-denied，pi 侧的 isError 结果只给模型看）
   */
  constructor({ write, sessionId, waitForUserText, existingTools, suppressOutputs }) {
    /** @type {(chunk: Record<string, unknown>) => void} */
    this.write = write
    this.sessionId = sessionId
    /** @type {null | (() => void)} 流收尾（finish/error 帧已写）时触发一次：服务端发 [DONE] 并释放 run 归属 */
    this.onFinished = null
    /** @type {string | null} */
    this.waitForUserText = waitForUserText ?? null
    /** 排队消息被投递后置 true；observer 模式初始 false */
    this.activated = !waitForUserText
    this.finished = false
    this._stepOpen = false
    /** 当前 assistant 消息序号（chunk id 前缀，跨消息唯一） */
    this._msgSeq = 0
    /** @type {Map<number, string>} contentIndex → text chunk id */
    this._textIds = new Map()
    /** @type {Map<number, string>} contentIndex → reasoning chunk id */
    this._reasoningIds = new Map()
    /** @type {Map<string, ToolPartState>} */
    this._toolParts = new Map()
    // 续流模式：客户端已有 input 序列的 part 预先登记（started/inputSent=true → 不补发 input）
    for (const [id, t] of Object.entries(existingTools ?? {})) {
      this._toolParts.set(id, /** @type {ToolPartState} */ ({
        toolCallId: id,
        toolName: t.toolName,
        started: true,
        inputSent: true,
        deltaBuffer: '',
      }))
    }
    /** @type {Set<string>} 审批被拒绝的 toolCallId：tool_execution_end 不发 output */
    this._suppressed = suppressOutputs ?? new Set()
    /** 最近一个 terminal stopReason（message_end 携带） */
    this._lastStopReason = 'stop'
    /** 本轮 run 内是否已产出过 assistant 内容（用于识别"另一条排队消息接管"） */
    this._assistantContentSeen = false
    /** 错误暂存（willRetry 期间不发给客户端） */
    /** @type {string | null} */
    this._pendingError = null
    /** agent_end 携带 */
    this._willRetry = false
  }

  /** 切到转发模式（服务端确认本请求是 run 归属方后调用；observer 待命期吞掉的其他 run 事件不会补发） */
  activate() {
    this.activated = true
    this.waitForUserText = null
  }

  /**
   * 确认门挂起：提前收尾当前 SSE（finish 帧 → onFinished 由服务端关流 + 退订），
   * 但 pi run 保持 parked（工具 promise 未决），等审批续流请求订阅后续事件。
   */
  finishEarly() {
    this._finish('stop')
  }

  /** 首帧：start（带 sessionId） */
  /** @param {string} messageId */
  begin(messageId) {
    this._emit({ type: 'start', messageId, messageMetadata: { sessionId: this.sessionId } })
  }

  /** 处理一个 pi AgentSessionEvent */
  /** @param {PiSessionEvent} ev */
  onEvent(ev) {
    if (this.finished) return

    // observer 门：等待排队消息投递
    if (!this.activated) {
      if (process.env.AI_DEBUG_ADAPTER) {
        // 只有 message_start/message_end 携带 message；先收窄再访问（联合类型其余成员无此字段）
        const role = ev.type === 'message_start' || ev.type === 'message_end' ? ev.message?.role : undefined
        console.error(`[adapter:gate] sid=${this.sessionId} ev=${ev.type}${role ? ` role=${role}` : ''}`)
      }
      if (ev.type === 'message_end' && ev.message && ev.message.role === 'user') {
        const text = messageText(ev.message)
        if (process.env.AI_DEBUG_ADAPTER) console.error(`[adapter:gate] sessionId=${this.sessionId} user message_end text=${JSON.stringify(text)} waitFor=${JSON.stringify(this.waitForUserText)} match=${text === this.waitForUserText}`)
        if (text === this.waitForUserText) {
          this.activated = true
          this.waitForUserText = null
          if (process.env.AI_DEBUG_ADAPTER) console.error(`[adapter:gate] sessionId=${this.sessionId} ACTIVATED`)
        }
      } else if (ev.type === 'agent_settled') {
        // 排队消息没来得及投递（例如运行被 abort）
        this._finish('interrupted')
      }
      return
    }

    // 已被另一条排队消息接管（本条的答案已转完，新 user 消息开始）→ 收尾
    if (ev.type === 'message_end' && ev.message && ev.message.role === 'user') {
      // 本轮答案结束后的新 user 消息：只有当"本轮"已产出过 assistant 内容时才算接管
      if (this._assistantContentSeen) {
        this._finish(mapStopReason(this._lastStopReason))
        return
      }
      return
    }

    switch (ev.type) {
      case 'turn_start':
        this._openStep()
        return
      case 'turn_end':
        this._closeStep()
        return

      case 'message_start':
        if (ev.message && ev.message.role === 'assistant') {
          this._msgSeq += 1
          this._textIds.clear()
          this._reasoningIds.clear()
          this._assistantContentSeen = true
        }
        return

      case 'message_end':
        if (ev.message && ev.message.role === 'assistant') {
          // 兜底关掉未显式结束的块（正常流里 text_end/thinking_end/toolcall_end 都会到）
          for (const id of this._textIds.values()) this._emit({ type: 'text-end', id })
          for (const id of this._reasoningIds.values()) this._emit({ type: 'reasoning-end', id })
          this._textIds.clear()
          this._reasoningIds.clear()
          const stopReason = ev.message.stopReason
          if (stopReason && stopReason !== 'pending' && stopReason !== 'toolUse') {
            this._lastStopReason = stopReason
          }
          if (stopReason === 'error') {
            this._pendingError =
              ev.message.errorMessage || `模型请求失败（${ev.message.rawStopReason ?? 'unknown'}）`
          }
        }
        return

      case 'message_update':
        this._onAssistantMessageEvent(ev.assistantMessageEvent)
        return

      case 'tool_execution_start': {
        // 兜底路径也可能先到（非流式 provider 无 toolcall_* 序列）：同样先关思考块
        this._closeOpenReasoning()
        // 兜底：记录参数，便于在缺失 tool-input 序列时重建 part
        const state =
          this._toolParts.get(ev.toolCallId) ??
          /** @type {ToolPartState} */ ({
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            started: false,
            inputSent: false,
            deltaBuffer: '',
          })
        state.args = ev.args
        this._toolParts.set(ev.toolCallId, state)
        return
      }

      case 'tool_execution_end': {
        // 审批被拒绝：pi 侧已拿到 isError 结果（模型据此继续），客户端 part 停在 output-denied
        if (this._suppressed.has(ev.toolCallId)) {
          this._toolParts.delete(ev.toolCallId)
          return
        }
        const state = this._toolParts.get(ev.toolCallId)
        if (state) {
          // 补齐可能缺失的 input 序列（正常流里 toolcall_* 已发全，inputSent=true 时跳过）
          if (!state.started) {
            this._emit({
              type: 'tool-input-start',
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
            })
            state.started = true
          }
          if (!state.inputSent) {
            this._emit({
              type: 'tool-input-available',
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              input: state.args ?? {},
            })
            state.inputSent = true
          }
        } else {
          // 完全没见到流式参数（防御：非流式 provider 路径）：补齐 input 序列
          this._emit({ type: 'tool-input-start', toolCallId: ev.toolCallId, toolName: ev.toolName })
          this._emit({
            type: 'tool-input-available',
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            input: {},
          })
        }
        if (ev.isError) {
          this._emit({
            type: 'tool-output-error',
            toolCallId: ev.toolCallId,
            errorText: resultText(ev.result) || '工具执行失败',
          })
        } else {
          const details = ev.result && ev.result.details
          this._emit({
            type: 'tool-output-available',
            toolCallId: ev.toolCallId,
            output: details !== undefined && details !== null ? details : resultText(ev.result),
          })
        }
        this._toolParts.delete(ev.toolCallId)
        return
      }

      case 'agent_end':
        this._willRetry = !!ev.willRetry
        return

      case 'agent_settled':
        if (this._pendingError && !this._willRetry) {
          this._fail(this._pendingError)
        } else {
          this._finish(ev.aborted ? 'interrupted' : mapStopReason(this._lastStopReason))
        }
        return

      default:
        // queue_update / entry_appended / session_info_changed / thinking_level_changed /
        // compaction_* / auto_retry_* / summarization_* / bash_execution_update：P1 不映射
        return
    }
  }

  // ---------- 内部 ----------

  /**
   * @private 关闭所有未结束的思考块并发 reasoning-end。
   * pi 在 message 结束才报 thinking_end，但思考在正文/工具调用开始时即告一段落：
   * 不提前关，客户端思考 part 会整段正文输出期间保持 'streaming'（UI 一直"思考中"）。
   * */
  _closeOpenReasoning() {
    for (const id of this._reasoningIds.values()) this._emit({ type: 'reasoning-end', id })
    this._reasoningIds.clear()
  }

  /** @private */
  /** @param {PiAssistantEvent} aev */
  _onAssistantMessageEvent(aev) {
    switch (aev.type) {
      case 'text_start': {
        // 正文开始 = 思考结束：先 flush 未关闭的思考块（协议顺序 reasoning-end 先于正文）
        this._closeOpenReasoning()
        const id = `m${this._msgSeq}-t${aev.contentIndex}`
        this._textIds.set(aev.contentIndex, id)
        this._emit({ type: 'text-start', id })
        return
      }
      case 'text_delta': {
        const id = this._textIds.get(aev.contentIndex) ?? (() => {
          // 防御：没见到 text_start 也补发
          const nid = `m${this._msgSeq}-t${aev.contentIndex}`
          this._textIds.set(aev.contentIndex, nid)
          this._emit({ type: 'text-start', id: nid })
          return nid
        })()
        if (aev.delta) this._emit({ type: 'text-delta', id, delta: aev.delta })
        return
      }
      case 'text_end': {
        const id = this._textIds.get(aev.contentIndex)
        if (id) {
          this._textIds.delete(aev.contentIndex)
          this._emit({ type: 'text-end', id })
        }
        return
      }

      case 'thinking_start': {
        const id = `m${this._msgSeq}-r${aev.contentIndex}`
        this._reasoningIds.set(aev.contentIndex, id)
        this._emit({ type: 'reasoning-start', id })
        return
      }
      case 'thinking_delta': {
        const id = this._reasoningIds.get(aev.contentIndex) ?? (() => {
          const nid = `m${this._msgSeq}-r${aev.contentIndex}`
          this._reasoningIds.set(aev.contentIndex, nid)
          this._emit({ type: 'reasoning-start', id: nid })
          return nid
        })()
        if (aev.delta) this._emit({ type: 'reasoning-delta', id, delta: aev.delta })
        return
      }
      case 'thinking_end': {
        const id = this._reasoningIds.get(aev.contentIndex)
        if (id) {
          this._reasoningIds.delete(aev.contentIndex)
          this._emit({ type: 'reasoning-end', id })
        }
        return
      }

      case 'toolcall_start': {
        // 同上：工具调用开始 = 思考结束，先 flush 未关闭的思考块
        this._closeOpenReasoning()
        // in-process 事件带 cumulative partial：从 partial.content[contentIndex] 取 ToolCall
        const block = aev.partial && Array.isArray(aev.partial.content)
          ? aev.partial.content[aev.contentIndex]
          : undefined
        const id = block && block.type === 'toolCall' ? block.id : ''
        const name = block && block.type === 'toolCall' ? block.name : ''
        const state = /** @type {ToolPartState} */ ({
          toolCallId: id,
          toolName: name,
          started: false,
          inputSent: false,
          deltaBuffer: '',
        })
        if (id) {
          this._emit({ type: 'tool-input-start', toolCallId: id, toolName: name })
          state.started = true
        }
        this._toolParts.set(this._toolPartKey(aev.contentIndex), state)
        return
      }
      case 'toolcall_delta': {
        const state = this._toolParts.get(this._toolPartKey(aev.contentIndex))
        if (!state) return
        state.deltaBuffer += aev.delta
        if (state.started && aev.delta) {
          this._emit({ type: 'tool-input-delta', toolCallId: state.toolCallId, inputTextDelta: aev.delta })
        }
        return
      }
      case 'toolcall_end': {
        const state = this._toolParts.get(this._toolPartKey(aev.contentIndex))
        const tc = aev.toolCall
        if (state) {
          state.toolCallId = tc.id
          state.toolName = tc.name
          if (!state.started) {
            // id 在 start 时未知：此刻补发 start + 缓冲的 delta
            this._emit({ type: 'tool-input-start', toolCallId: tc.id, toolName: tc.name })
            if (state.deltaBuffer) {
              this._emit({ type: 'tool-input-delta', toolCallId: tc.id, inputTextDelta: state.deltaBuffer })
            }
            state.started = true
            state.deltaBuffer = ''
          }
          // 与 tool_execution_start 的参数兜底对齐
          state.args = tc.arguments
          state.inputSent = true
          this._toolParts.set(tc.id, state)
          this._toolParts.delete(this._toolPartKey(aev.contentIndex))
        } else {
          const fresh = /** @type {ToolPartState} */ ({
            toolCallId: tc.id,
            toolName: tc.name,
            started: true,
            inputSent: true,
            deltaBuffer: '',
            args: tc.arguments,
          })
          this._toolParts.set(tc.id, fresh)
        }
        this._emit({
          type: 'tool-input-available',
          toolCallId: tc.id,
          toolName: tc.name,
          input: tc.arguments ?? {},
        })
        return
      }

      case 'error': {
        // provider 级流错误（正常会被 agent loop 转成 stopReason=error 的 message_end；防御分支）
        this._pendingError = (aev.error && aev.error.errorMessage) || '模型请求失败'
        return
      }

      default:
        // start / done：agent loop 已转换为 message_start/message_end，不重复处理
        return
    }
  }

  /** toolcall 事件按 contentIndex 定位（同一 assistant 消息内唯一） */
  /** @param {number} contentIndex @returns {string} */
  _toolPartKey(contentIndex) {
    return `ci${this._msgSeq}:${contentIndex}`
  }

  _openStep() {
    if (this._stepOpen) return
    this._stepOpen = true
    this._emit({ type: 'start-step' })
  }

  _closeStep() {
    if (!this._stepOpen) return
    this._stepOpen = false
    this._emit({ type: 'finish-step' })
  }

  /** @private */
  /** @param {FinishReason} finishReason */
  _finish(finishReason) {
    if (this.finished) return
    this._closeStep()
    this._emit({ type: 'finish', finishReason })
    this.finished = true
    if (this.onFinished) this.onFinished()
  }

  /** 错误收尾：error part（UI 友好文案）+ finish */
  /** @param {string} errorText */
  fail(errorText) {
    if (this.finished) return
    this._fail(errorText)
  }

  /** @private */
  /** @param {string} errorText */
  _fail(errorText) {
    if (this.finished) return
    this._closeStep()
    this._emit({ type: 'error', errorText })
    this._emit({ type: 'finish', finishReason: 'error' })
    this.finished = true
    if (this.onFinished) this.onFinished()
  }

  /** @private */
  /** @param {Record<string, unknown>} chunk */
  _emit(chunk) {
    if (this.finished) return
    try {
      this.write(chunk)
    } catch {
      // 客户端断开导致的写失败：不在此处理（res close 由服务端统一 abort）
    }
  }
}
