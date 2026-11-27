// 运行时配置覆盖：事故当晚最想要的动作（改扫描节奏/把通知指到新群）不该要求回命令行改 env 重启。
// 白名单键落 JSON 文件、每次现读（体量小、无缓存失效问题）；env 仍是底座与默认来源。
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

const FILE = join(config.dataDir, 'config-override.json')

/** 白名单：只有这些键可被 UI 改；端口/数据目录等一律 env-only */
const ALLOW = new Set(['inspectIntervalMin', 'notifyWebhookUrl', 'panelBaseUrl', 'llmGatewayBase', 'llmApiKey', 'llmModel', 'llmProviders', 'llmActiveProvider'])

/**
 * Provider 项校验（llmProviders 数组的单项）。
 * apiKey 三态：字符串=新值；'__KEEP__'=保留盘上同 id 旧项的 key（前端编辑时留空即此，
 * 密钥永不经 GET 回显，编辑表单拿不到明文）；缺省=空串（无鉴权）。
 * @param {unknown} raw @param {any[]} list 旧 llmProviders（KEEP 合并用）
 * @returns {{ ok: true, item: any } | { ok: false, error: string }}
 */
function validateProvider(raw, list) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'provider 项须为对象' }
  const it = /** @type {any} */ (raw)
  const name = String(it.name ?? '').trim()
  if (!name || name.length > 40) return { ok: false, error: 'provider 名称不能为空（≤40 字符）' }
  const baseUrl = String(it.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, error: `provider「${name}」网关须为 http(s) 地址` }
  if (!Array.isArray(it.models) || it.models.length === 0 || it.models.length > 30) return { ok: false, error: `provider「${name}」须含 1-30 个模型` }
  const models = []
  for (const m of it.models) {
    const sv = String(m ?? '').trim()
    if (!sv || sv.length > 120 || /[\s,;"']/.test(sv)) return { ok: false, error: `provider「${name}」模型名须为单段标识（≤120 字符，不含空格/逗号）` }
    models.push(sv)
  }
  const old = (Array.isArray(list) ? list : []).find(x => x && x.id === it.id)
  let apiKey = ''
  if (it.apiKey === '__KEEP__') apiKey = String(old?.apiKey ?? '')
  else if (typeof it.apiKey === 'string') apiKey = it.apiKey
  const id = /^[a-z0-9][a-z0-9-]{3,31}$/.test(String(it.id ?? '')) ? String(it.id) : cryptoRandomId()
  return { ok: true, item: { id, name, baseUrl, apiKey, models } }
}

/** provider id：8 位 base16，服务端生成防前端塞怪字符进 models.json 键 */
function cryptoRandomId() {
  return 'p' + randomUUID().replace(/-/g, '').slice(0, 7)
}

/** @returns {Record<string, any>} 已过白名单的覆盖项（llmProviders 为数组） */
export function readOverrides() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    /** @type {Record<string, any>} */
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
 * 当前生效的 LLM 接入（多 Provider 优先，其次旧单键覆盖/env 底座）。
 * 判定链：llmProviders 非空 → 取 active（未显式指定且仅一项时自动 active）；
 * 列表为空/active 指向已删项 → 回退旧语义（UI 覆盖 llmGatewayBase > env）。
 * @returns {{ baseUrl: string, apiKey: string, label: string, providerId: string | null }}
 */
export function activeLlm() {
  const o = readOverrides()
  const list = Array.isArray(o.llmProviders) ? o.llmProviders : []
  const p = list.find(x => x && x.id === o.llmActiveProvider) ?? (list.length === 1 ? list[0] : undefined)
  if (p && String(p.baseUrl ?? '')) return { baseUrl: String(p.baseUrl), apiKey: String(p.apiKey ?? ''), label: String(p.name ?? p.id), providerId: String(p.id) }
  const base = effective('llmGatewayBase')
  return { baseUrl: String(base ?? ''), apiKey: String(effective('llmApiKey') ?? ''), label: String(base) ? 'env/单覆盖' : '', providerId: null }
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
      // 清空 provider 列表时 active 指向必须连带删，否则悬空 id 让语义含糊（activeLlm 有兜底但账面脏）
      if (k === 'llmProviders') delete o.llmActiveProvider
      continue
    }
    if (k === 'llmProviders') {
      if (!Array.isArray(v)) return { ok: false, error: 'llmProviders 须为数组或 null' }
      if (v.length > 10) return { ok: false, error: 'provider 数量上限 10' }
      const oldList = Array.isArray(o.llmProviders) ? o.llmProviders : []
      /** @type {any[]} */
      const items = []
      for (const raw of v) {
        const r = validateProvider(raw, oldList)
        if (!r.ok) return r
        // id 撞车（同 id 传两次）会让 KEEP 合并与 models.json 键互相覆盖
        if (items.some(x => x.id === r.item.id)) return { ok: false, error: `provider id 重复：${r.item.id}` }
        items.push(r.item)
      }
      o.llmProviders = items
      // active 悬空收敛：显式值合法则留，否则首项兜底；清空列表回 env 底座
      const want = String(o.llmActiveProvider ?? '')
      o.llmActiveProvider = items.some(x => x.id === want) ? want : (items[0]?.id ?? '')
      if (!o.llmActiveProvider) delete o.llmActiveProvider
    } else if (k === 'llmActiveProvider') {
      const list = Array.isArray(o.llmProviders) ? o.llmProviders : []
      const sv = String(v ?? '')
      if (sv && !list.some(x => x.id === sv)) return { ok: false, error: `active provider ${sv} 不在列表（先保存列表再选默认）` }
      if (sv) o.llmActiveProvider = sv
      else delete o.llmActiveProvider
    } else if (k === 'inspectIntervalMin') {
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
