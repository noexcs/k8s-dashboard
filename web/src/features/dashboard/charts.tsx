// 首页图表的共享数据层：滚动采样 hook + 卡片外壳。
// 历史版本里的六个 recharts 死组件（集群趋势/节点折线/相态饼/命名空间条形/节点雷达/径向）
// 已删除——首页大图由 components/dashboard/chart-area-interactive 承担，本文件只留它和
// DashboardPage 实际 import 的部分。
// k8s 无指标历史（metrics-server 只有当前值）→ 时序图用「页面打开期间每 15s 采样」的滚动窗口，
// 数据只从 react-query 缓存读（不额外发请求），页面保持打开即积累趋势。
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts'
import type { K8sObject, Node, Pod } from '@/api/types'
import { parseQty } from '@/lib/format'
import { tf, useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'

export interface MetricNode extends K8sObject {
  usage?: Record<string, string>
  capacity?: Record<string, string>
}

interface MetricList {
  items: MetricNode[]
}

const round1 = (n: number) => Math.round(n * 10) / 10

// ---------- 滚动采样 ----------

interface NodeSample {
  name: string
  cpuPct: number | null
  memPct: number | null
}

export interface MetricSample {
  t: number
  cpuPct: number | null
  memPct: number | null
  nodes: NodeSample[]
}

const SAMPLE_MS = 15_000
const MAX_SAMPLES = 120 // 30 分钟窗口

/** 从 dashboard 查询缓存采样集群/节点利用率(15s 间隔,只读缓存不发请求);
 *  metricsError=true 时推 null 空样——react-query 出错后仍保留旧 data,照常采样会把
 *  metrics-server 中途挂掉伪造成「曲线平稳」(七轮审计 high):断流必须在图上
 *  断成水平空洞(Area 默认 connectNulls=false),可被值班看见。 */
export function useMetricsHistory(c: string, summary: Summary | undefined, metrics: MetricList | undefined, metricsError = false): MetricSample[] {
  const qc = useQueryClient()
  const [samples, setSamples] = useState<MetricSample[]>([])
  // 30s 轮询会更新 props;interval 闭包必须读最新值(用 ref,避免 effect 依赖 props 反复重建)
  const latest = useRef({ summary, metrics, metricsError })
  latest.current = { summary, metrics, metricsError }
  // t=0 的首拍落在 metrics 到达前被作废:实际出图被推迟到 30s,与「15s 一次」文案不符。
  // 数据齐了补拍一次,首点=打开即有,第二点 +15s
  const pushRef = useRef<() => void>(() => {})
  const ready = !!summary && !!metrics
  useEffect(() => {
    if (ready) pushRef.current()
    // 布尔依赖=false→true 只触发一次;后续采样归 15s interval
  }, [ready])

  useEffect(() => {
    const push = () => {
      if (latest.current.metricsError) {
        // 错误期只盖时间戳不取陈旧缓存:曲线断点=断流的诚实形状
        setSamples(prev => [
          ...prev.slice(-(MAX_SAMPLES - 1)),
          { t: Date.now(), cpuPct: null, memPct: null, nodes: [] },
        ])
        return
      }
      const s = latest.current.summary ?? qc.getQueryData<Summary>(['dashboard', c, 'summary'])
      const m = latest.current.metrics ?? qc.getQueryData<MetricList>(['dashboard', c, 'metrics'])
      if (!s || !m) return
      const capBy = new Map(s.nodes.map(n => [n.metadata.name, n]))
      let uCpu = 0, capCpu = 0, uMem = 0, capMem = 0
      const nodes: NodeSample[] = []
      for (const met of m.items) {
        const n = capBy.get(met.metadata.name)
        const uC = parseQty(met.usage?.cpu)
        const cC = parseQty(n?.status?.capacity?.cpu)
        const uM = parseQty(met.usage?.memory)
        const cM = parseQty(n?.status?.capacity?.memory)
        const cpuPct = uC != null && cC ? Math.min(100, (uC / cC) * 100) : null
        const memPct = uM != null && cM ? Math.min(100, (uM / cM) * 100) : null
        if (uC != null && cC) { uCpu += uC; capCpu += cC }
        if (uM != null && cM) { uMem += uM; capMem += cM }
        nodes.push({ name: met.metadata.name, cpuPct, memPct })
      }
      setSamples(prev => [
        ...prev.slice(-(MAX_SAMPLES - 1)),
        {
          t: Date.now(),
          cpuPct: capCpu ? round1((uCpu / capCpu) * 100) : null,
          memPct: capMem ? round1((uMem / capMem) * 100) : null,
          nodes,
        },
      ])
    }
    pushRef.current = push
    push()
    const id = setInterval(push, SAMPLE_MS)
    return () => clearInterval(id)
    // summary/metrics 每次 30s 轮询都变 → 依赖它们会让 interval 重建；
    // 这里只按集群重置窗口，数据在 interval 闭包里通过 ref 最新化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, qc])

  return samples
}

// 供 hook 读取的 summary 形状（与 DashboardPage 同构，避免跨文件类型依赖环）
export interface Summary {
  nodes: Node[]
  pods: Pod[]
}

// ---------- 卡片外壳 ----------

export function ChartCard({
  title,
  sub,
  className,
  children,
  bodyClassName,
  actions,
}: {
  title: string
  sub?: string
  className?: string
  children: React.ReactNode
  bodyClassName?: string
  actions?: React.ReactNode
}) {
  return (
    // h-full:同行并排时跟主图卡等高(grid 拉伸外层 div,Card 不撑死内容高),
    // 配合调用方 bodyClassName flex-1 min-h-0 让图表吃满剩余高度,列底不空。
    <Card size="sm" className={cn('h-full', className)}>
      <CardHeader className="shrink-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>{title}</CardTitle>
            {sub && <CardDescription className="tabular-nums">{sub}</CardDescription>}
          </div>
          {actions}
        </div>
      </CardHeader>
      <CardContent className={bodyClassName}>{children}</CardContent>
    </Card>
  )
}

// ---------- 工作负载副本柱状图 ----------

export interface ReplicaBar {
  label: string
  kind: string
  namespace?: string
  readyN: number
  unready: number
  desired: number
}

/**
 * 柱宽随类别数自适应:1-2 根时 22px 孤柱飘空场(实拍)。卡宽固定(5 列布局),
 * 按带宽 ~40% 反推 ≈176/n,夹在 18-44;recharts v3 的 barCategoryGap/barPercentage
 * 与堆叠配合实测把柱削到 5px(三次实拍回归),不用比例属性,直接给 barSize。
 */
function adaptiveBarSize(n: number) {
  return Math.min(44, Math.max(18, Math.round(176 / Math.max(1, n))))
}

/**
 * 副本规模与缺口 top8 竖向柱状图：柱高=期望副本（规模），灰色=就绪段，amber=未就绪缺口。
 * 值班读法「谁体量大、谁卡住了」一眼分层；主图 300px 更高，次级图默认 250——图表层级靠高度也靠宽度。
 * fill=true 时随卡高铺满(与更高的主图并排同行,网格拉伸下不留底部空白)。
 * 堆叠而非分组：两个数本是同一 desired 的两个去向，分组反而要读两次。
 */
export function WorkloadReplicaBars({ items, fill = false }: { items: ReplicaBar[]; fill?: boolean }) {
  const t = useT()
  const cfg = {
    readyN: { label: t('res:readyLabel'), color: 'var(--chart-2)' },
    unready: { label: tf('sys:barUnready'), color: 'var(--chart-3)' },
  } satisfies ChartConfig
  const barSize = adaptiveBarSize(items.length)
  return (
    <ChartContainer config={cfg} className={fill ? 'h-[300px] w-full' : 'h-[250px] w-full'}>
      <BarChart data={items} margin={{ left: 0, right: 8 }}>
        <BarAxes labels={items.map((it) => it.label)} />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(_value, payload) => {
                const p = payload?.[0]?.payload as ReplicaBar | undefined
                return p ? `${p.kind} ${p.label}${p.namespace ? ` · ${p.namespace}` : ''} — ${p.readyN}/${p.desired}` : ''
              }}
            />
          }
        />
        <Bar dataKey="readyN" stackId="rep" fill="var(--color-readyN)" barSize={barSize} isAnimationActive={false} />
        {/* amber 段永远在柱顶:缺口悬在就绪段之上,视觉即「还差这么多」 */}
        <Bar dataKey="unready" stackId="rep" fill="var(--color-unready)" barSize={barSize} radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  )
}

// ---------- Pod 重启次数柱状图 ----------

export interface RestartBar {
  label: string
  kind: string
  namespace?: string
  restarts: number
  pods: number
  /** 属主当前不就绪(CrashLoop 中):柱染 amber,与工作负载表红色行互证 */
  bad?: boolean
}

const MONO_TICK = { fontSize: 11, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)' }

/**
 * 显示名压缩:盲目截 6-7 字符会把 demo-* 一水截成「demo-…」(实拍)——
 * 先剥数据集的公共前缀(demo-/kube-/istio- 这类部署惯例),截断只落在去歧义后的剩余上。
 * 全名永远在 tooltip;前缀 <3 字符不剥(剥「a-」这种没意义)。
 * 剥完撞名(demo-web 与另一 ns 的 web 都成「web」,实拍 x≈868/930)时,只把**撞名的那几根**
 * 换成尾部式「…web」(尾缀比头缀有区分度);全体退回长名会把 8 柱轴重新粘死(二次实拍回归)。
 */
function compactLabeler(labels: string[]) {
  const longs = labels.filter((l) => l.length > 8)
  let prefix = ''
  if (longs.length >= 2) {
    prefix = longs[0]
    for (const l of longs.slice(1)) {
      while (prefix && !l.startsWith(prefix)) prefix = prefix.slice(0, -1)
    }
    if (prefix.length < 3) prefix = ''
  }
  const cut = (s: string) => (s.length > 8 ? `${s.slice(0, 7)}…` : s)
  const stripped = new Map(labels.map((v) => [v, (prefix && v.startsWith(prefix) ? cut(v.slice(prefix.length)) : cut(v)) || v]))
  const outs = [...stripped.values()]
  const clashing = new Set(outs.filter((o, i) => outs.indexOf(o) !== i))
  const tail = (v: string) => (v.length > 5 ? `…${v.slice(-4)}` : v)
  const display = new Map(labels.map((v) => [v, clashing.has(stripped.get(v)!) ? tail(v) : stripped.get(v)!]))
  return (v: unknown) => display.get(String(v)) ?? cut(String(v))
}

/** 竖向柱状图共用坐标轴：X=类别名(公共前缀剥离+截断),Y=计数 */
function BarAxes({ labels }: { labels: string[] }) {
  const fmt = compactLabeler(labels)
  return (
    <>
      <CartesianGrid vertical={false} />
      <XAxis
        dataKey="label"
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        interval={0}
        tickFormatter={fmt}
        tick={MONO_TICK}
      />
      <YAxis type="number" allowDecimals={false} width={32} tickLine={false} axisLine={false} tickMargin={4} tick={MONO_TICK} />
    </>
  )
}

/**
 * 重启次数 top8：值班第二问「谁在反复重启」（第一问是趋势=集群整体健康）。
 * 单段中性灰柱——重启数本身是事实不是异常，amber 留给真正的就绪缺口；
 * 全 0 时父层显示「无重启记录」正向空态，不画空坐标系。
 */
export function RestartBars({ items }: { items: RestartBar[] }) {
  const cfg = {
    restarts: { label: tf('sys:barRestartSeg'), color: 'var(--chart-2)' },
    // 第二 config 键只为 legend/tooltip 配色服务;柱体逐 cell 着色(见 Bar fill)
    bad: { label: tf('sys:barUnready'), color: 'var(--chart-3)' },
  } satisfies ChartConfig
  return (
    <ChartContainer config={cfg} className="h-[250px] w-full">
      <BarChart data={items} margin={{ left: 0, right: 8 }}>
        <BarAxes labels={items.map((it) => it.label)} />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(_value, payload) => {
                const p = payload?.[0]?.payload as RestartBar | undefined
                return p ? `${p.kind} ${p.label}${p.namespace ? ` · ${p.namespace}` : ''} — ${tf('sys:barRestartTip', { n: p.restarts, pods: p.pods })}` : ''
              }}
            />
          }
        />
        <Bar dataKey="restarts" fill="var(--color-restarts)" barSize={adaptiveBarSize(items.length)} radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {items.map((it, i) => (
            <Cell key={i} fill={it.bad ? 'var(--chart-3)' : 'var(--chart-2)'} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
