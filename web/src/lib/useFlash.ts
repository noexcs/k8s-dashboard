import { useEffect, useRef, useState } from 'react'

/**
 * watch 推送导致值真实变化时闪一下：返回 data-flash 开关与 onAnimationEnd 清理。
 * 视觉由 index.css `[data-flash]::after` 全局渲染（仅 currentColor 透明度，reduced-motion 降 200ms）。
 * 用法：<span data-flash={flash || undefined} onAnimationEnd={onEnd}>{value}</span>
 */
export function useFlash(value: unknown): { flash: boolean; onEnd: () => void } {
  const prev = useRef(value)
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value
      setFlash(true)
    }
  }, [value])
  return { flash, onEnd: () => setFlash(false) }
}
