import type { ReactNode } from "react"
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { useFlash } from "@/lib/useFlash"

export interface KpiCard {
  label: string
  value: string
  /** 副行说明（footer 大字行）；允许分段着色：语义色只落在异常 phase 上 */
  sub: ReactNode
  /** footer 第二行（更细的解释） */
  hint: string
  /** 角标：仅异常时出现的简短说明（如「2 未就绪」）；null = 不显示。健康状态已由大数字表达，不再重复 */
  delta?: { text: string } | null
  /** 异常着色目标：'value' = 大数字本身即状态（如 0/1）；副行状态改为 sub 内嵌分段着色 */
  warn?: 'value'
  loading?: boolean
}

function DeltaBadge({ delta, warn }: { delta: NonNullable<KpiCard['delta']>; warn?: boolean }) {
  return (
    <span
      className={cn(
        "text-[13px] font-medium tabular-nums",
        // 异常角标与表格异常角标同配方(bg-caution/15 药丸):此前 KPI 裸文本、
        // 表头描边 chip、表格药丸三种制式并存,同角色徽章只剩一种 amber 徽章
        warn
          ? "rounded bg-caution/15 px-1 text-caution-on-primary"
          : "text-muted-foreground"
      )}
    >
      {delta.text}
    </span>
  )
}

/** 30s 轮询值真实变化时 flash 一下:详情页/列表页数值早就接了 useFlash,
 *  KPI 卡曾是本页唯一的沉默硬切(9/10→8/10 无感知) */
function KpiValue({ value }: { value: string }) {
  const { flash, onEnd } = useFlash(value)
  return <span data-flash={flash || undefined} onAnimationEnd={onEnd}>{value}</span>
}

/** 块状 KPI 行：拷贝自 shadcn block dashboard-01 的 section-cards（容器查询 1/2/4 列）。 */
export function SectionCards({ cards }: { cards: KpiCard[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label} className="@container/card">
          <CardHeader>
            <CardDescription>{c.label}</CardDescription>
            <CardTitle
              className={`text-2xl font-medium tabular-nums @[250px]/card:text-3xl ${
                c.warn === 'value' ? 'text-caution' : ''
              }`}
            >
              {c.loading ? '–' : <KpiValue value={c.value} />}
            </CardTitle>
            <CardAction>
              {c.delta && <DeltaBadge delta={c.delta} warn={c.warn === 'value'} />}
            </CardAction>
          </CardHeader>
          {/* mt-auto:四张同类卡的说明行钉到同一底缘(此前 2 行 hint 与 3 行 sub 的卡
              底部空白 37px vs 17px,同类内容不在一条线上) */}
          <CardFooter className="mt-auto flex-col items-start gap-1.5 text-sm">
            {/* 原 flex gap-2 + line-clamp-1 互相抵消(line-clamp 需 -webkit-box):
                长副行实际自然换行。Failed 44 是关键计数,clamp 会藏掉——保持自然折行 */}
            <div className="font-medium tabular-nums">
              {c.sub}
            </div>
            <div className="text-muted-foreground">{c.hint}</div>
          </CardFooter>
        </Card>
      ))}
    </div>
  )
}
