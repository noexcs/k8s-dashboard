// Expose 成 Service 操作域（自 WorkloadDeployActions 拆出）：仅 Deployment，按首容器端口 POST services。
// RBAC（create services）由父组件一次查好，这里只接 allowed；创建成功后跳 Service 详情。
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { get, postObject } from '@/api/client'
import { tf, useT } from '@/i18n'
import type { K8sObject } from '@/api/types'
import { itemPath, listPath, type AnyResourceDef } from '@/resources/registry'
import { GatedButton } from '@/components/GatedButton'
import { ActionMenuItem } from './WorkloadActions'
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
import type { WlPodSpec } from './SetImageButton'

export function ExposeButton({
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
  /** create services 权限（父组件统一 RBAC 门控后传入） */
  allowed: boolean
  /** 渲染为「更多」菜单项（ghost），替代头部 outline 按钮 */
  menuMode?: boolean
  /** 菜单场景下由宿主持有对话框（见 SetImageButton.onRequest 同注释） */
  onRequest?: () => void
}) {
  const t = useT()
  const navigate = useNavigate()
  const [exposeOpen, setExposeOpen] = useState(false)

  if (def.kind !== 'Deployment') return null

  return (
    <>
      {menuMode ? (
        <ActionMenuItem
          allowed={allowed}
          onSelect={onRequest ?? (() => setExposeOpen(true))}
          icon={<Upload className="size-3.5" />}
          label={t('res:expose')}
        />
      ) : (
        <GatedButton allowed={allowed} variant="outline" onClick={() => setExposeOpen(true)}>
          <Upload className="size-3.5" />
          {t('res:expose')}
        </GatedButton>
      )}
      {!onRequest && exposeOpen && (
        <ExposeDialog
          open={exposeOpen}
          onOpenChange={setExposeOpen}
          cluster={cluster}
          ns={ns}
          def={def}
          name={name}
          onCreated={() => {
            setExposeOpen(false)
            navigate(`/c/${cluster}/r/Service/${ns}/${name}`)
          }}
        />
      )}
    </>
  )
}

/** Expose：按首容器端口生成 Service（ClusterIP），名称 = workload 名 */
export function ExposeDialog({
  open,
  onOpenChange,
  cluster,
  ns,
  def,
  name,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  cluster: string
  ns: string
  def: AnyResourceDef
  name: string
  onCreated: (svcName: string) => void
}) {
  const t = useT()
  const [ports, setPorts] = useState<{ port: string; target: string }[]>([])
  const [selector, setSelector] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setErr(null)
    void (async () => {
      try {
        const obj = await get<WlPodSpec>(cluster, itemPath(def, ns, name))
        const labels = (obj.spec?.template as { metadata?: { labels?: Record<string, string> } } | undefined)?.metadata?.labels ?? {}
        setSelector(labels)
        const cp = obj.spec?.template?.spec?.containers?.[0]?.ports ?? []
        setPorts(
          cp.length > 0
            ? cp.map(p => ({ port: String(p.containerPort), target: p.name ?? String(p.containerPort) }))
            : [{ port: '80', target: '80' }],
        )
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [open, cluster, def, ns, name])

  const valid = ports.length > 0 && ports.every(p => Number(p.port) > 0 && p.target !== '') && Object.keys(selector).length > 0

  const submit = async () => {
    setBusy(true)
    try {
      await postObject(cluster, listPath({ group: '', version: 'v1', resource: 'services', scope: 'namespaced' }, ns), {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name, namespace: ns, labels: { app: name } },
        spec: {
          type: 'ClusterIP',
          selector,
          ports: ports.map(p => ({ port: Number(p.port), targetPort: /^\d+$/.test(p.target) ? Number(p.target) : p.target, protocol: 'TCP' })),
        },
      } as unknown as K8sObject, `暴露「${name}」（创建 Service）`)
      toast.success(tf('res:exposeDone', { name }))
      onCreated(name)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={v => !busy && onOpenChange(v)}>
      <AlertDialogContent className="w-fit min-w-88 max-w-[92vw]">
        <AlertDialogHeader>
          <AlertDialogTitle className="whitespace-nowrap">{tf('res:exposeTitle', { name })}</AlertDialogTitle>
          <AlertDialogDescription className="text-[13px]">{t('res:exposeDesc')}</AlertDialogDescription>
        </AlertDialogHeader>
        {loading && <div className="py-2 text-[13px] text-muted-foreground">{t('res:loading')}</div>}
        {err && <div className="py-2 text-[13px] text-destructive">{err}</div>}
        {!loading && !err && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              {t('res:exposeSelector')}: <span className="font-mono">{Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}</span>
            </div>
            {ports.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-[13px]">
                <span className="w-24 text-muted-foreground">{t('res:exposePort')}</span>
                <Input
                  className="w-20 font-mono"
                  value={p.port}
                  onChange={e => setPorts(ps => ps.map((x, j) => (j === i ? { ...x, port: e.target.value } : x)))}
                />
                <span className="text-muted-foreground">{t('res:exposeTargetMark')}</span>
                <Input
                  className="w-24 font-mono"
                  value={p.target}
                  onChange={e => setPorts(ps => ps.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))}
                />
              </div>
            ))}
            <div className="text-xs text-muted-foreground">{t('res:exposeTypeNote')}</div>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('res:cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || !valid || loading}
            onClick={e => {
              e.preventDefault()
              void submit()
            }}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {t('res:expose')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
