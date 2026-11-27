// 修改容器镜像操作域（自 WorkloadDeployActions 拆出）：加载 PodTemplate 容器列表 → 编辑 image → strategic-merge PATCH。
// 适用 Deployment/StatefulSet/DaemonSet；RBAC（update 本 kind）由父组件一次查好，这里只接 allowed。
import { useEffect, useState } from 'react'
import { Loader2, Rocket } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { get, patchObject } from '@/api/client'
import { tf, useT } from '@/i18n'
import type { K8sObject } from '@/api/types'
import { itemPath, type AnyResourceDef } from '@/resources/registry'
import { GatedButton } from '@/components/GatedButton'
import { ActionMenuItem } from './WorkloadActions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** workload 通用形状：只声明镜像/端口/模板标签用到的段（ExposeButton 也复用） */
export interface WlPodSpec extends K8sObject {
  spec?: {
    template?: {
      spec?: {
        containers?: { name: string; image: string; ports?: { containerPort: number; name?: string; protocol?: string }[] }[]
      }
    }
  }
}

export function SetImageButton({
  def,
  cluster,
  ns,
  name,
  allowed,
  menuMode = false,
  onRequest,
}: {
  def: AnyResourceDef
  cluster: string
  ns: string
  name: string
  /** update 本 kind 权限（父组件统一 RBAC 门控后传入） */
  allowed: boolean
  /** 渲染为「更多」菜单项（ghost），替代头部 outline 按钮 */
  menuMode?: boolean
  /** 菜单场景下由宿主持有对话框（菜单 Content 收起即卸载，状态必须活在菜单外）；传入后本组件不再自持对话框 */
  onRequest?: () => void
}) {
  const t = useT()
  const path = itemPath(def, ns, name)
  const [imageOpen, setImageOpen] = useState(false)

  return (
    <>
      {menuMode ? (
        <ActionMenuItem
          allowed={allowed}
          onSelect={onRequest ?? (() => setImageOpen(true))}
          icon={<Rocket className="size-3.5" />}
          label={t('res:setImage')}
        />
      ) : (
        <GatedButton allowed={allowed} variant="outline" onClick={() => setImageOpen(true)}>
          <Rocket className="size-3.5" />
          {t('res:setImage')}
        </GatedButton>
      )}
      {!onRequest && imageOpen && (
        <SetImageDialog open={imageOpen} onOpenChange={setImageOpen} cluster={cluster} path={path} />
      )}
    </>
  )
}

/** 修改镜像：加载 PodTemplate 容器列表，编辑 image → strategic-merge PATCH */
export function SetImageDialog({
  open,
  onOpenChange,
  cluster,
  path,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  cluster: string
  path: string
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const [containers, setContainers] = useState<{ name: string; image: string; edited: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setErr(null)
    void (async () => {
      try {
        const obj = await get<WlPodSpec>(cluster, path)
        setContainers(
          (obj.spec?.template?.spec?.containers ?? []).map(c => ({ name: c.name, image: c.image, edited: c.image })),
        )
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [open, cluster, path])

  const dirty = containers.filter(c => c.edited.trim() && c.edited.trim() !== c.image)

  const submit = async () => {
    setBusy(true)
    try {
      await patchObject(
        cluster,
        path,
        { spec: { template: { spec: { containers: dirty.map(c => ({ name: c.name, image: c.edited.trim() })) } } } },
        `改镜像 ${dirty.length} 个容器`,
      )
      toast.success(tf('res:setImageDone', { n: dirty.length }))
      // 详情页 YAML/概览缓存失效，立即反映新镜像
      void queryClient.invalidateQueries({ queryKey: ['yaml', cluster, path] })
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('res:setImageTitle')}</DialogTitle>
          <DialogDescription className="text-[13px]">{t('res:setImageDesc')}</DialogDescription>
        </DialogHeader>
        {loading && <div className="py-4 text-[13px] text-muted-foreground">{t('res:loading')}</div>}
        {err && <div className="py-2 text-[13px] text-destructive">{err}</div>}
        {!loading && !err && (
          <div className="space-y-4">
            {containers.map(c => (
              <div key={c.name} className="space-y-2">
                {/* 镜像地址长且要全宽核对，label 上置而非左挤 */}
                <span className="block truncate font-mono text-[13px] text-muted-foreground" title={c.name}>
                  {c.name}
                </span>
                <Input
                  value={c.edited}
                  onChange={e =>
                    setContainers(cs => cs.map(x => (x.name === c.name ? { ...x, edited: e.target.value } : x)))
                  }
                  className="h-8 w-full font-mono text-[13px]"
                />
              </div>
            ))}
            {containers.length === 0 && <div className="text-[13px] text-muted-foreground">{t('res:setImageNone')}</div>}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('res:cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || dirty.length === 0}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {t('res:apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
