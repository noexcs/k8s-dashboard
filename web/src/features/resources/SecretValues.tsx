// Secret 详情的值解码视图：data 各键 base64 → 文本，默认掩码、只在本地解码。
// 只做纯文本视图：不解剖 .dockerconfigjson / tls.crt 之类的特殊结构（要看原文去 YAML tab）。
// 安全：解码值只存在于组件内存，绝不写 console、绝不进 URL/query。
import { Check, Copy, Eye, EyeOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { tf, useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { clipboardWrite } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

/** 展开态最多渲染的字符数：证书/CA 包动辄几 KB，全量塞进 DOM 没必要，完整值走复制按钮 */
const MAX_SHOWN = 500

type Decoded =
  | { state: 'text'; text: string; bytes: number }
  | { state: 'binary'; raw: string; bytes: number }
  | { state: 'invalid'; text: string }
  | { state: 'empty' }

/**
 * base64 → 文本。atob 得到的是 binary string，必须逐字节转 Uint8Array 再按 UTF-8 解码，
 * 否则非 ASCII（中文密码、UTF-8 token）会乱码。含 NUL，或替换符/控制字符占比过高，
 * 判为二进制（只报字节数、禁止展开）；atob 抛错判为非法 base64（退回显示原文）。
 */
function decodeValue(raw: unknown): Decoded {
  if (typeof raw !== 'string' || raw === '') return { state: 'empty' }
  let bin: string
  try {
    bin = atob(raw)
  } catch {
    return { state: 'invalid', text: raw }
  }
  const buf = Uint8Array.from(bin, c => c.charCodeAt(0))
  if (buf.includes(0)) return { state: 'binary', raw, bytes: buf.length }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  let bad = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    // U+FFFD（非法 UTF-8 序列）+ 除 \t\n\r 外的 C0/C1 控制字符
    if (cp === 0xfffd || (cp < 32 && cp !== 9 && cp !== 10 && cp !== 13) || (cp >= 0x7f && cp <= 0x9f)) bad++
  }
  // 双条件：少量 U+FFFD 不算二进制（正常文本里也可能混一个），成规模的乱码才判二进制
  if (bad >= 3 && bad / text.length > 0.1) return { state: 'binary', raw, bytes: buf.length }
  return { state: 'text', text, bytes: buf.length }
}

export function SecretValues({ obj }: { obj: Record<string, unknown> }) {
  const t = useT()
  // obj 是 YAML parse 的任意对象，kind 需显式收窄后才能比较
  const kind = typeof obj.kind === 'string' ? obj.kind : ''
  // useMemo 必须在 kind 早退之前：切换资源时同一挂载点的 hook 数量不能变
  const rows = useMemo<{ key: string; decoded: Decoded }[]>(() => {
    if (kind !== 'Secret') return []
    const data = (obj.data as Record<string, unknown> | undefined) ?? {}
    return Object.entries(data).map(([key, value]) => ({ key, decoded: decodeValue(value) }))
  }, [obj, kind])
  if (kind !== 'Secret') return null

  return (
    <Card>
      <CardContent className="pt-3">
        <div className="mb-2 text-[13px] font-medium text-muted-foreground">{tf('sec:dataKeys', { n: rows.length })}</div>
        <div className="mb-2 text-xs text-muted-foreground">{t('sec:localOnlyNote')}</div>
        {rows.length === 0 ? (
          <div className="text-[13px] text-muted-foreground">{t('sec:noData')}</div>
        ) : (
          <div className="max-h-96 space-y-1.5 overflow-auto">
            {rows.map(r => (
              <SecretRow key={r.key} name={r.key} decoded={r.decoded} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** 单行：key（等宽）+ 值（默认掩码）+ 显示切换/复制。展开态是本地 state，不落 URL 也不高亮可搜索 */
function SecretRow({ name, decoded }: { name: string; decoded: Decoded }) {
  const t = useT()
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  // 掩码只露前 4 字符；≤4 字符的短值一个明文字符都不给（掩码本身就泄露全部）
  const full = decoded.state === 'text' || decoded.state === 'invalid' ? decoded.text : ''
  const mask = full.length > 4 ? `${full.slice(0, 4)}●●●` : '●●●'
  const shown = revealed ? full.slice(0, MAX_SHOWN) : mask
  const canReveal = decoded.state === 'text' || decoded.state === 'invalid'
  const truncated = revealed && full.length > MAX_SHOWN
  // 二进制行不给展开但可复制，复制的是原始 base64（等价 kubectl -o jsonpath）
  const copyText = decoded.state === 'binary' ? decoded.raw : full

  const doCopy = useCallback(() => {
    clipboardWrite(copyText)
      .then(() => {
        setCopied(true)
        toast.success(tf('sec:copiedKey', { key: name }))
      })
      .catch(() => toast.error(t('sec:copyFailed')))
  }, [copyText, name, t])

  return (
    <div className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)_auto] items-start gap-2 text-[13px]">
      <span className="truncate font-mono text-muted-foreground" title={name}>
        {name}
      </span>
      <div className="min-w-0">
        {decoded.state === 'empty' && <span className="text-muted-foreground">{t('sec:emptyValue')}</span>}
        {decoded.state === 'binary' && (
          <span className="text-muted-foreground" title={t('sec:binary')}>
            {tf('sec:byteCount', { n: decoded.bytes })} · {t('sec:binary')}
          </span>
        )}
        {canReveal && (
          <span className={cn('break-all font-mono', revealed && 'whitespace-pre-wrap')}>
            {shown}
            {truncated && '…'}
          </span>
        )}
        {truncated && (
          <div className="mt-0.5 text-xs text-muted-foreground">{tf('sec:truncated', { n: MAX_SHOWN })}</div>
        )}
        {decoded.state === 'invalid' && (
          <div className="mt-0.5 text-xs text-muted-foreground">{t('sec:decodeFailed')}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={revealed ? t('sec:hide') : t('sec:show')}
          title={revealed ? t('sec:hide') : t('sec:show')}
          disabled={!canReveal}
          onClick={() => setRevealed(v => !v)}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? t('sec:copied') : t('sec:copy')}
          title={copied ? t('sec:copied') : t('sec:copy')}
          disabled={decoded.state === 'empty'}
          onClick={doCopy}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  )
}
