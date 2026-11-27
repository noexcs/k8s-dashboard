// 首页 /c/:cluster = 集群数据面板，布局即 shadcn block dashboard-01：
// SectionCards（KPI 行）+ 交互面积图（集群资源趋势）+ 工作负载表（ResourceDataTable，与资源列表页同一渲染路径）。
// 全部真实数据：react-query 30s 轮询；趋势图 = 15s 采样查询缓存积累 30 分钟滚动窗口。
import { useMemo, useState, type ReactNode } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { askAi } from '@/features/ai/askBus'
import { useQuery } from '@tanstack/react-query'
import { NavLink, useNavigate, useParams } from 'react-router-dom'
import { list, namespacesPath } from '@/api/client'
import { tf, useT } from '@/i18n'
import type { Deployment, K8sObject, Node, Pod } from '@/api/types'
import { age, shortTime } from '@/lib/format'
import { dispStale } from '@/lib/disp'
import { cn } from '@/lib/utils'
import { detailRoute, type Col } from '@/resources/registry'
import { ClusterTrendChart } from '@/components/dashboard/chart-area-interactive'
import { ResourceDataTable } from '@/components/ResourceDataTable'
import { WorkloadRowPods } from '@/features/resources/WorkloadRowPods'
import { Badge } from '@/components/ui/badge'
import { SectionCards, type KpiCard } from '@/components/dashboard/section-cards'
import { ChartCard, RestartBars, WorkloadReplicaBars, type MetricNode, useMetricsHistory } from './charts'
import { Q, usePromRange, usePrometheus } from '@/hooks/usePrometheus'
import { PromTrend } from '@/components/PromTrend'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

const POLL_MS = 30_000

interface Summary {
  nodes: Node[]
  nodesTotal: number
  nodesReady: number
  pods: Pod[]
  depReady: number
  depDesired: number
  namespaces: number
}

interface WorkloadKind {
  kind: string
  group: string // '' = core
  version: string
  resource: string
}

/** 工作负载对象（spec/status 段） */
interface WorkloadObj extends K8sObject {
  spec?: { replicas?: number; completions?: number }
  status?: {
    observedGeneration?: number
    readyReplicas?: number
    desiredNumberScheduled?: number
    numberReady?: number
    succeeded?: number
    active?: number
    failed?: number
    updatedReplicas?: number
    updatedNumberScheduled?: number
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[]
  }
}

/**
 * 异常根因（零请求）：list 返回的对象自带 status.conditions——
 * Progressing=False（滚动卡死）/ Failed / Available=False 的 message 就是 kubectl
 * describe 里那行根因。首页角标与 tooltip 直接展示，点开问 AI 时一并预填。
 */
function stuckCause(o: WorkloadObj): string | null {
  const cs = o.status?.conditions ?? []
  const bad =
    cs.find(c => c.type === 'Progressing' && c.status === 'False') ??
    cs.find(c => c.type === 'Failed' && c.status === 'True') ??
    cs.find(c => c.type === 'Available' && c.status === 'False')
  return bad?.message || bad?.reason || null
}

/**
 * ResourceDataTable 的行 = 原始 k8s 对象 + 就绪度派生字段。
 * 通用表格按 K8sObject 取数（name/ns/age 都在 metadata 里），跨 kind 的就绪算法
 * 差异只在取数处折算成 ready/readyOk 两个展示字段，列定义保持纯渲染。
 */
interface WorkloadRow extends WorkloadObj {
  /** 就绪度展示："2/3"（Job 为 succeeded/completions） */
  ready: string
  readyOk: boolean
  /** 数值就绪度（副本柱状图用；ready 是给表格看的字符串，柱状图要能算长度） */
  desiredN: number
  readyN: number
  /** Job 运行中（active>0 且未 Complete/Failed）：中性第三态，不置顶不判红 */
  jobRunning?: boolean
}

const WORKLOAD_KINDS: WorkloadKind[] = [
  { kind: 'Deployment', group: 'apps', version: 'v1', resource: 'deployments' },
  { kind: 'StatefulSet', group: 'apps', version: 'v1', resource: 'statefulsets' },
  { kind: 'DaemonSet', group: 'apps', version: 'v1', resource: 'daemonsets' },
  { kind: 'Job', group: 'batch', version: 'v1', resource: 'jobs' },
]

/** 首页行 → 巡检处置键候选（与后端 findingKey 同构）。Job 的红行既可能是失败段也可能是
 * 长时运行段，两键任一命中即算已认领；其余 kind 只走 unready-workloads。 */
function homeDispKeys(o: WorkloadRow): string[] {
  const ns = o.metadata.namespace ?? ''
  if (o.kind === 'Job') {
    const keys = [`running-jobs/${ns}/Job/${o.metadata.name}`, `failed-jobs/${ns}/Job/${o.metadata.name}`]
    // CronJob 派生 Job：服务端键已归一 owner/实例名，前端不同步则巡检认领过的键首页永不命中
    const owner = (o.metadata.ownerReferences ?? []).find(r => r.kind === 'CronJob')
    if (owner) {
      keys.push(`running-jobs/${ns}/Job/${owner.name}/${o.metadata.name}`, `failed-jobs/${ns}/Job/${owner.name}/${o.metadata.name}`)
    }
    return keys
  }
  return [`unready-workloads/${ns}/${o.kind}/${o.metadata.name}`]
}

/** 处置是否仍有效：「复发」判定与巡检页共用 lib/disp 单一函数（两页同键同结论） */
function dispStillValid(o: WorkloadRow, dispTs?: string): boolean {
  if (!dispTs) return true
  const conds = (o.status as { conditions?: { lastTransitionTime?: string }[] } | undefined)?.conditions ?? []
  const last = conds.map((c) => c.lastTransitionTime ?? '').sort().pop() ?? ''
  return !dispStale(dispTs, last)
}

/** 复发=处置过但认领已作废（处置后又转态）：旧结论失效的一刻恰恰最需要看到「当初为什么处置」 */
function recurredOf(o: WorkloadRow, disp: Map<string, { state: string; ts?: string; note?: string }>): { key: string; state: string; ts?: string; note?: string } | null {
  for (const k of homeDispKeys(o)) {
    const d = disp.get(k)
    if (d?.ts && !dispStillValid(o, d.ts)) return { key: k, ...d }
  }
  return null
}

const claimedOf = (o: WorkloadRow, disp: Map<string, { state: string; ts?: string }>): { state?: string; ts?: string } => {
  for (const k of homeDispKeys(o)) {
    const d = disp.get(k)
    if (d && dispStillValid(o, d.ts)) return d
  }
  return {}
}

/** 工作负载表列（混合 kind，不走注册表 colsFor）；label 为 i18n key，由表格内部翻译。
 * dispMap 注入处置态：异常行若已被认领/忽略，红色旁给灰徽章——值班一眼分得清「要管」和「已有人管」 */
/**
 * 发布在途派生态（与 ai-exec/lib/inspect.js rollingGrace 同判据同常量，改一处必改另一处）：
 * 持续信号=新版本就绪未达期望（updatedReplicas/updatedNumberScheduled 滞后；og 在控制器
 * 消费 spec 后秒级追平，不能作锚），og 滞后仅作补充窗口；真实卡死由 stuckCause
 * （Progressing=False 等红条件）优先接管为红色三角；停滞=在途且 Progressing 最后变化
 * 超 10 分钟（与巡检豁免同阈值，此前 10/15 分裂）。
 */
function rollingState(o: WorkloadRow): { rolling: boolean; stalled: boolean } {
  const off = { rolling: false, stalled: false }
  if (!['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(o.kind)) return off
  if (stuckCause(o)) return off
  const st = o.status ?? {}
  const isDS = o.kind === 'DaemonSet'
  const desired = isDS ? st.desiredNumberScheduled : o.spec?.replicas
  const updated = isDS ? st.updatedNumberScheduled : st.updatedReplicas
  const ogLag = o.metadata.generation != null && st.observedGeneration != null && st.observedGeneration < o.metadata.generation
  const inFlight = (desired != null && desired > 0 && (updated ?? 0) < desired) || ogLag
  if (!inFlight) return off
  const prog = (st.conditions ?? []).find(c => c.type === 'Progressing') as { lastUpdateTime?: string } | undefined
  if (!prog) {
    // STS 常态没有 Progressing 条件（实测 conditions=null）：OnDelete 策略下没人删 pod
    // 就永不收敛——「滚动中·非故障」的转圈会骗值班继续等，直接升级疑似停滞；
    // 其余无时间源场景维持 chip（无据升级会误伤健康滚动）
    const onDelete = o.kind === 'StatefulSet' && (o.spec as { updateStrategy?: { type?: string } } | undefined)?.updateStrategy?.type === 'OnDelete'
    return { rolling: true, stalled: onDelete }
  }
  const since = prog.lastUpdateTime ? Date.parse(prog.lastUpdateTime) : NaN
  return { rolling: true, stalled: Number.isFinite(since) && Date.now() - since > 10 * 60_000 }
}


function workloadCols(dispMap: Map<string, { state: string; ts?: string; note?: string }>, cluster: string, addedSet: Set<string>): Col<WorkloadRow>[] {
return [
  {
    key: 'kind',
    label: 'ui:colKind',
    width: '110px',
    value: o => o.kind,
    // kind 是低基数枚举：取值复选列表筛选，替代此前手写的 Tabs kind 切换
    filter: 'select',
    render: o => <Badge variant="outline" className="px-1.5 text-muted-foreground">{o.kind}</Badge>,
  },
  {
    key: 'name',
    label: 'res:colName',
    value: o => o.metadata.name,
    filter: 'text',
    render: o => (
      <>
        <span className="min-w-0 truncate font-mono font-medium">{o.metadata.name}</span>
        {(() => {
          const rec = recurredOf(o, dispMap)
          if (!rec || claimedOf(o, dispMap).state) return null
          // 两页同判据的「复发」：处置态 ∩ 最近报告 added ∩ 行仍异常 → caution；
          // 其余（已修好转态/不在榜上）只降级为灰字「认领已过期」，绿行/榜外行不配警示色
          const trueRecur = !o.readyOk && homeDispKeys(o).some(k => addedSet.has(k))
          return (
          <span onClick={(e) => { e.stopPropagation(); e.preventDefault() }} onKeyDown={(e) => { e.stopPropagation(); e.preventDefault() }}>
            <NavLink
              to={`/c/${encodeURIComponent(cluster)}/inspect?view=latest&focus=${encodeURIComponent(rec.key)}`}
              className={trueRecur ? 'ml-1.5 shrink-0 rounded bg-caution/15 px-1 text-[11px] text-caution-on-primary hover:underline' : 'ml-1.5 shrink-0 rounded bg-muted px-1 text-[11px] text-ink-on-muted hover:underline'}
              title={`${tf(trueRecur ? 'inspect:recurring' : 'sys:claimExpired')}${rec.note ? ` · ${rec.note}` : ''} @ ${shortTime(rec.ts)}`}
            >
              {tf(trueRecur ? 'inspect:recurring' : 'sys:claimExpired')}
            </NavLink>
          </span>
          )
        })()}
      </>
    ),
  },
  {
    key: 'ns',
    label: 'res:colNs',
    width: '120px',
    value: o => o.metadata.namespace,
    filter: 'select',
    render: o => <span className="text-muted-foreground">{o.metadata.namespace}</span>,
  },
  {
    key: 'ready',
    label: 'res:colReady',
    width: '70px',
    align: 'right',
    render: o =>
      o.jobRunning ? (
        <span className="inline-flex items-center justify-end gap-1 text-muted-foreground">
          {o.ready}
          <span className="rounded border border-border px-1 text-[11px] text-muted-foreground">{tf('sys:jobRunning')}</span>
        </span>
      ) : o.readyOk ? (
        <span className="text-positive">
          {o.ready}
          {o.kind === 'Job' && (o.status?.failed ?? 0) > 0 && (
            // 重试后成功≠干净：崩溃史是内存/超时配额不足的前兆，绿也要说得完整
            <span className="text-muted-foreground" title={`${o.status?.failed} 次失败后成功`}> ·f{o.status?.failed}</span>
          )}
        </span>
      ) : (
        // 异常行角标 = status.conditions 里的真实根因（悬停看全文）：2/3 不再需要点进详情猜
        <span className="inline-flex items-center justify-end gap-1 text-caution" title={stuckCause(o) ?? undefined}>
          {o.ready}
          {rollingState(o).rolling ? (
            rollingState(o).stalled ? (
              // 滞后 >10min：控制器不消费 spec 时「滚动中」会永远挂着，时效升级为疑似停滞
              <span className="rounded bg-caution/15 px-1 text-[11px] text-caution-on-primary" title={tf('sys:stalledRolling')}>{tf('sys:stalledRolling')}</span>
            ) : (
              // 过渡态给动态身份（旋转环）：与相邻两枚浅灰药丸（运行中/已认领）拉开语义层
              <span className="inline-flex items-center gap-1 text-[11px] text-primary" title={tf('sys:rollingOutHint')}>
                <Loader2 className="size-3 animate-spin" />
                {tf('sys:rollingOut')}
              </span>
            )
          ) : (
            <TriangleAlert className="size-3 shrink-0" />
          )}
          {claimedOf(o, dispMap).state && (
            <span className="rounded bg-muted px-1 text-[11px] text-ink-on-muted" title={`${claimedOf(o, dispMap).state === 'acked' ? tf('inspect:acked') : tf('inspect:ignored')} @ ${claimedOf(o, dispMap).ts ? shortTime(claimedOf(o, dispMap).ts!) : ''}`}>
              {claimedOf(o, dispMap).state === 'acked' ? tf('inspect:acked') : tf('inspect:ignored')}
            </span>
          )}
        </span>
      ),
  },
  {
    key: 'age',
    label: 'res:colAge',
    width: '70px',
    align: 'right',
    // 排序键用原始时间戳（ISO 字典序 == 时间序），展示才折算成 "3d 4h"
    value: o => o.metadata.creationTimestamp,
    render: o => <span className="text-xs text-muted-foreground">{age(o.metadata.creationTimestamp)}</span>,
  },
  {
    key: 'rowpods',
    label: 'sys:colPods',
    width: '44px',
    align: 'right',
    // 高频问题「2/3 是哪个 pod 卡住」就地回答：此前必须进详情页
    render: o => <WorkloadRowPods cluster={cluster} obj={o} />,
  },
]
}

export function DashboardPage() {
  const t = useT()
  const navigate = useNavigate()
  const { cluster } = useParams()
  const c = cluster!

  const summary = useQuery({
    queryKey: ['dashboard', c, 'summary'],
    queryFn: async (): Promise<Summary> => {
      const [nodes, pods, deps, nss] = await Promise.all([
        list<Node>(c, '/api/v1/nodes'),
        list<Pod>(c, '/api/v1/pods'),
        list<Deployment>(c, '/apis/apps/v1/deployments'),
        list<K8sObject>(c, namespacesPath),
      ])
      return {
        nodes: nodes.items,
        nodesTotal: nodes.items.length,
        nodesReady: nodes.items.filter(n =>
          n.status?.conditions?.some(x => x.type === 'Ready' && x.status === 'True'),
        ).length,
        pods: pods.items,
        depReady: deps.items.reduce((s, d) => s + (d.status?.readyReplicas ?? 0), 0),
        depDesired: deps.items.reduce((s, d) => s + (d.spec?.replicas ?? 0), 0),
        namespaces: nss.items.length,
      }
    },
    refetchInterval: POLL_MS,
  })

  const metrics = useQuery({
    queryKey: ['dashboard', c, 'metrics'],
    // 本集群 metricsserver 只暴露 v1beta1（k3s）；v1 优先，失败回退
    queryFn: async () => {
      try {
        return await list<MetricNode>(c, '/apis/metrics.k8s.io/v1/nodes')
      } catch {
        return list<MetricNode>(c, '/apis/metrics.k8s.io/v1beta1/nodes')
      }
    },
    refetchInterval: POLL_MS,
  })

  // 工作负载表数据：4 个 kind 全部命名空间
  const workloads = useQuery({
    queryKey: ['dashboard', c, 'workloads'],
    queryFn: async (): Promise<{ rows: WorkloadRow[]; failed: string[] }> => {
      const results = await Promise.allSettled(
        WORKLOAD_KINDS.map(wk =>
          list<WorkloadObj>(c, `/${wk.group ? `apis/${wk.group}` : 'api'}/${wk.version}/${wk.resource}`),
        ),
      )
      const failed: string[] = []
      const rows: WorkloadRow[] = []
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') {
          // 失败的 kind 必须上报：RBAC 拿不到 DaemonSet 时表格悄悄少一类是误导
          failed.push(WORKLOAD_KINDS[i].kind)
          return
        }
        const wk = WORKLOAD_KINDS[i]
        for (const o of r.value.items) {
          const spec = o.spec ?? {}
          const status = o.status ?? {}
          // 就绪度算法按 kind 不同（Job 看 succeeded/completions，DaemonSet 看 status 计数），
          // 在这里一次折算成展示值，列定义只负责上色渲染
          let ready: string
          let readyOk: boolean
          let jobRunning = false
          let desiredN = 0
          let readyN = 0
          if (wk.kind === 'Job') {
            const desired = spec.completions ?? 1
            const done = status.succeeded ?? 0
            desiredN = desired
            readyN = done
            const conds = (status.conditions ?? []) as { type?: string; status?: string }[]
            const complete = conds.some(c => c.type === 'Complete' && c.status === 'True')
            const failedC = conds.some(c => c.type === 'Failed' && c.status === 'True')
            // Job 三态：Failed 条件才是红；active>0 未完成是中性「运行中」（长时运行/高频
            // CronJob 派生 Job 此前一律判红，首页红信号被排程流量永久稀释）；Complete 绿。
            // 没跑起来（无 active 无条件）仍红——多半是没调度/镜像问题，那才是要管的
            jobRunning = !complete && !failedC && (status.active ?? 0) > 0
            ready = complete ? `${desired}/${desired}` : `${done}/${desired}`
            readyOk = complete || jobRunning
          } else if (wk.kind === 'DaemonSet') {
            const desired = status.desiredNumberScheduled ?? 0
            const rdy = status.numberReady ?? 0
            desiredN = desired
            readyN = rdy
            ready = `${rdy}/${desired}`
            readyOk = rdy >= desired
          } else {
            const desired = spec.replicas ?? 0
            const rdy = status.readyReplicas ?? 0
            desiredN = desired
            readyN = rdy
            ready = `${rdy}/${desired}`
            readyOk = rdy >= desired
          }
          rows.push({
            // 行对象就是 k8s 对象（ResourceDataTable 的 T extends K8sObject 约束）；
            // kind/apiVersion 用请求参数回填，不赌列表项一定带类型字段
            ...o,
            apiVersion: wk.group ? `${wk.group}/${wk.version}` : wk.version,
            kind: wk.kind,
            ready,
            readyOk,
            desiredN,
            readyN,
            jobRunning,
          })
        }
      })
      return {
        rows: rows.sort((a, b) => {
          // 异常行（副本不就绪/Job 未完成）永远置顶：概览页的本职是「找到红色的东西」，
          // 500 个正常负载不能让异常埋到第 7 页
          if (a.readyOk !== b.readyOk) return a.readyOk ? 1 : -1
          const an = a.metadata.namespace ?? 'default'
          const bn = b.metadata.namespace ?? 'default'
          return an === bn ? a.metadata.name.localeCompare(b.metadata.name) : an.localeCompare(bn)
        }),
        failed,
      }
    },
    refetchInterval: POLL_MS,
  })

  const s = summary.data
  // 处置状态 join：巡检页标记过的异常在首页不再假装「没人管」
  const dispQ = useQuery({
    queryKey: ['dispositions', cluster],
    queryFn: () => fetch(`/ai/disposition?cluster=${encodeURIComponent(cluster ?? '')}`).then((r) => r.json() as Promise<{ items: { key: string; state: string; ts?: string; note?: string }[] }>),
    retry: 0,
    staleTime: 15_000,
  })
  const dispMap = useMemo(() => new Map((dispQ.data?.items ?? []).map((d) => [d.key, d])), [dispQ.data])
  // 上次巡检新增异常：diff 已随报告落盘，读最新一份即可——首页也能回答「断线/下班期间新出了什么」
  const reportsQ = useQuery({
    queryKey: ['inspect-reports', cluster],
    queryFn: () => fetch(`/ai/reports?cluster=${encodeURIComponent(cluster ?? '')}`).then((r) => r.json() as Promise<{ items: { generatedAt: string; diff?: { hasPrev: boolean; added?: unknown[] } }[]; inspectIntervalMin?: number; nextScanAt?: number | null }>),
    retry: 0,
    // 后台定时扫描的可见成果必须随扫描节奏刷新；全局关掉了 focus 重取，值班常开一个标签页一整班
    refetchInterval: 60_000,
  })
  // 复发角标与巡检页同判据：巡检页的「复发」= 处置态 ∩ diff.added；只看时间转态会把
  // 「处置后被外部修好、至今全绿」的健康行常年挂 caution（绿行不配警示色）
  const addedSet = useMemo(() => new Set(((reportsQ.data?.items?.[0]?.diff?.added ?? []) as unknown[]).map(String)), [reportsQ.data])
  const newSinceInspect = useMemo(() => {
    const withDiff = (reportsQ.data?.items ?? []).find((r) => r.diff?.hasPrev)
    return withDiff?.diff?.added?.length ?? 0
  }, [reportsQ.data])
  const workloadColsMemo = useMemo(() => workloadCols(dispMap, cluster ?? '', addedSet), [dispMap, cluster, addedSet])
  // 「仅看异常」：异常置顶解决埋没，chip 解决刷屏（500 正常行里翻找 → 一键只剩红的）
  const [onlyBad, setOnlyBad] = useState(false)
  const badCount = useMemo(() => (workloads.data?.rows ?? []).filter(r => !r.readyOk).length, [workloads.data])
  // chip 语义升级为值班口径：红色是事实，「未认领」才是待办
  const unackCount = useMemo(() => (workloads.data?.rows ?? []).filter(r => !r.readyOk && !claimedOf(r, dispMap).state).length, [workloads.data, dispMap])
  const workloadRows = useMemo(() => {
    const rows = workloads.data?.rows ?? []
    return onlyBad ? rows.filter((r) => !r.readyOk && !claimedOf(r, dispMap).state) : rows
  }, [onlyBad, workloads.data, dispMap])
  const phaseCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const p of s?.pods ?? []) m[p.status.phase] = (m[p.status.phase] ?? 0) + 1
    return m
  }, [s?.pods])
  // 副本规模与缺口 top8（替代已删的承诺水位卡）：值班真正关注的是「谁体量大、谁还差几副本」,
  // 数据源与工作负载表同一 rows——图与表对同屏数字必须同源,不得两个口径
  const replicaBars = useMemo(() => {
    const top = (workloads.data?.rows ?? [])
      .filter(r => r.desiredN > 0)
      .sort((a, b) => b.desiredN - a.desiredN || a.metadata.name.localeCompare(b.metadata.name))
      .slice(0, 8)
    const nameCount = new Map<string, number>()
    for (const r of top) nameCount.set(r.metadata.name, (nameCount.get(r.metadata.name) ?? 0) + 1)
    return top.map(r => ({
      label: (nameCount.get(r.metadata.name) ?? 0) > 1 ? `${r.metadata.name}.${r.metadata.namespace ?? '-'}` : r.metadata.name,
      kind: r.kind,
      namespace: r.metadata.namespace,
      readyN: r.readyN,
      unready: Math.max(0, r.desiredN - r.readyN),
      desired: r.desiredN,
    }))
  }, [workloads.data])
  // 重启 top8：pod→属主工作负载聚合（Deployment 经 ReplicaSet 名去版本后缀回填），
  // 回答值班第二问「谁在反复重启」；表格里重启数不可见，此图是它的唯一入口
  const restartBars = useMemo(() => {
    // 不就绪属主集合:重启柱染 amber 的依据,与表格红色行同一判据(readyOk)
    const badOwners = new Set((workloads.data?.rows ?? []).filter(r => !r.readyOk).map(r => `${r.metadata.namespace ?? ''}/${r.kind}/${r.metadata.name}`))
    const byOwner = new Map<string, { label: string; kind: string; namespace?: string; restarts: number; pods: number; bad: boolean }>()
    for (const p of s?.pods ?? []) {
      const ref = (p.metadata.ownerReferences ?? [])[0]
      if (!ref) continue
      const isRs = ref.kind === 'ReplicaSet'
      const label = isRs ? ref.name.replace(/-[a-z0-9]{4,10}$/, '') : ref.name
      const kind = isRs ? 'Deployment' : ref.kind
      const restarts = (p.status.containerStatuses ?? []).reduce((sum, cs) => sum + (cs.restartCount ?? 0), 0)
      if (restarts <= 0) continue
      const key = `${p.metadata.namespace ?? ''}/${kind}/${label}`
      const hit = byOwner.get(key)
      if (hit) {
        hit.restarts += restarts
        hit.pods += 1
      } else byOwner.set(key, { label, kind, namespace: p.metadata.namespace, restarts, pods: 1, bad: badOwners.has(key) })
    }
    return [...byOwner.values()]
      .sort((a, b) => b.restarts - a.restarts || a.label.localeCompare(b.label))
      .slice(0, 8)
  }, [s?.pods, workloads.data])
  // 命名空间副本分布：同 WorkloadReplicaBars 形态的第三次复用（ns 当 label，kind 仅 tooltip 用）
  const nsBars = useMemo(() => {
    const byNs = new Map<string, { readyN: number; unready: number; desired: number }>()
    for (const r of workloads.data?.rows ?? []) {
      if (r.desiredN <= 0) continue
      const ns = r.metadata.namespace ?? '-'
      const hit = byNs.get(ns) ?? { readyN: 0, unready: 0, desired: 0 }
      hit.readyN += r.readyN
      hit.unready += Math.max(0, r.desiredN - r.readyN)
      hit.desired += r.desiredN
      byNs.set(ns, hit)
    }
    return [...byNs.entries()]
      .sort((a, b) => b[1].desired - a[1].desired || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([ns, v]) => ({ label: ns, kind: 'Namespace', readyN: v.readyN, unready: v.unready, desired: v.desired }))
  }, [workloads.data])

  // 15s 采样滚动窗口（趋势图用；只读 react-query 缓存）
  const hist = useMetricsHistory(c, s, metrics.data, metrics.isError)
  const histLoading = summary.isLoading || metrics.isLoading

  const cards: KpiCard[] = [
    {
      label: t('sys:kpiNodes'),
      value: s ? `${s.nodesReady}/${s.nodesTotal}` : '–',
      sub: s && s.nodesReady === s.nodesTotal && s.nodesTotal > 0 ? t('sys:allNodesReady') : t('sys:nodeReadiness'),
      hint: t('sys:nodeHint'),
      delta:
        s && s.nodesReady < s.nodesTotal
          ? { text: tf('sys:notReady', { n: s.nodesTotal - s.nodesReady }) }
          : null,
      warn: s != null && s.nodesReady < s.nodesTotal ? 'value' : undefined,
      loading: !s && !summary.isError,
    },
    {
      label: t('sys:kpiPods'),
      value: s ? String(s.pods.length) : '–',
      // 语义色只落在异常 phase:整串 amber 会把 Running 11 / Succeeded 3 一起演成告警
      sub: (() => {
        if (!s) return t('sys:podTotal')
        const segs = ['Running', 'Pending', 'Succeeded', 'Failed', 'Unknown']
          .filter((ph) => (phaseCounts[ph] ?? 0) > 0)
          .map((ph) => (
            <span key={ph} className={cn('whitespace-nowrap', ph === 'Pending' || ph === 'Failed' || ph === 'Unknown' ? 'text-caution' : undefined)}>
              {ph} {phaseCounts[ph]}
            </span>
          ))
        if (!segs.length) return t('sys:podTotal')
        return segs.reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, ' · ', el] : [el]), [])
      })(),
      hint: t('sys:allNamespaces'),
      // 「Running N · Failed N」已在副行，角标不再重复；着色内嵌在分段里
      delta: null,
      loading: !s && !summary.isError,
    },
    {
      label: t('sys:kpiDeployments'),
      value: s ? `${s.depReady}/${s.depDesired}` : '–',
      sub: s && s.depReady === s.depDesired ? t('sys:allReplicasReady') : t('sys:replicaReadiness'),
      hint: t('sys:replicasRatio'),
      delta:
        s && s.depReady < s.depDesired
          ? { text: tf('sys:missingReplicas', { n: s.depDesired - s.depReady }) }
          : null,
      warn: s != null && s.depReady < s.depDesired ? 'value' : undefined,
      loading: !s && !summary.isError,
    },
    {
      label: t('sys:kpiNamespaces'),
      value: s ? String(s.namespaces) : '–',
      sub: t('sys:namespaceTotal'),
      hint: t('sys:allNamespaces'),
      delta: null,
      loading: !s && !summary.isError,
    },
  ]

  return (
    // pb:右下常驻 AI FAB(fixed bottom-4 size-12)会盖住末块内容(趋势图 X 轴尾刻度)
    <div className="flex flex-col gap-4 pb-16 lg:gap-6">
      {summary.isError && (
        // 概览失败此前表现为 KPI 卡永久骨架「–」，用户只会以为慢——错误必须可见
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive-on-primary">
          {tf('sys:loadFailed', { msg: summary.error instanceof Error ? summary.error.message : String(summary.error) })}
        </div>
      )}
      <SectionCards cards={cards} />
      {/* 巡检状态条按用户要求整段移除(含「上一次巡检/已开启/下一次约」心跳);
          巡检动态仍可见:表头「上次巡检 +N 新异常」chip(:714)与巡检页本身 */}
      <PromClusterTrend cluster={c} />
      {/* 图表层级:趋势为主图占 3 列,副本柱状图为次、更小且不同形态(横条排行),并排不抢戏 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <ClusterTrendChart
            samples={hist}
            loading={histLoading}
            error={metrics.isError ? t('sys:metricsFailed') : undefined}
          />
        </div>
        <div className="lg:col-span-2">
          <ChartCard title={tf('sys:barReplicasTitle')} sub={tf('sys:barReplicasSub', { n: Math.min(8, replicaBars.length) })} bodyClassName="flex-1 min-h-0">
            {workloads.isLoading ? (
              <Skeleton className="h-[300px]" />
            ) : replicaBars.length ? (
              <WorkloadReplicaBars items={replicaBars} fill />
            ) : (
              <div className="flex h-[300px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {tf('sys:barReplicasEmpty')}
              </div>
            )}
          </ChartCard>
        </div>
      </div>
      {/* 第二行图表:重启榜=谁在 CrashLoop(常态只有零星几根柱,占 2 列),ns 分布=体量在哪(柱多,占 3 列) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <ChartCard title={tf('sys:barRestartsTitle')} sub={tf('sys:barRestartsSub', { n: Math.min(8, restartBars.length) })}>
            {summary.isLoading ? (
              <Skeleton className="h-[250px]" />
            ) : restartBars.length ? (
              <RestartBars items={restartBars} />
            ) : (
              <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">
                {tf('sys:barRestartsEmpty')}
              </div>
            )}
          </ChartCard>
        </div>
        <div className="lg:col-span-3">
          <ChartCard title={tf('sys:barNsTitle')} sub={tf('sys:barNsSub', { n: Math.min(8, nsBars.length) })}>
            {workloads.isLoading ? (
              <Skeleton className="h-[250px]" />
            ) : nsBars.length ? (
              <WorkloadReplicaBars items={nsBars} />
            ) : (
              <div className="flex h-[250px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {tf('sys:barReplicasEmpty')}
              </div>
            )}
          </ChartCard>
        </div>
      </div>
      {/* 工作负载表：与资源列表页共用 ResourceDataTable（排序/列筛选/分页/行选择一体）。
          行点击进通用详情页；高频三件（是哪个 pod 卡住/聚合日志/重启）已在行内 Pods 弹层就地可做，
          副本调整·删除仍在详情页。 */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="text-base font-medium">{t('ui:workloads')}</div>
          {badCount > 0 && (
            <>
              <button
                onClick={() => setOnlyBad(v => !v)}
                aria-pressed={onlyBad}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-xs tabular-nums transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden',
                  onlyBad
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent/50',
                )}
              >
                {/* 处置态读不到时不报计数：空 dispMap 会把全部已处置异常重算成「未认领」——
                    待办数虚高与 ai-exec 掉线是两种事，得各说各的 */}
                {dispQ.isPending
                  ? tf('sys:onlyBadLoading', { total: badCount })
                  : dispQ.isError
                    ? tf('sys:onlyBadUnreadable', { total: badCount })
                    : unackCount < badCount
                    ? tf('sys:onlyBadUnack', { n: unackCount, total: badCount })
                    : tf('sys:onlyBad', { n: badCount })}
              </button>
              {/* 待办可见更要可达：一键去巡检处置，不必手动重跑扫描再找条目 */}
              {/* 处置动线读档即可（复发名单基于最近一次扫描，30 分钟一跑）；强制重扫按钮在巡检页 */}
              <NavLink to={`/c/${encodeURIComponent(cluster ?? '')}/inspect?view=latest`} className="text-xs text-muted-foreground hover:underline">
                {t('sys:toInspect')}
              </NavLink>
            </>
          )}
          {newSinceInspect > 0 && (
            // 后台定时巡检的可见成果：上次扫描后新增 N 个异常（含首页不展示的段）；点开直接看那份报告
            <NavLink
              to={`/c/${encodeURIComponent(cluster ?? '')}/inspect?view=latest`}
              className="rounded-md border border-caution/40 px-2 py-0.5 text-xs tabular-nums text-caution-on-primary hover:bg-caution/10"
              title={reportsQ.data?.items?.[0] ? `${t('sys:inspectAt')} ${shortTime(reportsQ.data.items[0].generatedAt)}` : undefined}
            >
              {tf('sys:inspectNew', { n: newSinceInspect })}
            </NavLink>
          )}
        </div>
        {workloads.data && workloads.data.failed.length > 0 && (
          // 部分 kind 拉取失败（常见 RBAC 缺失）时明示缺了哪几类，不静默少数据；
          // 全部失败升级为 destructive（「少几类」与「全没」不能共用 amber 提示）
          <div
            className={cn(
              'rounded-md border px-3 py-2 text-[13px]',
              workloads.data.failed.length === 4
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-caution/40 text-caution',
            )}
          >
            {tf('sys:workloadsPartial', { kinds: workloads.data.failed.join(', ') })}
          </div>
        )}
        {workloads.isPending ? (
          <div className="space-y-2 rounded-lg border bg-card p-3">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : (
        <ResourceDataTable
          columns={workloadColsMemo}
          rows={workloadRows}
          askRow={o =>
            askAi(
              tf('sys:askStuck', {
                kind: o.kind,
                ns: o.metadata.namespace ?? '-',
                name: o.metadata.name,
                cause: stuckCause(o) ?? t('sys:causeUnknown'),
              }),
            )
          }
          rowKey={o => `${o.kind}/${o.metadata.namespace ?? 'default'}/${o.metadata.name}`}
          // 键盘路径不能只靠 onRowClick(鼠标独占):名称格真链接由 nameHref 开关承担,
          // 列表页同款——本页此前没传,行导航 Cmd/中键开新页与 Enter 全不可用
          nameHref={o =>
            detailRoute(
              { kind: o.kind, scope: 'namespaced' },
              c,
              o.metadata.namespace ?? 'default',
              o.metadata.name,
            )
          }
          onRowClick={o =>
            navigate(
              detailRoute(
                { kind: o.kind, scope: 'namespaced' },
                c,
                o.metadata.namespace ?? 'default',
                o.metadata.name,
              ),
            )
          }
        />
        )}
      </section>
    </div>
  )
}

const RANGE_LABELS: Record<number, string> = { 3600: 'sys:promRange1h', 86_400: 'sys:promRange24h', 604_800: 'sys:promRange7d' }

/** Prometheus 真实历史（档位 1h/24h/7d，集群 CPU 总核数 / 内存总和工作集）；未配置/不可达整卡隐藏 */
function PromClusterTrend({ cluster }: { cluster: string }) {
  const t = useT()
  const { cfg, reachable } = usePrometheus(cluster)
  // 档位透传给现成 query_range：容量/增长的问法从来不是「过去一小时」，此前全产品视野钉死 1h
  const [rangeSec, setRangeSec] = useState(3600)
  const cpu = usePromRange(cluster, reachable ? cfg : null, reachable ? Q.clusterCpu : null, rangeSec)
  const mem = usePromRange(cluster, reachable ? cfg : null, reachable ? Q.clusterMem : null, rangeSec)
  if (!reachable) return null
  const cpuSeries = (cpu.data ?? []).map(s => ({ name: 'CPU', points: s.points }))
  const memSeries = (mem.data ?? []).map(s => ({ name: t('sys:mem'), points: s.points.map(p => ({ t: p.t, v: p.v / 1073741824 })) }))
  return (
    // 3:2 span 打破两列等宽模板感：CPU 为集群趋势主图，内存次之（数据逻辑不变）
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <ChartCard
        title={t('sys:promClusterCpu')}
        sub={t(RANGE_LABELS[rangeSec])}
        actions={(
          // 同款 ToggleGroup(描边 outline):此前手搓裸 button 零 transition、
          // 激活态还加 font-medium 把相邻档位挤动(布局抖),与兄弟趋势卡两套制式
          <ToggleGroup
            type="single"
            value={String(rangeSec)}
            onValueChange={v => v && setRangeSec(Number(v))}
            variant="outline"
            size="sm"
          >
            {([3600, 86_400, 604_800] as const).map(r => (
              <ToggleGroupItem key={r} value={String(r)} className="px-2.5 tabular-nums">
                {t(RANGE_LABELS[r])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        className="lg:col-span-3"
      >
        <PromTrend series={cpuSeries} unit="" valueFmt={v => `${v.toFixed(1)}c`} error={cpu.isError} />
      </ChartCard>
      <ChartCard title={t('sys:promClusterMem')} sub={t(RANGE_LABELS[rangeSec])} className="lg:col-span-2">
        <PromTrend series={memSeries} unit="" valueFmt={v => `${v.toFixed(1)}Gi`} error={mem.isError} />
      </ChartCard>
    </div>
  )
}
