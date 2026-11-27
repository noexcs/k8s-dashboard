"use client"

// 块状交互面积图：拷贝自 shadcn block dashboard-01 的 chart-area-interactive
//（Card + 时间范围档位 + 双折线面积图 + ChartTooltip），数据换成集群 CPU/内存利用率。
// 数据源 = useMetricsHistory 的 15s 采样滚动窗口（页面打开期间积累，最长 30 分钟）。
import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Skeleton } from "@/components/ui/skeleton"
import type { MetricSample } from "@/features/dashboard/charts"
import { useT } from "@/i18n"

const fmtHM = (t: number) =>
  new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })

const RANGE_MINUTES: Record<string, number> = {
  "30m": 30,
  "15m": 15,
  "5m": 5,
}

interface SamplePoint {
  t: number
  cpu: number | null
  mem: number | null
}

export function ClusterTrendChart({
  samples,
  loading,
  error,
}: {
  samples: MetricSample[]
  loading: boolean
  /** metrics-server 缺失/查询失败：不能伪装成「采样中」（该文案谎称 15s 一次在采） */
  error?: string
}) {
  const isMobile = useIsMobile()
  const t = useT()
  const [timeRange, setTimeRange] = React.useState("30m")

  // 组件内定义：mem label 走 i18n，切语言后需随渲染更新
  const chartConfig = {
    cpu: {
      label: "CPU",
      // 负载序列用 ink 主线；positive 绿保留给「Running/健康」状态语义（同 PromTrend 口径）
      color: "var(--primary)",
    },
    mem: {
      label: t('ui:mem'),
      // 序列线走文本墨档(亮灰 #98a1b0 的柱填充档在白卡上撑不起线条对比,审计 med)
      color: "var(--muted-foreground)",
    },
  } satisfies ChartConfig

  React.useEffect(() => {
    if (isMobile) {
      setTimeRange("15m")
    }
  }, [isMobile])

  const data = React.useMemo<SamplePoint[]>(() => {
    // oxlint-disable-next-line react/purity -- 时间窗 cutoff：samples 本身是外部状态，渲染期取当前时刻是正确语义
    const cutoff = Date.now() - RANGE_MINUTES[timeRange] * 60_000
    return samples
      .filter((s) => s.t >= cutoff)
      .map((s) => ({ t: s.t, cpu: s.cpuPct, mem: s.memPct }))
  }, [samples, timeRange])

  // 时间比例轴(审计 med):类目轴等距布点把 30s 的窗口拉满「近 30 分钟」全宽,
  // 两端刻度同一分钟、采样空洞被等距压扁不可见。number/time 轴下空洞=真实水平空隙,
  // 断流(null 采样)也沿时间比例显形
  const tDomain = React.useMemo<[number, number]>(() => {
    // oxlint-disable-next-line react/purity -- 同上:右界=渲染时刻的窗口终点
    const right = Date.now()
    return [right - RANGE_MINUTES[timeRange] * 60_000, right]
  }, [timeRange, samples])
  // 分钟整点显式 ticks:number 轴默认 ticks 按数据生成,采样刚起步(1-2 点)时整条轴
  // 只剩 1 个刻度——轴刻度必须随窗口走,不随数据走
  const tTicks = React.useMemo(() => {
    const spanMin = (tDomain[1] - tDomain[0]) / 60_000
    const stepMs = (spanMin <= 6 ? 1 : spanMin <= 18 ? 3 : 5) * 60_000
    const out: number[] = []
    for (let t = Math.ceil(tDomain[0] / stepMs) * stepMs; t <= tDomain[1]; t += stepMs) out.push(t)
    return out
  }, [tDomain])

  // Y 轴整数阶梯:自适应 domain 曾给出 0/7/14/21/25(实拍),刻度不可口算、
  // 与同页柱图的整数阶(0/15/30/45/60)制式打架。上限对齐台阶,顶格线=domain 顶。
  const yScale = React.useMemo(() => {
    let m = 0
    for (const d of data) m = Math.max(m, d.cpu ?? 0, d.mem ?? 0)
    // 上界随数据自适应(5% 台阶、留 25% 余量、封顶 100%),尖峰出现时自动抬升
    let cap = m > 0 ? Math.min(100, Math.max(10, Math.ceil((m * 1.25) / 5) * 5)) : 100
    const step = cap <= 25 ? 5 : cap <= 50 ? 10 : 20
    if (cap % step !== 0) cap = Math.min(100, Math.ceil(cap / step) * step)
    return { cap, ticks: Array.from({ length: cap / step + 1 }, (_, i) => i * step) }
  }, [data])

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>{t('ui:clusterResourceTrend')}</CardTitle>
        <CardDescription>
          <span className="hidden @[540px]/card:block">
            {t('ui:chartDescFull')}
          </span>
          <span className="@[540px]/card:hidden">{t('ui:chartDescMobile')}</span>
        </CardDescription>
        {/* CardAction 是 grid 区非 flex:子元素默认竖排堆叠——前两轮只调图例 span 内部
            对齐没动容器,图例一直悬在档位组上方(用户实拍指出)。容器直接成行。 */}
        <CardAction className="flex flex-row flex-wrap items-center gap-x-3 gap-y-1">
          {/* 线型即编码(CPU 实线、内存虚线),同绘图区 */}
          <span className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="w-3.5 border-t-2 border-[var(--primary)]" />
              CPU
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="w-3.5 border-t-2 border-dashed border-[var(--chart-2)]" />
              {t('ui:mem')}
            </span>
          </span>
          {/* 阈值随 3/5 列布局重标:670px 卡装得下三键,沿用 shadcn 全宽卡时代的 767 会误判成窄卡 */}
          <ToggleGroup
            type="single"
            value={timeRange}
            onValueChange={setTimeRange}
            variant="outline"
            className="hidden *:data-[slot=toggle-group-item]:px-4! @[560px]/card:flex"
          >
            <ToggleGroupItem value="30m">{t('ui:range30m')}</ToggleGroupItem>
            <ToggleGroupItem value="15m">{t('ui:range15m')}</ToggleGroupItem>
            <ToggleGroupItem value="5m">{t('ui:range5m')}</ToggleGroupItem>
          </ToggleGroup>
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger
              className="flex w-40 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[560px]/card:hidden"
              size="sm"
              aria-label={t('ui:selectTimeRange')}
            >
              <SelectValue placeholder={t('ui:range30m')} />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              <SelectItem value="30m" className="rounded-lg">
                {t('ui:range30m')}
              </SelectItem>
              <SelectItem value="15m" className="rounded-lg">
                {t('ui:range15m')}
              </SelectItem>
              <SelectItem value="5m" className="rounded-lg">
                {t('ui:range5m')}
              </SelectItem>
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {/* 错误横幅不受 data.length 门控:出过一次图后 metrics-server 再挂,
            旧数据+静默轮询=把断流读成「一直健康」(审计 high)。空洞由 null 采样
            在折线上断开,横幅说明原因,两者同时在场 */}
        {error && (
          <div className="mx-4 mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-center text-[13px] text-destructive sm:mx-4">
            {error}
          </div>
        )}
        {loading || data.length < 2 ? (
          !error && (
            <div className="flex h-[250px] flex-col justify-end gap-2">
              <Skeleton className="h-[200px] w-full" />
              <div className="text-center text-[13px] text-muted-foreground">
                {t('ui:sampling')}
              </div>
            </div>
          )
        ) : (
          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-[300px] w-full"
          >
            <AreaChart data={data} margin={{ right: 26 }}>
              <CartesianGrid vertical={false} />
              {/* 两条独立利用率序列：不堆叠（相加无意义）；Y 域自适应下面积高度随比例伸缩、
                  低负载时会塌成灰条，故双序列都纯折线：CPU 实线为主，内存虚线（194 行） */}
              <YAxis
                // 0–100 钉死时,负载 <5% 的集群曲线全压底、图无信息;
                // 上界随数据自适应,刻度恒为整数阶梯(yScale)
                domain={[0, yScale.cap]}
                ticks={yScale.ticks}
                allowDecimals={false}
                width={44}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value) => `${value}%`}
                tick={{
                  fontSize: 11,
                  fill: "var(--muted-foreground)",
                  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
                }}
              />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={tDomain}
                ticks={tTicks}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                allowDecimals={false}
                tickFormatter={(value) => fmtHM(Number(value))}
                tick={{
                  fontSize: 11,
                  fill: "var(--muted-foreground)",
                  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
                }}
              />
              {/* legend 移入卡头 HTML(原 recharts Legend 悬在绘图区右上,右缘与
                  ToggleGroup 错开 ~20px、孤悬卡头与网格线空带,归属不明) */}
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => {
                      const d = new Date(Number(value))
                      return d.toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })
                    }}
                    indicator="dot"
                  />
                }
              />
              {/* 单色主题下靠线型区分:CPU 实线为主序列,内存虚线;高频数据不动画,
                  每 15s 新采样点不重放描线(PromTrend 已关,此处对齐) */}
              <Area
                dataKey="mem"
                name={t('ui:mem')}
                type="natural"
                fill="none"
                stroke="var(--color-mem)"
                strokeDasharray="5 4"
                isAnimationActive={false}
              />
              <Area
                dataKey="cpu"
                name="CPU"
                type="natural"
                fill="none"
                stroke="var(--color-cpu)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
