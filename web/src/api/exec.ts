// Pod exec 客户端:直连 headlamp-server 的集群 WS 代理 /clusters/{c}{path}
// (替代早期 /wsMultiplexer 隧道——multiplexer Go 侧拨号不带 exec 子协议,
//  k8s ≥1.37 会拒绝无 v5.channel.k8s.io 的 exec WS;直连由浏览器声明子协议,
//  代理透传 Upgrade 头,实测 101 回显 v5.channel.k8s.io,2026-11-25)。
//
// 集群侧 exec 帧(WS 二进制消息,首字节 = k8s channel id):
// 0 = stdin 1 = stdout 2 = stderr 3 = 错误/退出 4 = resize(v4)
// v5 子协议额外规则(协商结果 = new WebSocket(url, protocols) 的 ws.protocol):
// - 服务端可能发 WS ping 心跳帧(浏览器自动回 pong,无需处理);
// - resize 用文本帧 {"Type":"RESIZED","Rows":n,"Cols":n}(v4 才是 ch4 二进制 JSON)。
// ch3 两种形态:
//  k8s ≥1.37 是 k8s Status JSON,退出码在 details.causes[reason=ExitCode].message,
//  如 {"message":"command terminated with exit code 3",
//  "reason":"NonZeroExitCode","details":{"causes":[{"reason":"ExitCode","message":"3"}]}};
//  k3s 1.36 是纯文本,如 "command terminated with non-zero exit code: ..., exit code 3"。
//
// 握手语义:101 = 命令通道建立(不代表命令启动成功;容器无 sh 等失败以 ch3 帧到达);
// tailnet 集群的代理拨号在 101 之前同步完成,可长达 60s+ → 30s 上限太紧,取 90s。
import { t } from '@/i18n'

export interface ExecOptions {
  /** 是否分配 pty。默认 true。 */
  tty?: boolean
  /** exec 命令。默认 ['sh']。 */
  command?: string[]
}

export interface ExecHandle {
  /** 写 stdin（channel 0）。参数为 UTF-8 文本。 */
  send(input: string): void
  /** 终端尺寸变化。v5 = 文本帧；v4 = channel 4。 */
  resize(cols: number, rows: number): void
  /** stdout/stderr（channel 1/2）回调。注册后立即返回；多次注册全部生效。 */
  onOutput(cb: (chunk: Uint8Array) => void): void
  /** 退出回调：exitCode 为 null 表示连接异常断开（reason 为原因）。只触发一次。 */
  onExit(cb: (exitCode: number | null, reason: string) => void): void
  /** 关闭 WS。幂等。 */
  close(): void
}

/**
 * 一次性命令：无 pty 跑完取全部输出 + 退出码（文件浏览/下载/上传用）。
 * 二进制安全：stdout 原样字节进 chunks（不做 UTF-8 解码），调用方自行处理。
 * stderr 合并进 chunks（exec 的 ch2 与 stdout 共享流；错误文本对调用方可见）。
 */
export function execCapture(
  cluster: string,
  namespace: string,
  pod: string,
  container: string,
  command: string[],
  timeoutMs = 60_000,
): Promise<{ code: number | null; chunks: Uint8Array[]; reason: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; chunks: Uint8Array[]; reason: string }>()
  void execPod(cluster, namespace, pod, container, { tty: false, command })
    .then(handle => {
      const chunks: Uint8Array[] = []
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        handle.close()
        reject(new Error(t('pods:execTimeout')))
      }, timeoutMs)
      handle.onOutput(c => chunks.push(c))
      handle.onExit((code, reason) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, chunks, reason })
      })
    })
    .catch(reject)
  return promise
}

interface K8sStatus {
  status?: string
  message?: string
  details?: { causes?: Array<{ reason?: string; message?: string }> }
}

/** 子协议优先级:新集群只接受 v5;老集群两者都认 */
const EXEC_PROTOCOLS = ['v5.channel.k8s.io', 'v4.channel.k8s.io']
const WS_OPEN_TIMEOUT_MS = 90_000

function bytesToUtf8(bytes: Uint8Array): string {
  // 分块避免 String.fromCharCode.apply 的栈限制
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return s
}

/**
 * 解析 ch3 帧得到退出码。
 * 实测两种形态：
 *  - k8s ≥1.37：k8s Status JSON，退出码在 details.causes[reason=ExitCode]；
 *  - k3s 1.36：纯文本，如 "command terminated with non-zero exit code:
 *    error executing command [sh], exit code 3"。
 */
function parseStatus(raw: string): { code: number | null; message: string } {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) {
    const m = /exit code (\d+)\s*$/.exec(trimmed)
    return { code: m ? Number(m[1]) : null, message: trimmed }
  }
  let st: K8sStatus
  try {
    st = JSON.parse(trimmed) as K8sStatus
  } catch {
    return { code: null, message: trimmed.slice(0, 200) || 'command terminated' }
  }
  const cause = st.details?.causes?.find(c => c.reason === 'ExitCode')
  if (cause?.message !== undefined && /^\d+$/.test(cause.message)) {
    return { code: Number(cause.message), message: st.message ?? '' }
  }
  const m = /exit code (\d+)/.exec(st.message ?? '')
  if (m) return { code: Number(m[1]), message: st.message ?? '' }
  return { code: st.status === 'Success' ? 0 : null, message: st.message ?? 'command terminated' }
}

/**
 * 对 Pod 容器发起 exec。
 *
 * @param cluster   集群 id（URL 中的 clusterName）
 * @param namespace Pod 命名空间
 * @param pod       Pod 名
 * @param container 容器名
 * @returns 连接就绪（101）后 resolve ExecHandle；握手失败时 reject。
 */
export function execPod(
  cluster: string,
  namespace: string,
  pod: string,
  container: string,
  opts: ExecOptions = {},
): Promise<ExecHandle> {
  const tty = opts.tty ?? true
  const command = opts.command ?? ['sh']

  const qs = new URLSearchParams()
  qs.set('container', container)
  qs.set('stderr', 'true')
  qs.set('stdin', 'true')
  qs.set('stdout', 'true')
  qs.set('tty', String(tty))
  for (const c of command) qs.append('command', c)
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${scheme}://${window.location.host}/clusters/${encodeURIComponent(cluster)}` +
    `/api/v1/namespaces/${namespace}/pods/${pod}/exec?${qs}`

  const { promise, resolve, reject } = Promise.withResolvers<ExecHandle>()
  let settled = false

  const ws = new WebSocket(url, EXEC_PROTOCOLS)
  ws.binaryType = 'arraybuffer'

  const outCbs = new Set<(chunk: Uint8Array) => void>()
  const exitCbs = new Set<(exitCode: number | null, reason: string) => void>()
  let exited = false
  let wsOpen = false
  const openTimer = setTimeout(() => fail(t('pods:dialTimeout')), WS_OPEN_TIMEOUT_MS)

  const fail = (reason: string) => {
    if (settled) return
    settled = true
    clearTimeout(openTimer)
    ws.close()
    reject(new Error(reason))
  }

  const emitExit = (code: number | null, reason: string) => {
    if (exited) return
    exited = true
    for (const cb of exitCbs) cb(code, reason)
  }

  const handle: ExecHandle = {
    send(input: string) {
      if (!wsOpen || ws.readyState !== WebSocket.OPEN || exited) return
      // channel 0 = stdin
      const body = new TextEncoder().encode(input)
      const frame = new Uint8Array(body.length + 1)
      frame[0] = 0
      frame.set(body, 1)
      ws.send(frame)
    },
    resize(cols: number, rows: number) {
      if (!wsOpen || ws.readyState !== WebSocket.OPEN || exited) return
      if (ws.protocol === 'v5.channel.k8s.io') {
        ws.send(JSON.stringify({ Type: 'RESIZED', Rows: rows, Cols: cols }))
      } else {
        // v4：channel 4 + JSON（client-go 口径 Width/Height）
        const json = new TextEncoder().encode(JSON.stringify({ Width: cols, Height: rows }))
        const frame = new Uint8Array(json.length + 1)
        frame[0] = 4
        frame.set(json, 1)
        ws.send(frame)
      }
    },
    onOutput(cb: (chunk: Uint8Array) => void) {
      outCbs.add(cb)
    },
    onExit(cb: (exitCode: number | null, reason: string) => void) {
      exitCbs.add(cb)
    },
    close() {
      ws.close()
    },
  }

  ws.onopen = () => {
    clearTimeout(openTimer)
    wsOpen = true
    // 101 = 通道建立；命令失败（如容器无 sh）随后以 ch3 帧送达
    if (!settled) {
      settled = true
      resolve(handle)
    }
  }
  ws.onerror = () => {
    if (!wsOpen) fail(t('pods:wsConnectFailed'))
  }
  ws.onclose = () => {
    if (!wsOpen) {
      // 握手被拒（HTTP 错误）：浏览器只给 close，拿不到状态码
      fail(t('pods:wsClosed'))
      return
    }
    if (!exited) emitExit(null, t('pods:connectionLost'))
  }
  ws.onmessage = (ev) => {
    let frame: Uint8Array
    if (typeof ev.data === 'string') {
      // v5 可能用文本帧承载 error/status（{"type":"ERROR"/"STATUS"}）；普通输出永远是二进制
      try {
        const j = JSON.parse(ev.data) as { type?: string; message?: string }
        if (j.type === 'ERROR' || j.type === 'STATUS') {
          const code = j.type === 'ERROR' ? null : 0
          emitExit(code, j.message ?? '')
          handle.close()
        }
      } catch {
        /* 非 JSON 文本帧：忽略 */
      }
      return
    }
    frame = new Uint8Array(ev.data as ArrayBuffer)
    if (frame.length === 0) return
    const ch = frame[0]
    const body = frame.subarray(1)
    if (ch === 1 || ch === 2) {
      for (const cb of outCbs) cb(new Uint8Array(body))
    } else if (ch === 3 && body.length > 0) {
      const { code, message } = parseStatus(bytesToUtf8(body))
      emitExit(code, message)
      handle.close()
    }
    // ch 0/4（客户端方向）不用
  }

  return promise
}
