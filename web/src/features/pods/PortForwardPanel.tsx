// Pod 端口转发面板：控制 headlamp-server 侧的 port-forward（后端 cache 维护生命周期）。
// 监听地址是 server 主机的 localhost:{port}（见 api/portforward.ts 头注），文案里明确说明，
// 不谎称「浏览器本机转发」；给出的链接按当前页面 hostname 拼 http://{host}:{port}。
import { ExternalLink, Loader2, Play, Square } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { listPortForwards, startPortForward, stopPortForward, type PortForward, type PortForwardStatus } from '@/api/portforward'
import type { PortItem } from '@/components/PortLinks'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { tf, useT } from '@/i18n'
import { cn } from '@/lib/utils'

/** Select 里代表「手动输入端口」的哨兵值（与真实端口字符串不冲突） */
const CUSTOM = '__custom__'

const STATUS_STYLE: Record<PortForwardStatus, { labelKey: string; cls: string }> = {
  Running: { labelKey: 'pf:statusRunning', cls: 'border-positive/40 text-positive' },
  Reconnecting: { labelKey: 'pf:statusReconnecting', cls: 'border-caution/40 text-caution' },
  Stopped: { labelKey: 'pf:statusStopped', cls: 'border-border text-muted-foreground' },
}

export function PortForwardPanel({
  cluster,
  ns,
  pod,
  ports,
}: {
  cluster: string
  ns: string
  pod: string
  ports: PortItem[]
}) {
  const t = useT()
  const queryClient = useQueryClient()
  // choice=null 表示「未交互」，取声明端口第一项；ports 为空则退化为手动输入
  const [choice, setChoice] = useState<string | null>(null)
  const [custom, setCustom] = useState('')
  const [starting, setStarting] = useState(false)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [toStop, setToStop] = useState<PortForward | null>(null)

  const portOptions = useMemo(() => {
    const seen = new Set<number>()
    const out: { value: string; label: string }[] = []
    for (const p of ports) {
      if (seen.has(p.port)) continue
      seen.add(p.port)
      out.push({ value: String(p.port), label: p.name ? `${p.name} · ${p.port}` : `${p.port}${p.protocol && p.protocol !== 'TCP' ? `/${p.protocol}` : ''}` })
    }
    return out
  }, [ports])

  const customMode = portOptions.length === 0 || choice === CUSTOM
  const targetPort = (customMode ? custom : (choice ?? portOptions[0]?.value ?? '')).trim()

  const listKey = ['portforwards', cluster]
  const { data, isLoading, error } = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => listPortForwards(cluster, signal),
    // 有未停止的项才轮询（全 Stopped 时列表不会再变化，省请求）
    refetchInterval: q =>
      (q.state.data ?? []).some(r => r.pod === pod && r.status !== 'Stopped') ? 5000 : false,
  })
  const rows = useMemo(() => (data ?? []).filter(r => r.pod === pod), [data, pod])

  const host = window.location.hostname

  const start = async () => {
    if (!targetPort || starting) return
    setStarting(true)
    try {
      const pf = await startPortForward(cluster, { namespace: ns, pod, targetPort })
      toast.success(tf('pf:started', { port: pf.port }))
      void queryClient.invalidateQueries({ queryKey: listKey })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  const confirmStop = async () => {
    if (!toStop) return
    setStoppingId(toStop.id)
    try {
      // 后端语义（store.go stopOrDeletePortForward）：isStopRequest=true 仅置 Stopped 留僵尸行，
      // false 才从 cache 真删。UI 意图是彻底清理，故传 false。
      await stopPortForward(cluster, toStop.id, false)
      toast.success(t('pf:stoppedToast'))
      void queryClient.invalidateQueries({ queryKey: listKey })
    } catch (e) {
      toast.error(tf('pf:stopFailed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setStoppingId(null)
      setToStop(null)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs leading-4 text-muted-foreground">{tf('pf:listenHint', { host })}</p>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-muted-foreground">{t('pf:targetPort')}</span>
        {portOptions.length > 0 && (
          <Select value={choice ?? portOptions[0]?.value ?? CUSTOM} onValueChange={setChoice}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue placeholder={t('pf:selectPort')} />
            </SelectTrigger>
            <SelectContent>
              {portOptions.map(o => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>{t('pf:customPort')}</SelectItem>
            </SelectContent>
          </Select>
        )}
        {customMode && (
          <Input
            value={custom}
            onChange={e => setCustom(e.target.value)}
            placeholder={t('pf:customPortPlaceholder')}
            className="h-7 w-32 font-mono text-[13px]"
          />
        )}
        <Button size="sm" onClick={() => void start()} disabled={!targetPort || starting}>
          {starting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          {starting ? t('pf:starting') : t('pf:start')}
        </Button>
      </div>

      {error != null && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {tf('pf:loadFailed', { error: error.message })}
        </div>
      )}

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 text-xs">{t('pf:colTarget')}</TableHead>
              <TableHead className="h-8 w-28 text-xs">{t('pf:colServer')}</TableHead>
              <TableHead className="h-8 w-24 text-xs">{t('pf:colStatus')}</TableHead>
              <TableHead className="h-8 w-28 text-right text-xs">{t('pf:colAction')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="h-16 text-center text-[13px] text-muted-foreground">
                  {t('sys:loading')}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-16 text-center text-[13px] text-muted-foreground">
                  {t('pf:empty')}
                </TableCell>
              </TableRow>
            ) : (
              rows.map(r => {
                const st = STATUS_STYLE[r.status] ?? STATUS_STYLE.Stopped
                const url = `http://${host}:${r.port}`
                return (
                  <TableRow key={r.id}>
                    <TableCell className="py-1.5 font-mono text-[13px]">{r.targetPort}</TableCell>
                    <TableCell className="py-1.5 font-mono text-[13px]">:{r.port}</TableCell>
                    <TableCell className="py-1.5">
                      <Badge variant="outline" className={cn('text-xs', st.cls)} title={r.error || undefined}>
                        {t(st.labelKey)}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-1.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {r.status !== 'Stopped' ? (
                          <Button size="xs" variant="outline" className="font-mono" asChild>
                            <a href={url} target="_blank" rel="noreferrer" title={url}>
                              {t('pf:open')}
                              <ExternalLink className="opacity-60" />
                            </a>
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                        <Button
                          size="xs"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setToStop(r)}
                          disabled={stoppingId === r.id}
                        >
                          {stoppingId === r.id ? <Loader2 className="animate-spin" /> : <Square />}
                          {t('pf:stop')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs leading-4 text-muted-foreground">{t('pf:autoCleanup')}</p>

      <AlertDialog open={toStop !== null} onOpenChange={open => !open && setToStop(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('pf:stopTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tf('pf:stopDesc', { pod: toStop?.pod ?? '', targetPort: toStop?.targetPort ?? '', port: toStop?.port ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('ui:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={() => void confirmStop()}
            >
              {t('pf:stopConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
