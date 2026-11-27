// i18n：zh / en 语言切换。
// 仿 useTheme 模式：模块级 store + useSyncExternalStore，无需 Provider；
// 持久化 localStorage（k8s-lang），默认 zh（与现有 UI 一致）。
// 字典 = 各模块 chunk 合并（./strings.ts），key 格式 "ns:camelCase"；
// t() 在任何上下文可用（api 错误信息在执行期调用），组件里用 useT() 获得语言切换重渲染。
// 特殊文案（Pods/Deployments 等资源名、K8S Dashboard 品牌词）两种语言同值，写两份相同英文。
import { useSyncExternalStore } from 'react'

import { STRINGS } from './strings'

export type Lang = 'zh' | 'en'

/** 语言选项（设置页切换器用） */
export const LANGS: { value: Lang; label: string; descKey: string }[] = [
  { value: 'zh', label: '简体中文', descKey: 'settings:langZhDesc' },
  { value: 'en', label: 'English', descKey: 'settings:langEnDesc' },
]

const KEY = 'k8s-lang'

function readStored(): Lang {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {
    /* localStorage 不可用时忽略 */
  }
  return 'zh'
}

let lang: Lang = readStored()
const listeners = new Set<() => void>()

function setLang(l: Lang): void {
  if (l === lang) return
  lang = l
  try {
    localStorage.setItem(KEY, l)
  } catch {
    /* 忽略 */
  }
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
  for (const f of listeners) f()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

const getSnapshot = () => lang

/** 组件内：返回 t；语言切换时组件重渲染，t 读到新值 */
export function useLang(): { lang: Lang; setLang: (l: Lang) => void } {
  const l = useSyncExternalStore(subscribe, getSnapshot)
  return { lang: l, setLang }
}

/** 查字典；缺失 key 返回 key 本身（开发期可见） */
export function t(key: string): string {
  const e = STRINGS[key]
  return e ? e[lang] : key
}

/** 带占位符：tf('pods:restarted', { n: 3 })，{n} 替换为 3 */
export function tf(
  key: string,
  vars?: Record<string, string | number | null | undefined>,
): string {
  const tpl = t(key)
  if (!vars) return tpl
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = vars[k]
    return v == null ? '' : String(v)
  })
}

/** 组件内取 t（订阅语言切换） */
export function useT(): (key: string) => string {
  useSyncExternalStore(subscribe, getSnapshot)
  return t
}
