// @ts-check
/**
 * 站外通知旁路（可选，未配置时零开销）：
 * 「AI 值班」的待办此前全部以面板标签页开着为前提——审批挂起 10 分钟无声自动拒绝、
 * 后台巡检发现节点/负载异常都只进盘上账面。webhook 让值班离屏也能被叫回来。
 * 尽力而为：任何失败不连累值班主流程——但**发送必落账**（notify.jsonl）：
 * 「生命线通道坏没坏」不能只剩设置页一颗手测按钮，通知风暴早晨之后面板要答得出
 * 「昨晚几点叫过、送没送到」。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { effective } from './overrides.js'
import { config } from './config.js'

const FILE = join(config.dataDir, 'notify.jsonl')
const KEEP = 200

/** @param {string} text @param {string} [deepLink] */
export function notify(text, deepLink) {
  const url = String(effective('notifyWebhookUrl'))
  if (!url) return
  const body = deepLink ? { text, link: deepLink } : { text }
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => record(r.ok ? { ok: true } : { ok: false, err: `HTTP ${r.status}` }, text, url))
    .catch((e) => record({ ok: false, err: e instanceof Error ? e.message.slice(0, 100) : 'failed' }, text, url))
}

/** 发送台账：目标 host 也记——通知被改指到别的群后，账面上「叫到哪」看得见 */
function record(/** @type {{ ok: boolean, err?: string }} */ r, /** @type {string} */ text, /** @type {string} */ url) {
  try {
    let host = '?'
    try { host = new URL(url).host } catch { /* 非法 URL 已在 fetch 失败路径 */ }
    const line = { ts: new Date().toISOString(), ok: r.ok, ...(r.err ? { err: r.err } : {}), host, text: text.slice(0, 160) }
    const lines = existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n').filter(Boolean) : []
    lines.push(JSON.stringify(line))
    writeFileSync(FILE, lines.slice(-KEEP).join('\n') + '\n')
  } catch { /* 台账失败不拦通知 */ }
}

/** 最近一次真实发送（设置卡「持续心跳」显示源；无记录返回 null） */
export function lastNotify() {
  try {
    if (!existsSync(FILE)) return null
    const lines = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean)
    return /** @type {{ ts: string, ok: boolean, err?: string, host?: string, text?: string } | null} */ (JSON.parse(lines[lines.length - 1] ?? 'null'))
  } catch {
    return null
  }
}
