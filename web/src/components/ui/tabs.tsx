"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Tabs as TabsPrimitive } from "radix-ui"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-8 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), "data-[variant=line]:relative", className)}
      {...props}
    >
      {children}
      {variant === "line" && <TabsLineIndicator />}
    </TabsPrimitive.List>
  )
}

// line 变体单条滑动指示：Radix 无内置 indicator，测 active trigger 的 rect 后用
// translateX/scaleX 位移（只动 transform，合成器友好）。基准宽 = 首次测到的 active
// 尺寸（inline 定一次），此后仅更新 transform；ResizeObserver 跟 tab 变宽，
// MutationObserver 跟 data-state 切换与 trigger 增删。reduced-motion 下不走
// transform，直接 left/top+尺寸 定位，只留 opacity 100ms。
function TabsLineIndicator() {
  const ref = React.useRef<HTMLSpanElement>(null)
  const baseRef = React.useRef(0)

  React.useLayoutEffect(() => {
    const el = ref.current
    const list = el?.parentElement
    if (!el || !list) return

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
    const measure = () => {
      const active = list.querySelector<HTMLElement>(
        "[data-slot=tabs-trigger][data-state=active]"
      )
      if (!active) {
        el.style.opacity = "0"
        return
      }
      const vertical = list.parentElement?.dataset.orientation === "vertical"
      const lr = list.getBoundingClientRect()
      const ar = active.getBoundingClientRect()
      const pos = vertical ? ar.top - lr.top : ar.left - lr.left
      const size = vertical ? ar.height : ar.width
      if (size <= 0) return
      if (reduced.matches) {
        el.style.transform = ""
        if (vertical) {
          el.style.left = ""
          el.style.top = `${pos}px`
          el.style.width = ""
          el.style.height = `${size}px`
        } else {
          el.style.left = `${pos}px`
          el.style.top = ""
          el.style.width = `${size}px`
          el.style.height = ""
        }
      } else {
        // 基准 = 首次（或方向切换后）的 active 尺寸，inline 定一次；此后只更新 transform
        if (el.dataset.axis !== (vertical ? "v" : "h") || baseRef.current <= 0) {
          baseRef.current = size
          el.dataset.axis = vertical ? "v" : "h"
        }
        if (vertical) {
          el.style.left = ""
          el.style.top = ""
          el.style.width = ""
          el.style.height = `${baseRef.current}px`
        } else {
          el.style.left = ""
          el.style.top = ""
          el.style.width = `${baseRef.current}px`
          el.style.height = ""
        }
        const scale = size / baseRef.current
        el.style.transform = vertical
          ? `translateY(${pos}px) scaleY(${scale})`
          : `translateX(${pos}px) scaleX(${scale})`
      }
      el.style.opacity = "1"
    }

    const ro = new ResizeObserver(measure)
    const observeTriggers = () => {
      ro.disconnect()
      ro.observe(list)
      for (const trigger of list.querySelectorAll("[data-slot=tabs-trigger]")) {
        ro.observe(trigger)
      }
    }
    const mo = new MutationObserver(() => observeTriggers())
    observeTriggers()
    mo.observe(list, {
      childList: true,
      subtree: true,
      attributeFilter: ["data-state", "data-orientation"],
    })
    measure()
    reduced.addEventListener("change", measure)
    return () => {
      ro.disconnect()
      mo.disconnect()
      reduced.removeEventListener("change", measure)
    }
  }, [])

  return (
    <span
      ref={ref}
      aria-hidden
      data-slot="tabs-indicator"
      className={cn(
        "pointer-events-none absolute left-0 -bottom-px h-0.5 w-px origin-left bg-foreground opacity-0",
        "transition-transform duration-200 ease-in-out motion-reduce:transition-[opacity] motion-reduce:duration-100",
        "group-data-[orientation=vertical]/tabs:top-0 group-data-[orientation=vertical]/tabs:-right-1 group-data-[orientation=vertical]/tabs:bottom-auto group-data-[orientation=vertical]/tabs:h-px group-data-[orientation=vertical]/tabs:w-0.5 group-data-[orientation=vertical]/tabs:origin-top"
      )}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out group-data-[variant=line]/tabs-list:flex-none group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "data-[state=active]:bg-background data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:duration-150", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
