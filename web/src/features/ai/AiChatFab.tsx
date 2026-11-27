// 全局 AI 助手入口：右下角 FAB + 右侧固定宽度停靠 dock（用户定稿形态 2026-11）。
// 历史版本的自由拖拽/三向缩放/几何持久化已删除——面板定位回归确定性：贴右缘全高、
// 桌面 420px、移动全宽；收起=隐藏（组件常驻不卸载，聊天会话/输入状态跨路由与开合保持，
// session 同时经 URL ?session= 持久）。Esc 或 header X 收起；「问 AI」入口经 askBus 唤起。
import { MessageSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { tf, useT } from '@/i18n'
import { AiChat } from '@/features/ai/AiChat'
import { useResourceContext } from './context'
import { onAskOpen } from './askBus'
import { useQuery } from '@tanstack/react-query'

export function AiChatFab({ cluster }: { cluster: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  // 待批准写操作=值班真待办：审批卡只活在展开的聊天面板里，切窗口即从产品消失——FAB 挂计数角标兜住。
  // **全集群计数**（不带 cluster 参数）：FAB 是全局组件，A 集群的挂起审批在用户看 B 集群时
  // 也必须可见——按集群过滤会让待办在切集群时静默消失直至 TTL 自动拒绝
  const [inbox, setInbox] = useState(false)
  const pendingQRef = useRef({ refetch: () => void 0 })
  const pendingQ = useQuery({
    queryKey: ['ai-pending'],
    queryFn: () => fetch('/ai/pending').then((r) => r.json() as Promise<{ items: { cluster?: string; toolName?: string; sessionId?: string; expiresAt?: number }[] }>),
    refetchInterval: inbox ? 15_000 : 30_000,
    // 裁决动作即时失效（AiChat onRespond），轮询只兜「人在面板外」的场景
    refetchIntervalInBackground: false,
    retry: 0,
    staleTime: 15_000,
  })
  const pendingItems = pendingQ.data?.items ?? []
  // 回前台即对账：后台标签页不轮询是省电的正确姿势，但人回到面板的第一眼必须是真数
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') void pendingQRef.current.refetch()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  pendingQRef.current.refetch = () => void pendingQ.refetch()

  const pendingCount = pendingItems.length
  const pendingTitle = tf('ai:fabPendingByCluster', {
    list: [...new Set(pendingItems.map(i => i.cluster || '?'))].join(', '),
  })
  const dockRef = useRef<HTMLDivElement>(null)
  const fabRef = useRef<HTMLButtonElement>(null)
  // 开合移焦（仅真实开合时；首挂载不动焦点）：FAB 可能埋在长列表里，
  // 开 → 进 dock，关 → 回 FAB，键盘用户不丢位置
  const prevOpen = useRef(false)
  useEffect(() => {
    if (open && !prevOpen.current) requestAnimationFrame(() => dockRef.current?.focus())
    if (!open && prevOpen.current) fabRef.current?.focus()
    prevOpen.current = open
  }, [open])

  // 面板里的 AiChat 挂在 AppLayout 内 → useResourceContext 读同一份路由状态，
  // 路由变化时上下文自然更新；title 与面板行为同一判定（cluster 防路由参数不一致）
  const routeCtx = useResourceContext()
  const carryCtx = routeCtx && routeCtx.cluster === cluster ? routeCtx : null

  // Esc 收起面板。让位给活动模态框：Radix DismissableLayer 处理 Escape 不阻断传播，
  // 聚合日志/Scale 确认框开着时按 Esc 会把 dock 一起收起（用户正对照日志看 AI 回复）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // 「问 AI」入口（详情页按钮/列表行）唤起面板；输入内容经 askBus 直达 AiChat 输入框
  useEffect(() => onAskOpen(() => setOpen(true)), [])

  return (
    <>
      {/* FAB：收起态常驻右下；展开时移到 dock 左缘外（移动端 dock 全宽则隐藏，
          关闭走 dock header 的 X）。live 点在开合两态都显示（全站状态点同一语义色）。
          收件箱角标是**平级真按钮**（此前嵌在 FAB button 内：span 永不可聚焦 →
          键盘无路进收件箱，button 套交互元素还是 ARIA 反模式） */}
      <div className={cn('fixed z-50 size-12', open ? 'right-4 top-3 hidden sm:block sm:right-[436px]' : 'bottom-4 right-4')}>
        <button
          ref={fabRef}
          aria-label={open ? t('core:close') : pendingCount > 0 ? pendingTitle : t('ai:assistant')}
          title={carryCtx ? tf('aictx:fabCarries', { kind: carryCtx.kind }) : undefined}
          aria-expanded={open}
          aria-controls="ai-dock"
          onClick={() => setOpen(o => !o)}
          className={cn(
            'flex size-12 items-center justify-center rounded-full shadow-md transition-colors',
            open ? 'border border-input bg-secondary text-secondary-foreground' : 'bg-primary text-primary-foreground',
          )}
        >
          <MessageSquare className="size-5" />
        </button>
        {/* 运行点左上、收件箱角标右上：挂起审批 + 流式进行中两个事实并存不互斥。
            开态也显示运行点（FAB 开态不换 ✕ 形:同屏双关闭已除,开态语义=收起,✕ 归 dock 头） */}
        {aiBusy && (
          <span title={t('ai:running')} className="absolute -left-0.5 top-1 size-2 rounded-full bg-positive ring-2 ring-background" />
        )}
        {!open && pendingCount > 0 && (
          <Popover
            open={inbox}
            onOpenChange={(v) => {
              setInbox(v)
              // 开弹层即对账：倒计时以数据新鲜度为准
              if (v) void pendingQ.refetch()
            }}
          >
            {/* 真 button 作 trigger：可聚焦、原生 Enter/Space、focus 环走全站惯例 */}
            <PopoverTrigger
              asChild
              aria-label={pendingTitle}
              className="absolute -right-1 -top-1 flex min-w-4.5 cursor-pointer items-center justify-center rounded-full bg-caution px-1 text-[11px] font-medium tabular-nums text-primary-foreground ring-2 ring-background focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <button type="button">{pendingCount}</button>
            </PopoverTrigger>
            {/* 待批准收件箱：工具名 + 归属集群 + 剩余时限 + 深链直达裁决现场（渲染/恢复链路全部现成） */}
            <PopoverContent side="top" align="end" className="w-72 p-2">
              <div className="mb-1 px-1 text-xs font-medium">{t('ai:inboxTitle')}</div>
              {pendingItems.map((it, i) => (
                <NavLink
                  key={`${it.sessionId}-${i}`}
                  to={`/c/${encodeURIComponent(it.cluster || cluster)}/ai?session=${encodeURIComponent(it.sessionId ?? '')}`}
                  onClick={() => setInbox(false)}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
                >
                  <span className="min-w-0 truncate font-mono">{it.toolName}</span>
                  <span className="shrink-0 text-muted-foreground">@{it.cluster}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-caution-on-primary">
                    {tf('ai:inboxExpire', { min: Math.max(0, Math.round(((it.expiresAt ?? 0) - pendingQ.dataUpdatedAt) / 60_000)) })}
                  </span>
                </NavLink>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </div>

      {/* 右侧停靠 dock：常驻挂载（hidden 切换），聊天状态跨页面/开合保持。
          开合瞬时是定案非缺陷：高频值班面板（Raycast 先例），键盘触发路径不加动画（animate 频率表）。
          开合移焦：FAB 可能埋在长列表里，开→进 dock，关→回 FAB，键盘用户不掉位置 */}
      <div
        id="ai-dock"
        ref={dockRef}
        role="region"
        aria-label={t('ai:assistant')}
        tabIndex={-1}
        className={cn(
          'fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l bg-background shadow-lg sm:w-[420px]',
          !open && 'hidden',
        )}
      >
        <AiChat
          key={cluster}
          cluster={cluster}
          showHeader
          compact
          className="h-full"
          onBusyChange={setAiBusy}
          onClose={() => setOpen(false)}
        />
      </div>
    </>
  )
}
