"use client"

// block nav-main 的裁剪版：保留顶部核心入口区结构，数据换成 总览 + AI 助手（AI 助手置顶）。
import { LayoutDashboard, History, MessageSquare, Radar } from "lucide-react"
import { NavLink, useLocation, useParams } from "react-router-dom"
import { useT } from "@/i18n"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

// 激活态走 SidebarMenuButton isActive（data-active 变体）；函数 className 传 asChild 子元素会被 Slot 字符串化。
export function NavMain() {
  const { cluster } = useParams()
  const { pathname } = useLocation()
  const t = useT()

  return (
    <SidebarGroup>
      {/* 只加组名不折叠：day-2 入口还会增长（定时巡检/告警），预挂归属避免二次改导航；
          折叠会让高频的「AI 助手」多一次展开，得不偿失 */}
      <SidebarGroupLabel>{t('ui:navOps')}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === `/c/${cluster}`}>
              <NavLink to={`/c/${cluster}`}>
                <LayoutDashboard />
                <span>{t('ui:overview')}</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === `/c/${cluster}/ai`}>
              <NavLink to={`/c/${cluster}/ai`}>
                <MessageSquare />
                <span>{t('ui:aiAssistant')}</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* 变更审计紧跟 AI 入口：AI 写权限的责任闭环入口放最显眼处 */}
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === `/c/${cluster}/audit`}>
              <NavLink to={`/c/${cluster}/audit`}>
                <History />
                <span>{t('audit:nav')}</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {/* 交接页是巡检动线的延伸：身在 /handover/:id 时侧栏须保持「巡检」高亮（导航语境连续） */}
            <SidebarMenuButton asChild isActive={pathname === `/c/${cluster}/inspect` || pathname.startsWith(`/c/${cluster}/handover/`)}>
              <NavLink to={`/c/${cluster}/inspect`}>
                <Radar />
                <span>{t('inspect:nav')}</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
