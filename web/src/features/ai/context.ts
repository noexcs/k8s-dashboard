// AI 资源上下文：从当前路由推导「用户正在看的资源」，供 AiChat 把资源引用拼进消息文本。
// 为什么解析 pathname 而非 useParams：AiChat 有两个挂载点——/ai 整页（深层路由内，useParams
// 能拿到全部段）和 AppLayout 下的悬浮面板（useParams 只有祖先段，拿不到 ns/name），
// pathname 解析对两个挂载点行为一致，且不改路由表。纯函数 + 纯 hook，不碰任何 store。
import { useMemo } from 'react'
import { useLocation } from 'react-router-dom'

export interface ResourceContext {
  kind: string
  /** 资源名 */
  name: string
  /** 命名空间；cluster scope（路由 ns 段 = 'cluster' 占位）→ null */
  ns: string | null
  cluster: string
}

/** cluster scope 详情路由的 ns 占位段（与 registry.detailRoute 约定一致） */
const CLUSTER_SCOPE_NS = 'cluster'

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * 路由 → 上下文。仅详情路由（有 name）产生上下文：
 *   /c/{c}/ns/{ns}/pods/{pod}        → Pod
 *   /c/{c}/r/{Kind}/{ns}/{name}      → Kind（ns 段 'cluster' = cluster scope）
 *   /c/{c}/yaml/{ns}/{Kind}/{name}   → Kind（旧 YAML 别名，段序与 r 不同）
 *   /c/{c}/helm/{ns}/{name}          → HelmRelease
 * 列表页（r/Kind、r/Kind/ns、ns/x/pods）、dashboard、设置等一律 null。
 */
function parsePathname(pathname: string): ResourceContext | null {
  const segs = pathname.split('/').filter(s => s !== '')
  if (segs[0] !== 'c' || !segs[1]) return null
  const cluster = decode(segs[1])
  const t = segs.slice(2)
  if (t.length === 4 && t[0] === 'ns' && t[2] === 'pods') {
    return { kind: 'Pod', ns: decode(t[1]), name: decode(t[3]), cluster }
  }
  if (t.length === 4 && t[0] === 'r') {
    return { kind: decode(t[1]), ns: t[2] === CLUSTER_SCOPE_NS ? null : decode(t[2]), name: decode(t[3]), cluster }
  }
  if (t.length === 4 && t[0] === 'yaml') {
    return { kind: decode(t[2]), ns: t[1] === CLUSTER_SCOPE_NS ? null : decode(t[1]), name: decode(t[3]), cluster }
  }
  if (t.length === 3 && t[0] === 'helm') {
    return { kind: 'HelmRelease', ns: decode(t[1]), name: decode(t[2]), cluster }
  }
  return null
}

/** 当前路由指向的资源详情；非详情路由返回 null（路由变化自动跟随） */
export function useResourceContext(): ResourceContext | null {
  const { pathname } = useLocation()
  // memo 稳定引用：上下文条/徽标不因无关重渲染误判变化
  return useMemo(() => parsePathname(pathname), [pathname])
}

/** 资源唯一标识：✕「本会话忽略」按它记忆——切到别的资源后上下文自然回来 */
export function resourceContextKey(ctx: ResourceContext): string {
  return `${ctx.cluster}/${ctx.kind}/${ctx.ns ?? CLUSTER_SCOPE_NS}/${ctx.name}`
}

/** 展示/注入用紧凑引用：namespaced → ns/name；cluster scope → name */
export function formatContextRef(ctx: ResourceContext): string {
  return ctx.ns ? `${ctx.ns}/${ctx.name}` : ctx.name
}

// ---------- 页面感知（全路由覆盖） ----------
// ResourceContext 只覆盖详情路由；这里补全所有页面（列表/大盘/Helm/事件/设置/AI 页），
// 每轮 /chat 附 page 字段 → 服务端拼进用户消息首行入会话历史，AI 由此知道
// 「用户此刻在哪个页面、看什么」，并能按 SYSTEM_PROMPT 里的地址表报出任意页面地址。

export interface PageContext {
  /** 页面语义（AI 用），含集群/命名空间/资源等关键参数 */
  label: string
  /** 当前地址（相对站点根） */
  path: string
}

/** 路由 → 页面语义。与 App.tsx 路由表一一对应；未知路径兜底返回原始地址。 */
function describePage(pathname: string, search: string): PageContext {
  const segs = pathname.split('/').filter(s => s !== '')
  const path = search ? `${pathname}${search}` : pathname
  if (segs[0] !== 'c' || !segs[1]) return { label: '未知页面', path }
  const cluster = decode(segs[1])
  const t = segs.slice(2)
  const at = (label: string): PageContext => ({ label: `${label}（集群=${cluster}）`, path })
  if (t.length === 0) return at('集群总览大盘：健康度 KPI、资源分布与趋势图表')
  if (t[0] === 'ai') return at('AI 助手整页')
  // 巡检/审计页必须语义化：行尾「问 AI」从这两页发起时，AI 需要知道用户在盯什么清单
  if (t[0] === 'inspect') return at('集群巡检页：规则扫描的异常清单（未就绪工作负载/异常Pod/节点/Warning事件/失败Job/暂停Cron）与上次对比；可读 inspect_report 工具获取同款数据')
  if (t[0] === 'audit') return at('变更审计页：UI 与 AI 写操作的合流留痕（谁改了什么）')
  if (t[0] === 'settings') return at('设置页：语言/外观/侧栏导航/Prometheus')
  if (t[0] === 'events') {
    return t[1] === 'ns' && t[2] ? at(`事件列表页，命名空间=${decode(t[2])}`) : at('事件列表页（全部命名空间）')
  }
  if (t[0] === 'helm') {
    if (t.length >= 3) return at(`Helm Release 详情页：${decode(t[1])}/${decode(t[2])}`)
    return at('Helm 页（Releases/图表/仓库 三个 tab）')
  }
  if (t[0] === 'pods') return at('Pod 列表页（全部命名空间）')
  if (t[0] === 'ns' && t[1]) {
    const ns = decode(t[1])
    if (t[2] === 'pods') return t.length >= 4 ? at(`Pod 详情页：${ns}/${decode(t[3])}`) : at(`Pod 列表页，命名空间=${ns}`)
    if (t[2] === 'events') return at(`事件列表页，命名空间=${ns}`)
  }
  if (t[0] === 'r' && t[1]) {
    const kind = decode(t[1])
    if (t.length >= 4) {
      const clusterScope = t[2] === CLUSTER_SCOPE_NS
      const ref = clusterScope ? decode(t[3]) : `${decode(t[2])}/${decode(t[3])}`
      return at(`${kind} 详情页：${ref}${clusterScope ? '（cluster scope）' : ''}`)
    }
    if (t.length === 3) return at(`${kind} 列表页，命名空间=${decode(t[2])}`)
    return at(`${kind} 列表页（全部命名空间）`)
  }
  if (t[0] === 'yaml' && t.length >= 4) {
    return at(`YAML 编辑页：${decode(t[1])}/${decode(t[2])}/${decode(t[3])}`)
  }
  return { label: '未知页面', path }
}

/** 当前路由的页面语义（路由切换自动更新） */
export function usePageContext(): PageContext {
  const { pathname, search } = useLocation()
  return useMemo(() => describePage(pathname, search), [pathname, search])
}

/** 拼进用户消息首行的页面行（服务端拼入并随会话历史持久，UI 不显示） */
export function formatPageForAI(ctx: PageContext): string {
  return `[当前页面] ${ctx.label}；地址 ${ctx.path}`
}

/** 空会话引导 chips：kind → 专属问题的 i18n key（未命中的 kind 走通用兜底） */
const GUIDE_CHIPS: Record<string, string[]> = {
  Pod: ['aictx:chipPodRestarts', 'aictx:chipPodLogs', 'aictx:chipPodOwner', 'aictx:chipPodEvents'],
  Deployment: ['aictx:chipDeployStuck', 'aictx:chipDeployHistory', 'aictx:chipDeployPods'],
  StatefulSet: ['aictx:chipStsStuck', 'aictx:chipStsPods', 'aictx:chipStsPvc'],
  Service: ['aictx:chipSvcEndpoints', 'aictx:chipSvcPods'],
  Node: ['aictx:chipNodeLoad', 'aictx:chipNodePods', 'aictx:chipNodeIssues'],
  HelmRelease: ['aictx:chipHelmStatus', 'aictx:chipHelmHistory', 'aictx:chipHelmValues'],
}
const DEFAULT_CHIPS = ['aictx:chipDefaultIssues', 'aictx:chipDefaultEvents']
// 无上下文（列表页/dashboard）的集群级通用问题
const GENERAL_CHIPS = ['aictx:chipGeneralHealth', 'aictx:chipGeneralCrashloop', 'aictx:chipGeneralEvents']

/** 空会话引导 chips 的 i18n key：有上下文按 kind 取专属问题（未收录 kind 走兜底，含 {kind} 占位），无上下文给集群级通用 */
export function contextGuideChipKeys(ctx: ResourceContext | null): string[] {
  if (!ctx) return GENERAL_CHIPS
  return GUIDE_CHIPS[ctx.kind] ?? DEFAULT_CHIPS
}
