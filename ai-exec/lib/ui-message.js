// @ts-check
/**
 * pi AgentMessage[] → AI SDK UIMessage[]（/ai/sessions/:id 跨设备恢复用）。
 *
 * 角色映射：
 * - user → { role:'user', parts:[text] }（图片块忽略：本服务只收文本，附件已在客户端拼进文本）
 * - assistant → 一个 UIMessage；内容块：
 *     text → { type:'text', state:'done' }
 *     thinking → { type:'reasoning', state:'done' }
 *     toolCall → { type:`tool-<name>`, state:'input-available', input }
 * - toolResult → 合并进前面 assistant 消息中同 toolCallId 的工具 part：
 *     成功 → state:'output-available' + output（details 结构化，缺失退化为文本）
 *     失败 → state:'output-error' + errorText
 * - system / custom / bashExecution / branchSummary / compactionSummary → 不参与前端渲染，跳过
 *
 * part 形状与 AI SDK v7 客户端（web/node_modules/ai src/ui/ui-messages.ts）一致，
 * 前端 TOOL_META 按 `tool-<name>` 前缀取中文标题。
 */

/** @typedef {import('@earendil-works/pi-agent-core').AgentMessage} AgentMessage */

/** UIMessageStream 工具/文本/推理 part（形状对齐 AI SDK v7 客户端） */
/**
 * @typedef {object} UIPart
 * @property {string} type
 * @property {string} [text]
 * @property {string} [id]
 * @property {string} [state]
 * @property {string} [toolCallId]
 * @property {unknown} [input]
 * @property {unknown} [output]
 * @property {string} [errorText]
 */

/**
 * @typedef {object} UIMessageRow
 * @property {string} id
 * @property {'user' | 'assistant'} role
 * @property {UIPart[]} parts
 */

/** @param {AgentMessage[]} messages @param {Set<string>} [pendingIds] 挂起审批的 toolCallId（还原审批卡用） @param {boolean} [staleUnresolved] 会话已不在执行：无结果 toolCall 标失效 @returns {UIMessageRow[]} */
export function toUIMessages(messages, pendingIds = new Set(), staleUnresolved = false) {
  /** @type {UIMessageRow[]} */
  const out = []
  let n = 0
  const nextId = () => `uimsg-${++n}`

  for (const m of messages) {
    if (m.role === 'user') {
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
          : ''
      if (!text) continue
      out.push({ id: nextId(), role: 'user', parts: [{ type: 'text', text, state: 'done' }] })
    } else if (m.role === 'assistant') {
      /** @type {UIPart[]} */
      const parts = []
      let r = 0
      for (const block of m.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text, state: 'done' })
        } else if (block.type === 'thinking') {
          parts.push({ type: 'reasoning', id: `r-${m.timestamp}-${r++}`, text: block.thinking, state: 'done' })
        } else if (block.type === 'toolCall') {
          // 挂起审批的 toolCall：还原 approval-requested（形状与 live 流原生 part 对齐，
          // approval.id === toolCallId），前端 hasUnsentApprovalResponse 据此重挂审批卡
          const awaiting = pendingIds.has(block.id)
          // 会话已不在执行（重启/淘汰/中断） yet 此调用无结果 = 待审批或执行随断线失效；
          // 有结果的 part 随后会被 toolResult 回填覆盖，误标不存在
          const stale = staleUnresolved && !awaiting
          parts.push({
            type: `tool-${block.name}`,
            toolCallId: block.id,
            state: stale ? 'output-error' : awaiting ? 'approval-requested' : 'input-available',
            input: block.arguments ?? {},
            // stale=结构化标记（前端据此显恢复入口/中性状态，不对 errorText 自由文案做前缀匹配）
            ...(stale ? { stale: true, errorText: '中断未生效：该操作在待审批或执行时随断线/重启失效，未作用于集群。可展开参数确认后重新发起原请求。' } : {}),
            ...(awaiting ? { approval: { id: block.id } } : {}),
          })
        }
      }
      if (parts.length > 0) out.push({ id: nextId(), role: 'assistant', parts })
    } else if (m.role === 'toolResult') {
      // 倒序找最近一条带同 toolCallId 工具 part 的 assistant 消息
      for (let i = out.length - 1; i >= 0; i--) {
        const msg = out[i]
        if (!msg || msg.role !== 'assistant') continue
        const part = msg.parts.find(
          (p) => p && p.type !== 'text' && p.type !== 'reasoning' && p.toolCallId === m.toolCallId,
        )
        if (!part) continue
        const text = Array.isArray(m.content)
          ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
          : ''
        if (m.isError) {
          part.state = 'output-error'
          part.errorText = text || '工具执行失败'
        } else {
          part.state = 'output-available'
          part.output = m.details !== undefined && m.details !== null ? m.details : text
        }
        break
      }
    }
    // 其余角色跳过
  }
  return out
}
