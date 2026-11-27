// AI 执行层 transport：useChat → 同源 POST /ai/chat（UIMessageStream 协议，
// 契约见 ai-exec/lib/adapter.js 头部映射表）。
// 用 AI SDK v7 内置 DefaultChatTransport（自定义 api），两处定制：
// - prepareSendMessagesRequest 把请求体重写为服务端契约
//   { sessionId?, cluster, message, model?, permission?, approvals?, messageId? }
//   （会话历史持久在 ai-exec 的 session JSONL，客户端只发最新一条用户消息；
//   approvals 非空 = 原生审批续流请求，携带 messageId 让服务端把续流合并进同一条消息）；
// - fetch 包装把连接失败 / HTTP 错误统一成用户友好文案（AbortError 原样透传，
//   让 useChat 把停止当正常中断处理）。
// 服务端首帧 start.messageMetadata 携带新分配的 sessionId，组件侧从 assistant 消息 metadata 读取。
import { DefaultChatTransport } from 'ai'
import { t, tf } from '@/i18n'
import type { AiChatMessage, AiPermission } from '@/api/ai'

/** 替代内置 fetch：非 2xx → 带状态码的错误；网络层失败 → “服务不可达”（ai:unreachable）；中止透传 */
const friendlyFetch: typeof globalThis.fetch = async (input, init) => {
  try {
    const res = await globalThis.fetch(input, init)
    if (!res.ok) throw new Error(tf('ai:serverError', { status: res.status }))
    return res
  } catch (e) {
    // 停止按钮 / 组件卸载触发的 abort 不是错误
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    // 浏览器网络层失败（fetch 拒绝连接/DNS/CORS 等都以 TypeError 呈现）
    if (e instanceof TypeError) throw new Error(t('ai:unreachable'))
    throw e
  }
}

export interface ServerTransportOptions {
  cluster: string
  /** 当前选中模型（发送时取最新值，切换即下次发送生效） */
  model: () => string
  /** 当前 sessionId（null = 首条消息 → 服务端分配新会话并在首帧返回） */
  sessionId: () => string | null
  /** 工具执行权限（发送时取最新值：只读/写确认/完全权限） */
  permission: () => AiPermission
  /** 当前页面语义行（发送时取最新路由；null = 不附） */
  page: () => string | null
  /** 拒绝理由旁路（SDK 审批响应形状不带自由文本；「拒绝并说明」写这里，随 approvals 上行） */
  denyNotes: () => Map<string, string>
}

/** 创建指向 /ai/chat 的 transport。每次渲染重建（构造成本可忽略），闭包始终取最新 cluster/model */
export function createServerTransport(options: ServerTransportOptions) {
  return new DefaultChatTransport<AiChatMessage>({
    api: '/ai/chat',
    fetch: friendlyFetch,
    prepareSendMessagesRequest: ({ messages, messageId }) => {
      // 服务端持有完整会话历史，客户端只发最新用户消息（附件已在 PromptInput 侧拼进文本）
      const lastUser = [...messages].reverse().find(m => m.role === 'user')
      const text = lastUser ? lastUser.parts.map(p => (p.type === 'text' ? p.text : '')).join('') : ''
      const sessionId = options.sessionId()
      const page = options.page()
      // 原生审批续流：**全部** assistant 消息里已裁决（approval-responded）的工具
      // part 一律组装（与 hasUnsentApprovalResponse 谓词同口径；只扫 lastAssistant
      // 会在用户补发新消息后漏掉旧卡 → 服务端闸门挂死，R2 P2-1）
      const approvals = messages.flatMap(m =>
        m.role === 'assistant'
          ? m.parts.flatMap(p => {
              if (p.type.startsWith('tool-') && 'state' in p && p.state === 'approval-responded') {
                const note = options.denyNotes().get(p.toolCallId)
                return [{ toolCallId: p.toolCallId, approved: p.approval.approved, input: p.input, ...(note ? { note } : {}) }]
              }
              return []
            })
          : [],
      )
      return {
        body: {
          ...(sessionId ? { sessionId } : {}),
          ...(messageId ? { messageId } : {}),
          cluster: options.cluster,
          message: text,
          model: options.model(),
          permission: options.permission(),
          // 页面感知：审批续流（非新 prompt）不带页面行，避免污染历史消息匹配
          ...(page && approvals.length === 0 ? { page } : {}),
          ...(approvals.length > 0 ? { approvals } : {}),
        },
      }
    },
  })
}
