// 全局 AI 助手入口：右下 FAB（收起态）+ 聊天 dock，双形态可切（用户定稿 2026-11）。
// dock 形态：xl+ 布局内真列（挤压内容区不遮盖）；更窄屏退回贴右缘浮层。
// float 形态（header 悬浮按钮切入）：自由拖拽（header 空白处按住）+ 三向缩放
// （右缘/下缘/右下角），几何与形态均持久 localStorage，越界自动钳回视口，
// 双击 header 复位默认位。指针事件统一鼠标/触屏（touch-action:none 防滚动手势抢事件）。
// 收起=隐藏（组件常驻不卸载，聊天会话/输入状态跨路由与开合保持，
// session 同时经 URL ?session= 持久）。「问 AI」入口经 askBus 唤起。
import { MessageSquare, PanelRight, PictureInPicture2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { tf, useT } from '@/i18n'
import { AiChat } from '@/features/ai/AiChat'
import { useResourceContext } from './context'
import { onAskOpen } from './askBus'
import { useQuery } from '@tanstack/react-query'

// 开态/形态/几何跨挂载存活性：/ai 整页不挂本组件（双实例会各开各的会话），
// 去一趟 AI 助手回来若是全新挂载，开态/形态/拖过的位置都不该当没发生过
const DOCK_OPEN_KEY = 'k8s-ai-dock'
const DOCK_MODE_KEY = 'k8s-ai-dock-mode'
const GEOMETRY_KEY = 'k8s-ai-dock-geo'

type DockMode = 'dock' | 'float'

interface Geometry {
  x: number
  y: number
  w: number
  h: number
}

/** 悬浮默认尺寸：贴右下；vh 窄时收缩 */
function defaultGeometry(): Geometry {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(420, vw - 16)
  const h = Math.min(680, vh - 7.5 * 16 * 2)
  return { x: vw - w - 16, y: vh - h - 76, w, h }
}

function loadGeometry(): Geometry {
  try {
    const raw = localStorage.getItem(GEOMETRY_KEY)
    if (!raw) return defaultGeometry()
    const g = JSON.parse(raw) as Partial<Geometry>
    if (typeof g.x === 'number' && typeof g.y === 'number' && typeof g.w === 'number' && typeof g.h === 'number' && g.w > 0 && g.h > 0) {
      return { x: g.x, y: g.y, w: g.w, h: g.h }
    }
  } catch {
    /* 损坏配置退回默认 */
  }
  return defaultGeometry()
}

const MIN_W = 320
const MIN_H = 380

/** 钳位：整块面板留在视口内（留 8px 边距）；尺寸随视口收缩 */
function clampGeometry(g: Geometry): Geometry {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(Math.max(g.w, MIN_W), Math.max(vw - 16, MIN_W))
  const h = Math.min(Math.max(g.h, MIN_H), Math.max(vh - 16, MIN_H))
  return {
    w,
    h,
    x: Math.min(Math.max(g.x, 8), Math.max(vw - w - 8, 8)),
    y: Math.min(Math.max(g.y, 8), Math.max(vh - h - 8, 8)),
  }
}

export function AiChatFab({ cluster }: { cluster: string }) {
  const t = useT()
  const [open, setOpen] = useState(() => localStorage.getItem(DOCK_OPEN_KEY) === '1')
  useEffect(() => {
    localStorage.setItem(DOCK_OPEN_KEY, open ? '1' : '0')
  }, [open])
  const [mode, setMode] = useState<DockMode>(() => (localStorage.getItem(DOCK_MODE_KEY) === 'float' ? 'float' : 'dock'))
  useEffect(() => {
    localStorage.setItem(DOCK_MODE_KEY, mode)
  }, [mode])
  const isFloat = mode === 'float'
  const [geo, setGeo] = useState<Geometry>(() => (typeof window === 'undefined' ? { x: 16, y: 16, w: 420, h: 640 } : loadGeometry()))
  // 拖拽/缩放进行中：跳过 CSS transition（跟手不拖影）
  const [interacting, setInteracting] = useState(false)
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

  const persistGeo = useCallback((g: Geometry) => {
    try {
      localStorage.setItem(GEOMETRY_KEY, JSON.stringify(g))
    } catch {
      /* 隐私模式等写失败不影响使用 */
    }
  }, [])

  // 视口变化（含转屏/切分栏态）→ 重新钳位，悬浮面板不跑出屏幕
  useEffect(() => {
    const onResize = () => setGeo(g => clampGeometry(g))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /**
   * 指针拖拽/缩放通用逻辑：起点坐标 + 起始几何 → move 时派生新几何。
   * setPointerCapture 保证指针滑出面板后事件仍归本元素（触屏必需）。
   */
  const startGesture = (e: React.PointerEvent, derive: (start: Geometry, dx: number, dy: number) => Geometry) => {
    e.preventDefault()
    const start = { ...geo }
    const sx = e.clientX
    const sy = e.clientY
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    setInteracting(true)
    const onMove = (ev: PointerEvent) => {
      setGeo(clampGeometry(derive(start, ev.clientX - sx, ev.clientY - sy)))
    }
    const onUp = () => {
      el.releasePointerCapture(e.pointerId)
      setInteracting(false)
      // ref 读最新值持久化（setGeo 的函数式更新结果）
      setGeo(g => {
        persistGeo(g)
        return g
      })
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // header 拖动：排除按钮区（closest 判定防误拖）；双击复位手动判定——
  // startGesture 的 pointerdown preventDefault 会抑制浏览器 dblclick 合成
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null)
  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isFloat) return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if ((e.target as HTMLElement).closest('button')) return
    const now = performance.now()
    const last = lastTapRef.current
    if (last && now - last.t < 350 && Math.abs(e.clientX - last.x) < 8 && Math.abs(e.clientY - last.y) < 8) {
      lastTapRef.current = null
      const g = defaultGeometry()
      setGeo(g)
      persistGeo(g)
      return
    }
    lastTapRef.current = { t: now, x: e.clientX, y: e.clientY }
    startGesture(e, (g, dx, dy) => ({ ...g, x: g.x + dx, y: g.y + dy }))
  }

  // 缩放：右缘调宽 / 下缘调高 / 右下角双向；左上角固定（kubectl 风格够用，不做八向）
  const onResizeHandle = (dir: 'e' | 's' | 'se') => (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    startGesture(e, (g, dx, dy) => ({
      x: g.x,
      y: g.y,
      w: dir === 'e' || dir === 'se' ? g.w + dx : g.w,
      h: dir === 's' || dir === 'se' ? g.h + dy : g.h,
    }))
  }

  // 形态切换按钮（进 AiChat header 的 X 之前）：悬浮 ↔ 停靠
  const modeBtn = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={isFloat ? t('ai:modeDock') : t('ai:modeFloat')} onClick={() => setMode(isFloat ? 'dock' : 'float')}>
          {isFloat ? <PanelRight className="size-3.5" /> : <PictureInPicture2 className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{isFloat ? t('ai:modeDock') : t('ai:modeFloat')}</TooltipContent>
    </Tooltip>
  )

  return (
    <>
      {/* FAB：仅收起态显示在右下（开态收起入口归 dock 头 X，不再隔空浮按钮）。
          收件箱角标是**平级真按钮**（此前嵌在 FAB button 内：span 永不可聚焦 →
          键盘无路进收件箱，button 套交互元素还是 ARIA 反模式） */}
      <div className={cn('fixed bottom-4 right-4 z-50 size-12', open && 'hidden')}>
        <button
          ref={fabRef}
          aria-label={pendingCount > 0 ? pendingTitle : t('ai:assistant')}
          title={carryCtx ? tf('aictx:fabCarries', { kind: carryCtx.kind }) : undefined}
          aria-expanded={open}
          aria-controls="ai-dock"
          onClick={() => setOpen(o => !o)}
          className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-colors"
        >
          <MessageSquare className="size-5" />
        </button>
        {/* 运行点左上、收件箱角标右上：挂起审批 + 流式进行中两个事实并存不互斥。 */}
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

      {/* dock：常驻挂载（hidden 切换），聊天状态跨页面/开合保持。
          float=fixed 自由窗（几何驱动）；dock=xl+ 布局列/窄屏贴边浮层 */}
      <div
        id="ai-dock"
        ref={dockRef}
        role="region"
        aria-label={t('ai:assistant')}
        tabIndex={-1}
        style={isFloat ? { left: geo.x, top: geo.y, width: geo.w, height: geo.h } : undefined}
        className={cn(
          'flex flex-col bg-background',
          isFloat
            ? 'fixed z-40 overflow-hidden rounded-xl border shadow-lg'
            : cn(
                'fixed inset-y-0 right-0 z-40 w-full border-l shadow-lg sm:w-[420px]',
                // xl+：从浮层转为布局列——static 落进 SidebarProvider 的 flex 行，
                // shrink-0 保住 420，SidebarInset(flex-1 min-w-0) 被真挤窄；
                // m-2/rounded-xl/shadow-sm 逐项对齐 SidebarInset 的 inset 卡片形态（同款兄弟）
                'xl:static xl:z-auto xl:shrink-0 xl:m-2 xl:ml-0 xl:overflow-hidden xl:rounded-xl xl:border-0 xl:shadow-sm',
              ),
          isFloat && !interacting && 'transition-[left,top,width,height] duration-150',
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
          headerExtra={modeBtn}
          headerProps={isFloat ? { onPointerDown: onHeaderPointerDown, className: 'cursor-grab touch-none select-none active:cursor-grabbing' } : undefined}
        />
        {/* 悬浮态缩放手柄：透明条贴边，cursor 提示可拖；se 角小三角给可缩暗示 */}
        {isFloat && (
          <>
            <div onPointerDown={onResizeHandle('e')} className="absolute right-0 top-6 bottom-4 w-1.5 cursor-ew-resize touch-none" />
            <div onPointerDown={onResizeHandle('s')} className="absolute left-4 right-4 bottom-0 h-1.5 cursor-ns-resize touch-none" />
            <div
              onPointerDown={onResizeHandle('se')}
              className="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none"
            >
              <svg viewBox="0 0 10 10" className="size-full text-muted-foreground/50" aria-hidden>
                <path d="M9 1v8H1" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </div>
          </>
        )}
      </div>
    </>
  )
}
