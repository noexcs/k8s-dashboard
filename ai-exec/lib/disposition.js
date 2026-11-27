// @ts-check
/**
 * 巡检异常项的处置状态（值班交接的确认落点）：acked=已处置 / ignored=已知不处理。
 * append-only JSONL（与 audit 同型）；同 key 后写覆盖先写，state:'none' 为解除标记。
 * 没有这一层，「恢复」名单跑完下一轮巡检就永久消失，交接班只能靠记忆。
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

const FILE = join(config.dataDir, 'dispositions.jsonl')
const MAX_BYTES = 512 * 1024

/** @param {Record<string, unknown>} entry */
export function record(entry) {
  try {
    if (existsSync(FILE) && statSync(FILE).size > MAX_BYTES) {
      const tail = readFileSync(FILE, 'utf8').slice(-MAX_BYTES / 2)
      writeFileSync(FILE, tail.slice(tail.indexOf('\n') + 1))
    }
    appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    // 处置记录是旁路：失败不反噬巡检/处置操作本身
  }
}

/**
 * 该集群当前生效的处置状态（新→旧，每 key 取最新一条，'none' 过滤掉）。
 * @param {string} cluster
 */
export function listLatest(cluster) {
  if (!existsSync(FILE)) return []
  /** @type {Map<string, Record<string, unknown>>} */
  const byKey = new Map()
  for (const ln of readFileSync(FILE, 'utf8').split('\n')) {
    const t = ln.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t)
      if (r?.cluster === cluster && typeof r.key === 'string') byKey.set(r.key, r) // 后读覆盖 = 最新
    } catch {
      /* 半行跳过 */
    }
  }
  const out = []
  const staleBefore = new Date(Date.now() - 90 * 86_400_000).toISOString()
  for (const r of byKey.values()) {
    // acked=认领，过期合理；ignored=「已知不修」的决定+辩护备注，是长期账面的一部分，
    // 90 天蒸发会让同一异常变回「未认领待办」且当初为什么忽略无处可查（体量由 512KB 轮换兜底）
    if (r.state === 'ignored') out.push(r)
    else if (r.state === 'acked' && String(r.ts ?? '') >= staleBefore) out.push(r)
  }
  out.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')))
  return out
}
