// 复制兜底:navigator.clipboard 仅在安全上下文(HTTPS/localhost)存在。
// 本产品典型部署是 http://内网IP:端口 远程访问——非安全上下文下 clipboard 是
// undefined,裸 .writeText 同步抛 TypeError(不是 rejected Promise,.catch 接不到),
// 表现即「点了但剪切板是空的」。统一走这里,调用方只面对 Promise。
export async function clipboardWrite(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // 安全上下文但权限被拒(未聚焦/无用户手势)→ 继续试 execCommand
    }
  }
  // execCommand('copy') 在非安全上下文仍可用,前提是同步用户手势内调用。
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '') // 防移动端弹键盘
  ta.style.position = 'fixed'
  ta.style.top = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  if (!ok) throw new Error('copy-unavailable')
}
