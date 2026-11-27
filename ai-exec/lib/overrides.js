// 运行时配置覆盖：事故当晚最想要的动作（改扫描节奏/把通知指到新群）不该要求回命令行改 env 重启。
// 白名单键落 JSON 文件、每次现读（体量小、无缓存失效问题）；env 仍是底座与默认来源。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

const FILE = join(config.dataDir, 'config-override.json')

/** 白名单：只有这些键可被 UI 改；端口/数据目录等一律 env-only */
const ALLOW = new Set(['inspectIntervalMin', 'notifyWebhookUrl', 'panelBaseUrl', 'llmGatewayBase', 'llmApiKey', 'llmModel'])

/** @returns {Record<string, string | number>} 已过白名单的覆盖项 */
export function readOverrides() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    /** @type {Record<string, string | number>} */
    const out = {}
    for (const [k, v] of Object.entries(raw)) if (ALLOW.has(k)) out[k] = /** @type {any} */ (v)
    return out
  } catch {
    return {}
  }
}

/**
 * 键的生效值：覆盖优先，env 兜底。每次现读——多进程各写各的 dataDir 不存在，读盘成本可忽略。
 * @param {'inspectIntervalMin'|'notifyWebhookUrl'|'panelBaseUrl'|'llmGatewayBase'|'llmApiKey'|'llmModel'} key
 */
export function effective(key) {
  const o = readOverrides()
  return o[key] !== undefined ? o[key] : config[key]
}

/**
 * 合并写覆盖（值校验后落盘）。
 * @param {Record<string, unknown>} patch
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeOverrides(patch) {
  const o = readOverrides()
  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOW.has(k)) return { ok: false, error: `键 ${k} 不允许 UI 修改（env-only）` }
    // null = 删除覆盖回到 env 底座；空串是「显式留空」，两语义不许混（否则 UI 填一次空永久压死 env）
    if (v === null) {
      delete o[k]
      continue
    }
    if (k === 'inspectIntervalMin') {
      // 空串 Number('')=0 会静默关扫描：显式拒绝，0 得明明白白地填
      if (String(v).trim() === '') return { ok: false, error: '巡检间隔不能为空，填 0-1440（0=关闭）' }
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0 || n > 1440) return { ok: false, error: '巡检间隔须为 0-1440 分钟（0=关闭）' }
      o.inspectIntervalMin = Math.round(n)
    } else if (k === 'notifyWebhookUrl' || k === 'panelBaseUrl' || k === 'llmGatewayBase') {
      const sv = String(v ?? '').trim()
      if (sv && !/^https?:\/\//.test(sv)) return { ok: false, error: `${k} 须为 http(s) 地址或留空` }
      o[k] = sv.replace(/\/+$/, '')
    } else if (k === 'llmModel') {
      const sv = String(v ?? '').trim()
      if (!sv) return { ok: false, error: '模型名不能为空（回到 env 底座请点「还原」）' }
      if (sv.length > 120 || /[\s,;"']/.test(sv)) return { ok: false, error: '模型名须为单段标识（≤120 字符，不含空格/逗号）' }
      o.llmModel = sv
    } else if (k === 'llmApiKey') {
      // 空串 = 显式无密钥（内网免鉴权网关）；null = 还原 env 底座——两语义沿用上方约定
      o.llmApiKey = String(v ?? '')
    }
  }
  try {
    writeFileSync(FILE, JSON.stringify(o))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '写入失败（dataDir 只读挂载？）' }
  }
}
