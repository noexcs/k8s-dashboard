// workload 扩展动作入口（参考 kubectl）：暂停/恢复 rollout、修改容器镜像、Expose 成 Service。
// 实现按操作域拆分：PauseRolloutButton / SetImageButton / ExposeButton（各自自持 busy 与对话框状态）。
// 本文件只做两件事：kind 准入 + 一次 RBAC 查询分发给各按钮——
// RBAC 合并为单次 usePermissions 是刻意的：拆到各按钮会把详情页头部的权限探测请求放大三倍。
// 与 WorkloadActions（scale/restart）并排挂在详情页头部。
import { useMemo } from 'react'
import { usePermissions, type PermissionCheck } from '@/hooks/usePermissions'
import { type AnyResourceDef } from '@/resources/registry'
import { PauseRolloutButton } from './PauseRolloutButton'
import { SetImageButton } from './SetImageButton'
import { ExposeButton } from './ExposeButton'

const ROLLBACKABLE: Record<string, true> = { Deployment: true, StatefulSet: true, DaemonSet: true }

export function WorkloadDeployActions({
  def,
  cluster,
  ns,
  name,
  paused,
  menuMode = false,
  onImage,
  onExpose,
}: {
  def: AnyResourceDef
  cluster: string
  ns: string
  name: string
  /** spec.paused（父组件从 yaml 解析；仅 Deployment 有意义） */
  paused: boolean | undefined
  /** true = 三个动作全部渲染为「更多」菜单项（ghost），替代头部 outline 按钮 */
  menuMode?: boolean
  /** 菜单场景：改镜像/暴露的对话框由宿主（详情页头部）持有 */
  onImage?: () => void
  onExpose?: () => void
}) {
  const isRolloutable = ROLLBACKABLE[def.kind] !== undefined

  const checks = useMemo<PermissionCheck[]>(
    () =>
      isRolloutable
        ? [
            { verb: 'update', group: def.group, version: def.version, resource: def.resource, namespace: ns },
            { verb: 'create', group: '', version: 'v1', resource: 'services', namespace: ns },
          ]
        : [],
    [isRolloutable, def, ns],
  )
  const { can } = usePermissions(cluster, checks)
  const canUpdate = isRolloutable && can(checks[0])
  const canExpose = isRolloutable && can(checks[1])

  if (!isRolloutable) return null

  return (
    <>
      <PauseRolloutButton def={def} cluster={cluster} ns={ns} name={name} paused={paused} allowed={canUpdate} menuMode={menuMode} />
      <SetImageButton def={def} cluster={cluster} ns={ns} name={name} allowed={canUpdate} menuMode={menuMode} onRequest={onImage} />
      <ExposeButton def={def} cluster={cluster} ns={ns} name={name} allowed={canExpose} menuMode={menuMode} onRequest={onExpose} />
    </>
  )
}
