// 设置页集群卡：展示 /config 集群 + 动态集群增删（headlamp --enable-dynamic-clusters）。
// 添加 = 粘贴 kubeconfig → POST /cluster（后端持久化到 headlamp 自己的 kubeconfig 文件，
// 挂载的只读源不动）；删除 = DELETE /cluster/:name?removeKubeConfig=true（仅动态集群，
// 内置 kubeconfig 集群由部署管理，UI 不提供删除）。后端未开 flag 时（isDynamicClusterEnabled
// = false）退化为只读列表。
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Boxes, Loader2, Plus, Trash2 } from 'lucide-react'
import { addCluster, deleteCluster } from '@/api/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useClusters } from '@/hooks/useClusters'
import { tf, useT } from '@/i18n'

const DYN = 'dynamic_cluster'

export function ClusterSettingsCard() {
  const t = useT()
  const { clusters, loading, error, dynamicEnabled } = useClusters()
  const queryClient = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [kcText, setKcText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [delTarget, setDelTarget] = useState<string | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['config'] })

  const doAdd = async () => {
    setBusy(true)
    setErr(null)
    try {
      await addCluster(kcText)
      setAddOpen(false)
      setKcText('')
      await refresh()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doRemove = async (name: string) => {
    setRemoving(name)
    setErr(null)
    try {
      await deleteCluster(name)
      setDelTarget(null)
      await refresh()
    } catch (e) {
      setErr((e as Error).message)
      setDelTarget(null)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <Card className="gap-3 [--card-spacing:--spacing(5)]">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-sm">{t('settings:cluster')}</CardTitle>
        {dynamicEnabled && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setAddOpen(true); setErr(null) }}>
            <Plus className="size-3" />
            {t('settings:clusterAdd')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {err && <div className="text-xs text-destructive">{err}</div>}
        {loading ? (
          <div className="h-4 animate-pulse rounded bg-muted" />
        ) : error ? (
          <div className="text-xs text-destructive">{tf('settings:clusterLoadError', { err: error })}</div>
        ) : (
          clusters.map(c => {
            const isDyn = c.meta_data?.source === DYN
            return (
              <div key={c.name} className="flex items-center gap-2.5 rounded-md border px-3 py-2">
                <Boxes className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{c.name}</span>
                    {c.auth_type && (
                      <Badge variant="secondary" className="px-1.5 py-0 text-xs font-normal">
                        {c.auth_type}
                      </Badge>
                    )}
                    {isDyn && (
                      <Badge variant="secondary" className="px-1.5 py-0 text-xs font-normal">
                        {t('settings:clusterDyn')}
                      </Badge>
                    )}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{c.server}</div>
                </div>
                {isDyn && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    title={t('settings:clusterDelete')}
                    disabled={removing === c.name}
                    onClick={() => setDelTarget(c.name)}
                  >
                    {removing === c.name ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  </Button>
                )}
              </div>
            )
          })
        )}
        {!dynamicEnabled && !loading && !error && (
          <p className="text-xs text-muted-foreground">{t('settings:clusterDynDisabled')}</p>
        )}

        {/* 添加动态集群 */}
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="text-sm">{t('settings:clusterAddTitle')}</DialogTitle>
              <DialogDescription className="text-xs">{t('settings:clusterAddHint')}</DialogDescription>
            </DialogHeader>
            <Textarea
              value={kcText}
              onChange={e => setKcText(e.target.value)}
              placeholder={t('settings:clusterKcPh')}
              className="h-48 resize-none font-mono text-xs"
              spellCheck={false}
            />
            <DialogFooter>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAddOpen(false)}>
                {t('ui:cancel')}
              </Button>
              <Button size="sm" className="h-7 text-xs" onClick={doAdd} disabled={busy || kcText.trim().length === 0}>
                {busy && <Loader2 className="size-3 animate-spin" />}
                {t('settings:clusterAddBtn')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 删除确认 */}
        <Dialog open={delTarget !== null} onOpenChange={o => !o && setDelTarget(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">{t('settings:clusterDeleteTitle')}</DialogTitle>
              <DialogDescription className="text-xs">
                {tf('settings:clusterDeleteDesc', { name: delTarget ?? '' })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setDelTarget(null)}>
                {t('ui:cancel')}
              </Button>
              <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => delTarget && doRemove(delTarget)}>
                {t('settings:clusterDelete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
