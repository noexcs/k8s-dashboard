// PVC 扩容：k8s 侧规则 = StorageClass 必须 allowVolumeExpansion，且 PVC 只能增大不能缩小；
// 提交 = strategic merge PATCH spec.resources.requests.storage，真正的 resize 由 PV 控制器 +
// 文件系统异步完成，进度只能在 status.conditions 里看（Resizing / FileSystemResizing 与 *ResizePending）。
// 依赖详情页已解析的 YAML（pvc prop），不自己再拉一次对象。
import { HardDriveUpload, Loader2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { get, patchObject } from '@/api/client'
import type { K8sObject } from '@/api/types'
import { parseQty } from '@/lib/format'
import { tf, useT } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Field, FieldContent, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/** 详情页 YAML 只取扩容相关字段，其余忽略 */
interface PvcLike {
  spec?: {
    resources?: { requests?: Record<string, string> }
    storageClassName?: string
    volumeName?: string
  }
  status?: {
    phase?: string
    conditions?: { type?: string; reason?: string; status?: string }[]
  }
}

interface StorageClassLike extends K8sObject {
  allowVolumeExpansion?: boolean
}

// 各 k8s 版本把 resize 状态放在 condition 的 type 或 reason 上：两处都匹配。
const RESIZING = ['resizing', 'filesystemresizing']
const RESIZE_PENDING = ['controllerresizepending', 'filesystemresizepending']

/** 进度条件判定：status=False 的条件是「已完成/已恢复」的历史记录，不算进行中 */
function hasReason(
  conditions: { type?: string; reason?: string; status?: string }[] | undefined,
  names: string[],
): boolean {
  return (conditions ?? []).some(c => {
    if (c.status === 'False') return false
    const key = (c.reason || c.type || '').toLowerCase()
    return names.includes(key)
  })
}

interface PvcExpandButtonProps {
  cluster: string
  ns: string
  name: string
  /** 详情页当前已解析的 PVC 对象 */
  pvc: Record<string, unknown>
  /** 有无 update 该 PVC 的权限（父组件用 usePermissions 求得） */
  allowed: boolean
}

export function PvcExpandButton({ cluster, ns, name, pvc, allowed }: PvcExpandButtonProps) {
  const t = useT()
  const queryClient = useQueryClient()
  const obj = pvc as unknown as PvcLike
  const scName = obj.spec?.storageClassName ?? ''
  const current = obj.spec?.resources?.requests?.storage ?? ''
  const phase = obj.status?.phase ?? ''
  // 与 registry.itemPath 完全一致的拼法（不 encode），否则失效 ['yaml', cluster, path] 缓存时 key 对不上
  const path = `/api/v1/namespaces/${ns}/persistentvolumeclaims/${name}`
  // 只有 Bound 且绑定了 StorageClass 才谈得上扩容（静态 PV 无 SC 时控制器不会 resize）
  const visible = phase === 'Bound' && scName !== ''

  const [open, setOpen] = useState(false)
  const [size, setSize] = useState(current)
  const [applying, setApplying] = useState(false)

  const { data: sc, error, refetch } = useQuery({
    queryKey: ['storageclass', cluster, scName],
    queryFn: () =>
      get<StorageClassLike>(cluster, `/apis/storage.k8s.io/v1/storageclasses/${scName}`),
    enabled: visible,
    staleTime: 60_000,
  })

  const expandable = sc?.allowVolumeExpansion === true
  const scError = error ? (error instanceof Error ? error.message : String(error)) : null
  // SC 还没读到（首次加载）：按钮禁用并显示 spinner，避免点开对话框才发现不支持扩容
  const checking = !sc && !scError
  // 按钮不可用的原因（同时作 tooltip 文案）：无权限 > SC 读失败 > SC 还在加载 > SC 不支持
  const hint = !allowed
    ? t('core:noPermission')
    : scError
      ? tf('pvc:scFailed', { sc: scName, msg: scError })
      : !sc
        ? t('pvc:checkingSc')
        : !expandable
          ? tf('pvc:notExpandable', { sc: scName })
          : null

  const currentBytes = parseQty(current)
  const nextBytes = parseQty(size.trim())
  const invalid = size.trim() !== '' && nextBytes === null
  // 容量单位可能写法不同（1Gi vs 1024Mi），统一换算成字节再比大小
  const tooSmall = nextBytes !== null && currentBytes !== null && nextBytes <= currentBytes
  const canSubmit = nextBytes !== null && !tooSmall && !applying

  if (!visible) return null

  const resizeConditions = obj.status?.conditions
  const resizing = hasReason(resizeConditions, RESIZING)
  const pending = hasReason(resizeConditions, RESIZE_PENDING)

  const openDialog = () => {
    setSize(current)
    setOpen(true)
  }

  // disabled 的按钮不触发 click，由外层 span 承接：给出原因提示，读取失败时顺带重试
  const onBlocked = () => {
    if (!allowed) return
    if (scError) void refetch()
    if (hint) toast.info(hint)
  }

  const doExpand = async () => {
    setApplying(true)
    try {
      await patchObject(cluster, path, { spec: { resources: { requests: { storage: size.trim() } } } }, `PVC 扩容至 ${size.trim()}`)
      void queryClient.invalidateQueries({ queryKey: ['yaml', cluster, path] })
      setOpen(false)
      toast.success(t('pvc:submitted'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  const button = (
    <Button variant="outline" disabled={hint !== null} onClick={hint === null ? openDialog : undefined}>
      {checking ? <Loader2 className="size-3.5 animate-spin" /> : <HardDriveUpload className="size-3.5" />}
      {t('pvc:expand')}
    </Button>
  )

  return (
    <div className="flex items-center gap-1.5">
      {hint === null ? (
        button
      ) : (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex" onClick={onBlocked}>
                {button}
              </span>
            </TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {resizing && <span className="text-[13px] text-muted-foreground">{t('pvc:expanding')}</span>}
      {pending && (
        <span className="inline-flex items-center gap-1 text-[13px] text-caution">
          <TriangleAlert className="size-3.5" />
          {t('pvc:resizePending')}
        </span>
      )}

      <AlertDialog open={open} onOpenChange={v => !applying && setOpen(v)}>
        <AlertDialogContent className="w-fit min-w-88 max-w-[92vw]">
          <AlertDialogHeader>
            <AlertDialogTitle className="whitespace-nowrap">{tf('pvc:title', { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {tf('pvc:desc', {
                current: current || t('pvc:notSet'),
                pv: obj.spec?.volumeName || t('pvc:notSet'),
                sc: scName,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field className="gap-1.5">
            <FieldLabel className="text-[13px]">{t('pvc:newSize')}</FieldLabel>
            <FieldContent>
              <Input
                className="w-32 font-mono"
                placeholder="2Gi"
                value={size}
                onChange={e => setSize(e.target.value)}
              />
              {invalid && <p className="text-[13px] text-destructive">{t('pvc:invalidSize')}</p>}
              {!invalid && tooSmall && <p className="text-[13px] text-destructive">{tf('pvc:mustGrow', { current })}</p>}
            </FieldContent>
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applying}>{t('pvc:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!canSubmit}
              onClick={e => {
                e.preventDefault()
                void doExpand()
              }}
            >
              {applying && <Loader2 className="size-3.5 animate-spin" />}
              {t('pvc:submit')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
