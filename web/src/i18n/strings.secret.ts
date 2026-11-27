// sec 字典：Secret 详情的值解码视图（features/resources/SecretValues.tsx）。ns = sec
// 文案里不出现任何 Secret 值本身，插值只有键名与字节数。
import type { Entry } from './strings'

export const STRINGS_SECRET: Record<string, Entry> = {
  'sec:dataKeys': { zh: '数据（{n} 个键）', en: 'Data ({n} keys)' },
  'sec:noData': { zh: '该 Secret 没有数据键', en: 'This Secret has no data keys' },
  // 安全提示：解码在浏览器本地完成，值不进日志/URL
  'sec:localOnlyNote': {
    zh: 'Secret 值仅在本机浏览器解码，未写入日志',
    en: 'Secret values are decoded in this browser only and never logged',
  },
  'sec:emptyValue': { zh: '空值', en: 'Empty value' },
  'sec:binary': { zh: '二进制数据', en: 'Binary data' },
  'sec:byteCount': { zh: '{n} 字节', en: '{n} bytes' },
  'sec:decodeFailed': { zh: '非合法 base64，已显示原文', en: 'Invalid base64, showing raw text' },
  'sec:truncated': {
    zh: '内容过长，仅显示前 {n} 字符（复制可取完整值）',
    en: 'Long value: only the first {n} characters are shown (copy for the full value)',
  },
  'sec:show': { zh: '显示', en: 'Show' },
  'sec:hide': { zh: '隐藏', en: 'Hide' },
  'sec:copy': { zh: '复制', en: 'Copy' },
  'sec:copied': { zh: '已复制', en: 'Copied' },
  'sec:copiedKey': { zh: '已复制 {key}', en: 'Copied {key}' },
  'sec:copyFailed': { zh: '复制失败', en: 'Copy failed' },
}
