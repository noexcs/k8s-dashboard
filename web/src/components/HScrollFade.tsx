// 横向滚动提示：内容宽于滚动容器时，右缘显示渐隐渐变提示「右侧还有内容」；
// 滑到底后自动隐藏（避免误导）。用于列表/工作台表格——窄视口下列宽总和超出容器，
// macOS 覆盖式滚动条不可见，无此提示时用户不知道表格可以横滑。
// 滚动容器默认是组件自身 div；ui/Table 这类组件的真实滚动容器是内嵌的
// overflow-x-auto div（data-slot=table-container）。表格数据异步加载，
// 挂载时往往还没有溢出，故用 MutationObserver 在内容变化后重新探测。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function HScrollFade({ className, children }: { className?: string; children: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hint, setHint] = useState(false)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    let scroller: HTMLElement | null = null
    let ro: ResizeObserver | null = null

    const update = () => {
      if (!scroller) return
      const show =
        scroller.scrollWidth > scroller.clientWidth + 1 &&
        scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1
      setHint(prev => (prev === show ? prev : show))
    }

    const rebind = () => {
      // 候选预筛(三轮 P1):不扫全树。markdown 表走 wrap 自身溢出分支 O(1);
      // ui/Table 类内嵌滚动框只剩 data-slot=table-container 一种形态
      const el =
        wrap.scrollWidth > wrap.clientWidth
          ? wrap
          : [...wrap.querySelectorAll<HTMLElement>('[data-slot=table-container]')].find(e => {
              const ox = getComputedStyle(e).overflowX
              return (ox === 'auto' || ox === 'scroll') && e.scrollWidth > e.clientWidth + 1
            }) ?? null
      if (el === scroller) return
      scroller?.removeEventListener('scroll', update)
      ro?.disconnect()
      scroller = el
      if (scroller) {
        scroller.addEventListener('scroll', update, { passive: true })
        ro = new ResizeObserver(update)
        ro.observe(scroller)
      }
      setHint(false)
      update()
    }

    rebind()
    // childList 记录必带节点增删,MutationObserver 规范下无「纯属性变更」可达的快速分支,直接 rebind;
    // 候选集收窄后 rebind 为 O(小常数),流式高频触发无害
    const mo = new MutationObserver(rebind)
    mo.observe(wrap, { subtree: true, childList: true })
    return () => {
      mo.disconnect()
      scroller?.removeEventListener('scroll', update)
      ro?.disconnect()
    }
  }, [])

  return (
    <div className="relative">
      <div ref={wrapRef} data-hscroll-scroll className={cn('overflow-x-auto overflow-y-hidden', className)}>
        {children}
      </div>
      {/* 常驻渲染 + opacity 切换：条件挂载会让渐隐提示硬闪（行 hover 是 150ms 渐变） */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 z-20 w-10 bg-[linear-gradient(to_left,var(--background),transparent)] transition-opacity duration-150',
          hint ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  )
}
