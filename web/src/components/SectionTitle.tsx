import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * 卡片区块标题的唯一制式：foreground 13/500（与字段标签的 muted 拉开层级），
 * 计数后缀由调用方包 `<span className="font-normal text-muted-foreground">`。
 * PodDetailPage / ResourceDetailPage 共用——两套标题色会毁掉同屏扫描层级。
 */
function SectionTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="section-title"
      className={cn("mb-2 text-[13px] font-medium text-foreground", className)}
      {...props}
    />
  )
}

export { SectionTitle }
