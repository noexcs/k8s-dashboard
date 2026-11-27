// @ts-check
/**
 * tools 域：list_pods / get_pod / pod_logs / list_events（自 tools.js buildTools 拆出；聚合注册见 tools.js）。
 */
import { Type } from 'typebox'
import { list, get, streamLogs } from './k8s.js'
import { result, safe, trimPod, pageParams, pageResult } from './tools-helpers.js'

/** @typedef {import('./tools-helpers.js').Pod} Pod */
/** @typedef {import('./tools-helpers.js').Node} Node */
/** @typedef {import('./tools-helpers.js').Deployment} Deployment */
/** @typedef {import('./tools-helpers.js').Event} Event */

/** @param {{ value: string }} clusterRef @returns {Record<string, any>} */
export function buildPodTools(clusterRef) {
  const cluster = () => clusterRef.value
  return {
    list_pods: {
      label: '查询 Pod 列表',
      description:
        '列出 Pod（查 Pod 一律用它，别用 k8s_get/k8s_request 拉原始 Pod——原始对象带完整 spec/annotations，实测一次命名空间列表就多花 20-30KB）。可选按命名空间 ns、相态 phase（Pending/Running/Succeeded/Failed/Unknown）过滤（服务端 fieldSelector，与分页组合正确）。看某个 Deployment/StatefulSet 名下的 Pod 就传它的 labelSelector（如 app=web-api，取自 list_deployments 的 labels）。分页：limit 缺省 20、上限 200；truncated=true 时带 continueToken 再拉下一页。返回 name/phase/ready/restarts/node/started 摘要。',
      parameters: Type.Object({
        ns: Type.Optional(Type.String({ description: '命名空间，缺省为全部命名空间' })),
        phase: Type.Optional(
          Type.Union([
            Type.Literal('Pending'),
            Type.Literal('Running'),
            Type.Literal('Succeeded'),
            Type.Literal('Failed'),
            Type.Literal('Unknown'),
          ], { description: '按相态过滤' }),
        ),
        labelSelector: Type.Optional(Type.String({ description: 'label 过滤，如 app=web-api（看某工作负载名下 Pod 用它）' })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: '本页条数，缺省 20、上限 200' })),
        continueToken: Type.Optional(Type.String({ description: '上一页返回的 continueToken（续拉下一页）' })),
      }),
      /** @param {string} _toolCallId @param {{ ns?: string; phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown'; labelSelector?: string; limit?: number; continueToken?: string }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const { ns, phase } = params
        const data = await safe(async () => {
          // phase 走服务端 fieldSelector（k8s 原生支持 status.phase=）：
          // 先 list 后本地 filter 会让 limit/continue 的页数对不上过滤结果
          const q = pageParams(params)
          if (params.labelSelector) q.labelSelector = params.labelSelector
          if (phase) q.fieldSelector = `status.phase=${phase}`
          const res = /** @type {{ items: Pod[] }} */ (
            await list(cluster(), ns ? `/api/v1/namespaces/${encodeURIComponent(ns)}/pods` : '/api/v1/pods', q, signal)
          )
          const page = pageResult(res)
          return { returned: page.returned, truncated: page.truncated, continueToken: page.continueToken, pods: page.items.map(trimPod) }
        })
        return result(data)
      },
    },

    get_pod: {
      label: '查看 Pod 详情',
      description: '查询单个 Pod 的详情：相态、IP、节点、容器状态（含 waiting/terminated 原因）与 conditions。',
      parameters: Type.Object({
        ns: Type.String(),
        name: Type.String(),
      }),
      /** @param {string} _toolCallId @param {{ ns: string; name: string }} params @param {AbortSignal|undefined} _signal 未用 */
      async execute(_toolCallId, params, _signal) {
        const { ns, name } = params
        const data = await safe(async () => {
          const pod = /** @type {Pod} */ (
            await get(cluster(), `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}`)
          )
          return {
            name: pod.metadata.name,
            namespace: ns,
            phase: pod.status?.phase,
            podIP: pod.status?.podIP ?? null,
            node: pod.spec?.nodeName ?? null,
            started: pod.status?.startTime ?? null,
            reason: pod.status?.reason ?? null,
            message: pod.status?.message?.slice(0, 300) ?? null,
            containers: (pod.status?.containerStatuses ?? []).map((c) => ({
              name: c.name,
              image: c.image,
              ready: c.ready,
              restarts: c.restartCount ?? 0,
              state: c.state?.running
                ? 'running'
                : c.state?.waiting
                  ? `waiting:${c.state.waiting.reason ?? ''}`
                  : c.state?.terminated
                    ? `terminated:${c.state.terminated.reason ?? c.state.terminated.exitCode}`
                    : 'unknown',
            })),
            conditions: (pod.status?.conditions ?? []).map((c) => ({
              type: c.type,
              status: c.status,
              reason: c.reason ?? undefined,
            })),
          }
        })
        return result(data)
      },
    },

    pod_logs: {
      label: '查看日志',
      description:
        '读取 Pod 最近日志——看容器输出一律用它，k8s_get/k8s_request 读不到日志。name 是 Pod 名（不是 Deployment 名；只有一个工作负载名时先 list_pods 拿 Pod 名，多 Pod 时逐个查或先查最异常的那个）。默认尾部 50 行，上限 200 行。CrashLoop 排查用 previous=true 看上个实例（当前容器还没崩、日志是空的时，崩溃堆栈在上一个已终止实例里）；container 指定多容器 Pod 的容器；sinceSeconds 只看最近 N 秒；timestamps=true 每行带时间戳。',
      parameters: Type.Object({
        ns: Type.String(),
        name: Type.String(),
        // zod .default(50) → TypeBox 无 default，execute 内补齐
        tail: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: '尾部行数' })),
        container: Type.Optional(Type.String({ description: '容器名；多容器 Pod 必填' })),
        previous: Type.Optional(Type.Boolean({ description: 'true = 上一个已终止容器实例的日志（CrashLoop/OOMKilled 排查）' })),
        sinceSeconds: Type.Optional(Type.Number({ minimum: 1, description: '只看最近 N 秒的日志' })),
        timestamps: Type.Optional(Type.Boolean({ description: 'true = 每行前缀时间戳' })),
      }),
      /** @param {string} _toolCallId @param {{ ns: string; name: string; tail?: number; container?: string; previous?: boolean; sinceSeconds?: number; timestamps?: boolean }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const { ns, name } = params
        const tail = params.tail ?? 50
        const data = await safe(async () => {
          // 与浏览器侧一致：15s 外层超时；全量累积后取尾部 6000 字符
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(new Error('读取日志超时（15s）')), 15_000)
          const abortables = [ctrl.signal]
          if (signal) abortables.push(signal)
          const any = signal ? AbortSignal.any(abortables) : ctrl.signal
          try {
            let out = ''
            await streamLogs(
              cluster(),
              ns,
              name,
              {
                tailLines: tail,
                follow: false,
                connectTimeoutMs: 15_000,
                container: params.container,
                previous: params.previous,
                sinceSeconds: params.sinceSeconds,
                timestamps: params.timestamps,
              },
              (chunk) => {
                out += chunk
              },
              any,
            )
            return {
              namespace: ns,
              pod: name,
              tail,
              ...(params.previous ? { previous: true } : {}),
              logs: out.trim() ? out.slice(-6000) : '(无日志输出)',
            }
          } finally {
            clearTimeout(timer)
          }
        })
        return result(data)
      },
    },

    list_events: {
      label: '查询事件',
      description:
        '列出集群事件（按时间倒序；同一对象同一原因的重复事件已合并为一条并在 count 累加，groups=合并后条数）。可选按命名空间 ns 过滤；warningOnly=true 只看 Warning；object（对象名）+objectKind（如 Pod/Deployment）按 involvedObject 精确过滤——事件默认 1h TTL 且被聚合，按对象查最可靠。查「为什么起不来」优先 diagnose（已把事件与副本/service 拼成结论），本工具用于看全量事件或追某个具体对象。分页：limit 缺省 20、上限 200；truncated=true 时带 continueToken 续拉。',
      parameters: Type.Object({
        ns: Type.Optional(Type.String({ description: '命名空间，缺省为全部' })),
        warningOnly: Type.Optional(Type.Boolean({ description: '只看 Warning 事件' })),
        object: Type.Optional(Type.String({ description: 'involvedObject.name（如某 Pod 名）' })),
        objectKind: Type.Optional(Type.String({ description: 'involvedObject.kind（如 Pod/Deployment/Node）；配合 object 收窄' })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: '本页条数，缺省 20、上限 200' })),
        continueToken: Type.Optional(Type.String({ description: '上一页返回的 continueToken（续拉下一页）' })),
      }),
      /** @param {string} _toolCallId @param {{ ns?: string; warningOnly?: boolean; object?: string; objectKind?: string; limit?: number; continueToken?: string }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const { ns } = params
        const warningOnly = params.warningOnly ?? false
        const data = await safe(async () => {
          // object/objectKind 走服务端 fieldSelector（involvedObject.* 是原生可索引字段）
          const q = pageParams(params)
          const fs = []
          if (warningOnly) fs.push('type=Warning')
          if (params.objectKind) fs.push(`involvedObject.kind=${params.objectKind}`)
          if (params.object) fs.push(`involvedObject.name=${params.object}`)
          if (fs.length) q.fieldSelector = fs.join(',')
          const res = /** @type {{ items: Event[] }} */ (
            await list(cluster(), ns ? `/api/v1/namespaces/${encodeURIComponent(ns)}/events` : '/api/v1/events', q, signal)
          )
          const page = pageResult(res)
          // warningOnly 已进 fieldSelector（type=Warning），无需再本地 filter
          const rows = page.items
            .slice()
            .sort((a, b) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? ''))
            .map((e) => ({
              type: e.type,
              reason: e.reason,
              namespace: e.metadata?.namespace ?? null,
              object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
              message: (e.message ?? '').slice(0, 200),
              count: e.count ?? 1,
              last: e.lastTimestamp ?? null,
            }))
          // 同一对象同一原因的重复事件合并成一条（实测 20 条事件里有 14 条是
          // 同一条 ImagePullBackOff 的重播，逐条摊开只是挤占列表预算）
          /** @type {Map<string, (typeof rows)[number]>} */
          const grouped = new Map()
          for (const r of rows) {
            const key = `${r.type}|${r.reason}|${r.object}|${r.namespace}`
            const prev = grouped.get(key)
            if (prev) {
              prev.count += r.count
              if ((r.last ?? '') > (prev.last ?? '')) prev.last = r.last
            } else grouped.set(key, { ...r })
          }
          const events = [...grouped.values()]
          return {
            returned: page.returned,
            groups: events.length,
            truncated: page.truncated,
            continueToken: page.continueToken,
            events,
          }
        })
        return result(data)
      },
    },

  }
}
