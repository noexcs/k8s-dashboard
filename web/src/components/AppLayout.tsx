// 应用壳层：shadcn dashboard-01 block 结构（SidebarProvider + AppSidebar inset + SidebarInset + SiteHeader）。
// block 的 app/dashboard/page.tsx 原样结构：
//   <SidebarProvider style={{ --sidebar-width, --header-height }}>
//     <AppSidebar variant="inset" />
//     <SidebarInset>
//       <SiteHeader />
//       <div @container/main>…<Outlet /></div>
//     </SidebarInset>
//   </SidebarProvider>
import * as React from "react"
import { Outlet, useLocation, useParams } from "react-router-dom"
import { AiChatFab } from "@/features/ai/AiChatFab"
import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { SiteHeader } from "@/components/dashboard/site-header"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { t } from "@/i18n"

export function AppLayout() {
  const { cluster } = useParams()
  const location = useLocation()

  return (
    <>
      <Toaster position="top-center" toastOptions={{ duration: 4000 }} />
      <SidebarProvider
        style={
          {
            /* 侧栏 256（密度区 240–280 内），顶栏 56（56–64 内） */
            "--sidebar-width": "calc(var(--spacing) * 64)",
            "--header-height": "calc(var(--spacing) * 14)",
          } as React.CSSProperties
        }
        className="h-screen min-h-0 overflow-hidden"
      >
        {/* skip link：侧栏平铺 90+ 资源链接（含 CRD），键盘到主内容要 ~84 个 Tab——
            这是全站最短可达性补丁（focus 时才占位） */}
        <a
          href="#k8s-main"
          onClick={e => {
            // 原生锚点跳转会把 overflow-hidden 的 shell 容器 scrollTop 顶走 64px 且滚不回来
            // （顶栏整体出视口）：只移动焦点、不滚动
            e.preventDefault()
            document.getElementById('k8s-main')?.focus({ preventScroll: true })
          }}
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow-md focus:outline focus:outline-2 focus:outline-ring"
        >
          {t('sys:skipToMain')}
        </a>
        {cluster && <AppSidebar variant="inset" />}
        <SidebarInset className="min-h-0">
          {cluster && <SiteHeader />}
          <div className="flex min-h-0 flex-1 flex-col">
            <div id="k8s-main" tabIndex={-1} className="@container/main flex min-h-0 flex-1 flex-col gap-2 outline-none">
              {/* key=pathname：切换路由重置错误状态，单页崩溃不跨页残留 */}
              <ErrorBoundary key={location.pathname}>
                <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
                  <Outlet />
                </div>
              </ErrorBoundary>
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>

      {/* 全局 AI 悬浮聊天（任何页面常驻，状态跨路由保持）；/ai 整页与 FAB 双实例会各开各的会话，故在 /ai 页隐藏；
          精确匹配整页路由：endsWith 会误伤名为 ai 的资源页（ns ai / Deployment ai 是高频命名），
          那些页面的「问 AI」按钮会因 Fab 卸载而哑火； / 重定向期间无 cluster 不挂载 */}
      {cluster && location.pathname !== `/c/${encodeURIComponent(cluster)}/ai` && <AiChatFab cluster={cluster} />}
    </>
  )
}
