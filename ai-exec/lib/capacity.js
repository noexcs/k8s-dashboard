// 集群承诺水位（容量视角最小闭环）：allocatable 总量 vs requests 承诺总量。
// 与 kubectl describe node 的 Allocated resources 同口径（requests 承诺，非实时用量）——
// metrics-server 可缺，承诺水位永远可算，回答「还能塞多少」用的就是这个。
import { list } from './k8s.js'
import { committedByNode } from './nodes.js'

/** @param {string | number | null | undefined} v @returns {number} */
function parseQty(v) {
  if (v == null) return 0
  const s = String(v)
  const m = /^([0-9.]+)(m|Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(s)
  if (!m) return 0
  const n = parseFloat(m[1] ?? '0')
  switch (m[2]) {
    case 'm': return n / 1000
    case 'Ki': return n * 1024
    case 'Mi': return n * 1024 ** 2
    case 'Gi': return n * 1024 ** 3
    case 'Ti': return n * 1024 ** 4
    case 'K': return n * 1e3
    case 'M': return n * 1e6
    case 'G': return n * 1e9
    case 'T': return n * 1e12
    default: return n
  }
}

/**
 * 集群级承诺水位：Σallocatable vs Σrequests（按节点聚合后求和）。
 * @param {string} cluster @param {AbortSignal} [signal]
 * @returns {Promise<{ allocCpu: number, allocMem: number, reqCpu: number, reqMem: number, pctCpu: number | null, pctMem: number | null } | null>}
 */
export async function clusterCapacity(cluster, signal) {
  try {
    const [{ items }, byNode] = await Promise.all([
      /** @type {Promise<{ items: { status?: { allocatable?: Record<string, string> } }[]}>} */ (list(cluster, '/api/v1/nodes', {}, signal)),
      committedByNode(cluster, signal),
    ])
    let allocCpu = 0
    let allocMem = 0
    for (const n of items) {
      allocCpu += parseQty(n.status?.allocatable?.cpu)
      allocMem += parseQty(n.status?.allocatable?.memory)
    }
    let reqCpu = 0
    let reqMem = 0
    for (const v of Object.values(byNode)) {
      reqCpu += v.requestsCpu
      reqMem += v.requestsMem
    }
    return {
      allocCpu: Math.round(allocCpu * 10) / 10,
      // 0.1Gi 精度与 CPU 侧 0.1c 对称;整数 Gi 把 1.15Gi 演成 1Gi(-13%)。
      // 单位是 Gi 不是 bytes——前端曾按 bytes 格式化显示成「1B / 6B」
      allocMem: Math.round((allocMem / 1073741824) * 10) / 10,
      reqCpu: Math.round(reqCpu * 10) / 10,
      reqMem: Math.round((reqMem / 1073741824) * 10) / 10,
      // 分母 0（空集群）= 没有水位概念，null 显示 '-'，别冒充 0%
      pctCpu: allocCpu > 0 ? Math.round((reqCpu / allocCpu) * 100) : null,
      pctMem: allocMem > 0 ? Math.round((reqMem / allocMem) * 100) : null,
    }
  } catch {
    return null
  }
}
