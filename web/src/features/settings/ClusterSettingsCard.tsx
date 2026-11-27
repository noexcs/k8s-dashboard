// 设置页集群卡：展示 /config 集群 + 动态集群增删（headlamp --enable-dynamic-clusters）。
// 添加 = 粘贴 kubeconfig → POST /cluster（后端持久化到 headlamp 自己的 kubeconfig 文件，
// 挂载的只读源不动）；删除 = DELETE /cluster/:name?removeKubeConfig=true（仅动态集群，
// 内置 kubeconfig 集群由部署管理，UI 不提供删除）。后端未开 flag 时（isDynamicClusterEnabled
// = false）退化为只读列表。
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Boxes, Loader2, Plus, Trash2 } from 'lucide-react'
import { addCluster, deleteCluster } from '@/api/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SectionCard, FADE } from './parts'
import {
  Dialog,
  DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useClusters } from '@/hooks/useClusters'
import { tf, useT } from '@/i18n'
import { cn } from '@/lib/utils'

const DYN = 'dynamic_cluster'

export function ClusterSettingsCard({ id }: { id?: string }) {
  const t = useT()
  const { clusters, loading, error, dynamicEnabled } = useClusters()
  const queryClient = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [kcText, setKcText] = useState('')
  const [busy, setBusy] = useState(false)
  // 添加/删除失败都显示在各自弹窗内——列表区的错误会被 Dialog 遮罩盖住，等于失败零反馈
  const [addErr, setAddErr] = useState<string | null>(null)
  const [delErr, setDelErr] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [delTarget, setDelTarget] = useState<string | null>(null)
  // 受控 open 的 Dialog 记不到触发器，关闭后焦点掉 body——自己存触发元素并显式归还
  const addBtnRef = useRef<HTMLButtonElement | null>(null)
  const delTriggerRef = useRef<HTMLButtonElement | null>(null)
  const backToAdd = (e: Event) => {
    e.preventDefault()
    addBtnRef.current?.focus()
  }
  // 删除成功后该行已卸载：回退聚焦「添加」而非死元素
  const backToDel = (e: Event) => {
    e.preventDefault()
    const el = delTriggerRef.current?.isConnected ? delTriggerRef.current : addBtnRef.current
    el?.focus()
  }

  // 新增行闪光确认（库内 [data-flash] 约定）：对比上一帧集群名单，认不出的行闪 400ms
  const prevNames = useRef<Set<string> | null>(null)
  useEffect(() => {
    prevNames.current = new Set(clusters.map(c => c.name))
  }, [clusters])
  const fresh = prevNames.current ? new Set(clusters.map(c => c.name).filter(n => !prevNames.current!.has(n))) : new Set<string>()

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['config'] })

  const doAdd = async () => {
    setBusy(true)
    setAddErr(null)
    try {
      await addCluster(kcText)
      setAddOpen(false)
      setKcText('')
      await refresh()
    } catch (e) {
      setAddErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doRemove = async (name: string) => {
    setRemoving(name)
    setDelErr(null)
    try {
      await deleteCluster(name)
      setDelTarget(null)
      await refresh()
    } catch (e) {
      // 删除失败留在弹窗内播报——先关弹窗再把红字丢到遮罩位置=零反馈
      setDelErr((e as Error).message)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <SectionCard
      id={id}
      title={t('settings:cluster')}
      desc={t('settings:clusterDesc')}
      action={
        dynamicEnabled && (
          <Button size="sm" variant="outline" ref={addBtnRef} onClick={() => { setAddOpen(true); setAddErr(null) }}>
            <Plus className="size-3" />
            {t('settings:clusterAdd')}
          </Button>
        )
      }
    >
      <div className="space-y-2">
        {loading ? (
          <>
            <div className="h-14 animate-pulse rounded-lg border bg-muted/40" />
            <div className="h-14 animate-pulse rounded-lg border bg-muted/40" />
          </>
        ) : error ? (
          <div className="text-xs text-destructive">{tf('settings:clusterLoadError', { err: error })}</div>
        ) : clusters.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">{t('settings:clusterEmpty')}</p>
        ) : (
          clusters.map(c => {
            const isDyn = c.meta_data?.source === DYN
            return (
              <div key={c.name} data-flash={fresh.has(c.name) || undefined} className={cn(FADE, 'flex items-center gap-2.5 rounded-lg border px-3 py-2.5')}>
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
                    aria-label={t('settings:clusterDelete')}
                    aria-disabled={removing === c.name || undefined}
                    onClick={e => {
                      if (removing === c.name) return
                      delTriggerRef.current = e.currentTarget
                      setDelTarget(c.name)
                    }}
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
        <Dialog
          open={addOpen}
          onOpenChange={o => {
            // 请求在途不许关（Esc/✕/取消同路）：关了失败就无人知晓
            if (!o && busy) return
            setAddOpen(o)
          }}
        >
          <DialogContent className="max-w-lg" onCloseAutoFocus={backToAdd}>
            <DialogHeader>
              <DialogTitle className="text-sm">{t('settings:clusterAddTitle')}</DialogTitle>
              <DialogDescription className="text-xs">{t('settings:clusterAddHint')}</DialogDescription>
            </DialogHeader>
            <Textarea
              value={kcText}
              onChange={e => setKcText(e.target.value)}
              placeholder={t('settings:clusterKcPh')}
              aria-label={t('settings:clusterAddTitle')}
              className="h-48 resize-none font-mono text-xs md:text-xs"
              spellCheck={false}
            />
            {addErr && <p role="alert" className="break-words text-xs text-destructive">{addErr}</p>}
            <DialogFooter>
              <Button size="sm" variant="outline" aria-disabled={busy || undefined} onClick={() => !busy && setAddOpen(false)}>
                {t('ui:cancel')}
              </Button>
              <Button
                size="sm"
                aria-disabled={busy || kcText.trim().length === 0 || undefined}
                onClick={() => {
                  if (busy || kcText.trim().length === 0) return
                  void doAdd()
                }}
              >
                {busy && <Loader2 className="size-3 animate-spin" />}
                {t('settings:clusterAddBtn')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 删除确认 */}
        <Dialog
          open={delTarget !== null}
          onOpenChange={o => {
            // 在途删除不许关：Esc 掉弹窗后 500 变 404 也无人知晓
            if (!o && removing) return
            if (!o) setDelTarget(null)
          }}
        >
          <DialogContent className="max-w-sm" onCloseAutoFocus={backToDel}>
            <DialogHeader>
              <DialogTitle className="text-sm">{t('settings:clusterDeleteTitle')}</DialogTitle>
              <DialogDescription className="text-xs">
                {tf('settings:clusterDeleteDesc', { name: delTarget ?? '' })}
              </DialogDescription>
            </DialogHeader>
            {delErr && <p role="alert" className="break-words text-xs text-destructive">{delErr}</p>}
            <DialogFooter>
              <Button size="sm" variant="outline" aria-disabled={removing === delTarget || undefined} onClick={() => removing !== delTarget && setDelTarget(null)}>
                {t('ui:cancel')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                aria-disabled={removing === delTarget || undefined}
                onClick={() => {
                  if (removing === delTarget || !delTarget) return
                  void doRemove(delTarget)
                }}
              >
                {removing === delTarget ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t('settings:clusterDelete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </SectionCard>
  )
}
