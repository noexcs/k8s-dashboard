// 行级 LCS diff（YAML 编辑预览用；无第三方依赖）。
// 输出按原文顺序的操作序列：same/del/add；连续 add 段附着在其前一个 same 行后。
// O(n·m) DP，YAML 场景行数 ≤ 数千可接受；超限退化为「全删全加」（只影响高亮美观不影响正确性）。

export type DiffOp = { type: 'same' | 'del' | 'add'; text: string; oldNo?: number; newNo?: number }

const MAX_DP = 2500

export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  if (a.length > MAX_DP || b.length > MAX_DP) {
    return [
      ...a.map((text, i) => ({ type: 'del' as const, text, oldNo: i + 1 })),
      ...b.map((text, i) => ({ type: 'add' as const, text, newNo: i + 1 })),
    ]
  }
  // LCS DP（Uint32 平铺表省内存；数千行 × 数千行仍在预算内）
  const n = a.length
  const m = b.length
  const dp = new Uint32Array((n + 1) * (m + 1))
  const at = (i: number, j: number) => dp[i * (m + 1) + j]
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * (m + 1) + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))

  const out: DiffOp[] = []
  let i = 0
  let j = 0
  let adds: string[] = [] // 连续 add 缓冲，统一在其后首个 same 前输出
  const flush = () => {
    // flush 时 j 已越过缓冲段：段起点 = j - 长度，newNo 从 1 基序号顺排
    const start = j - adds.length
    for (let k = 0; k < adds.length; k++) out.push({ type: 'add', text: adds[k], newNo: start + k + 1 })
    adds = []
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush()
      out.push({ type: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 })
      i++
      j++
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ type: 'del', text: a[i], oldNo: i + 1 })
      i++
    } else {
      adds.push(b[j])
      j++
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i], oldNo: i + 1 })
    i++
  }
  const newStart = j
  for (let k = 0; k < adds.length; k++) out.push({ type: 'add', text: adds[k], newNo: newStart + k + 1 })
  while (j < m) {
    out.push({ type: 'add', text: b[j], newNo: j + 1 })
    j++
  }
  return out
}
