// Pod 调试（参考 CLI ephemeral + copy-to）：
// - ephemeral：k8s ≥1.25 原生 Debug 容器，strategic-merge PATCH spec.ephemeralContainers
//   （按 name 合并，已存在同名则复用），随 Pod 生命周期，Pod 重建即消失；
// - copy-to：无 shell/持续崩溃容器取证 → 复制其文件系统到新 debug 容器（targetResourceName），
//   在副本里跑 sh，原容器不受影响。两者都靠 kubectl 同款 registry.k8s.io/pause 之外的
//   通用调试镜像（默认 busybox，可改）。attach 走既有终端（execPod container=<debug>）。
import { useState } from 'react'
import { Bug, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, patchObject, podsPath } from '@/api/client'
import { tf, useT } from '@/i18n'
import { GatedButton } from '@/components/GatedButton'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** 常见调试镜像（无 pull 问题的国内/离线集群可自行替换输入） */
const IMAGES = ['busybox:latest', 'alpine:latest', 'nicolaka/netshoot:latest']

interface EphemeralContainer extends Record<string, unknown> {
  name: string
  image: string
  command?: string[]
  targetContainerName?: string
  stdin?: boolean
  tty?: boolean
}

export function DebugDialog({
  cluster,
  ns,
  pod,
  containers,
  allowed,
  onStarted,
}: {
  cluster: string
  ns: string
  pod: string
  containers: string[]
  allowed: boolean
  /** 调试容器就绪 → 父组件切终端 tab 并选中新容器 */
  onStarted: (name: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState(containers[0] ?? '')
  const [image, setImage] = useState(IMAGES[0]!)
  const [copy, setCopy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [createdName, setCreatedName] = useState<string | null>(null)

  const start = async () => {
    const name = `debug-${target}`.slice(0, 63).replace(/[^a-z0-9-]/gi, '-').toLowerCase()
    setBusy(true)
    try {
      const ec: EphemeralContainer = {
        name,
        image: image.trim() || IMAGES[0]!,
        command: ['sh', '-c', 'while true; do sleep 3600; done'],
        stdin: true,
        tty: true,
      }
      if (copy) ec.targetContainerName = target
      await patchObject(cluster, `${podsPath(ns)}/${encodeURIComponent(pod)}/ephemeralcontainers`, {
        spec: { ephemeralContainers: [ec] },
      })
      setCreatedName(name)
      toast.success(tf('pods:debugStarted', { name }))
      onStarted(name)
    } catch (e) {
      // 同名已存在（上次打开的 debug 容器还在）→ 直接复用
      if (e instanceof ApiError && e.status === 422 && /already in use|exists/i.test(e.message)) {
        setCreatedName(name)
        onStarted(name)
        return
      }
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <GatedButton allowed={allowed} variant="outline" onClick={() => setOpen(true)}>
        <Bug />
        {t('pods:debug')}
      </GatedButton>
      <Dialog open={open} onOpenChange={v => !busy && setOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('pods:debugTitle')}</DialogTitle>
            <DialogDescription className="text-[13px]">{t('pods:debugDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-[13px]">
            <label className="block space-y-1">
              <span className="text-muted-foreground">{t('pods:debugTarget')}</span>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {containers.map(c => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="block space-y-1">
              <span className="text-muted-foreground">{t('pods:debugImage')}</span>
              <div className="flex gap-1.5">
                <Input value={image} onChange={e => setImage(e.target.value)} className="flex-1 font-mono text-[13px]" />
              </div>
              <div className="flex gap-1 pt-0.5">
                {IMAGES.map(im => (
                  <Button key={im} size="xs" variant={image === im ? 'secondary' : 'outline'} className="font-mono text-xs" onClick={() => setImage(im)}>
                    {im.split(':')[0]}
                  </Button>
                ))}
              </div>
            </label>
            <label className="flex items-start gap-2 rounded-md border px-3 py-2">
              <Checkbox checked={copy} onCheckedChange={v => setCopy(v === true)} className="mt-0.5" />
              <span>
                <span className="font-medium">{t('pods:debugCopy')}</span>
                <span className="block text-muted-foreground">{t('pods:debugCopyDesc')}</span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t('res:cancel')}
            </Button>
            <Button onClick={() => void start()} disabled={busy || !target}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {t('pods:debugStart')}
            </Button>
          </DialogFooter>
          {createdName && <div className="text-xs text-muted-foreground">{tf('pods:debugAttachHint', { name: createdName })}</div>}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Pod 的普通 + ephemeral 容器名（终端/文件 tab 共用；调试容器出现后即可选）。
 * 参数宽松取 spec 两段：Pod 类型未声明 ephemeralContainers，watch 数据里实际存在 */
export function allContainerNames(pod: { spec?: Record<string, unknown> }): string[] {
  const spec = pod.spec ?? {}
  const main = ((spec.containers ?? []) as { name: string }[]).map(c => c.name)
  const eph = ((spec.ephemeralContainers ?? []) as { name: string }[]).map(c => c.name)
  return [...main, ...eph]
}
