// 节点 shell（对齐 kubectl node-shell / kubectl debug node）：
// 在目标节点起一个特权 helper Pod（hostPID/hostNetwork + rootfs 挂到 /host，活循环撑着），
// 再用既有 Pod 终端 exec 进去，默认命令 nsenter 进 PID1 命名空间；镜像缺 nsenter 时切 chroot /host。
// 终端不重写：完全复用 features/pods/Terminal.tsx（xterm + exec WS），本文件只管 helper Pod 生命周期。
import { Loader2, SquareTerminal, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, list, namespacesPath } from '@/api/client'
import { tf, useT } from '@/i18n'
import type { K8sObject } from '@/api/types'
import {
  DEFAULT_SHELL_IMAGE,
  HOST_CHROOT_CMD,
  HOST_NSENTER_CMD,
  SHELL_CONTAINER,
  SHELL_IMAGES,
  createNodeShellPod,
  deleteNodeShellPod,
  findNodeShellPod,
  getShellPod,
  shellPodWaitingReason,
  type NodeShellPod,
} from '@/api/nodeshell'
import { GatedButton } from '@/components/GatedButton'
import { TerminalView } from '@/features/pods/Terminal'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
import { cn } from '@/lib/utils'

/** 等待 Running 的上限：镜像拉不下来/PSA 拒绝特权容器都会卡在这里，超时后文案指向事件 */
const WAIT_MS = 60_000
type Mode = 'nsenter' | 'chroot'

export function NodeShell({
  cluster,
  nodeName,
  allowed,
}: {
  cluster: string
  nodeName: string
  /** 目标 ns 的 create pods 权限（父页面权限门传入） */
  allowed: boolean
}) {
  const t = useT()
  const qc = useQueryClient()
  const [ns, setNs] = useState('default')
  const [image, setImage] = useState(DEFAULT_SHELL_IMAGE)
  /** 「创建并连接」显式指定的 Pod 名（含刚 POST 回来的那个）；null = 按标签认领集群里既有的 */
  const [picked, setPicked] = useState<string | null>(null)
  /** 刚创建/复用回来的对象：轮询查询还在飞时先拿它渲染，状态不闪空 */
  const [created, setCreated] = useState<NodeShellPod | null>(null)
  const [creating, setCreating] = useState(false)
  const [deadline, setDeadline] = useState<number | null>(null)
  const [mode, setMode] = useState<Mode>('nsenter')
  const [confirmDestroy, setConfirmDestroy] = useState(false)
  const [destroying, setDestroying] = useState(false)

  const { data: nsData } = useQuery({
    queryKey: ['namespaces', cluster],
    queryFn: () => list<K8sObject>(cluster, namespacesPath),
    staleTime: 60_000,
  })
  const namespaces = nsData?.items.map(i => i.metadata.name) ?? []

  const findKey = ['nodeshell-find', cluster, ns, nodeName]
  // 进页面/换 ns 先认领本节点仍在跑的 helper Pod（上次没销毁的），避免重复建特权 Pod
  const findQuery = useQuery({
    queryKey: findKey,
    queryFn: () => findNodeShellPod(cluster, ns, nodeName),
    staleTime: 10_000,
  })
  const helperName = picked ?? findQuery.data?.metadata.name ?? null

  // 按名字轮询那一个 Pod：既是 Pending→Running 的等待，也能发现被别处删掉/已结束
  const podQuery = useQuery({
    queryKey: ['nodeshell-pod', cluster, ns, helperName],
    queryFn: () => getShellPod(cluster, ns, helperName!),
    enabled: !!helperName,
    retry: 1,
    // 404（别处删了 helper Pod）就别再轮询，其余按 phase 决定节奏
    refetchInterval: q => {
      const e: unknown = q.state.error
      if (e instanceof ApiError && e.status === 404) return false
      return q.state.data?.status?.phase === 'Running' ? 5_000 : 2_000
    },
  })
  // 三个来源里取名字对得上的那个（find 列表缓存 / create 返回 / 轮询）
  const pod = [podQuery.data, created, findQuery.data].find(p => p?.metadata.name === helperName) ?? null
  const phase = pod?.status?.phase ?? 'Unknown'
  // 本页面之外删掉了 helper Pod：说清楚，不再显示 Pending/等待
  const podErr: unknown = podQuery.error
  const gone = podErr instanceof ApiError && podErr.status === 404
  const running = phase === 'Running' && !gone
  // 超时判定搭轮询便车（未 Running 时每 2s 一次重渲染），不另起计时器
  // oxlint-disable-next-line react/purity -- 同上：靠轮询重渲染推进超时，取当前时刻即语义本体
  const timedOut = !running && !gone && deadline !== null && Date.now() > deadline

  const reset = () => {
    setPicked(null)
    setCreated(null)
    setDeadline(null)
  }

  const doCreate = async () => {
    setCreating(true)
    try {
      const reused = findQuery.data?.metadata.name
      const body = await createNodeShellPod(cluster, ns, nodeName, { image })
      setPicked(body.metadata.name)
      setCreated(body)
      setDeadline(Date.now() + WAIT_MS)
      qc.invalidateQueries({ queryKey: findKey })
      toast.success(
        reused === body.metadata.name
          ? tf('shell:reused', { name: body.metadata.name })
          : tf('shell:created', { name: body.metadata.name }),
      )
    } catch (err) {
      toast.error(tf('shell:createFailed', { msg: err instanceof Error ? err.message : String(err) }))
    } finally {
      setCreating(false)
    }
  }

  const doDestroy = async () => {
    if (!helperName) return
    const name = helperName
    setDestroying(true)
    try {
      await deleteNodeShellPod(cluster, ns, name)
      reset()
      qc.removeQueries({ queryKey: ['nodeshell-pod', cluster, ns, name] })
      qc.invalidateQueries({ queryKey: findKey })
      toast.success(tf('shell:destroyed', { name }))
      setConfirmDestroy(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDestroying(false)
    }
  }

  const waitingReason = shellPodWaitingReason(pod)

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* 强警示：root + 特权 + 生命周期 + 权限前提，创建前必须看得见（无静默创建） */}
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px]">
        <div className="mb-1 font-medium text-destructive">{t('shell:warnTitle')}</div>
        <p className="text-muted-foreground">{t('shell:warnBody')}</p>
        <p className="mt-1 text-muted-foreground">{t('shell:warnLifecycle')}</p>
        <p className="mt-1 text-muted-foreground">{t('shell:warnPerm')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">{t('shell:namespace')}</span>
          <Select
            value={ns}
            onValueChange={v => {
              setNs(v)
              // 换 ns 后终端连的是旧 ns 的 Pod，断开重新认领
              reset()
            }}
          >
            <SelectTrigger size="sm" className="w-44" aria-label={t('shell:namespace')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">default</SelectItem>
              {namespaces
                .filter(n => n !== 'default')
                .map(n => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </label>
        <label className="block min-w-56 flex-1 space-y-1">
          <span className="text-xs text-muted-foreground">{t('shell:image')}</span>
          <Input
            value={image}
            onChange={e => setImage(e.target.value)}
            spellCheck={false}
            className="h-7 font-mono text-[13px]"
            aria-label={t('shell:image')}
          />
        </label>
        <div className="flex gap-1 pb-0.5">
          {SHELL_IMAGES.map(im => (
            <Button
              key={im}
              size="sm"
              variant={image === im ? 'secondary' : 'outline'}
              className="h-7 px-1.5 text-xs font-mono"
              onClick={() => setImage(im)}
            >
              {im.split(':')[0]}
            </Button>
          ))}
        </div>
        <GatedButton allowed={allowed} busy={creating} onClick={() => void doCreate()} className="h-7">
          {creating ? <Loader2 className="size-3.5 animate-spin" /> : <SquareTerminal className="size-3.5" />}
          {creating ? t('shell:creating') : t('shell:create')}
        </GatedButton>
      </div>
      <p className="text-xs text-muted-foreground">{t('shell:imageHint')}</p>

      {/* helper Pod 现状：名字 + phase + 等待原因（复用/新建/Pending 卡住都在这行说清） */}
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-muted-foreground">{t('shell:helper')}</span>
        {helperName ? (
          <>
            <span className="font-mono" title={helperName}>
              {helperName}
            </span>
            {!gone && (
              <>
                <Badge
                  variant={phase === 'Failed' ? 'destructive' : 'secondary'}
                  className={cn(running && 'bg-positive/10 text-positive')}
                >
                  {phase}
                </Badge>
                <GatedButton
                  allowed={allowed}
                  variant="ghost"
                  destructive
                  busy={destroying}
                  onClick={() => setConfirmDestroy(true)}
                  className="h-7"
                >
                  {destroying ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  {destroying ? t('shell:destroying') : t('shell:destroy')}
                </GatedButton>
              </>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">{t('shell:noHelper')}</span>
        )}
        {helperName && !running && gone && (
          <span className="text-muted-foreground">{t('shell:gone')}</span>
        )}
        {helperName && !running && !gone && (
          <span className="text-caution">
            {tf('shell:waiting', {
              phase,
              reason: waitingReason ? t('shell:reasonSep') + waitingReason : '',
            })}
          </span>
        )}
      </div>
      {timedOut && (
        <div className="rounded-md border border-caution/50 bg-caution/10 px-3 py-2 text-[13px] text-caution">
          {t('shell:waitTimeout')}
        </div>
      )}

      {running && helperName && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="shrink-0 text-muted-foreground">{t('shell:mode')}</span>
            <div className="flex shrink-0 gap-1">
              {(['nsenter', 'chroot'] as Mode[]).map(m => (
                <Button
                  key={m}
                  size="sm"
                  variant={mode === m ? 'secondary' : 'outline'}
                  className="h-7 px-2 text-xs"
                  onClick={() => setMode(m)}
                >
                  {t(m === 'nsenter' ? 'shell:modeNsenter' : 'shell:modeChroot')}
                </Button>
              ))}
            </div>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={t('shell:modeHint')}>
              {t('shell:modeHint')}
            </span>
          </div>
          {/* key 含 ns/Pod 名/进入方式：切方式或换 Pod 都重建终端，让 initialCommand 生效 */}
          <div className="min-h-0 flex-1">
            <TerminalView
              key={`${ns}/${helperName}/${mode}`}
              cluster={cluster}
              ns={ns}
              pod={helperName}
              containers={[SHELL_CONTAINER]}
              initial={SHELL_CONTAINER}
              initialCommand={mode === 'nsenter' ? HOST_NSENTER_CMD : HOST_CHROOT_CMD}
            />
          </div>
        </div>
      )}

      <AlertDialog open={confirmDestroy} onOpenChange={v => !destroying && setConfirmDestroy(v)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tf('shell:destroyTitle', { name: helperName ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('shell:destroyDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destroying}>{t('shell:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={destroying}
              onClick={e => {
                e.preventDefault()
                void doDestroy()
              }}
            >
              {destroying && <Loader2 className="size-3.5 animate-spin" />}
              {destroying ? t('shell:destroying') : t('shell:destroy')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
