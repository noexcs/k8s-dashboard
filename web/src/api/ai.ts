// AI 执行服务（/ai/*）客户端：流协议契约见 ai-exec/lib/adapter.js 头部映射表。
// Go 侧把 /ai/ 前缀反代到同容器 ai-exec（127.0.0.1:4470），前端全部同源请求。
// 聊天 SSE 流不走这里（见 features/ai/server-transport.ts 的 AI SDK transport），此处只管非流式端点。
import type { UIMessage } from 'ai'
import { tf } from '@/i18n'

export interface AiModel {
  id: string
  name: string
}

export interface AiSessionSummary {
  id: string
  title: string
  cluster: string
  updatedAt: string
}

/** assistant 消息 metadata：服务端首帧（start.messageMetadata）注入新分配的 sessionId */
interface AiSessionMetadata {
  sessionId?: string
}

/** 工具执行权限（随每次 /chat 下发；服务端默认 confirm） */
export type AiPermission = 'readonly' | 'confirm' | 'full'

/** 客户端消息类型：与服务端 UIMessageStream 同构（工具 part 为 tool-<name>，24 个工具名见 TOOL_META） */
export type AiChatMessage = UIMessage<AiSessionMetadata, never>

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(tf('ai:apiError', { status: res.status }))
  return (await res.json()) as T
}

/** 模型列表（来自 ai-exec models.json 目录）；404/空 = 服务未就绪 */
export function listAiModels(): Promise<AiModel[]> {
  return fetch('/ai/models', { headers: { Accept: 'application/json' } }).then(r => json<AiModel[]>(r))
}

/** 会话列表（当前 cluster；title 为首条用户消息截断） */
export function listAiSessions(cluster: string): Promise<AiSessionSummary[]> {
  return fetch(`/ai/sessions?cluster=${encodeURIComponent(cluster)}`, {
    headers: { Accept: 'application/json' },
  }).then(r => json<AiSessionSummary[]>(r))
}

/** 会话历史消息（UIMessage 数组，供跨设备恢复） */
/** 会话历史 + 免询白名单（x-auto-allow 头）：白名单是服务端会话态，刷新/深链后必须同路回灌 */
export async function getAiSessionMessages(id: string): Promise<{ messages: AiChatMessage[]; autoAllowed: string[] }> {
  const r = await fetch(`/ai/sessions/${encodeURIComponent(id)}`, {
    headers: { Accept: 'application/json' },
  })
  const messages = await json<AiChatMessage[]>(r)
  const hdr = r.headers.get('x-auto-allow')
  const autoAllowed = hdr ? decodeURIComponent(hdr).split(',').filter(Boolean) : []
  return { messages, autoAllowed }
}

/** 中止当前 run（fire-and-forget：结果忽略，失败不影响本地停止） */
export function abortAiSession(id: string): void {
  void fetch(`/ai/sessions/${encodeURIComponent(id)}/abort`, { method: 'POST' }).catch(() => {})
}
