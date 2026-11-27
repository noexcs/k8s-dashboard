// 暂停/恢复 rollout 操作域（自 WorkloadDeployActions 拆出）：Deployment 的 spec.paused 开关。
// RBAC（update 本 kind）由父组件一次查好，这里只接 allowed 并自持提交 busy 态。
import { useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { toast } from 'sonner'
import { patchObject } from '@/api/client'
import { useT } from '@/i18n'
import { itemPath, type AnyResourceDef } from '@/resources/registry'
import { GatedButton } from '@/components/GatedButton'
import { ActionMenuItem } from './WorkloadActions'

const PAUSABLE: Record<string, true> = { Deployment: true }

export function PauseRolloutButton({
  def,
  cluster,
  ns,
  name,
  paused,
  allowed,
  menuMode = false,
}: {
  def: AnyResourceDef
  cluster: string
  ns: string
  name: string
  /** spec.paused（父组件从 yaml 解析；仅 Deployment 有意义） */
  paused: boolean | undefined
  /** update 本 kind 权限（父组件统一 RBAC 门控后传入） */
  allowed: boolean
  /** 渲染为「更多」菜单项（ghost），替代头部 outline 按钮 */
  menuMode?: boolean
}) {
  const t = useT()
  const path = itemPath(def, ns, name)
  const [pauseBusy, setPauseBusy] = useState(false)

  const doPause = async (v: boolean) => {
    setPauseBusy(true)
    try {
      await patchObject(cluster, path, { spec: { paused: v } }, v ? '暂停滚动更新（spec.paused=true）' : '恢复滚动更新')
      toast.success(v ? t('res:pauseDone') : t('res:resumeDone'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setPauseBusy(false)
    }
  }

  if (!PAUSABLE[def.kind] || paused === undefined) return null

  const icon = paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />
  const label = paused ? t('res:resume') : t('res:pause')
  const run = () => void doPause(!paused)

  return menuMode ? (
    <ActionMenuItem allowed={allowed} busy={pauseBusy} onSelect={run} icon={icon} label={label} />
  ) : (
    <GatedButton allowed={allowed} variant="outline" busy={pauseBusy} onClick={run}>
      {icon}
      {label}
    </GatedButton>
  )
}
