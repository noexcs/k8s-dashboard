"use client"

// 壳层侧栏：拷贝自 shadcn block dashboard-01 的 app-sidebar（Sidebar inset 变体 + 分组结构），
// 导航数据换成真实资源注册表；footer 集群选择 + 设置纵向排列固定左下角（命名空间由 URL 决定，无全局切换器）。
import * as React from "react"
import { Boxes, Settings, type LucideIcon } from "lucide-react"
import { Link, NavLink, useLocation, useParams } from "react-router-dom"
import { useT } from "@/i18n"

import { ClusterSwitcher } from "@/components/ClusterSwitcher"
import { NavMain } from "@/components/dashboard/nav-main"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { useCrds } from "@/resources/crds"
import { useNavPrefs } from "@/hooks/useNavPrefs"
import {
  NAV_SECTIONS,
  kindIconFor,
  listRoute,
  sectionItems,
} from "@/resources/registry"

/**
 * 导航项：SidebarMenuButton(asChild) + NavLink。
 * 激活态由 SidebarMenuButton 的 isActive prop 驱动（data-active 变体上色）。
 * 注意：不能把函数形式的 className 传给 asChild 子元素——Radix Slot 合并 className 时
 * 会把函数 String() 后拼进 class 属性，样式失效且污染 class 列表。
 */
function NavItem({
  to,
  re,
  Icon,
  label,
}: {
  to: string
  /** 额外激活匹配（如 dedicated 资源的 ns 内详情路由） */
  re?: RegExp
  Icon?: LucideIcon
  label: string
}) {
  const t = useT()
  const { pathname } = useLocation()
  const active =
    pathname === to || pathname.startsWith(to + '/') || (re ? re.test(pathname) : false)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <NavLink to={to}>
          {Icon && <Icon />}
          <span>{t(label)}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/** 资源分组（静态注册表 + CRD 共用） */
function NavGroup({
  label,
  items,
}: {
  label: string
  items: { to: string; Icon?: LucideIcon; label: string }[]
}) {
  const t = useT()
  if (items.length === 0) return null
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t(label)}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map(it => (
            <NavItem key={it.label} {...it} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { cluster } = useParams()
  const c = cluster!
  const t = useT()
  const { defs: crds } = useCrds(c)
  const nav = useNavPrefs(c)

  // 分组渲染数据：section → items；'crd' 组排到最后（order 里如此存储）；隐藏条目按 kind 剔除
  interface NavRow {
    to: string
    re?: RegExp
    Icon?: LucideIcon
    label: string
    hidden: boolean
  }
  const groups: { key: string; label: string; items: NavRow[] }[] = nav.orderedSections.flatMap(
    (section): { key: string; label: string; items: NavRow[] }[] => {
      if (section === 'crd')
        return crds.length > 0
          ? [{ key: 'crd', label: 'ui:customResources', items: crds.map(def => ({ to: listRoute(def, c), Icon: kindIconFor(def), label: def.label, hidden: nav.hidden.has(def.kind) })) }]
          : []
      const items: NavRow[] = sectionItems(section).map(def => ({
        to: def.dedicated ? `/c/${c}/${def.dedicated}` : listRoute(def, c),
        // dedicated 资源的 ns 内列表/详情（/c/:c/ns/:ns/pods[:pod]）也高亮
        re: def.dedicated ? new RegExp(`^/c/${c}/ns/[^/]+/${def.dedicated}(/[^/]+)?$`) : undefined,
        Icon: kindIconFor(def),
        label: def.label,
        hidden: nav.hidden.has(def.kind),
      }))
      return [{ key: section, label: NAV_SECTIONS.find(s => s.section === section)!.label, items }]
    },
  )

  return (
    <Sidebar collapsible="offcanvas" variant="inset" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:p-1.5!"
            >
              <Link to={`/c/${c}`}>
                <Boxes className="size-5!" />
                <span className="text-base font-semibold">K8S Dashboard</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain />
        {groups.map(g => (
          <NavGroup key={g.key} label={g.label} items={g.items.filter(it => !it.hidden)} />
        ))}
      </SidebarContent>
      <SidebarFooter>
        {/* 左下角纵向：集群选择在上、设置在下（命名空间选择已删除，ns 由 URL 决定） */}
        <div className="flex flex-col gap-2 px-1">
          <ClusterSwitcher />
          <NavLink
            to={`/c/${c}/settings`}
            aria-label={t('ui:settings')}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            <Settings className="size-3.5" />
            {t('ui:settings')}
          </NavLink>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
