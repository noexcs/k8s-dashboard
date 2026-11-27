// Prometheus 区间趋势卡（recharts 折线，多序列自动上色）：Node/Pod 详情页与首页共用。
// 数据形状 = usePromRange 输出（{name, points:[{t,v}]}），按时间轴合并成 recharts 行。
import { useMemo } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { useT } from '@/i18n'
import type { RangePoint } from '@/hooks/usePrometheus'

const fmtHM = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

/** 折线配色：主线用 primary（ink 主线），其余走中性阶；语义色（--chart-1/3/4）留给阈值/状态，不参与循环 */
const SERIES_COLORS = ['var(--primary)', 'var(--chart-2)', 'var(--chart-5)']
const color = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length]

export function PromTrend({
  series,
  unit,
  height = 'h-48',
  yMax,
  valueFmt,
  error,
}: {
  series: { name: string; points: RangePoint[] }[]
  unit: string
  height?: string
  /** 百分比图固定 0-100；网络等自动域 */
  yMax?: number
  valueFmt?: (v: number) => string
  /** 查询失败：与「区间内无数据」分岔，错误要指认问题 */
  error?: boolean
}) {
  const t = useT()
  const { rows, keys } = useMemo(() => {
    const keys = series.map((s, i) => s.name || `s${i}`)
    const byT = new Map<number, Record<string, number | string>>()
    for (const s of series) {
      for (const p of s.points) {
        const row = byT.get(p.t) ?? { time: fmtHM(p.t) }
        row[s.name] = Math.round(p.v * 100) / 100
        byT.set(p.t, row)
      }
    }
    const rows = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r)
    return { rows, keys }
  }, [series])

  if (error) {
    return <div className={`flex ${height} w-full items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 px-4 text-center text-[13px] text-destructive`}>{t('sys:promFailed')}</div>
  }
  if (rows.length === 0 || keys.length === 0) {
    return <div className={`flex ${height} w-full items-center justify-center text-[13px] text-muted-foreground`}>{t('sys:promNoData')}</div>
  }

  const config = Object.fromEntries(keys.map((k, i) => [k, { label: k, color: color(i) }]))

  return (
    <ChartContainer config={config} className={`${height} w-full`}>
      <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-[var(--border)]" />
        <XAxis dataKey="time" tickLine={false} axisLine={false} tickMargin={8} minTickGap={40} className="text-xs" />
        <YAxis
          domain={yMax ? [0, yMax] : ['auto', 'auto']}
          width={40}
          tickLine={false}
          axisLine={false}
          tickFormatter={v => (valueFmt ? valueFmt(Number(v)) : `${v}${unit}`)}
          className="text-xs"
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name) => [valueFmt ? valueFmt(Number(value ?? 0)) : `${value ?? 0}${unit}`, name]}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {keys.map((k, i) => (
          <Line key={k} dataKey={k} stroke={color(i)} strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} />
        ))}
      </LineChart>
    </ChartContainer>
  )
}
