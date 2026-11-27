// Prometheus 集成（参考 CLI per-cluster Prometheus）：
// - 配置：localStorage 按集群（k8s.prom.{cluster} = { url?, ns?, svc? }）；ns+svc 走
//   集群 API service-proxy（浏览器无需直连集群内网，headlamp-server 透传实测可用），
//   url 用于集群外可达地址。设置页维护，usePromConfig 读取。
// - 查询：/api/v1/query（瞬时）与 query_range（区间），5xx/网络错 = 未配置好，调用方降级。
//   kube-prometheus-stack 与裸 prometheus 通用；指标名走默认约定（container_image… 变体不管）。
import { useQuery } from '@tanstack/react-query'

export interface PromConfig {
  url?: string
  ns?: string
  svc?: string
  port?: string
}

const KEY = (cluster: string) => `k8s.prom.${cluster}`

export function readPromConfig(cluster: string | undefined): PromConfig | null {
  if (!cluster) return null
  try {
    const raw = localStorage.getItem(KEY(cluster))
    if (!raw) return null
    const c = JSON.parse(raw) as PromConfig
    return c.url || (c.ns && c.svc) ? c : null
  } catch {
    return null
  }
}

export function writePromConfig(cluster: string, c: PromConfig | null) {
  if (c && (c.url || (c.ns && c.svc))) localStorage.setItem(KEY(cluster), JSON.stringify(c))
  else localStorage.removeItem(KEY(cluster))
}

/** base 路径：ns/svc 模式经集群 API 代理（前缀 /clusters/:c，headlamp-server 透传）；url 模式直连 */
function promBase(cluster: string, cfg: PromConfig): string {
  if (cfg.ns && cfg.svc) {
    const port = cfg.port || 'http'
    const svc = port === 'http' ? `http:${cfg.svc}` : `${cfg.svc}:${port}`
    return `/clusters/${encodeURIComponent(cluster)}/api/v1/namespaces/${encodeURIComponent(cfg.ns)}/services/${encodeURIComponent(svc)}/proxy`
  }
  return cfg.url!.replace(/\/$/, '')
}

interface PromValue {
  metric: Record<string, string>
  value: [number, string]
}
interface PromResult {
  status: string
  data: { resultType: string; result: PromValue[] }
}

async function promQuery(cluster: string, cfg: PromConfig, query: string, at?: number): Promise<PromValue[]> {
  const u = `${promBase(cluster, cfg)}/api/v1/query?query=${encodeURIComponent(query)}${at ? `&time=${at}` : ''}`
  const res = await fetch(u, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Prometheus ${res.status}`)
  const j = (await res.json()) as PromResult
  if (j.status !== 'success') throw new Error('Prometheus query failed')
  return j.data.result ?? []
}

export interface RangePoint {
  t: number
  v: number
}

async function promQueryRange(cluster: string, cfg: PromConfig, query: string, rangeSec: number): Promise<{ name: string; points: RangePoint[] }[]> {
  const step = Math.max(60, Math.round(rangeSec / 120 / 60) * 60)
  const end = Math.floor(Date.now() / 1000)
  const u = `${promBase(cluster, cfg)}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${end - rangeSec}&end=${end}&step=${step}`
  const res = await fetch(u, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Prometheus ${res.status}`)
  const j = (await res.json()) as { status: string; data: { result: { metric: Record<string, string>; values: [number, string][] }[] } }
  if (j.status !== 'success') throw new Error('Prometheus query failed')
  return (j.data.result ?? []).map(s => ({
    name: s.metric.node || s.metric.pod || s.metric.container || s.metric.device || s.metric.instance || '∑',
    points: (s.values ?? []).map(([t, v]) => ({ t: t * 1000, v: Number(v) })),
  }))
}

/** 配置 + 连通性探测（up 瞬时查询；60s 缓存，失败不重试刷屏） */
export function usePrometheus(cluster: string | undefined) {
  const cfg = readPromConfig(cluster)
  const q = useQuery({
    queryKey: ['prom-probe', cluster, cfg && cluster ? promBase(cluster, cfg) : ''],
    queryFn: () => promQuery(cluster!, cfg!, 'up'),
    enabled: !!cluster && !!cfg,
    staleTime: 60_000,
    retry: false,
  })
  return { cfg, reachable: q.isSuccess, checking: !!cfg && !q.isFetched, enabled: !!cfg }
}

/** 区间趋势数据（rangeSec 秒窗口；失败由调用方显示空态） */
export function usePromRange(cluster: string, cfg: PromConfig | null, query: string | null, rangeSec: number) {
  return useQuery({
    queryKey: ['prom-range', cluster, cfg ? promBase(cluster, cfg) : '', query, rangeSec],
    queryFn: () => promQueryRange(cluster, cfg!, query!, rangeSec),
    enabled: !!cfg && !!query,
    refetchInterval: 60_000,
    retry: false,
  })
}

// ---------- 惯用 PromQL（kube-prometheus-stack / 裸 prometheus 通用命名） ----------

export const Q = {
  nodeCpuPct: (n: string) => `100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle",instance=~"${instanceRe(n)}"}[5m])))`,
  nodeMemPct: (n: string) => `100 * (1 - node_memory_MemAvailable_bytes{instance=~"${instanceRe(n)}"} / node_memory_MemTotal_bytes{instance=~"${instanceRe(n)}"})`,
  nodeNetRx: (n: string) => `sum(rate(node_network_receive_bytes_total{instance=~"${instanceRe(n)}",device!~"lo|veth.*|cali.*|flannel.*|cni.*"}[5m]))`,
  nodeNetTx: (n: string) => `sum(rate(node_network_transmit_bytes_total{instance=~"${instanceRe(n)}",device!~"lo|veth.*|cali.*|flannel.*|cni.*"}[5m]))`,
  podCpu: (ns: string, p: string) => `sum(rate(container_cpu_usage_seconds_total{namespace="${ns}",pod="${p}",container!=""}[5m])) by (container)`,
  podMem: (ns: string, p: string) => `sum(container_memory_working_set_bytes{namespace="${ns}",pod="${p}",container!=""}) by (container)`,
  clusterCpu: 'sum(rate(container_cpu_usage_seconds_total{container!=""}[5m]))',
  clusterMem: 'sum(container_memory_working_set_bytes{container!=""})',
}

/** instance 通常是 nodeIP:9100 或 hostname:9100；锚定正则。PromQL 字符串里 `\d` 是非法转义，用 (:.*)? 覆盖端口 */
function instanceRe(n: string): string {
  return `${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:.*)?`
}
