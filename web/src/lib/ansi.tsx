// ANSI 色码渲染（参考 CLI 日志 ANSI 解析）：容器日志普遍带色（jest/npm/go test/uvicorn 等）。
// 子集：SGR（1 粗/2 暗/3 斜体/4 下划线/7 反色/9 删除线/22-29 对应关闭、30-37+90-97 前景、
// 40-47+100-107 背景、38/48;5;n 与 38/48;2;r;g;b 真彩近似到 16 色、0 全复位）；
// OSC/其余 CSI 序列跳过；\r 与退格剥除。
// 性能：无 ESC 的行原样返回字符串（日志多数无码），调用方零 DOM 开销。
import type { ReactNode } from 'react'

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>7Mc]/g

export function hasAnsi(s: string): boolean {
  return s.includes('\x1b') || s.includes('\r') || s.includes('\x08')
}

/** 剥除 ANSI/控制字符：过滤匹配、下载 .log、复制都用纯文本 */
export function stripAnsi(s: string): string {
  if (!hasAnsi(s)) return s
  return s.replace(ANSI_RE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

// SGR → Tailwind 类；色板对齐终端默认色，light/dark 双档各自可读。
const FG: Record<number, string> = {
  30: 'text-zinc-500',
  31: 'text-red-600 dark:text-red-400',
  32: 'text-emerald-600 dark:text-emerald-400',
  33: 'text-amber-600 dark:text-amber-400',
  34: 'text-blue-600 dark:text-blue-400',
  35: 'text-purple-600 dark:text-purple-400',
  36: 'text-cyan-600 dark:text-cyan-400',
  37: 'text-zinc-700 dark:text-zinc-300',
  90: 'text-zinc-500',
  91: 'text-red-500 dark:text-red-400',
  92: 'text-emerald-500 dark:text-emerald-400',
  93: 'text-yellow-500 dark:text-yellow-400',
  94: 'text-blue-500 dark:text-blue-400',
  95: 'text-fuchsia-500 dark:text-fuchsia-400',
  96: 'text-sky-500 dark:text-sky-400',
  97: 'text-zinc-900 dark:text-zinc-100',
}
const BG: Record<number, string> = {
  40: 'bg-zinc-800',
  41: 'bg-red-600',
  42: 'bg-emerald-600',
  43: 'bg-amber-500',
  44: 'bg-blue-600',
  45: 'bg-purple-600',
  46: 'bg-cyan-600',
  47: 'bg-zinc-200',
}

interface Style {
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
  strike?: boolean
  fg?: string
  bg?: string
}

const sext = (v: number) => Math.min(5, Math.max(0, Math.round(v * 5)))

/** 256 色索引 → 最接近的 16 色 Tailwind 类（0-15 直映射、16-231 立方体、232-255 灰阶） */
function approx256(n: number, fg: boolean): string {
  if (n < 8) return (fg ? FG[30 + n] : BG[40 + n])!
  if (n < 16) return (fg ? FG[90 + n - 8] : BG[100 + n - 8])!
  if (n >= 232) {
    const t = (n - 232) / 23
    return t < 0.5 ? (fg ? FG[30]! : BG[40]!) : t < 0.85 ? (fg ? FG[37]! : BG[47]!) : (fg ? FG[97]! : BG[47]!)
  }
  const m = n - 16
  const r = Math.floor(m / 36), g = Math.floor((m % 36) / 6), b = m % 6
  if (r > 3 && g < 2 && b < 2) return fg ? FG[31]! : BG[41]!
  if (g > 3 && r < 2 && b < 2) return fg ? FG[32]! : BG[42]!
  if (b > 3 && r < 2 && g < 2) return fg ? FG[34]! : BG[44]!
  if (r > 3 && g > 3 && b < 2) return fg ? FG[33]! : BG[43]!
  if (r > 3 && b > 3) return fg ? FG[35]! : BG[45]!
  if (g > 3 && b > 3) return fg ? FG[36]! : BG[46]!
  const lum = r + g + b
  return fg ? (lum >= 9 ? FG[97]! : FG[37]!) : lum >= 9 ? BG[47]! : BG[40]!
}

function applySgr(st: Style, codes: number[]): Style {
  let next = { ...st }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) next = {}
    else if (c === 1) next.bold = true
    else if (c === 2) next.dim = true
    else if (c === 3) next.italic = true
    else if (c === 4) next.underline = true
    else if (c === 7) next.inverse = true
    else if (c === 9) next.strike = true
    else if (c === 22) { next.bold = false; next.dim = false }
    else if (c === 23) next.italic = false
    else if (c === 24) next.underline = false
    else if (c === 27) next.inverse = false
    else if (c === 29) next.strike = false
    else if (c === 39) next.fg = undefined
    else if (c === 49) next.bg = undefined
    else if (c >= 30 && c <= 37) next.fg = FG[c]
    else if (c >= 40 && c <= 47) next.bg = BG[c]
    else if (c >= 90 && c <= 97) next.fg = FG[c]
    else if (c >= 100 && c <= 107) next.bg = BG[c - 60]
    // 38;5;n / 48;5;n（256 色）与 38;2;r;g;b（真彩）→ 16 色近似
    else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
      const cls = approx256(codes[i + 2] ?? 0, c === 38)
      if (c === 38) next.fg = cls
      else next.bg = cls
      i += 2
    } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
      const idx = 16 + 36 * sext((codes[i + 2] ?? 0) / 255) + 6 * sext((codes[i + 3] ?? 0) / 255) + sext((codes[i + 4] ?? 0) / 255)
      const cls = approx256(idx, c === 38)
      if (c === 38) next.fg = cls
      else next.bg = cls
      i += 4
    }
  }
  return next
}

function styleCls(st: Style): string {
  const parts: string[] = []
  if (st.fg) parts.push(st.fg)
  if (st.bg) parts.push(st.bg)
  if (st.inverse) parts.push('bg-foreground', 'text-background')
  if (st.bold) parts.push('font-bold')
  if (st.dim) parts.push('opacity-60')
  if (st.italic) parts.push('italic')
  if (st.underline) parts.push('underline')
  if (st.strike) parts.push('line-through')
  return parts.join(' ')
}

/** 单行 ANSI → ReactNode；无码行原样返回字符串（React 直接渲染，零开销） */
export function ansiToNode(line: string): ReactNode {
  if (!hasAnsi(line)) return line
  const segs: { text: string; st: Style }[] = []
  let style: Style = {}
  let out = ''
  const push = () => {
    if (out) {
      segs.push({ text: out, st: style })
      out = ''
    }
  }
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '\x1b') {
      if (line[i + 1] === '[') {
        const m = /^\[[0-9;]*m/.exec(line.slice(i + 1))
        if (m) {
          push()
          const arg = m[0].slice(1, -1)
          style = applySgr(style, arg === '' ? [0] : arg.split(';').map(x => Number(x) || 0))
          i += 1 + m[0].length
          continue
        }
      }
      const rest = ANSI_RE.exec(line.slice(i))
      ANSI_RE.lastIndex = 0
      if (rest && rest.index === 0) {
        i += rest[0].length
        continue
      }
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\x08' || (ch >= '\x00' && ch <= '\x1f' && ch !== '\t')) {
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  push()
  const plain = segs.map(s => s.text).join('')
  if (segs.length === 0) return plain
  if (segs.length === 1 && !styleCls(segs[0].st)) return segs[0].text
  return (
    <>
      {segs.map((s, j) => {
        const cls = styleCls(s.st)
        return cls ? (
          <span key={j} className={cls}>
            {s.text}
          </span>
        ) : (
          <span key={j}>{s.text}</span>
        )
      })}
    </>
  )
}
