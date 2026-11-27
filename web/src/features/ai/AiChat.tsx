// 可复用 AI 聊天组件：AI SDK v7 useChat 接服务端 AI 执行服务（同源 /ai/*，推理在 ai-exec 进程内执行，
// 渲染层照抄 shadcn 官方 chat pattern（ui.shadcn.com/docs/ai-elements/radix/chat.md）：
// 流协议契约见 ai-exec/lib/adapter.js 头部映射表。
// MessageScroller 套件 + Message/Bubble + Trace（reasoning/工具步骤）+ Markdown + InputGroup，
// 用户轮无入场动画：发送是键盘高频路径（animate skill 频率表：键盘触发=不动画）。
// 26 个工具（12 只读 + 14 写/执行）在 ai-exec 进程内执行，TOOL_META 仅用于 UI 展示。
// 会话持久在服务端：sessionId 与 URL query ?session= 双向同步（跨设备续聊链接）。
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useChat } from '@ai-sdk/react'
import type { UIMessage } from 'ai'
import {
  AlertTriangle,
  Boxes,
  CircleCheck,
  History,
  MessageCircleDashed,
  MessageSquareText,
  ArrowDown,
  SquarePen,
  X,
} from 'lucide-react'
import {
  abortAiSession,
  getAiSessionMessages,
  listAiModels,
  listAiSessions,
} from '@/api/ai'
import type { AiChatMessage, AiPermission } from '@/api/ai'
import { age } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/markdown'
import { PromptInput, type PromptInputFile } from '@/components/ai-elements/prompt-input'
import { tf, useT } from '@/i18n'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Message, MessageContent } from '@/components/ui/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { createServerTransport } from './server-transport'
import { contextGuideChipKeys, formatContextRef, formatPageForAI, resourceContextKey, usePageContext, useResourceContext } from './context'
import { subscribeAsk, takePendingAsk } from './askBus'
import { ApprovalRow, CopyAnswer, StepRow, type ChatPart, type ReasoningPart, type TextPart, type ToolPart } from './MessageParts'

// ---------- 组件 ----------

/**
 * 审批续流自动重发的条件（替代内置 lastAssistantMessageIsCompleteWithApprovalResponses）。
 * 内置谓词要求最后一步的**全部**工具 part 处于终态；但 confirm 模式下模型同一步发多个工具
 * （一个被门控 + 其余排在门后排队）时，排队工具的 part 永远停在 input-available
 * （sequential 执行，run parked 在门上）→ 内置条件永不成立 → 审批 POST 永不发出 →
 * 服务端闸门永久挂起（实测死锁）。
 * 放宽为：任一 assistant 消息存在已裁决（approval-responded）的工具 part 即重发。
 * 扫全部消息而非仅最后一条（R2 P2-1）：用户在批准卡后先补发一条新消息时，只看
 * last 会让旧审批卡的续流永不发出 → 服务端闸门挂到 TTL。responded part 在续流
 * 成功后必转 output-* 终态（条件转假，无循环）；续流失败的消息进 SDK 的
 * interruptedMessageIds，shouldSendAutomatically 直接拒绝。
 * @param {UIMessage[]} messages
 * @returns {boolean}
 */
function hasUnsentApprovalResponse(messages: UIMessage[]): boolean {
  return messages.some(
    m =>
      m.role === 'assistant' &&
      m.parts.some(
        p =>
          (p.type === 'dynamic-tool' || p.type.startsWith('tool-')) &&
          'state' in p &&
          p.state === 'approval-responded',
      ),
  )
}

export interface AiChatProps {
  cluster: string
  /** 全屏模式：显示顶部标题栏（/ai 页用）；卡片模式省略（dashboard 卡片自带标题） */
  showHeader?: boolean
  /** 紧凑模式：卡片内使用，收缩内边距 */
  compact?: boolean
  className?: string
  /** 悬浮 dock 的关闭回调：header 右端渲染 X；整页 /ai 不传 */
  onClose?: () => void
  /** 流式回复状态上抛（FAB 收起时据此显示 live 点） */
  onBusyChange?: (busy: boolean) => void
}

/** 权限选择持久化 key（跨刷新记忆；默认 confirm） */
const PERMISSION_STORAGE_KEY = 'k8s-ai-permission'

export function AiChat({ cluster, showHeader = false, compact = false, className, onClose, onBusyChange }: AiChatProps) {
  const t = useT()
  // 裁决即时生效：批准/拒绝后 FAB 角标立刻归零/递减（30s 轮询只兜「人在面板外」）
  const pendingQc = useQueryClient()
  // 「本会话免询」白名单：此前授完即隐身——审计页里白名单写与逐条批准的写同貌，
  // 会话内也看不到/想不起免过什么。chips 行让授权在 UI 可见（撤销=换档，账在审计页）
  const [autoAllowed, setAutoAllowed] = useState<string[]>([])
  const [allowErr, setAllowErr] = useState(false)
  // 模型列表：GET /ai/models（models.json 目录容器构建期注入 env，进程内不变 → staleTime 5min）
  const modelsQuery = useQuery({
    queryKey: ['ai-models'],
    queryFn: listAiModels,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  const models = modelsQuery.data ?? []
  const aiReady = models.length > 0

  // 模型：默认取列表第一个；切换即下次发送生效（transport 发送时取最新值，不清会话）
  const [model, setModel] = useState('')
  const selectedModel = model || (models[0]?.id ?? '')

  // 工具执行权限：只读/写确认/完全权限（localStorage 记忆；默认写确认——真实集群写操作先批准）
  const [permission, setPermission] = useState<AiPermission>(() => {
    const v = localStorage.getItem(PERMISSION_STORAGE_KEY)
    return v === 'readonly' || v === 'confirm' || v === 'full' ? v : 'confirm'
  })
  useEffect(() => {
    localStorage.setItem(PERMISSION_STORAGE_KEY, permission)
  }, [permission])

  // 会话：state + URL query ?session= 双向同步（跨设备续聊链接）
  // URL → state：挂载时读一次并恢复会话（见下方 restore effect）；state → URL：replaceState（不动路由栈）
  const [sessionId, setSessionId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('session'),
  )
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
    const url = new URL(window.location.href)
    if (sessionId) url.searchParams.set('session', sessionId)
    else url.searchParams.delete('session')
    window.history.replaceState(window.history.state, '', url)
  }, [sessionId])

  // 会话重置/切集群时自增 → 重挂载 PromptInput，清空其内部附件状态
  const [sessionKey, setSessionKey] = useState(0)
  const [input, setInput] = useState('')

  // 「问 AI」总线：列表/详情页的问 AI 入口把诊断请求预填进输入框（面板由 Fab 唤起）。
  // 双挂载点（/ai 整页 + Fab 隐藏面板）各自消费互不干扰；挂载时兜底取一次 pending
  useEffect(() => {
    const fill = (text: string) => setInput(prev => (prev.trim() ? `${prev}\n${text}` : text))
    const unsub = subscribeAsk(fill)
    const p = takePendingAsk()
    if (p) fill(p)
    return unsub
  }, [])

  // 当前页面资源上下文（详情路由 → 非空；随路由切换自动更新）。
  // ✕「本会话忽略」按资源 key 记忆：同一会话内切回别的资源上下文自然回来；
  // 新会话/切会话（sessionKey 变化）清除忽略，上下文重新可用。
  const routeCtx = useResourceContext()
  // 页面感知：任意路由的语义描述随每轮发送（transport 闭包取最新）
  const pageCtx = usePageContext()
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  useEffect(() => {
    setDismissedKey(null)
  }, [sessionKey])
  // cluster 校验：上下文资源必须属于本聊天面板的集群（防御路由参数与 props 不一致）
  const activeCtx =
    routeCtx && routeCtx.cluster === cluster && resourceContextKey(routeCtx) !== dismissedKey
      ? routeCtx
      : null

  // transport：指向同源 /ai/chat；每次渲染重建，闭包取最新 cluster/model/sessionId/permission
  // 「拒绝并说明」的理由旁路（toolCallId → note）：SDK 审批形状只带 approved 布尔
  const denyNotesRef = useRef(new Map<string, string>())
  const transport = aiReady
    ? createServerTransport({
        cluster,
        model: () => selectedModel,
        sessionId: () => sessionIdRef.current,
        permission: () => permission,
        page: () => formatPageForAI(pageCtx),
        denyNotes: () => denyNotesRef.current,
      })
    : undefined

  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    setMessages,
    clearError,
    addToolApprovalResponse,
  } = useChat<AiChatMessage>({
    transport,
    // 原生审批：存在已裁决未续流的审批 part → 自动重发 /chat（approvals 续流请求）
    sendAutomaticallyWhen: ({ messages }) => hasUnsentApprovalResponse(messages as UIMessage[]),
  })

  // 会话内切历史会话：switchSession 恢复的白名单经 ref 过继给本 effect——
  // 直接 setAutoAllowed(sess.autoAllowed) 会被本 effect 的无条件清空抹掉（React 批处理必然后跑）
  const autoAllowSeed = useRef<string[] | null>(null)
  useEffect(() => {
    setAutoAllowed(autoAllowSeed.current ?? [])
    autoAllowSeed.current = null
    setAllowErr(false)
  }, [sessionId])
  // AI 经 disposition_set 登记处置 → 开着的首页/巡检页必须跟上：
  // AI 说「已登记」而值班屏还说「没人管」= 双账本
  // 按产出条数一次性触发：messages 每流式帧换引用，布尔判定会让历史里
  // 存在任一 disposition_set 输出后每帧空转 invalidate
  const dispWriteSeen = useRef(0)
  useEffect(() => {
    const n = messages.reduce(
      (acc, m) =>
        acc +
        ((m.parts ?? []).some(
          (pt: { type?: string; state?: string; toolName?: string }) =>
            pt.state === 'output-available' && (pt.type === 'tool-disposition_set' || (pt.type === 'dynamic-tool' && pt.toolName === 'disposition_set')),
        )
          ? 1
          : 0),
      0,
    )
    if (n > dispWriteSeen.current) {
      dispWriteSeen.current = n
      void pendingQc.invalidateQueries({ queryKey: ['dispositions', cluster] })
    }
  }, [messages, cluster, pendingQc])

  // 挂载恢复：URL 带 ?session= 时，先经会话列表确认其属于当前集群
  //（防止切集群时 ?session= 被带过来），再拉历史消息
  const [restoring, setRestoring] = useState(() => sessionId != null)
  useEffect(() => {
    const urlSession = sessionIdRef.current
    if (!urlSession) return
    let cancelled = false
    void (async () => {
      try {
        const list = await listAiSessions(cluster)
        if (cancelled) return
        if (!list.some(s => s.id === urlSession)) {
          // 会话不属于当前集群（或已失效）→ 清 URL 参数，从新会话开始
          setSessionId(null)
          setSessionKey(k => k + 1)
          return
        }
        const sess = await getAiSessionMessages(urlSession)
        if (cancelled) return
        if (sess.messages.length > 0) setMessages(sess.messages)
        if (sess.autoAllowed.length > 0) setAutoAllowed(sess.autoAllowed)
      } catch {
        // 服务暂不可达 / 网络抖动：保留 sessionId（下次发送在服务端续上），历史留空
      } finally {
        if (!cancelled) setRestoring(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, []) // 仅挂载时（切集群由父层 key 重挂载，天然重置）

  // 服务端首帧（start.messageMetadata）携带新分配的 sessionId → 同步到 state（上方 effect 回写 URL）
  useEffect(() => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    const sid = lastAssistant?.metadata?.sessionId
    if (sid && sid !== sessionIdRef.current) setSessionId(sid)
  }, [messages])


  const busy = status === 'submitted' || status === 'streaming'

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    // 切集群（父层 key 重挂载）或服务就绪状态变化后清空输入草稿与附件
    setInput('')
    setSessionKey(k => k + 1)
  }, [cluster, aiReady])

  // 发送：附件拼进消息（文本内容进代码块；二进制/超限只提文件名）
  // 上下文注入：激活时把「参考上下文」行拼进消息正文首行——诚实可见（用户气泡里能看到、
  // 发送前可编辑），非隐藏 system 注入；上下文条 ✕ 忽略后不再拼接。
  const send = (raw: string, files: PromptInputFile[]) => {
    const text = raw.trim()
    if (!text || busy || restoring || !aiReady) return
    setInput('')
    let full = activeCtx
      ? tf('aictx:injectLine', { kind: activeCtx.kind, ref: formatContextRef(activeCtx) }) + '\n' + text
      : text
    for (const f of files) {
      full +=
        f.content != null
          ? tf('ai:attachmentContent', { name: f.name, content: f.content })
          : tf('ai:attachmentBinary', { name: f.name })
    }
    void sendMessage({ text: full })
  }

  const reset = () => {
    setMessages([])
    clearError()
    setInput('')
    setSessionId(null) // → effect 移除 URL 的 ?session=
    setSessionKey(k => k + 1)
  }

  // 历史会话：popover 打开时查询列表（每次打开重取），点选即恢复（拉历史消息 → 换入当前会话）
  const [historyOpen, setHistoryOpen] = useState(false)
  const sessionsQuery = useQuery({
    queryKey: ['ai-sessions', cluster],
    queryFn: () => listAiSessions(cluster),
    enabled: historyOpen,
    staleTime: 0, // 每次打开都刷新（新会话随时产生）
  })
  const switchSession = (id: string) => {
    setHistoryOpen(false)
    if (id === sessionIdRef.current) return
    if (busy) stop() // 先中止当前 run 再切换
    setRestoring(true)
    void (async () => {
      try {
        const sess = await getAiSessionMessages(id)
        setMessages(sess.messages)
        autoAllowSeed.current = sess.autoAllowed
        clearError()
        setInput('')
        setSessionId(id) // → effect 回写 URL ?session=（跨设备链接跟着变）
        setSessionKey(k => k + 1)
      } catch {
        // 服务暂不可达：保留当前会话
      } finally {
        setRestoring(false)
      }
    })()
  }

  const handleStop = () => {
    // 先切断本地 SSE，再通知服务端中止 pi run（服务端工具调用/LLM 调用一并停止；fire-and-forget）
    stop()
    const sid = sessionIdRef.current
    if (sid) abortAiSession(sid)
  }

  const last = messages[messages.length - 1]
  const thinking =
    busy &&
    last?.role === 'assistant' &&
    !last.parts.some(
      p =>
        (p.type === 'text' && p.text) ||
        (p.type === 'reasoning' && p.text) ||
        p.type === 'dynamic-tool' ||
        p.type.startsWith('tool-'),
    )

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
      <div className={cn('relative flex h-full min-h-0 flex-col bg-background', className)}>
        {showHeader && (
          <div className="flex h-11 shrink-0 items-center gap-2 px-4">
            <div className="ml-auto flex items-center gap-1">
              {/* 本地 Provider：应用无全局 TooltipProvider（同 GatedButton 约定），缺失即崩 */}
              <TooltipProvider delayDuration={300}>
              {/* 历史会话：打开即查列表，点选恢复；Tooltip 补齐裸图标发现性 */}
              <Tooltip>
                <TooltipTrigger asChild>
              <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8" aria-label={t('ai:history')}>
                    <History className="size-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-1.5">
                  <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{t('ai:history')}</div>
                  {sessionsQuery.isLoading ? (
                    <div className="flex items-center gap-2 px-2 py-3 text-[13px] text-muted-foreground">
                      <Spinner className="size-3.5" />
                      {t('ai:loading')}
                    </div>
                  ) : (sessionsQuery.data ?? []).length === 0 ? (
                    <div className="px-2 py-3 text-[13px] text-muted-foreground">{t('ai:noSessions')}</div>
                  ) : (
                    <div className="max-h-72 overflow-y-auto">
                      {[...(sessionsQuery.data ?? [])]
                        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                        .map(s => (
                          <button
                            key={s.id}
                            onClick={() => switchSession(s.id)}
                            aria-current={s.id === sessionId ? 'true' : undefined}
                            className={cn(
                              'flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/60',
                              s.id === sessionId && 'bg-muted',
                            )}
                          >
                            <span className="w-full truncate text-[13px] font-medium" title={s.title || undefined}>{s.title || t('ai:unnamedSession')}</span>
                            <span className="text-xs text-muted-foreground">
                              {age(s.updatedAt)}
                              {s.id === sessionId ? t('ai:currentSession') : ''}
                            </span>
                          </button>
                        ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
                </TooltipTrigger>
                <TooltipContent>{t('ai:history')}</TooltipContent>
              </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      aria-label={t('ai:newSession')}
                      onClick={reset}
                      disabled={busy}
                    >
                      {/* ↻ 运维语境读作「刷新」；新建会话用笔形 */}
                      <SquarePen className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('ai:newSession')}</TooltipContent>
                </Tooltip>
              {onClose && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-8" aria-label={t('core:close')} onClick={onClose}>
                      <X className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('core:close')}</TooltipContent>
                </Tooltip>
              )}
              </TooltipProvider>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1">
          {modelsQuery.isLoading ? (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
              <Spinner className="size-3.5" />
              {t('ai:loadingModels')}
            </div>
          ) : !aiReady ? (
            <Empty className="h-full">
              <EmptyHeader className="max-w-md">
                <EmptyMedia variant="icon">
                  <MessageCircleDashed />
                </EmptyMedia>
                <EmptyTitle>{t('ai:serviceNotReady')}</EmptyTitle>
                <EmptyDescription>{t('ai:serviceNotReadyDesc')}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : restoring ? (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
              <Spinner className="size-3.5" />
              {t('ai:restoringSession')}
            </div>
          ) : messages.length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader className="max-w-md">
                <EmptyMedia variant="icon" className="size-10 [&_svg]:size-5">
                  <MessageSquareText />
                </EmptyMedia>
                <EmptyDescription>{t('ai:emptyDesc')}</EmptyDescription>
              </EmptyHeader>
              {/* 引导问题是空态的行动指引，必须与空态同构图（此前锚在输入区上方互不相干） */}
              <EmptyContent className="flex-row flex-wrap justify-center gap-2">
                {contextGuideChipKeys(activeCtx).map(k => {
                  const q = tf(k, { kind: activeCtx?.kind ?? '' })
                  return (
                    <Button key={k} variant="outline" size="xs" className="min-h-8 shrink-0" onClick={() => send(q, [])}>
                      {q}
                    </Button>
                  )
                })}
              </EmptyContent>
            </Empty>
          ) : (
            <MessageScroller className="h-full min-h-0">
              <MessageScrollerViewport>
                <MessageScrollerContent
                  aria-busy={busy}
                  className={cn(
                    'mx-auto w-full max-w-3xl gap-5',
                    compact ? 'px-3 py-2' : 'px-4 py-3',
                  )}
                >
                  {messages.map((m, mi) => {
                    if (m.role === 'user') {
                      return (
                        <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor>
                          <Message align="end">
                            <MessageContent>
                              <Bubble align="end" variant="tinted">
                                {/* 注入的上下文行与正文以 \n 分隔：pre-wrap 保证按行显示（用户气泡原文完整可见） */}
                                <BubbleContent className="whitespace-pre-wrap text-sm leading-6">
                                  {m.parts.filter((p): p is TextPart => p.type === 'text').map(p => p.text).join('')}
                                </BubbleContent>
                              </Bubble>
                            </MessageContent>
                          </Message>
                        </MessageScrollerItem>
                      )
                    }

                    const streaming = busy && m === messages.at(-1)
                    const isPendingApproval = (p: ChatPart): p is ToolPart =>
                      (p.type === 'dynamic-tool' || p.type.startsWith('tool-')) &&
                      'state' in p &&
                      p.state === 'approval-requested'
                    // 按 parts 原始时间序渲染：连续的 思考/工具 段合并进一个 Trace，正文 part 打断分段——
                    // 若按类型分组（全部步骤在前、全部正文在后），模型中途说的正文会拼到所有工具后面，时序错乱。
                    const isStep = (p: ChatPart): p is ReasoningPart | ToolPart =>
                      (p.type === 'reasoning' || p.type === 'dynamic-tool' || p.type.startsWith('tool-')) &&
                      !isPendingApproval(p)
                    type Segment =
                      | { t: 'trace'; key: number; items: (ReasoningPart | ToolPart)[] }
                      | { t: 'text'; key: number; text: string }
                      | { t: 'approval'; key: number; part: ToolPart }
                    // 断线失效工具行的重发素材：本 assistant 消息之前最近的用户请求
                    const prevUserText = [...messages.slice(0, mi)]
                      .reverse()
                      .find(x => x.role === 'user')
                      ?.parts.find(p => p.type === 'text')
                      ?.text
                    const segments: Segment[] = []
                    m.parts.forEach((part, idx) => {
                      if (isPendingApproval(part)) {
                        // 待批准的工具 part：shadcn pattern 里 pending approval 是「提示」，渲染在 Trace 之外
                        segments.push({ t: 'approval', key: idx, part })
                      } else if (part.type === 'text') {
                        segments.push({ t: 'text', key: idx, text: part.text })
                      } else if (isStep(part)) {
                        const last = segments[segments.length - 1]
                        if (last && last.t === 'trace') last.items.push(part)
                        else segments.push({ t: 'trace', key: idx, items: [part] })
                      }
                    })

                    return (
                      <MessageScrollerItem key={m.id} messageId={m.id}>
                        <Message>
                          {/* 轮内段间距 8 < 轮间 12（MessageScrollerContent gap-3）：组内紧、组间松 */}
                          <MessageContent className="gap-2">
                            {segments.map((seg, si) =>
                              seg.t === 'trace' ? (() => {
                                const rows = seg.items.map((part, i) => (
                                  <StepRow
                                    key={
                                      'toolCallId' in part
                                        ? part.toolCallId
                                        : 'id' in part && part.id
                                          ? part.id
                                          : i
                                    }
                                    part={part}
                                    streaming={streaming}
                                    staleResend={prevUserText}
                                    onStaleResend={(text) => setInput((prev) => (prev.trim() ? `${prev}\n${text}` : text))}
                                  />
                                ))
                                // 完成态台账收成一行「已完成 N 步」（平铺 7+ 行占屏 1/4）；
                                // 失败计数常驻收起行保持 negative，不让失败被折叠藏掉
                                const fails = seg.items.filter(
                                  p => 'state' in p && (p.state === 'output-error' || p.state === 'output-denied') && (p as { stale?: boolean }).stale !== true,
                                ).length
                                if (streaming) {
                                  return (
                                    <div key={seg.key} className="animate-in fade-in-0 duration-150">
                                      <Trace>{rows}</Trace>
                                    </div>
                                  )
                                }
                                return (
                                  // 流式中在上面 return 走了平铺分支;能到这行的必是完成态。
                                  // key 固定 -d 后缀:平铺→收行是不同 key,remount 重放 fade 不硬跳
                                  <div key={`${seg.key}-d`} className="animate-in fade-in-0 duration-150">
                                    <TraceCollapsible>
                                    <TraceCollapsibleTrigger className="w-full">
                                      <TraceLine status={fails > 0 ? 'error' : undefined} className="text-[13px]">
                                        <TraceIcon>
                                          {fails > 0 ? <AlertTriangle className="size-3.5" /> : <CircleCheck className="size-3.5" />}
                                        </TraceIcon>
                                        <TraceTitle className="text-[13px]">{tf('ai:traceSummary', { n: seg.items.length })}</TraceTitle>
                                        {fails > 0 && <TraceDescription className="text-negative text-xs">{tf('ai:traceFails', { n: fails })}</TraceDescription>}
                                      </TraceLine>
                                    </TraceCollapsibleTrigger>
                                    <TraceCollapsibleContent>
                                      <div className="space-y-1">{rows}</div>
                                    </TraceCollapsibleContent>
                                  </TraceCollapsible>
                                  </div>
                                )
                              })() : seg.t === 'text' ? (
                                seg.text ? (
                                  <div key={seg.key} className={streaming ? 'animate-in fade-in-0 duration-150' : undefined}>
                                    <Markdown>{seg.text}</Markdown>
                                    {streaming && si === segments.length - 1 && (
                                      // 流式出字指示：静态方块光标（不用 blink/pulse）
                                      <span aria-hidden className="mt-1 inline-block size-2 align-middle bg-foreground/60" />
                                    )}
                                  </div>
                                ) : null
                              ) : (
                                <ApprovalRow
                                  key={`approval-${'toolCallId' in seg.part ? seg.part.toolCallId : seg.key}`}
                                  part={seg.part}
                                  onRespond={(id, approved, note) => {
                                    if (!approved && note) denyNotesRef.current.set(id, note)
                                    addToolApprovalResponse({ id, approved })
                                    // 先本地摘除再 invalidate 对账：裁决真正生效在之后的续流 POST，
                                    // 只 invalidate 的话 GET 抢在 POST 前返回原清单，幽灵角标再挂 30s
                                    pendingQc.setQueryData<{ items: { toolCallId: string }[] }>(['ai-pending'], old =>
                                      old ? { items: old.items.filter(i => i.toolCallId !== id) } : old,
                                    )
                                    void pendingQc.invalidateQueries({ queryKey: ['ai-pending'] })
                                  }}
                                  onAllowSession={
                                    sessionId
                                      ? (id, toolName) => {
                                          // 先登记白名单再批成本卡：同会话后续同名工具直接执行。
                                          // 失败不能吞——吞错的授权表现为「卡片又出现了」而无任何解释
                                          void fetch('/ai/autoallow', {
                                            method: 'POST',
                                            headers: { 'content-type': 'application/json' },
                                            body: JSON.stringify({ sessionId, toolName, cluster }),
                                          })
                                            .then(r => (r.ok ? (r.json() as Promise<{ autoAllowed?: string[] }>) : Promise.reject(new Error(String(r.status)))))
                                            .then(d => setAutoAllowed(d.autoAllowed ?? []))
                                            .catch(() => setAllowErr(true))
                                          addToolApprovalResponse({ id, approved: true })
                                        }
                                      : undefined
                                  }
                                />
                              ),
                            )}
                          {(() => {
                            const all = segments.filter(x => x.t === 'text').map(x => x.text).join('\n\n').trim()
                            return all ? <CopyAnswer text={all} /> : null
                          })()}
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    )
                  })}

                  {thinking && (
                    <MessageScrollerItem>
                      <Message>
                        <MessageContent>
                          <div className="flex items-center gap-2 px-1 py-0.5 text-[13px] text-muted-foreground">
                            <Spinner className="size-3.5" />
                            {t('ai:thinking')}
                          </div>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  )}

                  {error && (
                    <MessageScrollerItem>
                      <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 break-words">{error.message || t('ai:unreachableShort')}</span>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-[13px]"
                          onClick={() => {
                            const u = [...messages].reverse().find(m => m.role === 'user')
                            if (u) setInput(u.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n'))
                            clearError()
                          }}
                        >
                          {t('ai:retryRefill')}
                        </Button>
                        <Button variant="ghost" size="xs" className="text-[13px]" onClick={clearError}>
                          {t('ai:close')}
                        </Button>
                      </div>
                    </MessageScrollerItem>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton className="z-10 bottom-2 start-auto end-6 translate-x-0 shadow-md rtl:translate-x-0">
                <ArrowDown />
                <span className="sr-only">{t('ai:scrollToEnd')}</span>
              </MessageScrollerButton>
            </MessageScroller>
          )}
        </div>

        <div className={cn('mx-auto w-full max-w-3xl shrink-0', compact ? 'px-3 py-2' : 'px-4 py-3')}>
          {/* 上下文条：当前路由指向资源详情时显示（输入框上方）；✕ 本会话忽略后不再拼接注入行 */}
          {activeCtx && (
            <div className="mb-2 flex h-7 items-center gap-1.5 rounded-md border bg-muted/40 px-2 text-[13px]">
              <Boxes className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 text-muted-foreground">{t('aictx:barLabel')}</span>
              <span className="shrink-0 font-medium">{activeCtx.kind}</span>
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {formatContextRef(activeCtx)}
              </span>
              <button
                className="ml-auto grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('aictx:dismiss')}
                title={t('aictx:dismiss')}
                onClick={() => setDismissedKey(resourceContextKey(activeCtx))}
              >
                <X className="size-3" />
              </button>
            </div>
          )}
          {/* 会话免询白名单可见化 + 授权失败可见 */}
          {(autoAllowed.length > 0 || allowErr) && (
            <div className="mb-2 flex min-h-7 flex-wrap items-center gap-1.5 text-xs" title={t('ai:autoAllowedHint')}>
              {allowErr && <span className="text-caution">{t('ai:autoAllowFail')}</span>}
              {autoAllowed.map(name => (
                <span key={name} className="inline-flex items-center gap-1.5 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  <span aria-hidden className="size-1.5 rounded-full bg-caution" />
                  {name}
                </span>
              ))}
              {autoAllowed.length > 0 && <span className="text-muted-foreground">{t('ai:autoAllowedSuffix')}</span>}
            </div>
          )}
                    {/* 输入区 = shadcn AI Elements PromptInput（附件/模型选择/发送停止在组件内自持） */}
          <PromptInput
            key={sessionKey}
            value={input}
            onChange={setInput}
            onSend={send}
            busy={busy}
            onStop={handleStop}
            disabled={!aiReady || restoring}
            models={models}
            selectedModel={selectedModel}
            onModelChange={setModel}
            permission={permission}
            onPermissionChange={(p) => {
              setPermission(p)
              // 服务端换档即清白名单（server 同语义）：UI 同步摘 chip，不留「隐形但生效」的假授权
              setAutoAllowed([])
            }}
            className={compact ? 'min-h-8' : undefined}
            compact={compact}
          />
        </div>
      </div>
    </MessageScrollerProvider>
  )
}
