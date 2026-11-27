/**
 * 严重度 → 语义 tone 的统一口径：chip/状态点/文字共用一套主题 token
 *（positive/caution/negative/muted，见 index.css 语义色工具类）。
 * 小写包含式匹配：CrashLoopBackOff / OOMKilled / ImagePullBackOff… 命中子串即可，
 * 不追求穷举 reason——调用方对未命中值按场景决定 muted 兜底语义。
 */
export type Tone = 'positive' | 'caution' | 'negative' | 'muted'

const NEGATIVE_KEYS = ['crash', 'error', 'oomkilled', 'fail']
// 'backoff'=重试进行中(ImagePullBackOff 类)→caution(Main 裁决);CrashLoopBackOff 先命中 'crash' 仍 negative
const CAUTION_KEYS = ['pending', 'containercreating', 'waiting', 'terminating', 'backoff', 'initializing']
const POSITIVE_KEYS = ['succeeded', 'ready', 'running', 'complete', 'true']

/** 条件行坏判定 SSOT：Failed/FailureTarget/Disrupted=True 或任何 Available 类=False 都是坏消息 */
const BAD_TRUE = ['failed', 'failuretarget', 'disrupted']
export function conditionBad(type: string | undefined, status: string | undefined): boolean {
  const t = (type ?? '').toLowerCase()
  if (status === 'True') return BAD_TRUE.includes(t)
  if (status === 'False') return !BAD_TRUE.includes(t)
  return false
}

export function severityTone(s: string | undefined | null): Tone {
  const v = (s ?? '').toLowerCase()
  if (NEGATIVE_KEYS.some(k => v.includes(k))) return 'negative'
  if (CAUTION_KEYS.some(k => v.includes(k))) return 'caution'
  if (POSITIVE_KEYS.some(k => v.includes(k))) return 'positive'
  return 'muted'
}

// Tailwind 只扫描源码字面量：tone → class 必须查表，禁止 `bg-${tone}/10` 模板拼接

/** tone → 文字色 */
export const toneText: Record<Tone, string> = {
  positive: 'text-positive',
  caution: 'text-caution',
  negative: 'text-negative',
  muted: 'text-muted-foreground',
}

/** tone → 异常 chip（统一语义 = bg-{tone}/10 text-{tone}） */
export const toneChip: Record<Tone, string> = {
  positive: 'bg-positive/10 text-positive transition-colors',
  caution: 'bg-caution/10 text-caution transition-colors',
  negative: 'bg-negative/10 text-negative transition-colors',
  muted: 'bg-muted text-muted-foreground border-border/60 transition-colors',
}

/** tone → 状态点 */
export const toneDot: Record<Tone, string> = {
  positive: 'bg-positive',
  caution: 'bg-caution',
  negative: 'bg-negative',
  muted: 'bg-muted-foreground',
}
