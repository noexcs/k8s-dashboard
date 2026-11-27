// @ts-check
/**
 * 交接班落盘：交接是全产品唯一此前只能「本地下载文件 + IM 传文件」的动线——
 * 面板内一切（收件箱/审计/会话）都是深链，唯独交接要离开网络。
 * 落盘后交班 MD 有了 URL，接班确认可以进审计账（责任闭环缺的「交接发生过」凭证）。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

const FILE = join(config.dataDir, 'handover.jsonl')
const MAX_RECORDS = 50

/**
 * @param {{ cluster: string, md: string, window?: string, actor?: string }} h
 * @returns {{ id: string }}
 */
export function save(h) {
  const id = `h${Date.now().toString(36)}`
  const line = JSON.stringify({ id, ts: new Date().toISOString(), ...h })
  appendFileSync(FILE, line + '\n')
  // 定条数轮换（MD 单份几 KB，50 份足够覆盖多集群数周的班次）
  if (existsSync(FILE)) {
    const lines = readFileSync(FILE, 'utf8').trim().split('\n')
    if (lines.length > MAX_RECORDS) writeFileSync(FILE, lines.slice(-MAX_RECORDS).join('\n') + '\n')
  }
  return { id }
}

/**
 * @param {string} id
 * @returns {{ id: string; ts: string; cluster: string; md: string; window?: string; actor?: string , ackedBy?: string; ackedTs?: string  } | null} | null, ackedBy?: string; ackedTs?: string  } | null}
 */
export function get(id) {
  if (!existsSync(FILE)) return null
  for (const l of readFileSync(FILE, 'utf8').trim().split('\n').reverse()) {
    try {
      const o = JSON.parse(l)
      if (o.id === id) return o
    } catch { /* 半行容忍 */ }
  }
  return null
}

/** 接班确认写进文档本体：审计是 300 条/2MB 的滚动账，交接凭证不能寄生在别人的轮换策略上 */
/** @param {string} id @param {string} actor @returns {boolean} 是否找到并回写 */
export function markAcked(id, actor) {
  if (!existsSync(FILE)) return false
  const lines = readFileSync(FILE, 'utf8').split('\n')
  let hit = false
  const out = lines.map((l) => {
    if (hit || !l.trim()) return l
    try {
      const o = JSON.parse(l)
      if (o.id !== id) return l
      hit = true
      return JSON.stringify({ ...o, ackedBy: actor || '', ackedTs: new Date().toISOString() })
    } catch {
      return l
    }
  })
  if (hit) writeFileSync(FILE, out.join('\n'))
  return hit
}

/** 全部文档摘要（启动回填用；带 ackUnknown 标记） */
export function listAll() {
  if (!existsSync(FILE)) return []
  return readFileSync(FILE, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
    .map((o) => {
      const { md, ...rest } = o
      if (rest.ackedTs === undefined) rest.ackUnknown = true
      return rest
    })
}

/** @param {string} cluster 最近 N 份摘要（列表/入口用，不带 md 全文；ackedBy/ackedTs 随 rest 透传） */
export function listRecent(cluster) {
  if (!existsSync(FILE)) return []
  return readFileSync(FILE, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter((o) => o && o.cluster === cluster)
    .slice(-10)
    .map((o) => {
      const { md, ...rest } = o
      // ackUnknown：ackedTs 回写上线前的旧档缺字段=无证据可判，别拿「待接班」_todo 色冤枉已接班的班
      if (rest.ackedTs === undefined) rest.ackUnknown = true
      return rest
    })
    .reverse()
}
