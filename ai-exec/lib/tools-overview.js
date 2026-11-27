// @ts-check
/**
 * tools 域：cluster_overview / top（集群级只读）（自 tools.js buildTools 拆出；聚合注册见 tools.js）。
 */
import { Type } from 'typebox'
import { list } from './k8s.js'
import { listReports, findingKey } from './inspect.js'
import { listLatest, record as dispRecord } from './disposition.js'
import { record as auditRecord } from './audit.js'
import { committedByNode } from './nodes.js'
import { result, MAX_ITEMS, safe, parseQty, listNodeMetrics, listPodMetrics, fmtCpuQty, fmtMemQty } from './tools-helpers.js'

/** @typedef {import('./tools-helpers.js').K8sMeta} K8sMeta */
/** @typedef {import('./tools-helpers.js').Pod} Pod */
/** @typedef {import('./tools-helpers.js').Node} Node */
/** @typedef {import('./tools-helpers.js').Deployment} Deployment */

/** @param {{ value: string }} clusterRef @param {string} [sessionId] @returns {Record<string, any>} */
/** @param {{ value: string }} clusterRef @param {string} sessionId @param {{ mode: string }} permRef 会话权限档（disposition_set 自记账时要盖章） */
export function buildOverviewTools(clusterRef, sessionId, permRef) {
  const cluster = () => clusterRef.value
  return {
    cluster_overview: {
      label: '集群概览',
      description:
        '集群整体概览：节点 Ready 数与 CPU/内存使用率、Pod 相态统计、Deployment 就绪度、命名空间数。适合回答"集群整体状况/资源水位如何/几个节点"。只问某一个命名空间或某一个服务的问题（起不来、慢、几个副本、什么原因）不要用它——那用 diagnose（可带 ns 直接给结论），集群级概览回答不了单个服务的根因。',
      parameters: Type.Object({}),
      /** @param {string} _toolCallId @param {Record<string, never>} _params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, _params, signal) {
        const data = await safe(async () => {
          const [nodes, pods, deps, nss, metrics] = await Promise.all([
            /** @type {Promise<{ items: Node[] }>} */ (list(cluster(), '/api/v1/nodes', {}, signal)),
            /** @type {Promise<{ items: Pod[] }>} */ (list(cluster(), '/api/v1/pods', {}, signal)),
            /** @type {Promise<{ items: Deployment[] }>} */ (list(cluster(), '/apis/apps/v1/deployments', {}, signal)),
            /** @type {Promise<{ items: K8sMeta[] }>} */ (list(cluster(), '/api/v1/namespaces', {}, signal)),
            listNodeMetrics(cluster(), signal),
          ])
          /** @type {Record<string, number>} */
          const phases = {}
          for (const p of pods.items) {
            const phase = p.status?.phase ?? 'Unknown'
            phases[phase] = (phases[phase] ?? 0) + 1
          }
          /** @param {Node} n */
          const isReady = (n) =>
            (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True')
          const byName = new Map((metrics ?? []).map((m) => [m.metadata.name, m]))
          return {
            nodes: {
              total: nodes.items.length,
              ready: nodes.items.filter(isReady).length,
              detail: nodes.items.map((n) => {
                const met = byName.get(n.metadata.name)
                const cpuU = parseQty(met?.usage?.cpu)
                const cpuC = parseQty(n.status?.capacity?.cpu)
                const memU = parseQty(met?.usage?.memory)
                const memC = parseQty(n.status?.capacity?.memory)
                return {
                  name: n.metadata.name,
                  ready: isReady(n),
                  cpuPercent: cpuU != null && cpuC ? Math.round((cpuU / cpuC) * 100) : null,
                  memoryPercent: memU != null && memC ? Math.round((memU / memC) * 100) : null,
                }
              }),
            },
            pods: { total: pods.items.length, byPhase: phases },
            deployments: {
              ready: deps.items.reduce((s, d) => s + (d.status?.readyReplicas ?? 0), 0),
              desired: deps.items.reduce((s, d) => s + (d.spec?.replicas ?? 0), 0),
            },
            namespaces: nss.items.length,
          }
        })
        return result(data)
      },
    },

    top: {
      label: '资源水位',
      description:
        'kubectl top 等价：节点/Pod 实时 CPU 与内存用量（metrics-server），只回答「用了多少/谁最热」。排查「起不来、不健康、部署卡住」请用 diagnose，本工具给不了原因；单个节点深挖（原因/taint/事件/承诺水位）用 node_view。nodes 附 capacity 百分比与热点标记；pods 按用量降序（≤20 条），ns 可限定命名空间（只问某命名空间的 Pod 用量就传 ns，此时默认只返回 pods，别顺带扫全集群 nodes）。metrics-server 不可用时 nodes 退化为 requests/limits 承诺水位（committed，基于 Pod 资源请求聚合，非实时用量），如实向用户区分口径。',
      parameters: Type.Object({
        scope: Type.Optional(
          Type.Union([Type.Literal('nodes'), Type.Literal('pods'), Type.Literal('both')], {
            description: '缺省：给了 ns 时 pods，否则 both',
          }),
        ),
        ns: Type.Optional(Type.String({ description: '仅 pods：命名空间，缺省全部' })),
        sortBy: Type.Optional(Type.Union([Type.Literal('cpu'), Type.Literal('memory')], { description: 'pods 排序维度，缺省 cpu' })),
      }),
      /** @param {string} _toolCallId @param {{ scope?: 'nodes' | 'pods' | 'both'; ns?: string; sortBy?: 'cpu' | 'memory' }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        // 传了 ns 就说明在问「这些 Pod 用了多少」，此时集群级 nodes 段只是白占上下文
        // （实测一次 top(ns=ai-tune) 返回 12627B，其中 nodes 段与问题无关）
        const scope = params.scope ?? (params.ns ? 'pods' : 'both')
        const sortBy = params.sortBy ?? 'cpu'
        const data = await safe(async () => {
          /** @type {Record<string, unknown>} */
          const out = {}
          if (scope === 'nodes' || scope === 'both') {
            const [nodes, metrics] = await Promise.all([
              /** @type {Promise<{ items: Node[] }>} */ (list(cluster(), '/api/v1/nodes', {}, signal)),
              listNodeMetrics(cluster(), signal),
            ])
            if (!metrics) {
              // metrics-server 缺失不再报错：退化为承诺水位（requests/limits ÷ allocatable），
              // 调度是否还塞得进去看这个口径，和实时用量是两个概念
              const committed = await committedByNode(cluster(), signal)
              /** @type {Array<Record<string, unknown>>} */
              const rows = nodes.items.map((n) => {
                const c = committed[n.metadata.name]
                // 分母用 allocatable（调度口径，与 node_view 一致），不是 capacity
                const allocCpu = parseQty(n.status?.allocatable?.cpu) ?? parseQty(n.status?.capacity?.cpu)
                const allocMem = parseQty(n.status?.allocatable?.memory) ?? parseQty(n.status?.capacity?.memory)
                const reqCpuPct = c && allocCpu ? Math.round((c.requestsCpu / allocCpu) * 100) : null
                const reqMemPct = c && allocMem ? Math.round((c.requestsMem / allocMem) * 100) : null
                return {
                  name: n.metadata.name,
                  cpu: '-',
                  cpuPercent: null,
                  memory: '-',
                  memoryPercent: null,
                  cpuCapacity: n.status?.capacity?.cpu ?? null,
                  memoryCapacity: n.status?.capacity?.memory ?? null,
                  hot: false,
                  committed: {
                    pods: c?.pods ?? 0,
                    requestsCpu: fmtCpuQty(c?.requestsCpu ?? 0),
                    requestsMem: fmtMemQty(c?.requestsMem ?? 0),
                    limitsCpu: fmtCpuQty(c?.limitsCpu ?? 0),
                    limitsMem: fmtMemQty(c?.limitsMem ?? 0),
                    requestsCpuPercent: reqCpuPct,
                    requestsMemPercent: reqMemPct,
                  },
                }
              })
              out.nodes = rows
              out.note = 'metrics-server 不可用：nodes 为 requests/limits 承诺水位（committed），非实时用量'
            } else {
              const byName = new Map(metrics.map((m) => [m.metadata.name, m]))
              /** @type {Array<Record<string, unknown>>} */
              const rows = nodes.items.map((n) => {
                const met = byName.get(n.metadata.name)
                const cpuU = parseQty(met?.usage?.cpu)
                const cpuC = parseQty(n.status?.capacity?.cpu)
                const memU = parseQty(met?.usage?.memory)
                const memC = parseQty(n.status?.capacity?.memory)
                const cpuPct = cpuU != null && cpuC ? Math.round((cpuU / cpuC) * 100) : null
                const memPct = memU != null && memC ? Math.round((memU / memC) * 100) : null
                return {
                  name: n.metadata.name,
                  cpu: fmtCpuQty(cpuU),
                  cpuPercent: cpuPct,
                  memory: fmtMemQty(memU),
                  memoryPercent: memPct,
                  cpuCapacity: n.status?.capacity?.cpu ?? null,
                  memoryCapacity: n.status?.capacity?.memory ?? null,
                  hot: (cpuPct ?? 0) >= 90 || (memPct ?? 0) >= 90,
                }
              })
              rows.sort((a, b) => Number(b.hot) - Number(a.hot))
              out.nodes = rows
            }
          }
          if (scope === 'pods' || scope === 'both') {
            // metrics 缺失时不让 pods 分支炸掉整个 top：nodes 的承诺水位仍有价值
            let items
            try {
              items = await listPodMetrics(cluster(), params.ns, signal)
            } catch {
              out.pods = { total: 0, returned: 0, items: [], note: 'metrics-server 不可用，无 Pod 实时用量' }
              return out
            }
            const rows = items
              .map((p) => {
                let cpu = 0
                let mem = 0
                let any = false
                for (const c of p.containers ?? []) {
                  const cu = parseQty(c.usage?.cpu)
                  const mu = parseQty(c.usage?.memory)
                  if (cu != null) cpu += cu
                  if (mu != null) mem += mu
                  if (cu != null || mu != null) any = true
                }
                return {
                  namespace: p.metadata.namespace ?? null,
                  name: p.metadata.name,
                  cpu: fmtCpuQty(any ? cpu : null),
                  memory: fmtMemQty(any ? mem : null),
                  cpuRaw: any ? cpu : -1,
                  memoryRaw: any ? mem : -1,
                }
              })
              .sort((a, b) => b[sortBy === 'cpu' ? 'cpuRaw' : 'memoryRaw'] - a[sortBy === 'cpu' ? 'cpuRaw' : 'memoryRaw'])
            const total = rows.length
            const shown = rows.slice(0, MAX_ITEMS).map(({ cpuRaw: _c, memoryRaw: _m, ...r }) => r)
            out.pods = { total, returned: shown.length, sortBy, items: shown }
          }
          return out
        })
        return result(data)
      },
    },

    // 巡检报告读取（只读）：规则扫描结果对 LLM 可见是「巡检→问 AI」交接不断联的关键——
    // 否则用户在巡检页点「问 AI」后，刚扫出的异常清单 AI 一个字都不知道，只能人肉复述
    disposition_set: {
      label: '标记处置',
      description:
        '给巡检异常项写处置状态（用户说「这条已知/帮我忽略/标记已处理/取消标记」时用它）。key 来自 inspect_report 条目的定位：`<段id>/<ns>/<kind>/<name>`（warning-events 段尾追加 `|<reason>`），state: acked=已处置 / ignored=已知不处理 / none=解除。这是值班决策记录，会进变更审计；拿不准用 acked 而非 ignored。',
      parameters: Type.Object({
        key: Type.String({ description: '处置键，如 suspended-crons/monitoring/CronJob/reindex' }),
        state: Type.Union([Type.Literal('acked'), Type.Literal('ignored'), Type.Literal('none')]),
        note: Type.Optional(Type.String({ description: '为什么忽略/怎么处理的备注（交接班看）' })),
      }),
      /** @param {string} _toolCallId @param {{ key: string; state: 'acked'|'ignored'|'none'; note?: string }} params @param {AbortSignal | undefined} _signal */
      async execute(_toolCallId, params, _signal) {
        const key = params.key.slice(0, 300)
        const note = params.note ? params.note.slice(0, 200) : undefined
        dispRecord({ cluster: clusterRef.value, key, state: params.state, ...(note ? { note } : {}) })
        // 与 UI 路径同汇审计流（这里不经 /disposition 路由，须自行兼报）：
        // actor=会话（审计页据此回链对话），kind/ns/name 从处置键解析（跳详情可用）
        const [, dNs, dKind, ...dRest] = key.split('/')
        auditRecord({
          source: 'ai',
          actor: sessionId,
          cluster: clusterRef.value,
          mode: permRef.mode,
          verb: params.state === 'none' ? 'unack' : params.state,
          target: key,
          kind: dKind || undefined,
          ns: dNs || undefined,
          // warning-events 键的 name 带 |reason 尾：留在 name 里跳详情必 404
          name: dRest.join('/').replace(/\|[\s\S]*$/, '') || undefined,
          ...(note ? { summary: note } : {}),
        })
        return result({ ok: true, key: params.key, state: params.state, hint: '巡检页下次扫描渲染即生效' })
      },
    },

    inspect_report: {
      label: '巡检报告',
      description:
        '读取本控制台「集群巡检」页最近一次规则扫描报告（全集群异常清单：未就绪工作负载/异常Pod/节点问题/Warning事件聚合/失败Job/运行中Job/暂停Cron，含各段截断后的条目）。条目上的 state 字段是用户的处置标记：acked=已处理、ignored=已知不处理——汇报清单时这类条目必须单列说明，不得当新异常播报；无 state 的才是待处理项。diff.added 是本次相对上一份报告新增的异常键（问「最近有什么新异常」直接用它）；用户问「集群整体有没有问题/巡检结果/最近有没有新异常」时优先用它（毫秒级返回，比逐个 k8s 现查快且口径与控制台页面一致），需要实时性或用结论指导修复时再对具体对象现查互证。无报告时提示用户去巡检页点一次「开始巡检」。',
      parameters: Type.Object({}),
      /** @param {string} _toolCallId @param {Record<string, never>} _params @param {AbortSignal | undefined} _signal */
      async execute(_toolCallId, _params, _signal) {
        const data = await safe(async () => {
          const items = listReports(clusterRef.value)
          const latest = items[0]
          if (!latest) return { generatedAt: null, note: '尚无巡检报告；请到 /inspect 页面点击「开始巡检」生成' }
          // 处置状态 join 进条目：AI 汇报清单时区分「用户已处置/忽略」与新异常
          const disp = new Map(listLatest(clusterRef.value).map((/** @type {any} */ d) => [d.key, d.state]))
          return {
            generatedAt: latest.generatedAt,
            // 与上一份报告的 diff：用户问「最近有什么新异常」时 added 就是答案（键格式同 disposition_set）
            diff: latest.diff ? { hasPrev: latest.diff.hasPrev, addedCount: (latest.diff.added ?? []).length, added: (latest.diff.added ?? []).slice(0, 20), resolvedCount: (latest.diff.resolved ?? []).length } : null,
            notes: latest.notes ?? [],
            sections: (latest.findings ?? []).map((/** @type {any} */ f) => ({
              id: f.id,
              count: (f.entries ?? []).length,
              items: (f.entries ?? []).slice(0, 20).map((/** @type {any} */ e) => {
                const state = disp.get(findingKey(f, e))
                return state ? { ...e, state } : e
              }),
            })),
            historyCount: items.length,
          }
        })
        return result(data)
      },
    },
  }
}
