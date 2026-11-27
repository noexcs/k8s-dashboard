// 拷贝自 shadcn block dashboard-01 的 site-header（SidebarTrigger + Separator + 标题区），
// 标题位替换为面包屑，右侧放搜索与主题切换。
import { ChevronRight, Moon, Sun } from 'lucide-react'
import { Fragment } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { GlobalSearch } from '@/components/GlobalSearch'
import { NsQuotaChip } from '@/components/NsQuotaChip'
import {
  Breadcrumb as BreadcrumbNav,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { useTheme } from '@/hooks/useTheme'
import { RESOURCE_MAP } from '@/resources/registry'
import { useT } from '@/i18n'

/** 顶层页面段 → label（kind 段走 RESOURCE_MAP，ns/集群名保留原文；可含 i18n key） */
const PAGE_LABELS: Record<string, string> = {
  pods: 'Pods',
  events: 'Events',
  helm: 'Helm Releases',
  ai: 'ui:aiAssistant',
  settings: 'ui:settings',
  // 同级路由不裸英文（面包屑走 t()）
  inspect: 'inspect:nav',
  audit: 'audit:nav',
  handover: 'inspect:handoverTitle',
}

interface Crumb {
  label: string
  to: string | null // null = 当前页（不可点）
}

/** 面包屑：shadcn Breadcrumb + 中间路径可点击跳转（前缀路由规则推导目标）。 */
function Breadcrumb() {
  const { pathname } = useLocation()
  const t = useT()
  const segs = pathname.split('/').filter(Boolean)
  // segs = [c, cluster, ...rest]；旧 YAML 别名 /yaml/Ns/Kind/Name 归一成 /r/Kind/Ns/Name
  const cluster = segs[1] ?? ''
  let rest = segs.slice(2)
  if (rest[0] === 'yaml' && rest.length === 4) rest = ['r', rest[2], rest[1], rest[3]]

  const crumbs: Crumb[] = []
  if (rest[0] === 'handover' && rest.length === 2) {
    // /handover/:id：中段无列表路由（通用前缀规则会生成死链被 catch-all 弹走）；末级裸 id 换可读标签
    crumbs.push({ label: PAGE_LABELS.handover, to: `/c/${cluster}/inspect` }, { label: `#${rest[1]}`, to: null })
  } else if (rest[0] === 'helm' && rest.length === 3) {
    // /helm/:ns/:name 详情：ns 无独立列表路由 → 跳回 release 列表
    crumbs.push(
      { label: PAGE_LABELS.helm, to: `/c/${cluster}/helm` },
      { label: rest[1], to: `/c/${cluster}/helm` },
      { label: rest[2], to: null },
    )
  } else {
    for (let i = 0; i < rest.length; i++) {
      const v = rest[i]
      if (v === 'r' || v === 'ns') continue // 路由占位段
      // cluster scope 详情的 'cluster' 占位段（/r/Node/cluster/name）
      if (v === 'cluster' && RESOURCE_MAP[rest[i - 1]]?.scope === 'cluster') continue
      const label = PAGE_LABELS[v] ?? RESOURCE_MAP[v]?.label ?? v
      // 跳转目标 = 当前段的前缀路径；段是 ns 值（前段为 'ns' 占位）时
      // /c/C/ns/N 本身不是路由 → 追加下一段拼成「该 ns 下的列表页」
      const end = rest[i - 1] === 'ns' && i + 1 < rest.length ? i + 2 : i + 1
      crumbs.push({ label, to: `/c/${cluster}/${rest.slice(0, end).join('/')}` })
    }
    if (crumbs.length > 0) crumbs[crumbs.length - 1].to = null // 末级 = 当前页
  }
  // 首级集群名 → 总览（已是总览时不可点）
  const items: Crumb[] = [{ label: cluster, to: crumbs.length > 0 ? `/c/${cluster}` : null }, ...crumbs]

  return (
    <BreadcrumbNav className="min-w-0">
      {/* flex-nowrap：移动端单行不折行；非末级 crumb 及其分隔符在 <sm 隐藏（只留当前页名，集群名侧栏可见） */}
      <BreadcrumbList className="text-[13px] flex-nowrap overflow-hidden">
        {items.map((c, i) => {
          const isLast = i === items.length - 1
          return (
            <Fragment key={`${c.label}-${i}`}>
              {i > 0 && (
                <BreadcrumbSeparator className={cn('text-muted-foreground', 'hidden sm:flex')}>
                  <ChevronRight className="size-3" />
                </BreadcrumbSeparator>
              )}
              <BreadcrumbItem className={cn('min-w-0', !isLast && 'hidden sm:inline-flex')}>
                {c.to ? (
                  <BreadcrumbLink asChild>
                    <Link to={c.to} className="truncate hover:underline" title={t(c.label)}>
                      {t(c.label)}
                    </Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="truncate font-medium">{t(c.label)}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </BreadcrumbNav>
  )
}

function ThemeToggle() {
  const { resolved, setTheme } = useTheme()
  const t = useT()
  return (
    <button
      type="button"
      onClick={() => {
        const next = resolved === 'dark' ? 'light' : 'dark'
        // 主题整页淡切；不支持 VT 的浏览器走 ?.() 短路直接 setTheme（自然硬切）
        document.startViewTransition?.(() => setTheme(next)) ?? setTheme(next)
      }}
      title={resolved === 'dark' ? t('ui:switchToLight') : t('ui:switchToDark')}
      aria-label={t('ui:toggleTheme')}
      className="flex size-8 max-md:size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  )
}

export function SiteHeader() {
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width] group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1 max-md:size-11" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        <div className="min-w-0 flex-1">
          <Breadcrumb />
        </div>
        <div className="flex items-center gap-2">
          {/* 命名空间配额芯片：自身解析路由，无具体 ns 时渲染 null */}
          <NsQuotaChip />
          <GlobalSearch />
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
