import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from '@/components/AppLayout'
import FirstRun from '@/components/first-run'
import { useClusters } from '@/hooks/useClusters'
import { AiPage } from '@/features/ai/AiPage'
import { ChangeLogPage } from '@/features/audit/ChangeLogPage'
import { InspectPage } from '@/features/inspect/InspectPage'
import { HandoverPage } from '@/features/inspect/HandoverPage'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { EventsPage } from '@/features/events/EventsPage'
import { HelmPage } from '@/features/helm/HelmPage'
import { NodeDetailPage } from '@/features/nodes/NodeDetailPage'
import { PodDetailPage } from '@/features/pods/PodDetailPage'
import { PodsListPage } from '@/features/pods/PodsListPage'
import { ResourceDetailPage } from '@/features/resources/ResourceDetailPage'
import { ResourceListPage } from '@/features/resources/ResourceListPage'
import { SettingsPage } from '@/features/settings/SettingsPage'

export default function App() {
  const { clusters, loading, error, dynamicEnabled } = useClusters()
  const first = clusters[0]?.name
  // 通配符兜底要读原路径（判定是否用户真的敲了一个地址，而非空路径首帧）
  const { pathname } = useLocation()

  // 门禁分岔：零集群/配置失败都不能演成永久 loading（加集群入口在门后，Day-1 接手会卡死）
  if (first == null) return <FirstRun loading={loading} error={error} dynamicEnabled={dynamicEnabled} />

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to={`/c/${first}`} replace />} />
        <Route path="/c/:cluster" element={<DashboardPage />} />

        <Route path="/c/:cluster/pods" element={<PodsListPage />} />
        <Route path="/c/:cluster/ns/:ns/pods" element={<PodsListPage />} />
        <Route path="/c/:cluster/ns/:ns/pods/:pod" element={<PodDetailPage />} />

        <Route path="/c/:cluster/events" element={<EventsPage />} />
        <Route path="/c/:cluster/ns/:ns/events" element={<EventsPage />} />

        {/* Helm releases（列表 + 详情）；后端需 --enable-helm 启动 */}
        <Route path="/c/:cluster/helm" element={<HelmPage />} />
        <Route path="/c/:cluster/helm/:ns/:name" element={<HelmPage />} />

        {/* Node 专用详情（须先于通用 /r/ 路由匹配） */}
        <Route path="/c/:cluster/r/Node/cluster/:name" element={<NodeDetailPage />} />
        {/* 通用资源：列表 + 详情（cluster scope 的 ns 段为 'cluster'） */}
        <Route path="/c/:cluster/r/:kind" element={<ResourceListPage />} />
        <Route path="/c/:cluster/r/:kind/:ns" element={<ResourceListPage />} />
        <Route path="/c/:cluster/r/:kind/:ns/:name" element={<ResourceDetailPage />} />
        {/* 旧 YAML 路由保留（Pod 详情页仍链接它） */}
        <Route path="/c/:cluster/yaml/:ns/:kind/:name" element={<ResourceDetailPage />} />

        <Route path="/c/:cluster/ai" element={<AiPage />} />
        <Route path="/c/:cluster/audit" element={<ChangeLogPage />} />
        <Route path="/c/:cluster/inspect" element={<InspectPage />} />
        <Route path="/c/:cluster/handover/:id" element={<HandoverPage />} />
        <Route path="/c/:cluster/settings" element={<SettingsPage />} />

        {/* 兜底：失效深链（书签过期/资源已删）不能静默换地址——落地页带 ?lost=1 说明来由。
            空路径与首页重定向有自己的路由，走不到这里，判空只是首帧兜底 */}
        <Route
          path="*"
          element={
            <Navigate
              to={{ pathname: `/c/${first}/pods`, search: pathname && pathname !== '/' ? '?lost=1' : '' }}
              replace
            />
          }
        />
      </Route>
    </Routes>
  )
}
