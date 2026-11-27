/**
 * CSS 变量 → 具体色值的解析（xterm、<input type=color> 这类 API 不吃 var()）。
 * 两个坑：getPropertyValue('--x') 返回原始 token 不求值，要贴真实元素读 computed color；
 * 而 Chrome 的 computed color / canvas fillStyle 都**保留 oklch() 原形式**（不转 rgb），
 * 所以下游要 hex 时只能自己做 oklch→sRGB。
 */
export function cssVarColor(name: string, fallback = 'rgb(0,0,0)'): string {
  const el = document.createElement('span')
  el.style.color = `var(${name})`
  document.body.appendChild(el)
  const c = getComputedStyle(el).color
  el.remove()
  return c.includes('(') || c.startsWith('#') ? c : fallback
}

const to255 = (lin: number) => {
  const c = Math.max(0, Math.min(1, lin))
  const g = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.round(Math.max(0, Math.min(1, g)) * 255)
    .toString(16)
    .padStart(2, '0')
}

/** 同上，输出 #rrggbb：支持 hex/rgb()/oklch() 三种 computed 形态（token 体系只用这三类） */
export function cssVarHex(name: string, fallback: string): string {
  const c = cssVarColor(name)
  if (c.startsWith('#')) return c.length === 7 ? c : fallback
  const nums = c.match(/-?[\d.]+/g)?.map(Number) ?? []
  if (/^rgb/.test(c) && nums.length >= 3) {
    return '#' + nums.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  }
  if (/^oklch/.test(c) && nums.length >= 3) {
    const [L, C, H] = nums
    const h = (H * Math.PI) / 180
    const a = C * Math.cos(h)
    const b = C * Math.sin(h)
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b
    const s_ = L - 0.0894841775 * a - 1.291485548 * b
    const [l, m, s] = [l_ ** 3, m_ ** 3, s_ ** 3]
    return (
      '#' +
      to255(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
      to255(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
      to255(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
    )
  }
  return fallback
}
