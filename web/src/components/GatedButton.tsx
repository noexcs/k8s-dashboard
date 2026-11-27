// 权限门控按钮（共享）：无权限时禁用 + tooltip「无权限」。
// disabled 按钮不触发指针事件，用 span 承接 hover。
// 调用点：ResourceDetailPage（编辑/删除）、WorkloadActions（扩缩容/重启）、NodeDetailPage（删节点）。
import type { ReactNode } from 'react'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface GatedButtonProps {
  allowed: boolean
  /** 按钮外观，默认 outline（与两处详情页/动作区现状一致） */
  variant?: 'default' | 'outline' | 'ghost'
  /** 破坏性动作：红色文字（ghost 删除按钮用） */
  destructive?: boolean
  /** 异步进行中：禁用 + 防重复点击 */
  busy?: boolean
  onClick?: () => void
  className?: string
  title?: string
  /** 图标钮的可及名（此前白名单不含 aria-label，调用点传了被静默丢弃） */
  ariaLabel?: string
  size?: 'default' | 'xs' | 'sm' | 'icon' | 'icon-sm' | 'icon-xs'
  children: ReactNode
}

export function GatedButton({
  allowed,
  variant = 'outline',
  destructive = false,
  busy = false,
  onClick,
  className,
  title,
  ariaLabel,
  size,
  children,
}: GatedButtonProps) {
  const t = useT()
  const button = (
    <Button
      variant={variant}
      size={size}
      aria-label={ariaLabel}
      disabled={!allowed || busy}
      onClick={allowed ? onClick : undefined}
      title={title}
      className={cn(destructive && 'text-destructive hover:text-destructive', className)}
    >
      {children}
    </Button>
  )
  if (allowed) return button
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{button}</span>
        </TooltipTrigger>
        <TooltipContent>{t('core:noPermission')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
