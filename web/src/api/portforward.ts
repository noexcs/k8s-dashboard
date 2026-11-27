// Pod 端口转发 API（对齐 backend/pkg/portforward/handler.go）
// 语义：转发由 headlamp-server 进程发起并维护（非 K8s 资源）；监听地址是
// server 所在主机的 localhost:{port}（handler.go net.ListenTCP("localhost:0")），
// 浏览器只是控制面。client.ts 的 json()/parseError() 未导出，这里写等价小函数、复用 ApiError。
import { tf } from '@/i18n'
import { ApiError } from './client'

export type PortForwardStatus = 'Running' | 'Stopped' | 'Reconnecting'

/** 后端 portForward 对象（cache 快照）。service/serviceNamespace 仅 service 转发的自动重启用。 */
export interface PortForward {
  id: string
  pod: string
  service?: string
  serviceNamespace?: string
  namespace: string
  cluster: string
  /** 服务器主机上监听的端口（字符串，后端即字符串类型） */
  port: string
  /** Pod 内目标端口（数字或容器端口名） */
  targetPort: string
  status: PortForwardStatus
  error?: string
}

export interface StartPortForwardBody {
  /** 留空后端生成 uuid */
  id?: string
  namespace: string
  pod: string
  targetPort: string
  /** 留空后端自动选空闲端口 */
  port?: string
  service?: string
  serviceNamespace?: string
}

const basePath = (cluster: string) => `/clusters/${encodeURIComponent(cluster)}/portforward`

async function parseError(res: Response): Promise<ApiError> {
  let body: unknown
  let message = tf('sys:httpStatus', { n: res.status })
  try {
    const text = await res.text()
    const parsed: unknown = JSON.parse(text)
    body = parsed
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      message = String(parsed.message)
    } else {
      message = text.slice(0, 200) || message
    }
  } catch {
    /* keep default */
  }
  return new ApiError(res.status, message, body)
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as T
}

/** 创建转发（201/200 返回 portforward 对象）。同 id 已 RUNNING → ApiError(409)。 */
export async function startPortForward(cluster: string, body: StartPortForwardBody): Promise<PortForward> {
  const res = await fetch(basePath(cluster), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  return json<PortForward>(res)
}

/** 停止转发。注意后端语义反直觉（store.go:79-94）：stopOrDelete=true 仅停止（记录保留为 Stopped），false 才从缓存删除。响应体是纯文本 "stopped"。 */
export async function stopPortForward(cluster: string, id: string, stopOrDelete: boolean): Promise<void> {
  const res = await fetch(basePath(cluster), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, stopOrDelete }),
  })
  if (!res.ok) throw await parseError(res)
}

/** 该集群（server 进程内 cache）的全部转发；空列表后端可能编码为 null，兜底成 []。 */
export async function listPortForwards(cluster: string, signal?: AbortSignal): Promise<PortForward[]> {
  const res = await fetch(`${basePath(cluster)}/list`, { headers: { Accept: 'application/json' }, signal })
  const data = await json<PortForward[] | null>(res)
  return data ?? []
}
