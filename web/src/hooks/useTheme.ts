// 主题 store 双维度：
// 1) Visual Theme（id）：设计 token 主题，取值清单来自 design-tokens 产物（禁止硬编码 id）；
// 2) 外观档位 light/dark/system：持久化 k8s-theme，应用 html.dark class。
// 非默认 id 写 <html data-theme=id>（dist css 的 :root[data-theme] 块生效；默认主题走 :root 基础块，删属性）。
// 模块导入时即应用，避免首帧主题闪烁；system 档位监听系统外观。
import { useSyncExternalStore } from 'react'
import { defaultThemeId, themeIds, type ThemeId } from '@tokens/typescript/tokens'

export type { ThemeId }
export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const KEY = 'k8s-theme'
const KEY_ID = 'k8s-theme-id'
const KEY_CUSTOM = 'k8s-appearance-custom'
const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

/**
 * 用户级自定义覆盖（运行时 inline CSS 变量，优先级高于一切主题块；不触碰 token 工程源）。
 * radiusPx/densityPx 覆盖 --dt-radius-base / --dt-spacing-scale-default；
 * fontPct 覆盖 root font-size；accent 覆盖 primary+ring，foreground 按亮度自动黑白。
 */
export interface CustomAppearance {
  radiusPx?: number
  densityPx?: number
  fontPct?: number
  /** 字重档位：boost=三档字重整体 +50，heavy=+100（治小字号 CJK 回退观感偏浅） */
  fontW?: 'boost' | 'heavy'
  accent?: string
  shadow?: 'none' | 'soft'
  sidebar?: string
  bgBase?: string
}

// 阴影「轻」档：单层细投影覆盖主题阴影族（none 直接归零；未设置交还主题取值）
const SHADOW_SOFT: Record<string, string> = {
  xs: '0 1px 1px rgba(15,23,42,.04)',
  sm: '0 1px 2px rgba(15,23,42,.05)',
  md: '0 2px 4px rgba(15,23,42,.06)',
  lg: '0 4px 10px rgba(15,23,42,.07)',
  xl: '0 10px 24px rgba(15,23,42,.08)',
}
const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && v >= lo && v <= hi ? v : undefined

function readStored(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* localStorage 不可用时忽略 */
  }
  return 'system'
}

function readStoredId(): ThemeId {
  try {
    const v = localStorage.getItem(KEY_ID)
    if (v && (themeIds as readonly string[]).includes(v)) return v as ThemeId
  } catch {
    /* 忽略 */
  }
  return defaultThemeId
}

function readStoredCustom(): CustomAppearance {
  try {
    const raw = localStorage.getItem(KEY_CUSTOM)
    if (!raw) return {}
    const o = JSON.parse(raw) as Record<string, unknown>
    const hex = (v: unknown) => (typeof v === 'string' && /^#[\da-f]{6}$/i.test(v) ? v : undefined)
    return {
      radiusPx: num(o.radiusPx, 0, 20),
      densityPx: num(o.densityPx, 2.5, 6),
      fontPct: num(o.fontPct, 80, 125),
      fontW: o.fontW === 'boost' || o.fontW === 'heavy' ? o.fontW : undefined,
      accent: hex(o.accent),
      shadow: o.shadow === 'none' || o.shadow === 'soft' ? o.shadow : undefined,
      sidebar: hex(o.sidebar),
      bgBase: hex(o.bgBase),
    }
  } catch {
    return {}
  }
}

// sRGB 相对亮度：accent 上白字还是黑字的判定依据（自定义滑杆预览通道复用）
export function hexLuminance(hex: string): number {
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5)
}

function resolve(t: Theme): ResolvedTheme {
  return t === 'system' ? (mq?.matches ? 'dark' : 'light') : t
}

interface ThemeState {
  theme: Theme
  resolved: ResolvedTheme
  id: ThemeId
  custom: CustomAppearance
}

const initial = readStored()
let state: ThemeState = { theme: initial, resolved: resolve(initial), id: readStoredId(), custom: readStoredCustom() }
const listeners = new Set<() => void>()

function apply(): void {
  const el = document.documentElement
  el.classList.toggle('dark', state.resolved === 'dark')
  if (state.id === defaultThemeId) el.removeAttribute('data-theme')
  else el.dataset.theme = state.id
  // 自定义层：inline 变量压过 dist 主题块（用户覆盖语义）；未设置的项 remove 交还主题取值
  const c = state.custom
  const varSet = (name: string, value?: string) => {
    if (value) el.style.setProperty(name, value)
    else el.style.removeProperty(name)
  }
  // 圆角:未自定义时交还主题层人格档(锐角/柔圆);滑杆显示值=生效像素,
  // 拖到主题同值即清覆盖(2026-11 修复:此前恒置 5px 把全部主题 radius 压死)
  varSet('--dt-radius-base', c.radiusPx != null ? `${c.radiusPx}px` : undefined)
  varSet('--dt-spacing-scale-default', c.densityPx != null ? `${c.densityPx}px` : undefined)
  varSet('--dt-color-primary-default', c.accent)
  varSet('--dt-color-border-ring', c.accent)
  varSet('--dt-color-primary-foreground', c.accent ? (hexLuminance(c.accent) > 0.45 ? '#111827' : '#ffffff') : undefined)
  for (const s of ['xs', 'sm', 'md', 'lg', 'xl']) {
    varSet(`--dt-shadow-${s}`, c.shadow === 'none' ? '0 0 #0000' : c.shadow === 'soft' ? SHADOW_SOFT[s] : undefined)
  }
  varSet('--dt-color-navigation-sidebar', c.sidebar)
  varSet('--dt-color-navigation-sidebar-foreground', c.sidebar ? (hexLuminance(c.sidebar) > 0.45 ? '#111827' : '#f8fafc') : undefined)
  // 底色只染 light 模式：dark 下浅底会整页炸对比
  varSet('--dt-color-background-default', c.bgBase && state.resolved !== 'dark' ? c.bgBase : undefined)
  el.style.fontSize = c.fontPct != null && c.fontPct !== 100 ? `${c.fontPct}%` : ''
  // 字重档位：整体平移 normal/medium/semibold 三档（index.css 把 Tailwind 字重
  // token 指向这三个运行时变量）；未覆盖交回 token 默认 400/500/600
  const w = c.fontW === 'boost' ? ['450', '550', '650'] : c.fontW === 'heavy' ? ['500', '600', '700'] : []
  varSet('--dt-w-normal', w[0])
  varSet('--dt-w-medium', w[1])
  varSet('--dt-w-semibold', w[2])
}

/** 把 store 真值重刷到 <html>（撤销未提交的 preview 变量）：取色面板取消时调用 */
export function reapplyTheme(): void {
  apply()
}

apply()
// withVT 声明下移到这里无妨：change 回调运行在模块求值之后，函数声明已提升
mq?.addEventListener('change', () => {
  if (state.theme === 'system') {
    // 系统外观翻转与手点档位同一反馈：200ms 淡切；state 同步更新防键盘/读取路径吃到旧值
    state = { ...state, resolved: resolve(state.theme) }
    listeners.forEach(l => l())
    withVT(apply)
  }
})

// 文案走 i18n（strings.core.ts 的 theme:*），渲染处用 t(o.labelKey)——模块级常量不能在切换语言后更新
export const THEME_OPTIONS: { value: Theme; labelKey: string; descKey: string }[] = [
  { value: 'system', labelKey: 'theme:system', descKey: 'theme:systemDesc' },
  { value: 'light', labelKey: 'theme:light', descKey: 'theme:lightDesc' },
  { value: 'dark', labelKey: 'theme:dark', descKey: 'theme:darkDesc' },
]

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 忽略 */
  }
}

// 主题/档位/自定义整页变更统一走 200ms View Transition 淡切（index.css 定义）；
// 不支持 VT 的环境 ?.() 短路自然硬切，prefers-reduced-motion 由 UA 自动 skip。
// 关键时序：state/persist/notify 必须同步执行——startViewTransition 回调延迟一帧，
// 若状态更新也塞进回调，键盘方向键连按会读到旧 state 吞键（选中与焦点分家）。
// VT 只包 apply()（纯 DOM 上色），React 重渲染在 VT 快照外即时完成。
function withVT(fn: () => void): void {
  if (typeof document !== 'undefined' && document.startViewTransition) document.startViewTransition(fn)
  else fn()
}

function setTheme(t: Theme): void {
  state = { ...state, theme: t, resolved: resolve(t) }
  persist(KEY, t)
  listeners.forEach(l => l())
  withVT(apply)
}

function setThemeId(id: ThemeId): void {
  state = { ...state, id }
  persist(KEY_ID, id)
  listeners.forEach(l => l())
  withVT(apply)
}

// 滑杆/取色器拖动逐 tick 落 store：localStorage 写防抖 150ms，apply（即时预览）不推迟
let customPersistT: number | undefined
function persistCustomSoon(): void {
  clearTimeout(customPersistT)
  customPersistT = window.setTimeout(() => persist(KEY_CUSTOM, JSON.stringify(state.custom)), 150)
}

function setCustom(patch: Partial<CustomAppearance>): void {
  const custom = { ...state.custom, ...patch }
  for (const k of Object.keys(custom) as (keyof CustomAppearance)[]) if (custom[k] === undefined) delete custom[k]
  state = { ...state, custom }
  persistCustomSoon()
  apply()
  listeners.forEach(l => l())
}

function resetCustom(): void {
  state = { ...state, custom: {} }
  clearTimeout(customPersistT)
  try {
    localStorage.removeItem(KEY_CUSTOM)
  } catch {
    /* 忽略 */
  }
  listeners.forEach(l => l())
  withVT(apply)
}

export function useTheme(): {
  theme: Theme
  resolved: ResolvedTheme
  setTheme: (t: Theme) => void
  id: ThemeId
  setThemeId: (id: ThemeId) => void
  custom: CustomAppearance
  setCustom: (patch: Partial<CustomAppearance>) => void
  resetCustom: () => void
} {
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
  return { theme: s.theme, resolved: s.resolved, setTheme, id: s.id, setThemeId, custom: s.custom, setCustom, resetCustom }
}
