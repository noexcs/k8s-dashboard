import { Check, FileQuestion, FileText, Loader2, PencilLine, RotateCcw } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { eventsPath, podsPath } from '@/api/client'
import type { Event, Pod } from '@/api/types'
import { usePermissions, type PermissionCheck } from '@/hooks/usePermissions'
import { usePodMetric } from '@/hooks/useMetrics'
import { Q, usePromRange, usePrometheus } from '@/hooks/usePrometheus'
import { PromTrend } from '@/components/PromTrend'
import { PortLinks } from '@/components/PortLinks'
import { SectionTitle } from '@/components/SectionTitle'
import { detailRoute, RESOURCE_MAP } from '@/resources/registry'
import { RelatedTab } from '@/features/resources/RelatedTab'

import { useWatch } from '@/hooks/useWatch'
import { age, cpuDisplay, fmtBytes, fmtCpu, fmtTime, parseQty, podHealth, shortTime } from '@/lib/format'
import { conditionBad, severityTone, toneChip, toneDot, toneText, type Tone } from '@/lib/tone'
import { useFlash } from '@/lib/useFlash'
import { cn } from '@/lib/utils'
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
import { GatedButton } from '@/components/GatedButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PodSpecSection } from '@/features/resources/PodSpecSection'
import { CodeBlockCopyButton } from '@/components/ui/code-block'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { tf, useLang, useT } from '@/i18n'
import { eventReasonLabel, eventTypeLabel } from '@/lib/eventL10n'
import { useYamlEdit, YamlEditor, YamlView } from '@/features/resources/YamlTab'
import { LogsView } from './LogsView'
import { FilesTab } from './FilesTab'
import { PodVolumesPanel } from './PodVolumesPanel'
import { PortForwardPanel } from './PortForwardPanel'
import { DebugDialog, allContainerNames } from './DebugDialog'
import { TerminalView } from './Terminal'

export function PodDetailPage() {
  const t = useT()
  const { lang } = useLang()
  const { cluster, ns, pod } = useParams()
  const { items, error, lastSync } = useWatch<Pod>({
    cluster: cluster!,
    path: podsPath(ns!),
    params: { fieldSelector: `metadata.name=${pod}` },
  })
  const podObj = items[0]

  const events = useWatch<Event>({
    cluster: cluster!,
    path: eventsPath(ns!),
    params: { fieldSelector: `involvedObject.name=${pod}` },
  })

  // YAML tab：RBAC（Apply 需 pods update）+ 共享 YAML 状态（查询/编辑/Apply/冲突）
  // 注意：与 useWatch 一样必须位于早退分支之前，否则 podObj 出现/消失时 hook 数量变化
  const checks = useMemo<PermissionCheck[]>(() => [
    { verb: 'update', group: '', version: 'v1', resource: 'pods', namespace: ns! },
  ], [ns])
  const { can } = usePermissions(cluster!, checks)
  const canUpdate = can(checks[0])
  // tab ↔ URL 双向：?tab= 派生 + replace 写回。此前只挂载时读一次——PortLinks 同页
  // 跳「端口转发」的链接、刷新、分享链接全部失效（同路由 query 变化不 remount）。
  const [sp, setSp] = useSearchParams()
  const tab = TAB_KEYS.includes(sp.get('tab') ?? '') ? (sp.get('tab') as string) : 'overview'
  const setTab = (v: string) =>
    setSp(s => { s.set('tab', v); return s }, { replace: true })
  // 调试：ephemeral 容器就绪后 → 终端 tab 选中它（key 变化重建终端）
  const [debugName, setDebugName] = useState<string | null>(null)
  const yaml = useYamlEdit({ cluster: cluster!, path: `${podsPath(ns!)}/${pod}` })
  // metrics-server 实时用量（Resources 卡 Usage 列）；无 metrics-server → 该列 '-'
  const podMetric = usePodMetric(cluster!, ns!, pod!)

  // 三态：error（RBAC/网络）→ 错误条；已同步但查无此 Pod → 404 空态；未同步 → 骨架
  if (error && !podObj) {
    return (
      <div className="rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-[13px] text-negative">
        {tf('pods:loadFailed', { error })}
      </div>
    )
  }
  if (!podObj) {
    if (lastSync) {
      return (
        <NotFound
          title={t('pods:podNotFound')}
          desc={tf('pods:podMaybeDeleted', { pod: `${ns}/${pod}` })}
          to={`/c/${cluster}/ns/${ns}/pods`}
        />
      )
    }
    return <DetailSkeleton />
  }

  const h = podHealth(podObj)
  const cs = podObj.status.containerStatuses ?? []
  const restarts = cs.reduce((n, c) => n + c.restartCount, 0)
  const owner = podObj.metadata.ownerReferences?.[0]
  // 健康 chip 统一语义 bg-{tone}/10 text-{tone}：灰 secondary 让 CrashLoop 和
  // Running 穿同一件衣服；tone 直接跟 podHealth 的状态点（Succeeded 维持中性灰）
  const chipTone: Tone =
    h.dot === 'bg-negative' ? 'negative' : h.dot === 'bg-caution' ? 'caution' : h.dot === 'bg-positive' ? 'positive' : 'muted'
  const warnCount = events.items.filter(e => e.type === 'Warning').length

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className={cn('size-2 shrink-0 rounded-full', h.dot)} />
        <h1 className="min-w-0 flex-1 truncate font-mono text-[16px] leading-none font-medium" title={podObj.metadata.name}>
          {podObj.metadata.name}
        </h1>
        <CodeBlockCopyButton value={podObj.metadata.name} className="shrink-0" aria-label={t('pods:copyPodName')} />
        <Badge variant="secondary" className={cn('shrink-0', toneChip[chipTone])}>
          {h.label}
        </Badge>
        {restarts > 0 && (
          <Badge variant="secondary" className={cn('shrink-0 tabular-nums', toneChip[restarts >= 3 ? 'negative' : 'caution'])}>
            <FlashVal v={restarts}>{tf('pods:restartsCount', { n: restarts })}</FlashVal>
          </Badge>
        )}
        {/* ns 删（面包屑已有）；节点名保留但变链接（概览唯一节点出口，历史裁决） */}
        <span className="shrink-0 text-[13px] text-muted-foreground">
          {t('pods:runningFor')} <span className="tabular-nums">{age(podObj.metadata.creationTimestamp)}</span>
        </span>
        {podObj.spec.nodeName && (
          <Link
            to={detailRoute(RESOURCE_MAP.Node!, cluster!, 'cluster', podObj.spec.nodeName)}
            className="max-w-56 shrink-0 truncate font-mono text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            title={podObj.spec.nodeName}
          >
            {podObj.spec.nodeName}
          </Link>
        )}
        {yaml.editing ? (
          <>
            <Button variant="outline" className="ml-auto shrink-0" onClick={yaml.discard} disabled={yaml.applying}>
              <RotateCcw />
              {t('res:discard')}
            </Button>
            <GatedButton
              allowed={canUpdate}
              variant="default"
              busy={yaml.applying}
              className="shrink-0"
              onClick={() => void yaml.doApply()}
            >
              {yaml.applying ? <Loader2 className="animate-spin" /> : <Check />}
              Apply
            </GatedButton>
          </>
        ) : (
          <>
            <DebugDialog
              cluster={cluster!}
              ns={ns!}
              pod={pod!}
              containers={podObj.spec.containers.map(c => c.name)}
              allowed={canUpdate}
              onStarted={name => {
                setDebugName(name)
                setTab('terminal')
              }}
            />
            <Button variant="outline" className="ml-auto shrink-0" onClick={() => setTab('yaml')}>
              <FileText />
              YAML
            </Button>
            <GatedButton
              allowed={canUpdate}
              className="shrink-0"
              onClick={() => {
                setTab('yaml')
                yaml.startEdit()
              }}
            >
              <PencilLine />
              {t('res:editYaml')}
            </GatedButton>
          </>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList variant="line" className="mb-3 w-full justify-start border-b">
          <TabsTrigger value="overview">{t('pods:tabOverview')}</TabsTrigger>
          <TabsTrigger value="conditions">{t('pods:tabConditions')}</TabsTrigger>
          <TabsTrigger
            value="events"
            className={cn(events.reconnecting && 'opacity-60', warnCount > 0 && 'text-caution')}
            title={warnCount > 0 ? tf('pods:tabEventsWarn', { n: warnCount }) : undefined}
          >
            {tf('pods:tabEvents', { n: events.items.length })}
          </TabsTrigger>
          <TabsTrigger value="logs">{t('pods:tabLogs')}</TabsTrigger>
          <TabsTrigger value="terminal">{t('pods:tabTerminal')}</TabsTrigger>
          <TabsTrigger value="files">{t('pods:tabFiles')}</TabsTrigger>
          <TabsTrigger value="volumes">{t('pods:tabVolumes')}</TabsTrigger>
          <TabsTrigger value="portforward">{t('pf:tabPortForward')}</TabsTrigger>
          <TabsTrigger value="monitor">{t('sys:tabMonitor')}</TabsTrigger>
          <TabsTrigger value="yaml">YAML</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="min-h-0 flex-1 space-y-3 overflow-auto">
          <Card>
            <CardContent className="pt-3">
              <div className="mb-3 flex items-baseline gap-2">
                <span className={cn('text-2xl leading-none font-medium tabular-nums', chipTone !== 'muted' && toneText[chipTone])}>
                  {cs.filter(c => c.ready).length}/{cs.length}
                </span>
                <span className="text-[13px] text-muted-foreground">{t('pods:readyContainers')}</span>
              </div>
              <dl className="grid grid-cols-1 gap-x-8 gap-y-0 text-[13px] leading-5 sm:grid-cols-2">
                <Item k="Phase" v={<FlashVal v={podObj.status.phase}>{podObj.status.phase}</FlashVal>} />
                <Item k="Pod IP" v={podObj.status.podIP ?? '-'} mono copy />
                <Item k="ServiceAccount" v={podObj.spec.serviceAccountName ?? '-'} />
                <Item k="QoS" v={podObj.status.qosClass ?? '-'} />
                <Item k={t('pods:createdAt')} v={fmtTime(podObj.metadata.creationTimestamp)} />
                <Item k="Owner" v={owner ? `${owner.kind}/${owner.name}` : '-'} />
                <Item k="UID" v={podObj.metadata.uid} mono copy />
                <Item k="Host IP" v={podObj.status.hostIP ?? '-'} mono copy />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-3">
              <SectionTitle>{tf('res:secCount', { title: t('pods:containersWord'), n: cs.length })}</SectionTitle>
              <div className="space-y-1">
                {cs.length === 0 && <div className="text-[13px] text-muted-foreground">{t('pods:containersWaiting')}</div>}
                {cs.map(c => {
                  const st = c.state
                  const stateText = st.running
                    ? 'Running'
                    : st.waiting
                      ? st.waiting.reason
                      : st.terminated
                        ? `Exit ${st.terminated.exitCode}`
                        : '-'
                  const lastExit = c.lastState?.terminated
                    ? tf('pods:lastExit', {
                        code: String(c.lastState.terminated.exitCode),
                        reason: c.lastState.terminated.reason ? `(${c.lastState.terminated.reason})` : '',
                        time: shortTime(c.lastState.terminated.finishedAt),
                      })
                    : null
                  return (
                    <div key={c.name} className="space-y-1">
                      <div className="flex items-center gap-3 rounded-md border px-3 py-2 text-[13px]">
                      <span
                        className={cn(
                          'size-2 shrink-0 rounded-full transition-colors duration-150',
                          c.ready
                            ? 'bg-positive'
                            : toneDot[severityTone(
                                st.waiting?.reason ??
                                  (st.terminated ? st.terminated.reason || `Exit ${st.terminated.exitCode}` : undefined),
                              )],
                        )}
                      />
                      <span className="w-44 min-w-0 shrink-0 truncate font-mono" title={c.name}>
                        {c.name}
                      </span>
                      <span
                        className={cn(
                          'w-28 shrink-0 truncate',
                          st.waiting || st.terminated
                            ? st.terminated?.exitCode === 0
                              ? toneText.positive
                              : toneText[severityTone(st.waiting?.reason ?? st.terminated?.reason)]
                            : '',
                        )}
                        title={stateText}
                      >
                        <FlashVal v={stateText}>{stateText}</FlashVal>
                      </span>
                      {lastExit && (
                        // 崩溃循环的第一证据:上次退出码/原因/时刻(定宽列,截断有 title 兜底)
                        <span className="hidden w-44 shrink-0 truncate font-mono text-xs tabular-nums text-muted-foreground md:block" title={lastExit}>
                          {lastExit}
                        </span>
                      )}
                      <span className={cn('w-16 shrink-0 text-right tabular-nums', c.restartCount >= 3 ? 'text-negative' : c.restartCount > 0 ? 'text-caution' : '')}>
                        <FlashVal v={c.restartCount}>{tf('pods:restartsInline', { n: c.restartCount })}</FlashVal>
                      </span>
                      <span className="hidden min-w-0 flex-1 truncate text-muted-foreground sm:block" title={c.image}>
                        {c.image}
                      </span>
                    </div>
                      {st.waiting?.message ? (
                        <pre className="overflow-x-auto rounded-md border border-negative/20 bg-card p-2 font-mono text-[13px] leading-4 text-negative">{st.waiting.message}</pre>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          <PortLinks
            cluster={cluster!}
            ns={ns!}
            name={pod!}
            kind="Pod"
            ports={podObj.spec.containers.flatMap(c => (c.ports ?? []).map(p => ({ port: p.containerPort, name: p.name, protocol: p.protocol })))}
          />

          {podObj.spec.containers.length > 0 && <ResourcesCard pod={podObj} usage={podMetric.data?.containers} />}

          {(podObj.metadata.ownerReferences?.length ?? 0) > 0 && (
            <RelatedTab cluster={cluster!} ns={ns!} owners={podObj.metadata.ownerReferences as { kind: string; name: string }[] | undefined} matchLabels={undefined} />
          )}

          {/* 语义密度：探针/env/挂载/调度全摊开（与工作负载详情页同构组件，kind=Pod 直取 spec） */}
          <PodSpecSection obj={podObj as unknown as Record<string, unknown>} kind="Pod" cluster={cluster!} />
        </TabsContent>

        <TabsContent value="conditions" className="min-h-0 flex-1 overflow-auto">
          {(podObj.status.conditions ?? []).length > 0 ? (
            <div className="space-y-1">
              {(podObj.status.conditions ?? []).map(c => (
                <div key={c.type} className={cn('flex items-center gap-3 rounded-md border px-3 py-2 text-[13px]', conditionBad(c.type, c.status) && 'border-l-2 border-l-negative/70 bg-negative/[0.04]')}>
                  <span className="min-w-40 shrink-0 font-medium" title={c.type}>
                    {c.type}
                  </span>
                  <span
                    className={cn(
                      'w-12 shrink-0',
                      conditionBad(c.type, c.status) ? toneText.negative : c.status === 'True' ? toneText.positive : toneText.caution,
                    )}
                  >
                    <FlashVal v={c.status}>{c.status}</FlashVal>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{fmtTime(c.lastTransitionTime)}</span>
                  <span className="min-w-0 flex-1 truncate" title={c.message}>
                    {c.reason && <span className="mr-2 font-medium">{eventReasonLabel(c.reason, lang)}</span>}
                    {c.message}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-full min-h-32 items-center justify-center text-[13px] text-muted-foreground">
              {t('pods:noConditions')}
            </div>
          )}
        </TabsContent>

        <TabsContent value="events" className="min-h-0 flex-1 overflow-auto">
          {events.error != null && events.items.length === 0 ? (
            // RBAC/网络失败不能渲染成「该 Pod 暂无事件」——事件正是无权限排障时最想看的
            <div className="rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-[13px] text-negative">
              {tf('pods:loadFailed', { error: events.error })}
            </div>
          ) : events.items.length > 0 ? (
            <div className="space-y-1">
              {events.reconnecting && (
                // watch 断线时必须可见：否则「没有新事件」会被读成「没再发生」（与 RDP EventsTab 同口径）
                <div className="rounded-md border border-border/50 px-3 py-2 text-[13px] text-muted-foreground">{t('res:eventsReconnecting')}</div>
              )}
              {(() => {
                // crash-loop 集群事件轻松数百条:封顶 100 + 如实尾注(同 RelatedTab slice 封顶口径)
                const evs = events.items
                  .slice()
                  .sort((a, b) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? ''))
                return (
                  <>
              {evs.slice(0, 100).map(e => (
                  <div
                    key={e.metadata.uid}
                    className={cn(
                      'animate-in fade-in-0 rounded-md border p-2 text-[13px] duration-150',
                      e.type === 'Warning'
                        ? 'border-caution/30 bg-caution/5'
                        : 'border-border/50',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'w-14 shrink-0',
                          e.type === 'Warning' ? 'text-caution' : 'text-muted-foreground',
                        )}
                      >
                        {eventTypeLabel(e.type, lang)}
                      </span>
                      <span className="min-w-0 truncate font-medium" title={e.reason}>
                        {eventReasonLabel(e.reason, lang)}
                      </span>
                      {(e.count ?? 0) > 1 && (
                        <span className="shrink-0 tabular-nums text-muted-foreground">×{e.count}</span>
                      )}
                      {/^spec\.containers/.test(e.involvedObject.fieldPath ?? '') && (
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">· {e.involvedObject.fieldPath!.replace(/^spec\.containers[({/]?/, '').replace(/[)}]$/, '')}</span>
                      )}
                      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground" title={fmtTime(e.lastTimestamp)}>
                        {age(e.lastTimestamp)}
                      </span>
                    </div>
                    <div className="mt-1 break-words">{e.message}</div>
                  </div>
                ))}
                    {evs.length > 100 && (
                      <div className="py-1 text-center text-[12px] text-muted-foreground">{tf('res:eventsCapped', { m: 100, n: evs.length })}</div>
                    )}
                  </>
                )
              })()}
            </div>
          ) : (
            <div className="flex h-full min-h-32 items-center justify-center text-[13px] text-muted-foreground">
              {t('pods:noEvents')}
            </div>
          )}
        </TabsContent>

        <TabsContent value="logs" className="min-h-0 flex-1">
          <LogsView
            cluster={cluster!}
            ns={ns!}
            pod={pod!}
            containers={podObj.spec.containers.map(c => c.name)}
          />
        </TabsContent>

        <TabsContent value="terminal" className="min-h-0 flex-1">
          <TerminalView
            key={debugName ?? 'main'}
            initial={debugName ?? undefined}
            cluster={cluster!}
            ns={ns!}
            pod={pod!}
            containers={allContainerNames(podObj)}
          />
        </TabsContent>

        <TabsContent value="files" className="min-h-0 flex-1">
          <FilesTab
            cluster={cluster!}
            ns={ns!}
            pod={pod!}
            containers={allContainerNames(podObj)}
          />
        </TabsContent>

        <TabsContent value="volumes" className="min-h-0 flex-1 overflow-auto">
          <PodVolumesPanel cluster={cluster!} ns={ns!} pod={podObj as unknown as Record<string, unknown>} />
        </TabsContent>

        <TabsContent value="portforward" className="min-h-0 flex-1 overflow-auto">
          <PortForwardPanel
            cluster={cluster!}
            ns={ns!}
            pod={pod!}
            ports={podObj.spec.containers.flatMap(c => (c.ports ?? []).map(p => ({ port: p.containerPort, name: p.name, protocol: p.protocol })))}
          />
        </TabsContent>

        <TabsContent value="monitor" className="min-h-0 flex-1 overflow-auto">
          <PodMonitor cluster={cluster!} ns={ns!} pod={pod!} />
        </TabsContent>

        <TabsContent value="yaml" className="min-h-0 flex-1 overflow-auto">
          {yaml.applyError && (
            <div className="mb-2 rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-[13px] text-negative">
              {yaml.applyError}
            </div>
          )}
          {yaml.editing && (
            <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[13px] text-muted-foreground">
              <PencilLine className="size-3.5" />
              {t('res:editingHint')}
            </div>
          )}
          {yaml.isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">{t('res:loading')}</div>
          ) : yaml.error ? (
            <div className="rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-[13px] text-negative">
              {tf('res:loadFailed', { msg: yaml.error.message })}
            </div>
          ) : yaml.editing ? (
            <YamlEditor
              value={yaml.draft}
              onChange={yaml.setDraft}
              title={`Pod/${pod}`}
              filename={`pod-${pod}.yaml`}
            />
          ) : (
            yaml.yamlText && <YamlView yamlText={yaml.yamlText} kind="Pod" name={pod!} />
          )}
          {/* 409 冲突对话框：与通用详情页同款，重新加载后放弃本地草稿 */}
          <AlertDialog open={yaml.conflict} onOpenChange={yaml.setConflict}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('res:resourceChangedTitle')}</AlertDialogTitle>
                <AlertDialogDescription>{t('res:resourceChangedDesc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('res:cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={yaml.reloadYaml}>{t('res:reload')}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** 监控 tab：Prometheus 按容器的 CPU/内存区间趋势。未配置/不可达 → 引导空态。 */
function PodMonitor({ cluster, ns, pod }: { cluster: string; ns: string; pod: string }) {
  const t = useT()
  const { cfg, reachable } = usePrometheus(cluster)
  const RANGE = 3600
  const cpu = usePromRange(cluster, reachable ? cfg : null, reachable ? Q.podCpu(ns, pod) : null, RANGE)
  const mem = usePromRange(cluster, reachable ? cfg : null, reachable ? Q.podMem(ns, pod) : null, RANGE)
  if (!cfg) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t('sys:promNotConfigured')}</EmptyTitle>
          <EmptyDescription>{t('sys:promConfigHint')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link to={`/c/${cluster}/settings`} className="text-[13px] text-primary underline">
            {t('sys:promGoSettings')}
          </Link>
        </EmptyContent>
      </Empty>
    )
  }
  if (!reachable) return <div className="px-2 py-6 text-center text-[13px] text-muted-foreground">{t('sys:promUnreachable')}</div>
  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="pt-3">
          <SectionTitle>{t('sys:promCpuPer')}</SectionTitle>
          <PromTrend series={cpu.data ?? []} unit="" valueFmt={v => `${v.toFixed(3)}c`} error={cpu.isError} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-3">
          <SectionTitle>{t('sys:promMemPer')}</SectionTitle>
          <PromTrend series={mem.data ?? []} unit="" valueFmt={v => `${(v / 1048576).toFixed(1)} Mi`} error={mem.isError} />
        </CardContent>
      </Card>
    </div>
  )
}

function Item({ k, v, mono, copy }: { k: string; v: ReactNode; mono?: boolean; copy?: boolean }) {
  // 96px 定宽左网格（PodSpecSection 红线同款）：同页两套「标签:值」扫描线会打架；
  // mono 值统一 12px（与 RDP dd / PodSpecSection 对齐，跨页同串同宽）
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-x-2">
      <dt className="truncate text-muted-foreground" title={k}>
        {k}
      </dt>
      <dd className={cn('flex min-w-0 items-center gap-1', mono && 'font-mono text-xs')} title={typeof v === 'string' ? v : undefined}>
        <span className="min-w-0 truncate">{v}</span>
        {copy && typeof v === 'string' && v !== '-' && (
          <CodeBlockCopyButton value={v} className="shrink-0" aria-label={k} />
        )}
      </dd>
    </div>
  )
}

const TAB_KEYS = ['overview', 'conditions', 'events', 'logs', 'terminal', 'files', 'volumes', 'portforward', 'monitor', 'yaml']

/** useFlash 接线点：watch 推送真实变化时 currentColor 闪一下（静态文本勿接） */
function FlashVal({ v, children }: { v: unknown; children: ReactNode }) {
  const { flash, onEnd } = useFlash(v)
  return (
    <span data-flash={flash || undefined} onAnimationEnd={onEnd}>
      {children}
    </span>
  )
}

function ResourcesCard({ pod, usage }: { pod: Pod; usage?: Array<{ name: string; usage?: Record<string, string> }> }) {
  const t = useT()
  const byName = new Map((usage ?? []).map(c => [c.name, c]))
  return (
    <Card>
      <CardContent className="pt-3">
        <SectionTitle>{t('pods:resources')}</SectionTitle>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 font-medium">{t('pods:colContainer')}</th>
              <th className="py-1 font-medium">{t('pods:colCpuReqLimit')}</th>
              <th className="py-1 font-medium">{t('pods:colMemory')}</th>
              <th className="py-1 text-right font-medium">{t('sys:colUsage')}</th>
            </tr>
          </thead>
          <tbody className="font-mono text-xs">
            {pod.spec.containers.map(c => {
              const u = byName.get(c.name)
              const cpuU = parseQty(u?.usage?.cpu)
              const memU = parseQty(u?.usage?.memory)
              // 用量对 limit(无 limit 退 request)占比:免心算,80/100 阈值配色
              const cpuRef = parseQty(c.resources?.limits?.cpu) ?? parseQty(c.resources?.requests?.cpu)
              const memRef = parseQty(c.resources?.limits?.memory) ?? parseQty(c.resources?.requests?.memory)
              const pct = (v: number | null, r: number | null) => (v != null && r ? Math.round((v / r) * 100) : null)
              const cpuPct = pct(cpuU, cpuRef)
              const memPct = pct(memU, memRef)
              const pctCls = (p: number | null) => (p == null ? 'text-muted-foreground' : p >= 100 ? 'text-negative' : p >= 80 ? 'text-caution' : 'text-muted-foreground')
              return (
                <tr key={c.name} className="border-t border-border/50">
                  <td className="py-1.5">{c.name}</td>
                  <td className="py-1.5">
                    {c.resources?.requests?.cpu ? cpuDisplay(c.resources.requests.cpu) : '-'} /{' '}
                    {c.resources?.limits?.cpu ? cpuDisplay(c.resources.limits.cpu) : '-'}
                  </td>
                  <td className="py-1.5">
                    {c.resources?.requests?.memory ?? '-'} / {c.resources?.limits?.memory ?? '-'}
                  </td>
                  <td className="py-1.5 text-right whitespace-nowrap tabular-nums">
                    {cpuU != null || memU != null ? (
                      <>
                        {fmtCpu(cpuU)} <span className="text-muted-foreground">·</span> {fmtBytes(memU)}
                        <span className={cn('ml-1.5', pctCls(cpuPct))}>{cpuPct ?? '-'}%</span>
                        <span className="text-muted-foreground">/</span>
                        <span className={pctCls(memPct)}>{memPct ?? '-'}%</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

/** 详情加载骨架（watch 首帧未到达） */
function DetailSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Skeleton className="size-2 rounded-full" />
        <Skeleton className="h-5 w-72" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Skeleton className="h-8 w-full max-w-md" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

/** 资源不存在（404）：明确空态 + 返回链接 */
function NotFound({ title, desc, to }: { title: string; desc: string; to: string }) {
  const t = useT()
  return (
    <div className="flex h-full items-center justify-center">
      <Empty className="gap-3">
        <EmptyHeader className="gap-2">
          <EmptyMedia variant="icon">
            <FileQuestion />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription className="text-[13px]">{desc}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="gap-2">
          <Button variant="outline" asChild>
            <Link to={to}>{t('pods:backToList')}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}
