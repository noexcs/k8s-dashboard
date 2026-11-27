// Job 挂起/恢复（spec.suspend）：kubectl 常用动作，AI 工具面早已可用（rollout/patch），
// 人反而只能开终端——补齐「相关操作可见/可点」的口径（Job 完成后无意义，父组件不渲染）。
import { useState } from 'react'
import { toast } from 'sonner'
import { Pause, Play } from 'lucide-react'
import { patchObject } from '@/api/client'
import { useT } from '@/i18n'
import { GatedButton } from '@/components/GatedButton'

export function JobActions({ cluster, ns, name, suspend, allowed }: { cluster: string; ns: string; name: string; suspend: boolean; allowed: boolean }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    setBusy(true)
    try {
      await patchObject(cluster, `/apis/batch/v1/namespaces/${ns}/jobs/${encodeURIComponent(name)}`, { spec: { suspend: !suspend } }, suspend ? `恢复 Job（suspend=false）` : `挂起 Job（suspend=true）`)
      toast.success(suspend ? t('res:jobResumeDone') : t('res:jobSuspendDone'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <GatedButton allowed={allowed} busy={busy} variant="outline" onClick={() => void toggle()} title={suspend ? t('res:jobResumeTip') : t('res:jobSuspendTip')}>
      {suspend ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
      {suspend ? t('res:jobResume') : t('res:jobSuspend')}
    </GatedButton>
  )
}
