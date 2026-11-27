import type { Pod } from '@/api/types'

/** 人类可读时长：3d2h / 5m / 12s */
export function age(ts?: string): string {
  if (!ts) return '-'
  const ms = Date.now() - new Date(ts).getTime()
  if (Number.isNaN(ms) || ms < 0) return '-'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`
}

export function fmtTime(ts?: string): string {
  if (!ts) return '-'
  const d = new Date(ts)
  return d.toLocaleString('zh-CN', { hour12: false })
}

/** 紧凑时间：MM-DD HH:mm（审计页传 sec=true——同分钟先后双写是最常对的账） */
export function shortTime(ts?: string, sec = false): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  // 跨年补年份：REPORT_CAP=20 份历史可跨年以上，纯 MM-DD 会歧义（当年保持紧凑）
  const date = [
    ...(d.getFullYear() !== new Date().getFullYear() ? [p(d.getFullYear() % 100)] : []),
    p(d.getMonth() + 1),
    p(d.getDate()),
  ].join('-')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  return `${date} ${sec ? `${hm}:${p(d.getSeconds())}` : hm}`
}

export interface PodHealth {
  key: 'running' | 'waiting' | 'crashed' | 'terminated' | 'pending'
  label: string
  dot: string // tailwind 背景色
}

export function podHealth(pod: Pod): PodHealth {
  const cs = pod.status.containerStatuses ?? []
  const anyWaiting = cs.some(c => c.state.waiting)
  const anyTerminated = cs.some(c => c.state.terminated)
  const allReady = cs.length > 0 && cs.every(c => c.ready)
  // 状态点一律用主题语义 token（与 PodDetailPage 容器行同色，禁止原始 Tailwind 调色板）
  if (pod.status.phase === 'Failed') return { key: 'terminated', label: 'Failed', dot: 'bg-negative' }
  if (pod.status.phase === 'Succeeded') return { key: 'terminated', label: 'Succeeded', dot: 'bg-muted-foreground' }
  if (pod.status.phase === 'Pending') return { key: 'pending', label: 'Pending', dot: 'bg-caution' }
  if (anyWaiting) {
    const w = cs.find(c => c.state.waiting)
    const reason = w?.state.waiting?.reason ?? 'Waiting'
    if (reason === 'CrashLoopBackOff') return { key: 'crashed', label: 'CrashLoopBackOff', dot: 'bg-negative' }
    return { key: 'waiting', label: reason, dot: 'bg-caution' }
  }
  if (anyTerminated) return { key: 'crashed', label: 'Terminated', dot: 'bg-negative' }
  if (allReady) return { key: 'running', label: 'Running', dot: 'bg-positive' }
  return { key: 'pending', label: 'Running (not ready)', dot: 'bg-caution' }
}

/** 资源量：500m → "500m", 2 → "2", 1Gi → "1Gi"（原样展示已足够，仅补 CPU 单位） */
export function cpuDisplay(v: string): string {
  return v.endsWith('m') ? v : `${v}c`
}

// ---------- K8s quantity 解析与人读格式化（metrics 用量列共享） ----------

const QTY_MULT: Record<string, number> = {
  '': 1, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
}

/** k8s quantity → 数值（cpu 毫核归一为核，内存归一为字节）；无法解析 → null */
export function parseQty(v: string | undefined): number | null {
  if (!v) return null
  const m = /^([0-9]+(?:\.[0-9]+)?)([A-Za-z]*)$/.exec(v.trim())
  if (!m) return null
  const mult = QTY_MULT[m[2]]
  return mult === undefined ? null : Number(m[1]) * mult
}

/** 核数 → "125m" / "1.2c"（<1 核用毫核，与 kubectl top 观感一致） */
export function fmtCpu(cores: number | null): string {
  if (cores == null) return '-'
  if (cores < 1) return `${Math.round(cores * 1000)}m`
  return `${(Math.round(cores * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}c`
}

/** 字节 → "123Mi" / "1.5Gi"（二进位，k8s 惯用单位） */
export function fmtBytes(bytes: number | null): string {
  if (bytes == null) return '-'
  const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${(Math.round(v * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })}${units[i]}`
}
