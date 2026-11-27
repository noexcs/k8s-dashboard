// 设置页共享卡片原语：统一「标题+说明+瓦片行」结构，对齐 shadcn create builder 的卡片语言
// （瓦片=bordered 行，小标签在上/值与控制在下；分段控件=muted 容器内白色 active 药丸）。
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** inset 面板：卡内嵌一层的唯一合法形态（圆角/描边/底色全页一致，条件挂载时淡入） */
export const INSET = 'rounded-xl border border-border bg-muted/40'
/** 条件挂载淡入：dirty footer、编辑瓦片、骨架→内容等「从无到有」处统一 150ms */
// 纯 opacity 淡入淡出：reduce 下不归零（index.css .motion-fade 保留 120ms，
// motion-safe: 直接挂起会硬弹，与本页「更温和」策略相悖，故不带 motion-safe 前缀）
export const FADE = 'motion-fade [@starting-style]:opacity-0 transition-opacity duration-150 ease-[var(--ease-strong)]'

// id=左侧导航锚点；relative 供 [data-flash] 定位（导航跳转落点闪光）
export function SectionCard({ id, title, desc, action, children }: {
  id?: string
  title: ReactNode
  desc?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card id={id} data-setting-section={id ? '' : undefined} className="relative scroll-mt-2 gap-4 [--card-spacing:--spacing(5)]">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <CardTitle className="text-base font-semibold tracking-tight">{title}</CardTitle>
            {desc && <p className="text-xs leading-5 text-muted-foreground">{desc}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/** 设置瓦片：一行一个设置项（label 上、内容下），与 builder 左列 Style/Base Color 同构 */
export function SettingTile({ label, trailing, children, className, ...rest }: {
  label: ReactNode
  trailing?: ReactNode
  children?: ReactNode
  className?: string
  'aria-disabled'?: boolean
}) {
  return (
    <div className={cn('rounded-lg border px-3 py-2.5', className)} {...rest}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {trailing}
      </div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  )
}

/** 横向瓦片：左「label+当前值」右控件（明暗/语言这类单行二选一） */
export function SettingRow({ label, hint, control }: { label: ReactNode; hint?: ReactNode; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="text-xs leading-4 text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

export function Segmented<V extends string>({ options, value, onChange, ariaLabel }: {
  options: { value: V; label: ReactNode; title?: string }[]
  value: V
  onChange: (v: V) => void
  ariaLabel: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  // radiogroup 约定：组内 roving tabindex（仅选中项可 Tab 进入），方向键/Home/End 切换选中并跟随焦点
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = options.length
    const i = Math.max(0, options.findIndex(o => o.value === value))
    const j =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n
      : e.key === 'Home' ? 0
      : e.key === 'End' ? n - 1
      : -1
    if (j < 0) return
    e.preventDefault()
    onChange(options[j].value)
    ref.current?.querySelectorAll<HTMLButtonElement>('[role=radio]')[j]?.focus()
  }
  return (
    <div ref={ref} onKeyDown={onKeyDown} className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5" role="radiogroup" aria-label={ariaLabel}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          tabIndex={value === o.value ? 0 : -1}
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-6 rounded-md px-2.5 text-xs transition-colors pointer-coarse:h-9',
            value === o.value
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
