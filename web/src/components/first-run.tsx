import { useState } from 'react'
import { tf, useT } from '@/i18n'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, TriangleAlert } from 'lucide-react'
import { addCluster } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

/**
 * 零集群/配置失败门禁屏：此前 first==null 一律渲染永久 loading——
 * 换 kubeconfig 或 ai-exec 初部署时新人面对转圈页无处可去（加集群入口在门后），
 * /config 失败也伪装成加载中。Day-1 硬阻断在此分岔为三种真实状态。
 */
export default function FirstRun({ loading, error, dynamicEnabled }: { loading: boolean; error: string | null; dynamicEnabled: boolean | null }) {
  const t = useT()
  const qc = useQueryClient()
  const [kcText, setKcText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">{t('core:loading')}</div>
  }

  const refresh = () => qc.invalidateQueries({ queryKey: ['config'] })

  const doAdd = async () => {
    setBusy(true)
    setErr(null)
    try {
      await addCluster(kcText)
      setKcText('')
      await refresh()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4">
        <h1 className="text-lg font-medium">{t('sys:firstRunTitle')}</h1>
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="break-words">{tf('sys:firstRunConfigError', { msg: error })}</p>
              <Button variant="outline" size="xs" className="mt-2" onClick={() => void refresh()}>
                {t('inspect:retry')}
              </Button>
            </div>
          </div>
        )}
        {dynamicEnabled ? (
          <>
            <p className="text-sm text-muted-foreground">{t('sys:firstRunHint')}</p>
            <Textarea
              value={kcText}
              onChange={e => setKcText(e.target.value)}
              placeholder={t('sys:firstRunKcPh')}
              className="h-40 font-mono text-xs"
              aria-label={t('sys:firstRunKcPh')}
            />
            {err && <p role="alert" className="break-words text-sm text-destructive">{err}</p>}
            <Button disabled={!kcText.trim() || busy} onClick={() => void doAdd()}>
              <Plus className="size-4" />
              {busy ? t('core:loading') : t('sys:firstRunAdd')}
            </Button>
          </>
        ) : (
          // dynamicEnabled=null 是「config 读不到」不是「未开启」：两种事实不说同一句话，
          // 否则开了 flag 的部署碰上瞬时故障会被拆台（合法表单路径凭空消失）
          <>
            <p className="text-sm text-muted-foreground">{dynamicEnabled === false ? t('sys:firstRunMountHint') : t('sys:firstRunUnknown')}</p>
            <Button variant="outline" onClick={() => void refresh()}>
              {t('inspect:retry')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
