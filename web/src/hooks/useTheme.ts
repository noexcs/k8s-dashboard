// 主题 store：light / dark / system（跟随系统）。
// 持久化到 localStorage（k8s-theme）；模块导入时即应用 html.dark class，
// 并在 system 档位下监听系统外观变化。
import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const KEY = 'k8s-theme'
const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

function readStored(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* localStorage 不可用时忽略 */
  }
  return 'system'
}

function resolve(t: Theme): ResolvedTheme {
  return t === 'system' ? (mq?.matches ? 'dark' : 'light') : t
}

interface ThemeState {
  theme: Theme
  resolved: ResolvedTheme
}

const initial = readStored()
let state: ThemeState = { theme: initial, resolved: resolve(initial) }
const listeners = new Set<() => void>()

function apply(): void {
  document.documentElement.classList.toggle('dark', state.resolved === 'dark')
}

apply()
mq?.addEventListener('change', () => {
  if (state.theme === 'system') {
    state = { ...state, resolved: resolve(state.theme) }
    apply()
    listeners.forEach(l => l())
  }
})

// 文案走 i18n（strings.core.ts 的 theme:*），渲染处用 t(o.labelKey)——模块级常量不能在切换语言后更新
export const THEME_OPTIONS: { value: Theme; labelKey: string; descKey: string }[] = [
  { value: 'system', labelKey: 'theme:system', descKey: 'theme:systemDesc' },
  { value: 'light', labelKey: 'theme:light', descKey: 'theme:lightDesc' },
  { value: 'dark', labelKey: 'theme:dark', descKey: 'theme:darkDesc' },
]

function setTheme(t: Theme): void {
  state = { theme: t, resolved: resolve(t) }
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* 忽略 */
  }
  apply()
  listeners.forEach(l => l())
}

export function useTheme(): { theme: Theme; resolved: ResolvedTheme; setTheme: (t: Theme) => void } {
  const s = useSyncExternalStore(
    (l: () => void) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => state,
    () => state,
  )
  return { theme: s.theme, resolved: s.resolved, setTheme }
}
