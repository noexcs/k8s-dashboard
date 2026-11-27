import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { execPod, type ExecHandle } from '@/api/exec'
import { useTheme } from '@/hooks/useTheme'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { tf, useT } from '@/i18n'
import { cssVarHex } from '@/lib/color'

// xterm 不支持 CSS 变量：读当前主题 token 的解析值喂 #rrggbb（明暗、配色主题、
// 自定义色全走 --background/--foreground 一条链，切主题自动跟）；
// cursor/selection 是终端操作色板，跟 cursor 一起走主题 primary 归一化
const termTheme = () => ({
  background: cssVarHex('--background', '#f5f5f6'),
  foreground: cssVarHex('--foreground', '#26262b'),
  cursor: cssVarHex('--primary', '#3b6fd4'),
  cursorAccent: cssVarHex('--background', '#f5f5f6'),
  selectionBackground: cssVarHex('--accent', '#d5e3f8'),
})

type TermStatus = 'connecting' | 'running' | 'exited' | 'failed'

interface TermState {
  status: TermStatus
  exitCode: number | null
  reason: string
  /** 原始 reason（friendly 改写时 title 里保留原文） */
  raw?: string
}

/** distroless/scratch 容器无 shell：把 "exec: "sh": executable file not found" 换成可操作提示 */
function friendlyExit(code: number | null, reason: string): { shown: string; raw: string } {
  if (code === null && /executable file not found/i.test(reason)) {
    const cmd = reason.match(/exec: "([^"]+)": executable file not found/)?.[1] ?? 'sh'
    return {
      shown: tf('pods:noShellInContainer', { cmd }),
      raw: reason,
    }
  }
  return { shown: reason, raw: reason }
}

const STATUS_KEY: Record<TermStatus, string> = {
  connecting: 'pods:statusConnecting',
  running: 'pods:statusConnected',
  exited: 'pods:statusExited',
  failed: 'pods:statusFailed',
}

export function TerminalView(props: {
  cluster: string
  ns: string
  pod: string
  containers: string[]
  /** 初始选中容器（调试启动后直接落到 debug 容器；父组件配合 key 重建） */
  initial?: string
  /** 初始 exec 命令（NodeShell 用 nsenter；默认 ['sh']）。仅挂载时生效，重建请换 key */
  initialCommand?: string[]
}) {
  const { cluster, ns, pod, containers } = props
  const t = useT()
  const { resolved, id: themeId, custom } = useTheme()
  const dark = resolved === 'dark'
  const [container, setContainer] = useState(props.initial ?? containers[0] ?? '')
  const [command, setCommand] = useState<string[]>(props.initialCommand ?? ['sh'])
  const [cmdInput, setCmdInput] = useState((props.initialCommand ?? ['sh']).join(' '))
  const [session, setSession] = useState(0)

  /** 输入框按空格拆词为 exec 参数；相同命令不重启会话 */
  const applyCmd = () => {
    const parts = cmdInput.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return
    if (parts.join(' ') !== command.join(' ')) setCommand(parts)
  }
  const [state, setState] = useState<TermState>({ status: 'connecting', exitCode: null, reason: '' })
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let disposed = false
    let handle: ExecHandle | null = null

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 12.5,
      // 与 --font-mono 同栈（xterm 不吃 var()，此处同步字面量）：同页两种等宽人格=拼装感
      fontFamily: "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: termTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term
    const fitSafe = () => {
      try {
        fit.fit()
      } catch {
        /* 容器隐藏/尺寸为 0 时忽略 */
      }
    }
    fitSafe()
    const ro = new ResizeObserver(fitSafe)
    ro.observe(el)

    setState({ status: 'connecting', exitCode: null, reason: '' })

    void execPod(cluster, ns, pod, container, { command })
      .then(h => {
        if (disposed) {
          h.close()
          return
        }
        handle = h
        h.onOutput(chunk => term.write(chunk))
        h.onExit((code, reason) => {
          const { shown, raw } = friendlyExit(code, reason)
          const exitLine =
            code !== null
              ? tf('pods:procExitedCode', { code })
              : shown
                ? tf('pods:procExitedReason', { reason: shown })
                : t('pods:procExited')
          term.write(`\r\n\x1b[90m[${exitLine}]\x1b[0m\r\n`)
          term.options.cursorBlink = false
          term.blur()
          setState({ status: 'exited', exitCode: code, reason: shown, raw })
        })
        term.onData(d => h.send(d))
        term.onResize(({ cols, rows }) => h.resize(cols, rows))
        h.resize(term.cols, term.rows)
        setState({ status: 'running', exitCode: null, reason: '' })
        term.focus()
      })
      .catch((e: unknown) => {
        if (disposed) return
        const msg = e instanceof Error ? e.message : String(e)
        term.write(`\x1b[31m${msg}\x1b[0m\r\n`)
        setState({ status: 'failed', exitCode: null, reason: msg })
      })

    return () => {
      disposed = true
      ro.disconnect()
      handle?.close()
      handle = null
      term.dispose()
      termRef.current = null
    }
  }, [cluster, ns, pod, container, command, session])

  // 主题切换时同步 xterm 配色（pane 已创建，重建会丢会话状态）；
  // 明暗、配色主题 id、自定义色覆盖三类变更都要重读 token
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = termTheme()
  }, [dark, themeId, custom])

  const busy = state.status === 'connecting' || state.status === 'running'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex h-8 items-center gap-2">
        {containers.length > 1 ? (
          <Select value={container} onValueChange={setContainer}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {containers.map(c => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="font-mono text-[13px] text-muted-foreground">{container}</span>
        )}
        <Input
          value={cmdInput}
          onChange={e => setCmdInput(e.target.value)}
          onBlur={applyCmd}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              applyCmd()
            }
          }}
          aria-label={t('pods:execCmdAria')}
          spellCheck={false}
          placeholder="sh"
          className="w-40 font-mono"
        />
        <Badge
          variant={state.status === 'failed' ? 'destructive' : 'outline'}
          className={cn(
            state.status === 'running' &&
              'border-positive/40 text-positive',
          )}
        >
          {t(STATUS_KEY[state.status])}
        </Badge>
        {state.status === 'exited' && state.exitCode !== null && state.exitCode !== 0 && (
          <span className="tabular-nums text-[13px] text-caution" title={state.reason}>
            exit code {state.exitCode}
          </span>
        )}
        {state.status === 'exited' && state.exitCode === null && state.reason && (
          <span
            className="max-w-96 truncate text-[13px] text-muted-foreground"
            title={state.raw ?? state.reason}
          >
            {state.reason}
          </span>
        )}
        <Button
          variant="outline"
          className="ml-auto"
          onClick={() => setSession(s => s + 1)}
          disabled={busy}
        >
          <RefreshCw className="size-3.5" />
          {t('pods:reconnect')}
        </Button>
      </div>
      <div
        className={cn(
          // 容器背景与 pane 背景同值：都吃 --background，切主题不留灰白色框
          'min-h-0 flex-1 overflow-hidden rounded-md border bg-background',
        )}
      >
        <div ref={hostRef} className="h-full p-1" />
      </div>
    </div>
  )
}
