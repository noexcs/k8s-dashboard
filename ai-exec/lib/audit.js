// @ts-check
/**
 * 写操作审计（AI 有集群写权限的责任闭环）：谁/何时/对什么对象/经哪个工具。
 * 单文件 JSONL 追加（ai-exec 写工具 + 前端 UI 写操作都汇入这里——UI 经 POST /audit 上报）；
 * 上限 2MB，超限截半轮换。审计丢条绝不阻断操作执行（record 全吞错）。
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

const FILE = join(config.dataDir, 'audit.jsonl')
const MAX_BYTES = 2 * 1024 * 1024

/** @param {Record<string, unknown>} entry */
export function record(entry) {
  try {
    if (existsSync(FILE) && statSync(FILE).size > MAX_BYTES) {
      const tail = readFileSync(FILE, 'utf8').slice(-MAX_BYTES / 2)
      writeFileSync(FILE, tail.slice(tail.indexOf('\n') + 1))
    }
    appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    // 只读挂载/磁盘满：审计失败不能反噬集群操作
  }
}

/**
 * 最近 N 条（新→旧）。轮换边界的半行跳过。
 * @param {number} limit @param {{ cluster?: string, since?: string, target?: string, verb?: string }} [opts] since=ISO 时间下界（倒序扫描早于即停）
 */
export function list(limit, opts = {}) {
  const { cluster, since } = opts
  /** @type {Record<string, unknown>[]} */
  const out = []
  if (!existsSync(FILE)) return out
  const lines = readFileSync(FILE, 'utf8').split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const ln = (lines[i] ?? '').trim()
    if (!ln) continue
    try {
      const row = /** @type {Record<string, unknown>} */ (JSON.parse(ln))
      // 倒序扫描：早于 since 的直接停（新→旧，后面只会更旧）
      if (since && (row.ts ?? '') < since) break
      if (cluster && row.cluster !== cluster) continue
      if (opts?.target && row.target !== opts.target) continue
      if (opts?.verb && row.verb !== opts.verb) continue
      out.push(row)
    } catch {
      /* 半行跳过 */
    }
  }
  return out
}
