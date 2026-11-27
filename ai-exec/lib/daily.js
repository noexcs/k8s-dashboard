// @ts-check
/**
 * 日摘要（独立于 20 份明细配额）：报告 20×30min≈10 小时就把状态史毁掉，
 * 「回看一周」在任何界面都拼不出来。每天一行 JSONL（异常计数+added/resolved 键并集），
 * 周视图读 7 行即可。只增不改，14 天封顶。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

const FILE = join(config.dataDir, 'inspect_daily.jsonl')
const KEEP_DAYS = 14

/**
 * @param {{ cluster?: string; generatedAt?: string; water?: { pctCpu: number | null, pctMem: number | null } | null; findings?: { id?: string; entries?: { key?: string; ns?: string; name?: string; cause?: string; reason?: string }[] }[] }} report
 * @param {{ added?: string[]; resolved?: string[] }} diff
 */
export function recordDaily(report, diff) {
  if (!report.cluster || !report.generatedAt) return
  const day = String(report.generatedAt).slice(0, 10)
  try {
    const lines = existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n').filter(Boolean) : []
    /** @type {Map<string, { date: string; cluster: string; ts: string; findings: number; added: string[]; resolved: string[]; worst?: string[]; water?: { pctCpu: number | null, pctMem: number | null } }>} */
    const byDay = new Map()
    for (const ln of lines) {
      try {
        const o = JSON.parse(ln)
        byDay.set(`${o.date}/${o.cluster}`, o)
      } catch { /* 半行跳过 */ }
    }
    const k = `${day}/${report.cluster}`
    const prev = byDay.get(k)
    const findings = (report.findings ?? []).reduce((a, f) => a + (f.entries?.length ?? 0), 0)
    // 复盘最小富快照：明细 20 份≈10 小时轮换完，一周后「那天到底是哪几条」只剩当日最重一轮的摘要
    const worst = (report.findings ?? [])
      .flatMap(f => (f.entries ?? []).map(e => `${e.key ?? `${f.id}/${e.ns ?? ''}/${e.name ?? ''}`}${e.cause || e.reason ? ` · ${e.cause || e.reason}` : ''}`))
      .slice(0, 20)
    const prevWorst = (report.findings ?? []).length > 0 && findings >= (prev?.findings ?? 0) ? worst : (prev?.worst ?? worst)
    byDay.set(k, {
      date: day,
      cluster: report.cluster,
      ts: report.generatedAt,
      worst: prevWorst,
      ...(report.water ? { water: report.water } : {}),
      // 计数取当日最新一次扫描；added/resolved 取当日累计并集
      findings,
      added: [...new Set([...(prev?.added ?? []), ...(diff?.added ?? [])])].slice(0, 500),
      resolved: [...new Set([...(prev?.resolved ?? []), ...(diff?.resolved ?? [])])].slice(0, 500),
    })
    const kept = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-KEEP_DAYS * 8)
    writeFileSync(FILE, kept.map(o => JSON.stringify(o)).join('\n') + '\n')
  } catch { /* 只读挂载不拦扫描 */ }
}

/** @param {string} cluster @returns {{ date: string; cluster: string; ts: string; findings: number; added: string[]; resolved: string[] }[]} 近 days 天 */
export function listDaily(cluster, days = 7) {
  if (!existsSync(FILE)) return []
  try {
    return readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter((o) => o && (!cluster || o.cluster === cluster))
      .slice(-days)
  } catch {
    return []
  }
}
