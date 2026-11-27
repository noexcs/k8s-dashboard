// 集群巡检（/c/:cluster/inspect）：一键全集群异常清单 + 与上次 diff——AI 值班化的手动档。
// 报告由 ai-exec 规则扫描产出（不经 LLM）；条目行直接接处置原语（详情跳转/问 AI/标记处置），
// 历史下拉回看落盘的旧报告；处置状态（已处置/忽略）落盘 dispositions.jsonl——
// 交接班要回答「哪些异常是已认领的」，没有这一层恢复名单跑完下一轮就永久消失。
import { useEffect, useRef, useState } from 'react'
import { NavLink, useParams, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, Ban, CalendarClock, CheckCheck, Download, History, Link2, Loader2, MessageSquareText, Radar, X } from 'lucide-react'
import { tf, useT } from '@/i18n'
import { clipboardWrite } from '@/lib/clipboard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { dispStale } from '@/lib/disp'
import { shortTime } from '@/lib/format'
import { RESOURCE_MAP, detailRoute } from '@/resources/registry'
import { askAi } from '@/features/ai/askBus'

interface Entry {
  ns?: string
  name?: string
  kind?: string
  /** 后端 findingKey 产出的处置键单一真源（前端 dispKey 仅为旧报告兜底） */
  key?: string
  [k: string]: unknown
  /** 对象 conditions 最近转态时间（inspect.js 产出）：认领是否作废的共用判据输入 */
  lt?: string
}
interface Finding {
  id: string
  entries: Entry[]
}
interface Report {
  generatedAt: string
  cluster?: string
  findings: Finding[]
  notes: string[]
  truncatedSections?: string[]
  diff?: { hasPrev: boolean; added: string[]; resolved: string[]; prevGeneratedAt?: string | null }
}
interface ReportResp {
  report?: Report
  diff?: { hasPrev: boolean; added: string[]; resolved: string[]; prevGeneratedAt?: string | null }
  error?: string
}
type DispState = 'acked' | 'ignored'
interface AuditLite {
  ts?: string
  actor?: string
  verb?: string
  kind?: string
  ns?: string
  name?: string
  cluster?: string
  source?: string
  target?: string
  summary?: string
}

/** 六类发现的标题与列（顺序 = 严重度直觉：负载→Pod→节点→事件→Job→Cron） */
const SECTIONS: Record<string, { title: string; cols: [string, string][]; kind?: string }> = {
  'unready-workloads': { title: 'inspect:secUnready', cols: [['kind', 'Kind'], ['ready', 'Ready']] },
  'abnormal-pods': { title: 'inspect:secPods', cols: [['phase', 'Phase'], ['reason', 'Reason']], kind: 'Pod' },
  'node-issues': { title: 'inspect:secNodes', cols: [['ready', 'Ready'], ['pressures', 'Pressure']], kind: 'Node' },
  'warning-events': { title: 'inspect:secWarnings', cols: [['kind', 'Kind'], ['reason', 'Reason'], ['count', 'Count']], kind: '' },
  'failed-jobs': { title: 'inspect:secJobs', cols: [['reason', 'Reason']], kind: 'Job' },
  'running-jobs': { title: 'inspect:secRunningJobs', cols: [['ready', 'Ready']], kind: 'Job' },
  'suspended-crons': { title: 'inspect:secCrons', cols: [], kind: 'CronJob' },
  'tls-certs-expiring': { title: 'inspect:secTlsCerts', cols: [['reason', 'Expiry']], kind: 'Secret' },
  'quota-pressure': { title: 'inspect:secQuotaPressure', cols: [['ready', 'Pressure']], kind: 'ResourceQuota' },
}

/** 段默认 kind（条目自带 kind 优先）：CRD 之外的六个固定段 */
function entryKind(sectionId: string, e: Entry): string | undefined {
  return e.kind ?? SECTIONS[sectionId]?.kind
}

/** 处置键与后端 findingKey 严格同构（`section/ns/kind/name`，warning 段尾拼 reason）——两侧不一致会静默错位 */
export const dispKey = (sectionId: string, e: Entry): string =>
  `${sectionId}/${e.ns ?? ''}/${e.kind ?? ''}/${e.name ?? ''}${sectionId === 'warning-events' ? `|${String(e.reason ?? '')}` : ''}`

/** diff 键 `section/ns/kind/name` → 详情路由（kind 缺段解析不出即纯文本） */
function diffKeyRoute(key: string, cluster: string): string | null {
  const [section, ns, kind, ...rest] = key.split('/')
  const name = rest.join('/')
  const k = kind || SECTIONS[section]?.kind
  const def = k ? RESOURCE_MAP[k] : undefined
  if (!def || !name) return null
  return detailRoute(def, cluster, ns || 'cluster', name)
}

export function InspectPage() {
  const t = useT()
  const { cluster } = useParams()
  // 巡检是昂贵动作：不自动跑，首屏空态按「开始巡检」；rerun 换 nonce
  const [sp, setSp] = useSearchParams()
  // 切集群 = 回到「未开始」：巡检昂贵是本页自设前提，路由原地换 cluster 不得静默触发新集群全量扫描
  useEffect(() => {
    setStarted(false)
    setViewOld(null)
    setRecurOnly(false)
    setHideAcked(false)
    setNotePrompt(null)
  }, [cluster])
  const [nonce, setNonce] = useState(0)
  const [started, setStarted] = useState(false)
  // 历史下拉选中的旧报告（null = 显示本次运行结果；diff 只属于最新一档）
  const [viewOld, setViewOld] = useState<Report | null>(null)
  // 「已处置/忽略」默认仍显示（灰显）——它们是需要偶尔复查的对象，不是要消失的噪声
  const [hideAcked, setHideAcked] = useState(false)
  const [recurOnly, setRecurOnly] = useState(false)
  const q = useQuery({
    queryKey: ['inspect', cluster, nonce],
    queryFn: () => fetch(`/ai/inspect?cluster=${encodeURIComponent(cluster ?? '')}`).then((r) => r.json() as Promise<ReportResp>),
    enabled: started,
    retry: 0,
    // rerun 换 key 时保留旧报告占位：否则「巡检中」这段最长等待恰恰全白
    placeholderData: keepPreviousData,
  })
  // 历史报告：reports.jsonl 已有数据才有意义，页面一开就拉（纯读、体量小）
  const history = useQuery({
    queryKey: ['inspect-reports', cluster],
    queryFn: () => fetch(`/ai/reports?cluster=${encodeURIComponent(cluster ?? '')}`).then((r) => r.json() as Promise<{ items: Report[] }>),
    retry: 0,
    // 后台定时扫描 30 分钟一档；读档中的页面要能发现「盘上有更新的报告」
    refetchInterval: 60_000,
  })
  // 处置状态：page 开就拉（体量 ≤ 键数，纯读）
  const disp = useQuery({
    queryKey: ['dispositions', cluster],
    queryFn: () =>
      fetch(`/ai/disposition?cluster=${encodeURIComponent(cluster ?? '')}`).then(
        (r) => r.json() as Promise<{ items: { key: string; state: DispState; note?: string; ts?: string }[] }>,
      ),
    retry: 0,
  })
  // 「恢复」名单 join 审计：恢复多半是某次变更修好的，名单旁直显疑似关联变更
  const auditRel = useQuery({
    queryKey: ['audit-rel', cluster, viewOld?.diff?.prevGeneratedAt ?? q.data?.diff?.prevGeneratedAt ?? null],
    queryFn: () => {
      const p = new URLSearchParams({ limit: '300', cluster: cluster ?? '' })
      const since = viewOld?.diff?.prevGeneratedAt ?? q.data?.diff?.prevGeneratedAt
      if (since) p.set('since', since)
      return fetch(`/ai/audit?${p}`).then((r) => r.json() as Promise<{ items: AuditLite[] }>)
    },
    retry: 0,
    staleTime: 30_000,
  })
  const report = viewOld ?? q.data?.report
  // 读档语义分岔：最新落盘（默认档）≠ 历史快照（caution 只留给真历史）
  const isLatestSaved = !!viewOld && viewOld.generatedAt === history.data?.items?.[0]?.generatedAt
  const bgNewerReport = !isLatestSaved && !!viewOld && !!history.data?.items?.[0] && history.data.items[0].generatedAt !== viewOld.generatedAt
    ? history.data.items[0].generatedAt
    : null
  // 读档模式消费落盘 diff（报告自带）：首页 +N chip 落地后新增标记/复发角标/归因不蒸发
  const diff = viewOld ? viewOld.diff : q.data?.diff
  // 归因窗口下界：live/落盘 diff 都携带（旧落盘报告缺省则不设下界，仍严于全局）
  const attrSince = diff?.prevGeneratedAt ?? undefined

  // 每次巡检成功服务端都已落盘新报告，历史下拉必须跟上（否则跑完最新一档仍是旧的）
  const queryClient = useQueryClient()
  useEffect(() => {
    if (q.data?.report) void queryClient.invalidateQueries({ queryKey: ['inspect-reports', cluster] })
  }, [q.data, queryClient, cluster])

  const dispList = disp.data?.items ?? []
  const dispMap = new Map(dispList.map((d) => [d.key, d.state]))
  const dispTsMap = new Map(dispList.map((d) => [d.key, d.ts]))
  // 认领作废（处置后对象又转态）单一判据来自 lib/disp——首页 claimedOf 同源。
  // 此前巡检页四处分流只认 added：同一键首页判「认领已过期/未认领待办」，
  // 本页却按旧结论灰显、能藏进「隐藏已处置」、还被批量 ack 排除——两页相反结论
  const claimInvalid = (key: string, e: Entry) => !!dispTsMap.get(key) && dispStale(dispTsMap.get(key), e.lt)
  const staleClaimKeys = new Set(
    (report?.findings ?? []).flatMap((f) => (f.entries ?? []).filter((e) => dispMap.has(e.key ?? dispKey(f.id, e)) && claimInvalid(e.key ?? dispKey(f.id, e), e)).map((e) => e.key ?? dispKey(f.id, e))),
  )
  // 「复发」=处置过又回到 added ∪ 认领已作废；chip 计数/过滤/行内角标共用，两页同判据
  const recurKeys = new Set([...((diff?.added ?? []).filter((k) => dispMap.has(k))), ...staleClaimKeys])
  const recurActive = recurOnly && recurKeys.size > 0
  const dispNote = new Map(dispList.map((d) => [d.key, d.note]))
  const dispTs = new Map(dispList.map((d) => [d.key, d.ts]))
  // ignored 那一跳自动摊开备注弹层（默认摊开、允许跳过——必填会赶走用户）
  const [notePrompt, setNotePrompt] = useState<string | null>(null)
  // 通知深链 ?focus= 落在「无处置态」的行上此前什么都不发生：高亮 + 滚到，
  // 把人从「在 60 行报告里肉眼对 key」里解放出来
  useEffect(() => {
    if (!notePrompt) return
    const target = [...document.querySelectorAll('[data-focuskey]')].find((n) => n.getAttribute('data-focuskey') === notePrompt)
    if (target && !dispMap.get(notePrompt)) {
      target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notePrompt, report])
  const [markErr, setMarkErr] = useState(false)
  // 在途/失败计数：批量 ack 部分失败要指认条数，且全部完成后自动收敛——
  // 只置位不收敛的红幅会永久驻留，把之后的正常操作全染成假警报
  const inflight = useRef({ n: 0, failed: 0 })
  const mark = (key: string, state: DispState | 'none', note?: string) => {
    // 乐观改本地缓存：处置是小写高频动作，等 RTT 会连点错位
    queryClient.setQueryData<{ items: { key: string; state: DispState; note?: string }[] }>(['dispositions', cluster], (old) => ({
      items: state === 'none' ? (old?.items ?? []).filter((i) => i.key !== key) : [...(old?.items ?? []).filter((i) => i.key !== key), { key, state, note }],
    }))
    inflight.current.n += 1
    void fetch('/ai/disposition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cluster: cluster ?? 'default',
        key,
        state,
        ...(note ? { note } : {}),
        // 「谁把这条异常判成忽略」也是责任账（与 UI 写/交接同一署名来源）
        ...(localStorage.getItem('k8s-oncall') ? { actor: localStorage.getItem('k8s-oncall') } : {}),
      }),
    })
      // 失败必须可见并回滚重拉：只读挂载下乐观态会一直假装「已处置」到下次刷新
      .then((r) => { if (!r.ok) throw new Error(String(r.status)) })
      .catch(() => {
        inflight.current.failed += 1
        void queryClient.invalidateQueries({ queryKey: ['dispositions', cluster] })
      })
      .finally(() => {
        inflight.current.n -= 1
        if (inflight.current.n === 0) {
          setMarkErr(inflight.current.failed > 0)
          inflight.current.failed = 0
        }
      })
  }

  // 交班窗口可择：'8h' 对齐班次语义（默认）、'day' 今天零点、'scan' 上次巡检以来（旧行为，保留）
  const [exportWin, setExportWin] = useState<'8h' | 'day' | 'scan'>('8h')
  const recentHandovers = useQuery({
    queryKey: ['handover-list', cluster],
    queryFn: () => fetch(`/ai/handover?cluster=${encodeURIComponent(cluster ?? '')}`).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json() as Promise<{ items: { id: string; ts: string; window?: string; actor?: string; ackedBy?: string; ackedTs?: string }[] }>
  }),
    retry: 0,
    staleTime: 30_000,
  })
  // 周回看最小账：日摘要 7 行（明细 20 份配额之外），异常水位一眼可读
  const dailyQ = useQuery({
    queryKey: ['inspect-daily', cluster],
    queryFn: () => fetch(`/ai/inspect/daily?cluster=${encodeURIComponent(cluster ?? '')}`).then((r) => r.json() as Promise<{ items: { date: string; findings: number; added: string[]; resolved: string[]; worst?: string[]; water?: { pctCpu: number | null; pctMem: number | null } }[] }>),
    retry: 0,
    staleTime: 60_000,
  })
  const [savedLink, setSavedLink] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
  const [failNote, setFailNote] = useState('')
  const [saving, setSaving] = useState(false)
  const buildMd = async (): Promise<{ md: string; winLabel: string } | null> => {
    if (!report) return null
    const base = `${location.origin}/c/${cluster}`
    // 窗口独立取数，不蹭 diff 归因查询（那只有 ~30 分钟，对 8 小时班次谎报完整）
    const winSince =
      exportWin === 'scan'
        ? (report.diff?.prevGeneratedAt ?? undefined)
        : exportWin === '8h'
          ? new Date(Date.now() - 8 * 3600_000).toISOString()
          : new Date(new Date().setHours(0, 0, 0, 0)).toISOString()
    const winLabel =
      exportWin === 'scan' ? t('inspect:winScan') : exportWin === '8h' ? t('inspect:win8h') : t('inspect:winDay')
    let auditItems: AuditLite[] = []
    try {
      const p = new URLSearchParams({ limit: '300', cluster: cluster ?? '' })
      if (winSince) p.set('since', winSince)
      auditItems = ((await (await fetch(`/ai/audit?${p}`)).json()) as { items?: AuditLite[] }).items ?? []
    } catch { /* 审计取数失败不拦导出 */ }
    // 窗口标注写进接收人手里的那份文件：无标注=接收方无从知道覆盖面。
    // 两段新鲜度也必须标注：异常清单=当前视图快照（可能几小时前），变更/待裁决=导出时刻
    const snapGap = Date.now() - new Date(report.generatedAt).getTime()
    const lines = [
      `# ${t('inspect:title')} · ${cluster ?? ''} · ${shortTime(report.generatedAt)}`,
      '',
      `> ${tf('inspect:mdWindow', { win: winLabel })}`,
      ...(snapGap > 2 * 60_000 ? [`> ${tf('inspect:mdSnapshot', { time: shortTime(report.generatedAt) })}`] : []),
      '',
    ]
    for (const f of report.findings) {
      if ((f.entries ?? []).length === 0) continue
      lines.push(`## ${t(SECTIONS[f.id]?.title ?? f.id)} (${(f.entries ?? []).length})`)
      for (const e of f.entries ?? []) {
        const st = dispMap.get(e.key ?? dispKey(f.id, e))
        const markSuffix = st ? ` [${st === 'acked' ? t('inspect:acked') : t('inspect:ignored')}${dispNote.get(e.key ?? dispKey(f.id, e)) ? `: ${dispNote.get(e.key ?? dispKey(f.id, e))}` : ''}]` : ''
        lines.push(`- ${e.ns ? `${e.ns}/` : ''}${e.name} ${Object.values(Object.fromEntries((SECTIONS[f.id]?.cols ?? []).map(([k]) => [k, e[k]]) ?? []))}`.trim() + markSuffix)
      }
      lines.push('')
    }
    // 交班包补两段「最需要口头补充」的信息：窗口内改了什么（AI 条目带会话深链）、还有什么等人拍板
    if (auditItems.length > 0) {
      lines.push(`## ${t('inspect:changesSection')}`)
      for (const a of auditItems.slice(0, 60)) {
        const sess = a.source === 'ai' && a.actor ? ` [${t('inspect:mdSession')}](${base}/ai?session=${a.actor})` : ''
        lines.push(`- \`${shortTime(a.ts)}\` [${a.source === 'ai' ? 'AI' : 'UI'}] ${a.verb} ${a.target ?? ''}${a.summary ? ` — ${a.summary}` : ''}${sess}`)
      }
      // 截断必须显式（inspect.js truncNote 同纪律）：交班文档恰恰最不能漏账
      if (auditItems.length > 60) lines.push(`> ${tf('inspect:mdAuditTrunc', { shown: 60, total: auditItems.length })} ${base}/audit`)
      lines.push('')
    }
    // 待裁决=下一班真待办：**全集群**（接手人轮值多集群时别漏他山的）+ 直达裁决深链
    try {
      const pend = (await (await fetch('/ai/pending')).json() as { items: { toolName: string; sessionId: string; expiresAt: number; cluster?: string }[] }).items
      if (pend.length > 0) {
        lines.push(`## ${t('inspect:pendingSection')}`)
        for (const p of pend) {
          // 深链用 pending 项**自身集群**：全集群拉取配当前集群路由，B 集群审批点进 A 集群空会话=「会话丢了」假象
          const link = p.sessionId ? ` [${t('inspect:mdAdjudicate')}](${location.origin}/c/${encodeURIComponent(p.cluster || cluster || '')}/ai?session=${p.sessionId})` : ''
          lines.push(`- ${p.toolName} @${p.cluster || cluster}（会话 ${p.sessionId.slice(0, 8)}，${new Date(p.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })} 前未裁决则自动拒绝）${link}`)
        }
        lines.push('')
      }
    } catch { /* 待裁决取数失败不阻断导出 */ }
    return { md: lines.join('\n'), winLabel }
  }

  const exportMd = async () => {
    const built = await buildMd()
    if (!built || !report) return
    const url = URL.createObjectURL(new Blob([built.md], { type: 'text/markdown' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `inspect-${cluster}-${report.generatedAt.slice(0, 16)}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  // 交接落盘：此前交班是全产品唯一离开 URL 网络的产物（本地文件 + IM 传输 + 无回执）。
  // 落盘后有深链、接班确认进审计——「交接发生过」从此有账
  const saveHandover = async () => {
    if (saving) return
    setSaving(true) // 置位在 await 之前：buildMd 有两次网络往返，窗口内双击=双份文档+双条审计
    try {
      const built = await buildMd()
      if (!built) {
        setSaving(false)
        return
      }
      const r = await fetch('/ai/handover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cluster: cluster ?? 'default', md: built.md, window: built.winLabel, ...(localStorage.getItem('k8s-oncall') ? { actor: localStorage.getItem('k8s-oncall') } : {}) }),
      })
      // 透传服务端诊断：只读挂载的 500 与服务不可达是两个处方，别押宝
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${r.status}`)
      const { id } = (await r.json()) as { id: string }
      const link = `${location.origin}/c/${encodeURIComponent(cluster ?? '')}/handover/${id}`
      // HTTP 部署（本产品样板形态）无 clipboard API：复制失败必须如实分岔，
      // 谎报「链接已复制」= 交班人以为链接已到手，接班人根本没收到
      let copied = false
      try {
        // clipboardWrite 内含 http 非安全上下文的 execCommand 兜底；
        // 仍失败（浏览器连 execCommand 都拒）才落手动态，绝不谎报「已复制」
        await clipboardWrite(link)
        copied = true
      } catch { /* 浏览器拒绝写入：走手动复制态 */ }
      setLinkCopied(copied)
      setSavedLink(link)
    } catch (e) {
      setFailNote(e instanceof Error ? e.message.slice(0, 80) : '')
      setSavedLink('__fail')
    } finally {
      setSaving(false)
    }
  }

  // 默认读档：值班到某集群巡检页第一眼=最近一次扫描结果，而不是先逼跑一次全量
  const autoViewRef = useRef('')
  useEffect(() => {
    const latest = history.data?.items?.[0]
    if (!started && !viewOld && latest && autoViewRef.current !== (cluster ?? '')) {
      autoViewRef.current = cluster ?? ''
      setViewOld(latest)
    }
  }, [history.data, started, viewOld, cluster])

  const run = () => {
    setStarted(true)
    setViewOld(null)
    // 新扫描的 added 通常为空：筛选态不清会谎报「全部正常」
    setRecurOnly(false)
    setHideAcked(false)
    setNonce((n) => n + 1)
  }
  // 首页「去巡检处置 →」带 ?run=1：意图就是扫一遍，落地不再手点第二次
  // 落地参数统一消费（两个 effect 各删各的会基于同一旧 sp 互相覆盖）：
  // ?view=latest=读最近落盘报告（读档不是扫描）；?focus=<处置键>=摊开该行备注（复发直达「当初为什么」）
  useEffect(() => {
    if (!sp.has('view') && !sp.has('focus')) return
    let viewApplied = false
    if (sp.get('view') === 'latest') {
      const latest = history.data?.items?.[0]
      if (latest) {
        setViewOld(latest)
        viewApplied = true
      }
    }
    const fk = sp.get('focus')
    // focus 只在落点就绪时消费并删除：view=latest 同帧时本帧闭包尚无 report/viewOld，
    // 连带删除 = 通知深链的 focus 死链（未消费则留在 URL，等下一帧数据到达再消费）
    const focusApplied = !!fk && (viewApplied || !!report || !!viewOld)
    if (focusApplied) setNotePrompt(fk)
    const touched = viewApplied || focusApplied
    if (touched) {
      const next = new URLSearchParams(sp)
      if (viewApplied) next.delete('view')
      if (focusApplied) next.delete('focus') // 未消费的 focus 留在 URL 等下一帧
      setSp(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.data, report, viewOld])
  useEffect(() => {
    if (sp.get('run') === '1') {
      run()
      // 消费即清除：留着的话回退/刷新/转发链接都会再触发全集群扫描
      const next = new URLSearchParams(sp)
      next.delete('run')
      setSp(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 巡检中且无占位数据（首跑）：六卡骨架，不留大片空白
  const showSkeleton = started && !report && q.isFetching

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h1 className="text-lg font-medium">{t('inspect:title')}</h1>
        {/* sub 挂标题行（审计页/资源列表同标尺），meta 统一 13px */}
        <span className="text-[13px] text-muted-foreground">{t('inspect:sub')}</span>
        {report && <span className="font-mono text-[13px] text-muted-foreground">{shortTime(report.generatedAt)}</span>}
        {diff?.hasPrev && (
          <span className="flex items-center gap-1.5 text-[13px] tabular-nums">
            {(diff.added ?? []).length > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <button className="cursor-pointer rounded-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden">
                    <Badge variant="outline" className="cursor-pointer border-caution/40 text-caution transition-opacity hover:opacity-80">{tf('inspect:added', { n: (diff.added ?? []).length })}</Badge>
                  </button>
                </PopoverTrigger>
                <DiffList keys={diff.added ?? []} cluster={cluster ?? ''} dispKeys={new Set(dispMap.keys())} />
              </Popover>
            )}
            {(diff.resolved ?? []).length > 0 && (
              // 「恢复」恰需人工确认（是真修好还是异常项换名躲过 diff），名单必须可见可点
              <Popover>
                <PopoverTrigger asChild>
                  <button className="cursor-pointer rounded-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden">
                    <Badge variant="outline" className="cursor-pointer border-positive/40 text-positive transition-opacity hover:opacity-80">{tf('inspect:resolved', { n: (diff.resolved ?? []).length })}</Badge>
                  </button>
                </PopoverTrigger>
                <DiffList keys={diff.resolved ?? []} cluster={cluster ?? ''} audit={auditRel.data?.items ?? []} generatedAt={report?.generatedAt} prevGeneratedAt={attrSince} truncated={(report?.truncatedSections?.length ?? 0) > 0} />
              </Popover>
            )}
            {(diff.added ?? []).length === 0 && (diff.resolved ?? []).length === 0 && <span className="text-muted-foreground">{t('inspect:sameAsLast')}</span>}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {(history.data?.items?.length ?? 0) > 0 && (
            <Select
              // 名实一致：未开扫（读档态）时选中项=实际在看的最新落盘时间戳；'latest' 语义=回到最新而非清空视图
              value={viewOld?.generatedAt ?? (started ? 'latest' : (history.data?.items?.[0]?.generatedAt ?? 'latest'))}
              onValueChange={(v) => {
                if (v === 'latest') setViewOld(started ? null : (history.data?.items?.[0] ?? null))
                else setViewOld(history.data?.items.find((r) => r.generatedAt === v) ?? null)
              }}
            >
              {/* 与同行控件同高（sm=h-7），只读下拉不得比主操作大；图标与「最近交接」区分：归档时间用 CalendarClock */}
              <SelectTrigger size="sm" className="w-36 text-xs" aria-label={t('inspect:histLabel')}>
                <CalendarClock className="size-3.5" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="latest">{t('inspect:histLatest')}</SelectItem>
                {(history.data?.items ?? []).map((r) => (
                  <SelectItem key={r.generatedAt} value={r.generatedAt} className="text-xs">
                    {shortTime(r.generatedAt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {dispMap.size > 0 && (
            <button
              onClick={() => setHideAcked((v) => !v)}
              aria-pressed={hideAcked}
              disabled={recurActive}
              title={recurActive ? t('inspect:hideAckedDisabled') : undefined}
              className={cn(
                'rounded-md border px-2 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden',
                hideAcked ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent/50',
              )}
            >
              {t('inspect:hideAcked')}
            </button>
          )}
          {recurKeys.size > 0 && (
            // 复发=处置过又回到 added：值班最该先看的子集；与「隐藏已处置」互斥（叠加时后者恒假成死键）
            <button
              onClick={() => { setRecurOnly((v) => !v); setHideAcked(false) }}
              aria-pressed={recurOnly}
              className={cn(
                'rounded-md border px-2 py-1 text-xs tabular-nums transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden',
                recurOnly ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent/50',
              )}
            >
              {tf('inspect:recurOnly', { n: recurKeys.size })}
            </button>
          )}
          {report && (
            <>
              <Select value={exportWin} onValueChange={(v) => setExportWin(v as '8h' | 'day' | 'scan')}>
                <SelectTrigger size="sm" className="w-30" aria-label={t('inspect:exportWin')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="8h">{t('inspect:win8h')}</SelectItem>
                  <SelectItem value="day">{t('inspect:winDay')}</SelectItem>
                  <SelectItem value="scan">{t('inspect:winScan')}</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={exportMd}>
                <Download className="size-3.5" />
                {t('inspect:export')}
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" aria-label={t('inspect:handoverRecent')}>
                    <History className="size-3.5" />
                    <span className="hidden lg:inline">{t('inspect:handoverRecent')}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-2">
                  <div className="mb-1 px-1 text-xs font-medium">{t('inspect:handoverRecent')}</div>
                  {recentHandovers.isError ? (
                    <p className="px-1 text-xs text-muted-foreground">{t('inspect:handoverDown')}</p>
                  ) : (
                    (recentHandovers.data?.items ?? []).length === 0 && <p className="px-1 text-xs text-muted-foreground">{t('inspect:handoverNone')}</p>
                  )}
                  {(recentHandovers.data?.items ?? []).map((h) => (
                    <NavLink key={h.id} to={`/c/${encodeURIComponent(cluster ?? '')}/handover/${h.id}`} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent">
                      <span className="shrink-0 font-mono text-muted-foreground tabular-nums">{shortTime(h.ts)}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{h.window ?? ''}{h.actor ? ` · ${h.actor}` : ''}</span>
                      {h.ackedTs ? <Badge variant="outline" className="shrink-0 border-positive/40 text-positive">{t('inspect:handoverAckShort')}</Badge> : <span className="shrink-0 text-[11px] text-caution">{t('inspect:handoverPendingAck')}</span>}
                    </NavLink>
                  ))}
                </PopoverContent>
              </Popover>
              <Button variant="outline" size="sm" onClick={() => void saveHandover()} disabled={saving}>
                <Link2 className="size-3.5" />
                {t('inspect:saveHandover')}
              </Button>
              {savedLink === '__fail' && (
                <span className="max-w-64 text-xs text-destructive">
                  {t('inspect:handoverFail')}
                  {failNote ? `（${failNote}）` : ''}
                </span>
              )}
              {savedLink && savedLink !== '__fail' && (
                <a href={savedLink} role="status" className="text-xs text-positive underline decoration-positive/40 hover:decoration-positive">
                  {t(linkCopied ? 'inspect:handoverSaved' : 'inspect:handoverPickLink')}
                </a>
              )}
            </>
          )}
          <Button size="sm" onClick={run} disabled={q.isFetching}>
            {q.isFetching ? <Loader2 className="size-3.5 animate-spin" /> : <Radar className="size-3.5" />}
            {q.isFetching ? t('inspect:running') : started ? t('inspect:rerun') : t('inspect:run')}
          </Button>
        </div>
      </div>

      {q.data?.error && <Alert variant="destructive">{q.data.error}</Alert>}
      {q.isError && <Alert variant="destructive">{t('inspect:failed')}</Alert>}
      {/* 处置名单加载失败是降级不是硬失败：徽章会静默消失、页面谎报「未处置」，
          批量 ack 会对已处置条目重复记账——必须可见并冻结写入口（caution：逐条询问仍可用） */}
      {disp.isError && (
        <Alert className="border-caution/40 text-caution">
          <AlertTitle className="flex flex-wrap items-center gap-2">
            {t('inspect:dispLoadFail')}
            <Button variant="outline" size="xs" onClick={() => void disp.refetch()}>{t('inspect:retry')}</Button>
          </AlertTitle>
        </Alert>
      )}
      {/* 周回看水位条：日摘要 7 行（findings 计数），周会/复盘的最小状态史——明细 20 份≈10 小时就轮换掉 */}
      {(dailyQ.data?.items?.length ?? 0) > 1 && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-label={t('inspect:weekTrend')}>
          <span className="shrink-0">{t('inspect:weekTrend')}</span>
          <div className="flex items-end gap-1" role="img" aria-label={(dailyQ.data?.items ?? []).map(d => `${d.date}: ${d.findings}`).join(', ')}>
            {(dailyQ.data?.items ?? []).map((d) => {
              const max = Math.max(...(dailyQ.data?.items ?? []).map(x => x.findings), 1)
              return (
                <span
                  key={d.date}
                  title={`${d.date} · ${d.findings} · +${(d.added ?? []).length}/-${(d.resolved ?? []).length}${d.water?.pctCpu != null ? ` · 承诺 CPU ${d.water.pctCpu}%` : ''}${d.water?.pctMem != null ? `/Mem ${d.water.pctMem}%` : ''}${(d.worst?.length ?? 0) ? `\n${(d.worst ?? []).slice(0, 6).join('\n')}${(d.worst?.length ?? 0) > 6 ? `\n…共 ${d.worst?.length} 条` : ''}` : ''}`}
                  className={cn('w-6 rounded-sm', d.findings > 0 ? 'bg-caution' : 'bg-positive')}
                  style={{ height: `${4 * Math.max(1, Math.round((d.findings / max) * 5))}px` }}
                />
              )
            })}
          </div>
          <span className="font-mono">{(dailyQ.data?.items ?? []).at(-1)?.findings ?? 0}</span>
        </div>
      )}
      {notePrompt && report && !report.findings.some(f => (f.entries ?? []).some(e => (e.key ?? dispKey(f.id, e)) === notePrompt)) && (
        // 灰角标「认领已过期」点进来的落点：对象已恢复/未入榜时最新报告里没有它的行，
        // 备注弹层无宿主——不兜底就是死胡同跳转，「当初为什么处置」在页面里无处可查
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{tf('inspect:focusMissed', { key: notePrompt })}</span>
          <NavLink to={`/c/${encodeURIComponent(cluster ?? '')}/audit`} className="shrink-0 hover:underline">{t('inspect:focusMissedAudit')}</NavLink>
          <button className="shrink-0 rounded p-0.5 hover:bg-muted" aria-label={t('ai:close')} onClick={() => setNotePrompt(null)}>
            <X className="size-3" />
          </button>
        </div>
      )}
      {markErr && (
        <Alert variant="destructive">
          {t('inspect:markFailed')}
          <Button
            variant="outline"
            size="xs"
            className="ml-2"
            onClick={() => {
              // 重试必须先收横幅：只 refetch 不清标志=点下去零反馈，红幅宣称的失败早已不存在
              setMarkErr(false)
              inflight.current.failed = 0
              void queryClient.refetchQueries({ queryKey: ['dispositions', cluster] })
            }}
          >
            {t('inspect:retry')}
          </Button>
        </Alert>
      )}

      {!started && !q.isFetching && !viewOld && !history.isPending && (
        <Empty className="py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Radar />
            </EmptyMedia>
            <EmptyTitle>{t('inspect:idle')}</EmptyTitle>
            <EmptyDescription>{t('inspect:idleDesc')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {viewOld && (isLatestSaved
        // 最新落盘（读档默认态）不是「历史快照」：中性陈述，别用 caution 吓值班
        ? <div className="px-1 text-xs text-muted-foreground">{t('inspect:viewingLatestSaved')}</div>
        : <div className="rounded-md border border-caution/40 px-3 py-1.5 text-xs text-caution">{t('inspect:viewingHistory')}</div>)}
      {bgNewerReport && (
        // 后台定时扫描落了新报告：读档中的页面要主动告知而非静默陈旧
        <button
          className="self-start rounded-md border border-primary/40 px-2 py-0.5 text-xs text-primary hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden"
          onClick={() => { setViewOld(history.data?.items?.[0] ?? null); setStarted(false) }}
        >
          {tf('inspect:bgNewer', { time: shortTime(bgNewerReport) })}
        </button>
      )}

      {showSkeleton && (
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-32" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {report && (
        // key=报告时间戳：新报告到达=整网格换 key，一次性 fade 进场而非旧卡硬吞新数;
        // rerun 期间 keepPreviousData 的旧报告半透明，防止「旧冒充最新」
        <div key={report.generatedAt} className={cn('grid items-start gap-3 animate-in fade-in-0 duration-150 lg:grid-cols-2', q.isPlaceholderData && 'opacity-50')}>
          {report.findings.map((f) => {
            const sec = SECTIONS[f.id]
            const entries = f.entries ?? []
            // 处置命中的条目灰显保留（可筛掉）；复发行不受隐藏影响——旧结论无权隐藏复发
            const clean = entries.filter((e) => {
              if (e === null) return false
              const k = e.key ?? dispKey(f.id, e)
              if (recurActive && !recurKeys.has(k)) return false
              return !(hideAcked && dispMap.get(k) === 'acked' && !diff?.added.includes(k) && !staleClaimKeys.has(k))
            })
            // 批量 ack 纳回「认领已作废」的旧 acked：它们首页口径就是待办，不能因旧结论免掉
            const batchKeys = clean.filter((e) => { const k = e.key ?? dispKey(f.id, e); return dispMap.get(k) !== 'acked' || staleClaimKeys.has(k) }).map((e) => e.key ?? dispKey(f.id, e))
            // 部分隐藏也要留痕：徽章 30→29 若无 −N 注脚，「被隐藏」与「异常消失」在账面上无从区分
            const hiddenN = entries.length - clean.length
            return (
              <Card key={f.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium">
                    {t(sec?.title ?? f.id)}
                    <Badge variant={clean.length > 0 ? 'secondary' : 'outline'} className={cn(clean.length > 0 && 'tabular-nums')}>
                      {clean.length}
                    </Badge>
                    {hiddenN > 0 && clean.length > 0 && (
                      <span className="text-xs text-muted-foreground tabular-nums" title={tf('inspect:secHidden', { n: hiddenN })}>
                        −{hiddenN}
                      </span>
                    )}
                    {batchKeys.length > 1 && (
                      // 同段=同规则口径，一次节点故障常灌满一段：批量 ack + 共享根因备注（ignored 不批量——每条要单独辩护）
                      <BatchAckBtn
                        n={batchKeys.length}
                        onBatch={(note) => batchKeys.forEach((k) => mark(k, 'acked', note || undefined))}
                      />
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="max-h-64 space-y-1 overflow-auto">
                  {clean.length === 0 && (
                    // 「全部被隐藏」≠「本来无异常」：值班语义相反，不许把 30 项已处置显示成正常
                    entries.length > 0
                      ? <div className="text-[13px] text-muted-foreground">{tf('inspect:secHidden', { n: entries.length - clean.length })}</div>
                      : <div className="text-[13px] text-muted-foreground">{t('inspect:secOk')}</div>
                  )}
                  {clean.map((e) => {
                    // 处置接缝：详情链接 + 处置状态 + 问 AI；键与后端 findingKey 同构
                    const kind = entryKind(f.id, e)
                    const def = kind ? RESOURCE_MAP[kind] : undefined
                    const link = def && e.name ? detailRoute(def, cluster ?? '', e.ns ?? 'cluster', e.name) : null
                    const key = e.key ?? dispKey(f.id, e)
                    const state = dispMap.get(key)
                    // 复发=回到 added 或认领已作废：两种「旧结论失效」都不许按旧结论灰显/隐藏
                    const recurring = !!state && (!!diff?.added.includes(key) || claimInvalid(key, e))
                    // 同段内条目列数相同 → 网格模板一致，数字/状态列竖读成列；操作列恒在最右
                    const hasCause = f.id === 'unready-workloads'
                    return (
                      <div
                        key={key}
                        data-focuskey={key}
                        className={cn('group grid items-baseline gap-2 rounded text-[13px] hover:bg-accent/40', notePrompt === key && !state && 'bg-primary/10 ring-1 ring-primary/40')}
                        style={{ gridTemplateColumns: `minmax(0,1fr) repeat(${(sec?.cols.length ?? 0) + (hasCause ? 1 : 0)}, auto) auto` }}
                      >
                        <span className={cn('flex min-w-0 items-baseline gap-2 transition-colors duration-150', state && !recurring && 'text-muted-foreground')}>
                          {link ? (
                            <NavLink to={link} className="min-w-0 truncate font-mono text-xs hover:underline" title={`${e.ns ?? ''}/${e.name}`}>
                              {e.ns ? <span className="text-muted-foreground">{e.ns}/</span> : null}
                              {e.name}
                            </NavLink>
                          ) : (
                            <span className="min-w-0 truncate font-mono text-xs" title={`${e.ns ?? ''}/${e.name}`}>
                              {e.ns ? <span className="text-muted-foreground">{e.ns}/</span> : null}
                              {e.name}
                            </span>
                          )}
                          {hasCause && !!e.cause && (
                            <span className="min-w-0 truncate text-xs text-caution" title={String(e.cause)}>
                              {String(e.cause)}
                            </span>
                          )}
                        </span>
                        {(sec?.cols ?? []).map(([k]) => {
                          const v = String((e[k] as string | number | undefined) ?? '')
                          // 硬故障 phase/reason（Failed/Evicted/BackOff/Unhealthy）脱离灰字：
                          // 30 行同灰时严重度为零，扫读找不出该先管谁
                          const hardFail = (k === 'phase' || k === 'reason' || k === 'status') && /Failed|Evicted|BackOff|Unhealthy|CrashLoop/i.test(v)
                          return (
                            <span key={k} className={cn('text-xs', k === 'count' ? 'w-10 text-right tabular-nums text-muted-foreground' : hardFail ? 'text-negative' : 'text-muted-foreground')}>
                              {k === 'count' ? `×${String(e[k] as number)}` : v}
                            </span>
                          )
                        })}
                        {hasCause && <span />}
                        <span data-row-actions className="ml-auto flex items-center gap-0.5">
                          {recurring ? (
                            // 复发比旧处置结论更权威：亮 caution 并保留处置入口（重开/再忽略）
                            <Badge variant="outline" className="border-caution/50 px-1 text-[11px] text-caution">{t('inspect:recurring')}</Badge>
                          ) : null}
                          {state && (
                            <DispBadge
                              state={state}
                              note={dispNote.get(key)}
                              ts={dispTs.get(key)}
                              viewOld={!!viewOld}
                              autoOpen={notePrompt === key}
                              onAutoOpenDone={() => setNotePrompt(null)}
                              onNote={(n) => mark(key, state, n)}
                              onClear={() => mark(key, 'none')}
                            />
                          )}
                          {e.name && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                              disabled={disp.isError}
                              // 处置按钮常显（触屏无 hover）：循环 未处置→已处置→忽略→未处置；
                              // 三态三字形（色盲/低对比下不靠色相辨态）
                              title={state === 'acked' ? t('inspect:toIgnored') : state === 'ignored' ? t('inspect:toUnmarked') : t('inspect:toAcked')}
                              aria-label={state === 'acked' ? t('inspect:toIgnored') : state === 'ignored' ? t('inspect:toUnmarked') : t('inspect:toAcked')}
                              onClick={() => {
                                const next = state === undefined ? 'acked' : state === 'acked' ? 'ignored' : 'none'
                                // 换态继承旧备注：交班依据不能因状态推进而蒸发
                                if (next === 'ignored') setNotePrompt(key) // 永久不处理更需要辩护：摊开备注层（Enter 存、Esc 跳过）
                                mark(key, next, dispNote.get(key))
                              }}
                            >
                              {state === 'acked' ? <BadgeCheck className="size-3.5 text-positive" /> : state === 'ignored' ? <Ban className="size-3.5" /> : <CheckCheck className="size-3.5 text-muted-foreground" />}
                            </Button>
                          )}
                          {kind && e.name && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                              // 问 AI 与处置按钮同策略常显（hover-only 在触屏等于不存在）
                              title={t('res:askAi')}
                              aria-label={t('res:askAi')}
                              onClick={() =>
                                askAi(tf('ai:askDiagnoseRow', { kind, ns: e.ns ?? '-', name: e.name }))
                              }
                            >
                              <MessageSquareText className="size-3.5" />
                            </Button>
                          )}
                        </span>
                      </div>
                    )
                  })}
                </CardContent>
              </Card>
            )
          })}
          {/* notes 是全局脚注：占满整行并沉底，不挤在半列网格里 */}
          {(report.notes ?? []).length > 0 && (
            <div className="text-xs text-muted-foreground lg:order-last lg:col-span-2">{tf('inspect:notes', { n: report.notes?.join('; ') })}</div>
          )}
        </div>
      )}
    </div>
  )
}

/** 处置徽章：点开可补备注（交接班的「为什么忽略」）或解除；后端 note 链路早已就绪 */
/** 段级批量 ack：Popover 摊开共享根因 → 逐条走既有 mark（乐观+审计逐条留痕，target 各不相同） */
function BatchAckBtn({ n, onBatch }: { n: number; onBatch: (note: string) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-5 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground">
          <CheckCheck className="size-3" />
          {tf('inspect:batchAck', { n })}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <Input
          autoFocus
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
          placeholder={t('inspect:batchNotePh')}
          maxLength={200}
          className="h-7 text-xs"
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && !ev.nativeEvent.isComposing) {
              onBatch(note.trim())
              setNote('')
              setOpen(false)
            }
          }}
        />
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              onBatch(note.trim())
              setNote('')
              setOpen(false)
            }}
          >
            {tf('inspect:batchConfirm', { n })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function DispBadge({ state, note, ts, viewOld, autoOpen, onAutoOpenDone, onNote, onClear }: { state: DispState; note?: string; ts?: string; viewOld?: boolean; autoOpen?: boolean; onAutoOpenDone?: () => void; onNote: (n: string) => void; onClear: () => void }) {
  const t = useT()
  const [text, setText] = useState(note ?? '')
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // 底层 note 变化（含 AI 经 disposition_set 写入）回填弹层：旧稿覆盖根因是数据丢失
  useEffect(() => { setText(note ?? '') }, [note])
  // 循环按钮推进到 ignored 时摊开一次（消费即清除，不干扰后续手动开合）
  useEffect(() => {
    if (autoOpen) {
      setOpen(true)
      onAutoOpenDone?.()
    }
  }, [autoOpen, onAutoOpenDone])
  // 历史回看时徽章是「今天补记的状态」而非当时事实——tooltip 必须说清
  const label = state === 'acked' ? t('inspect:acked') : t('inspect:ignored')
  const tip = `${viewOld ? `${t('inspect:currentMark')} ` : ''}${label}${ts ? ` @ ${shortTime(ts)}` : ''}${note ? ` · ${note}` : ''}`
  // 非模态 Popover 的 Portal 挂在 body 末尾且不开焦点（Radix trapFocus:false）：
  // 保存/解除必须显式收尾并把焦点送回本行操作区（解除后 trigger 卸载 → 回首个幸存按钮）
  const close = (mutate?: () => void) => {
    const rowActions = triggerRef.current?.closest('[data-row-actions]')
    setOpen(false)
    mutate?.()
    requestAnimationFrame(() => rowActions?.querySelector('button')?.focus())
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          className="rounded px-1 text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden"
          title={tip}
        >
          {state === 'acked' ? t('inspect:acked') : t('inspect:ignored')}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <Input
          autoFocus
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          placeholder={t('inspect:notePh')}
          maxLength={200}
          className="h-7 text-xs"
          onKeyDown={(ev) => { if (ev.key === 'Enter' && !ev.nativeEvent.isComposing) close(() => onNote(text.trim())) }}
        />
        {note && <div className="mt-1 text-[11px] text-muted-foreground">{t('inspect:noteClearHint')}</div>}
        <div className="mt-3 flex justify-between">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" onClick={() => close(onClear)}>
            {t('inspect:unmark')}
          </Button>
          <Button size="sm" className="h-6 px-2 text-xs" onClick={() => close(() => onNote(text.trim()))}>
            {t('inspect:noteSave')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** diff 名单弹层：键 → 详情链接；resolved 场景 join 审计直显「疑似关联变更」（恢复多半是某次变更修的） */
function DiffList({ keys, cluster, audit, generatedAt, prevGeneratedAt, dispKeys, truncated }: { keys: string[]; cluster: string; audit?: AuditLite[]; generatedAt?: string; prevGeneratedAt?: string | null; dispKeys?: Set<string>; truncated?: boolean }) {
  const t = useT()
  return (
    <PopoverContent
        onKeyDown={(ev) => {
          // 非模态换回页面可滚动，键盘收益(Tab 环)手工补上——浮层内 a/button 首尾闭环
          if (ev.key !== 'Tab') return
          const f = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>('a,button')).filter((el) => !el.hasAttribute('disabled'))
          if (!f.length) return
          const first = f[0], last = f[f.length - 1]
          if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus() }
          else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus() }
        }} align="start" className="w-105 p-1.5">
      {/* 截断窗口的漂移会造出假恢复（条目被挤出 top-N ≠ 被修好），名单必须自我声明 */}
      {truncated && <div className="px-2 pb-1 text-[11px] text-caution">{t('inspect:resolvedTruncated')}</div>}
      {audit && <div className="px-2 pb-1 text-[11px] text-muted-foreground">{t('inspect:attribNote')}</div>}
      <div className="max-h-60 space-y-0.5 overflow-auto">
        {keys.map((k) => {
          const route = diffKeyRoute(k, cluster)
          const [section, ns, kind, ...rest] = k.split('/')
          const name = rest.join('/')
          const kKind = kind || SECTIONS[section]?.kind
          // 归因过滤：同集群 + 变更时间早于报告时间——他集群同名对象/恢复之后的操作不是原因
          // 归因窗口双向界定：只有两次巡检之间的同集群写才可能是恢复原因
          const rel = audit?.find((a) => a.kind === kKind && a.name === name && (a.ns ?? '') === (ns ?? '') && (a.cluster ?? '') === cluster && (!generatedAt || (a.ts ?? '') <= generatedAt) && (!prevGeneratedAt || (a.ts ?? '') >= prevGeneratedAt))
          return (
            <div key={k} className="rounded-md px-2 py-1 hover:bg-muted/60">
              <span className="flex items-baseline gap-1.5">
                {route ? (
                  <NavLink to={route} className="min-w-0 truncate font-mono text-xs hover:underline" title={k}>
                    {k}
                  </NavLink>
                ) : (
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={k}>
                    {k}
                  </span>
                )}
                {dispKeys?.has(k) && (
                  // 处置过的项进了「新增」= 复发信号，名单里也要一眼认出
                  <span className="shrink-0 text-[11px] text-caution">{t('inspect:recurring')}</span>
                )}
              </span>
              {rel && (
                <NavLink
                  to={`/c/${encodeURIComponent(cluster)}/audit`}
                  className="block truncate text-[11px] text-muted-foreground hover:underline"
                  title={rel.ts ? `${rel.verb ?? ''} @ ${shortTime(rel.ts)}` : rel.verb ?? ''}
                >
                  {tf('inspect:relatedChange', { verb: rel.verb ?? '?', time: rel.ts ? shortTime(rel.ts) : '' })}
                </NavLink>
              )}
            </div>
          )
        })}
      </div>
    </PopoverContent>
  )
}
