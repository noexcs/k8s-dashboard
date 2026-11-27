// @ts-check
/**
 * 集群巡检报告（AI 从「问答」到「值班」）：一次并发全集群扫描，输出结构化异常清单，
 * 与上一次报告 diff（新增/恢复）。纯规则不吃 LLM——diagnose 已验证的判定口径的全集群版。
 * 报告 JSONL 追加（保留最近 REPORT_CAP 份，重写文件防膨胀）。
 */
import { X509Certificate } from 'node:crypto'
import { recordDaily } from './daily.js'
import { clusterCapacity } from './capacity.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { list } from './k8s.js'
import { config } from './config.js'

const REPORT_FILE = join(config.dataDir, 'reports.jsonl')
const REPORT_CAP = 20

/** 配额 Quantity 粗解析（K8s 数量后缀；解析失败按 0 处理不误报压力） */
function parseQtyLoose(/** @type {string | number | undefined} */ v) {
  if (v == null) return 0
  const m = /^([0-9.]+)(m|Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(String(v))
  if (!m) return 0
  const n = parseFloat(m[1] ?? '0')
  const unit = { m: 0.001, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2] ?? ''] ?? 1
  return n * unit
}

/** 出错维度不炸整份报告：记 notes，其余照常 */
async function attempt(/** @type {string} */ label, /** @type {() => Promise<any>} */ fn) {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, label, error: e instanceof Error ? e.message : String(e) }
  }
}

/** @param {unknown} v */
function items(/** @type {any} */ v) {
  return Array.isArray(v?.items) ? v.items : []
}

/**
 * @param {string} cluster
 * @param {AbortSignal} [signal]
 */
export async function buildClusterReport(cluster, signal) {
  /**
   * 分页全量（limit=500 + continue）：大集群 pods/events 一次全量 list 是数百 MB 响应
   * （10k pods × 含 managedFields 的序列化），容器 OOM/超时风险；500 页片轮转把
   * 单请求压到 MB 级。PAGE_CAP 防 continue 死循环（对象数上限 4 万/维度，远超即截断）。
   */
  const PAGE = '500'
  const PAGE_CAP = 80
  /** @param {string} path @param {Record<string,string>} [extra] */
  const listAll = async (path, extra) => {
    /** @type {any[]} */
    const out = []
    /** @type {string|undefined} */
    let cont
    for (let i = 0; i < PAGE_CAP; i++) {
      const res = await list(cluster, path, { limit: PAGE, ...(cont ? { continue: cont } : {}), ...(extra ?? {}) }, signal)
      out.push(...items(res))
      cont = /** @type {{ metadata?: { continue?: string } }} */ (/** @type {unknown} */ (res))?.metadata?.continue || undefined
      if (!cont) break
    }
    if (cont) listAllTruncated.add(path) // 触顶仍有 continue：大集群漏报必须显式，不许无声
    return out
  }
  const listAllTruncated = new Set()
  /** 截断段结构化落字段：UI 消费字段而非对 note 自由文案做子串匹配（措辞一改告警就静默消失） */
  const truncatedSections = []
  /** entry.key=处置键单一真源（findingKey 同函数产出）：前端两份手写镜像键格式的历史结束 */
  /** @param {() => Promise<any[]>} fn */
  const attemptAll = (/** @type {string} */ label, fn) => attempt(label, async () => ({ items: await fn() }))
  const [deps, sts, ds, jobs, cron, pods, nodes, events, quotas, secrets] = await Promise.all([
    attemptAll('deployments', () => listAll('/apis/apps/v1/deployments')),
    attemptAll('statefulsets', () => listAll('/apis/apps/v1/statefulsets')),
    attemptAll('daemonsets', () => listAll('/apis/apps/v1/daemonsets')),
    attemptAll('jobs', () => listAll('/apis/batch/v1/jobs')),
    attemptAll('cronjobs', () => listAll('/apis/batch/v1/cronjobs')),
    attemptAll('pods', () => listAll('/api/v1/pods')),
    attemptAll('nodes', () => listAll('/api/v1/nodes')),
    // Warning 服务端过滤：events 无过滤全量拉（5 万+条）只为客户端筛 type，纯浪费
    attemptAll('events', () => listAll('/api/v1/events', { fieldSelector: 'type=Warning' })),
    // 合规面两段：安全周检此前只能口头问 AI（答案不 diff/不可处置/不进交接）
    attemptAll('resourcequotas', () => listAll('/api/v1/resourcequotas')),
    // secrets 的 type 不在服务端可过滤字段集：客户端筛；RBAC 不给 list 时 attempt 降级 note（无权限≠没证书）
    attemptAll('tls-secrets', () => listAll('/api/v1/secrets')),
  ])
  /** @type {string[]} */
  const notes = []
  for (const x of [deps, sts, ds, jobs, cron, pods, nodes, events, quotas, secrets]) {
    if (!x.ok && 'label' in x) notes.push(`${x.label}: ${'error' in x ? x.error : '?'}`)
  }
  for (const t of listAllTruncated) {
    notes.push(`${t}: 超过 ${80 * 500} 对象上限，仅扫描前部分`)
    truncatedSections.push(t)
  }
  /** 段级截断显式落 note：61 个未就绪时「与上次相同」可能是假象 */
  const truncNote = (/** @type {string} */ section, /** @type {number} */ total, /** @type {number} */ cap) => {
    if (total > cap) {
      notes.push(`${section}: 共 ${total} 条，仅显示前 ${cap}（diff 同样只覆盖已显示部分）`)
      truncatedSections.push(section)
    }
  }
  const meta = (/** @type {any} */ o) => ({
    ns: o?.metadata?.namespace ?? '',
    name: o?.metadata?.name ?? '?',
    // conditions 最近转态时间：前端「处置是否作废（=复发）」的唯一判据源，首页/巡检共用
    lt: (o?.status?.conditions ?? []).map((/** @type {any} */ c) => c.lastTransitionTime ?? '').sort().pop() || '',
  })
  /** @param {any} o @returns {string|null} */
  const stuckCause = (o) => {
    const cs = o?.status?.conditions ?? []
    const bad =
      cs.find((/** @type {any} */ c) => c.type === 'Progressing' && c.status === 'False') ??
      cs.find((/** @type {any} */ c) => c.type === 'Failed' && c.status === 'True') ??
      cs.find((/** @type {any} */ c) => c.type === 'Available' && c.status === 'False')
    return bad?.message || bad?.reason || null
  }

  // 工作负载就绪比（与首页表同口径）
  /** @type {{ns:string,name:string,kind:string,ready:string,cause:(string|null)}[]} */
  const unready = []
  /**
   * 滚动豁免/停滞时效（与首页 chip 同判据同常量，两侧各 10min——改一处必改另一处）。
   * 信号锚定：og 在控制器消费 spec 后秒级追平，真·滚动在途的持续信号是
   * updatedReplicas 未达期望（og 滞后仅作补充窗口）；Progressing 未红且 <10min → 在途不报。
   * @param {any} o @param {boolean} [isDS]
   */
  const rollingGrace = (/** @type {any} */ o, isDS) => {
    const st = o.status ?? {}
    const desired = isDS ? st.desiredNumberScheduled : o.spec?.replicas
    const updated = isDS ? st.updatedNumberScheduled : st.updatedReplicas
    const ogLag = o.metadata?.generation != null && st.observedGeneration != null && st.observedGeneration < o.metadata.generation
    const inFlight = (desired != null && desired > 0 && (updated ?? 0) < desired) || ogLag
    if (!inFlight) return { lag: false, skip: false, note: null }
    const prog = (st.conditions ?? []).find((/** @type {any} */ c) => c.type === 'Progressing')
    const since = prog?.lastUpdateTime ? Date.parse(prog.lastUpdateTime) : NaN
    const min = Number.isFinite(since) ? Math.round((Date.now() - since) / 60_000) : null
    if (min != null && min < 10 && !stuckCause(o)) return { lag: true, skip: true, note: null }
    return { lag: true, skip: false, note: min != null ? `滚动已进行 ${min} 分钟未收敛（新版本就绪不足）` : '新版本就绪不足/observedGeneration 滞后' }
  }  /** @param {any} x @param {string} kind @param {(o:any)=>[string,boolean]} calc @param {boolean} [rollAware] */
  const scan = (x, kind, calc, rollAware) => {
    if (!x.ok) return
    for (const o of items(x.data)) {
      const [ready, ok] = calc(o)
      if (ok) continue
      if (rollAware) {
        const rg = rollingGrace(o, kind === 'DaemonSet')
        if (rg.skip) continue
        unready.push({ ...meta(o), kind, ready, cause: stuckCause(o) ?? rg.note })
        continue
      }
      unready.push({ ...meta(o), kind, ready, cause: stuckCause(o) })
    }
  }
  scan(deps, 'Deployment', (/** @type {any} */ o) => {
    const d = o.spec?.replicas ?? 0
    const rdy = o.status?.readyReplicas ?? 0
    return [`${rdy}/${d}`, rdy >= d]
  }, true)
  scan(sts, 'StatefulSet', (/** @type {any} */ o) => {
    const d = o.spec?.replicas ?? 0
    const rdy = o.status?.readyReplicas ?? 0
    return [`${rdy}/${d}`, rdy >= d]
  }, true)
  scan(ds, 'DaemonSet', (/** @type {any} */ o) => {
    const d = o.status?.desiredNumberScheduled ?? 0
    const rdy = o.status?.numberReady ?? 0
    return [`${rdy}/${d}`, rdy >= d]
  }, true)

  /** 截断必须发生在稳定排序之后：API 返回序无保证，乱序截断的窗口漂移会被 diff 读成「新增/恢复」 */
  const byName = (/** @type {any} */ a, /** @type {any} */ b) =>
    `${a?.metadata?.namespace}/${a?.metadata?.name}`.localeCompare(`${b?.metadata?.namespace}/${b?.metadata?.name}`)
  const podList = pods.ok ? items(pods.data) : []
  const abnormalPodsAll = podList
    .filter((/** @type {any} */ p) => p.status?.phase && !['Running', 'Succeeded'].includes(p.status.phase))
    .sort(byName)
  truncNote('abnormal-pods', abnormalPodsAll.length, 30)
  const abnormalPods = abnormalPodsAll.slice(0, 30)
    .map((/** @type {any} */ p) => ({ ...meta(p), kind: 'Pod', phase: p.status.phase, reason: p.status.containerStatuses?.find((/** @type {any} */ c) => c.state?.waiting?.reason)?.state?.waiting?.reason ?? p.status.reason ?? '' }))

  const nodeList = nodes.ok ? items(nodes.data) : []
  const badNodes = []
  for (const /** @type {any} */ n of nodeList) {
    const conds = n.status?.conditions ?? []
    const notReady = conds.some((/** @type {any} */ c) => c.type === 'Ready' && c.status !== 'True')
    const pressures = conds.filter((/** @type {any} */ c) => ['MemoryPressure', 'DiskPressure', 'PIDPressure'].includes(c.type) && c.status === 'True').map((/** @type {any} */ c) => c.type)
    if (notReady || pressures.length) badNodes.push({ name: n.metadata?.name ?? '?', ready: !notReady, pressures: pressures.join(',') })
  }

  const evtList = events.ok ? items(events.data) : []
  /** @type {Map<string, {ns:string,kind:string,name:string,reason:string,count:number}>} */
  const warnTop = new Map()
  for (const /** @type {any} */ e of evtList) {
    if (e.type !== 'Warning') continue
    const key = `${e.involvedObject?.kind}/${e.involvedObject?.namespace}/${e.involvedObject?.name}|${e.reason}`
    const g = warnTop.get(key)
    if (g) g.count += e.count ?? 1
    else warnTop.set(key, { ns: e.involvedObject?.namespace ?? '', kind: e.involvedObject?.kind ?? '?', name: e.involvedObject?.name ?? '?', reason: e.reason ?? '?', count: e.count ?? 1 })
  }
  const warningsAll = [...warnTop.values()]
    .sort((a, b) => b.count - a.count || `${a.ns}/${a.name}`.localeCompare(`${b.ns}/${b.name}`))
  truncNote('warning-events', warningsAll.length, 12)
  const warnings = warningsAll.slice(0, 12)

  // CronJob 派生的 Job 键归一到 owner CronJob 名：实例名每小时全新，逐实例 ack 永远追不上排程（「认领」沦为摆设）
  /** @param {any} j */
  const jobMeta = (/** @type {any} */ j) => {
    const owner = (j.metadata?.ownerReferences ?? []).find((/** @type {any} */ o) => o.kind === 'CronJob')
    const m0 = meta(j)
    return owner ? { ...m0, name: `${owner.name}/${m0.name}`, kind: 'Job' } : m0
  }
  const failedJobsAll = (jobs.ok ? items(jobs.data) : [])
    .filter((/** @type {any} */ j) => (j.status?.failed ?? 0) > 0 && !(j.status?.succeeded ?? 0))
    .sort(byName)
  truncNote('failed-jobs', failedJobsAll.length, 15)
  const failedJobs = failedJobsAll
    .slice(0, 15)
    .map((/** @type {any} */ j) => ({ ...jobMeta(j), kind: 'Job', reason: j.status?.conditions?.find((/** @type {any} */ c) => c.type === 'Failed')?.reason ?? 'Failed' }))
  // 首页把「succeeded < desired」的 Job 一律判红（长时运行 Job 永远红），此前巡检无对应段：
  // 首页红项在巡检没有键、无法处置。补 running-jobs 让两套异常视图共用同一键空间。
  const runningJobs = (jobs.ok ? items(jobs.data) : [])
    .filter((/** @type {any} */ j) => {
      const desired = j.spec?.completions ?? 1
      const done = j.status?.succeeded ?? 0
      const complete = (j.status?.conditions ?? []).some((/** @type {any} */ c) => c.type === 'Complete' && c.status === 'True')
      const failed = (j.status?.failed ?? 0) > 0 && !done
      return !complete && !failed && done < desired && (j.status?.active ?? 0) > 0
    })
    .sort(byName)
    .slice(0, 15)
    .map((/** @type {any} */ j) => ({ ...jobMeta(j), kind: 'Job', ready: `${j.status?.succeeded ?? 0}/${j.spec?.completions ?? 1}` }))
  const suspendedCrons = (cron.ok ? items(cron.data) : [])
    .filter((/** @type {any} */ c) => c.spec?.suspend === true)
    .map((/** @type {any} */ c) => ({ ...meta(c), kind: 'CronJob' }))

  // 证书到期：x509 notAfter ≤30 天（node 内建解析，不引依赖）；解析失败显式 note，坏证书不许静默跳过
  const tlsCerts = []
  if (secrets.ok) {
    let parseFail = 0
    for (const sec of items(secrets.data)) {
      if (sec.type !== 'kubernetes.io/tls') continue
      const crt = sec.data?.['tls.crt']
      if (!crt) continue
      try {
        const x = new X509Certificate(Buffer.from(crt, 'base64'))
        const validTo = new Date(x.validTo)
        const days = Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
        if (days <= 30) tlsCerts.push({ e: { ...meta(sec), kind: 'Secret', reason: `${days < 0 ? `已过期 ${-days} 天` : `${days} 天后到期`}（${validTo.toISOString().slice(0, 10)}）` }, days })
      } catch {
        parseFail++
      }
    }
    if (parseFail > 0) notes.push(`tls-certs: ${parseFail} 个 TLS Secret 解析失败（未计入到期检查）`)
    tlsCerts.sort((a, b) => a.days - b.days)
  }
  // 配额压力：ResourceQuota 任一维度 used/hard ≥85%（合规周检的「配额面」，与 NsQuotaChip 同口径进可 diff 账）
  const quotaPressure = []
  if (quotas.ok) {
    for (const q of items(quotas.data)) {
      const hard = q.status?.hard ?? {}
      const used = q.status?.used ?? {}
      const hot = Object.keys(hard)
        .map((res) => {
          const h = parseQtyLoose(hard[res])
          const u = parseQtyLoose(used[res])
          if (!h) return null
          const pct = Math.round((u / h) * 100)
          return pct >= 85 ? `${res} ${pct}%` : null
        })
        .filter(Boolean)
      if (hot.length > 0) quotaPressure.push({ ...meta(q), kind: 'ResourceQuota', ready: hot.join(', ') })
    }
  }
  unready.sort((a, b) => `${a.ns}/${a.kind}/${a.name}`.localeCompare(`${b.ns}/${b.kind}/${b.name}`))
  const findings = [
    { id: 'unready-workloads', entries: (truncNote('unready-workloads', unready.length, 60), unready.slice(0, 60)) },
    { id: 'abnormal-pods', entries: abnormalPods },
    { id: 'node-issues', entries: badNodes },
    { id: 'warning-events', entries: warnings },
    { id: 'failed-jobs', entries: failedJobs },
    { id: 'running-jobs', entries: runningJobs },
    { id: 'suspended-crons', entries: suspendedCrons },
    { id: 'tls-certs-expiring', entries: tlsCerts.slice(0, 30).map((x) => x.e) },
    { id: 'quota-pressure', entries: quotaPressure.slice(0, 30) },
  ]
  // 处置键挂回条目：前端（巡检行/首页 join）消费 e.key，不再各自镜像 findingKey 格式
  for (const f of findings) {
    for (const e of f.entries) e.key = findingKey(f, e)
  }
  return { generatedAt: new Date().toISOString(), cluster, findings, notes, truncatedSections }
}

/**
 * 报告条目唯一键（diff 与处置共用；前端 dispKey 与本函数严格同构，改一侧必改另一侧）。
 * 对象级粒度：换失败原因仍算同一异常；**warning-events 段例外**——该段本就先按
 * kind/ns/name|reason 聚合，同对象每个 reason 一行，键必须同样带 reason，
 * 否则标记一行 = 同对象所有 Warning 一起被处置，且 reason 漂移时 diff 整段失真。
 */
export function findingKey(/** @type {{id:string}} */ f, /** @type {{ns?:string,name?:string,kind?:string,reason?:string}} */ e) {
  const extra = f.id === 'warning-events' ? `|${e.reason ?? ''}` : ''
  return `${f.id}/${e.ns ?? ''}/${e.kind ?? ''}/${e.name ?? ''}${extra}`
}

/** 读上一份报告（最后一条），算新增/恢复 */
function diffWithLast(/** @type {any} */ report) {
  if (!existsSync(REPORT_FILE)) return { added: [], resolved: [], hasPrev: false, prevGeneratedAt: null }
  const lines = readFileSync(REPORT_FILE, 'utf8').split('\n').filter(Boolean)
  /** @type {Set<string>} */
  let prevKeys = new Set()
  let hasPrev = false
  /** @type {string|null} */
  let prevGeneratedAt = null
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const prev = JSON.parse(lines[i] ?? '')
      if (prev.cluster !== report.cluster) continue
      // 命中同集群上一份才算 hasPrev（他集群/坏行不算——否则首次巡检谎称「与上次对比」）
      hasPrev = true
      prevGeneratedAt = prev.generatedAt ?? null
      prevKeys = new Set((prev.findings ?? []).flatMap((/** @type {any} */ f) => f.entries.map((/** @type {any} */ e) => findingKey(f, e))))
      break
    } catch { /* 半行跳过 */ }
  }
  const nowKeys = new Set(report.findings.flatMap((/** @type {any} */ f) => f.entries.map((/** @type {any} */ e) => findingKey(f, e))))
  // prevGeneratedAt：「疑似关联变更」归因下界——只有两次巡检之间的写才可能是恢复原因
  return {
    hasPrev,
    prevGeneratedAt,
    added: [...nowKeys].filter((k) => !prevKeys.has(k)),
    resolved: [...prevKeys].filter((k) => !nowKeys.has(k)),
  }
}

/**
 * 跑巡检 + 持久化 + 与上次 diff。
 * @param {string} cluster @param {AbortSignal} [signal]
 */
export async function inspectCluster(cluster, signal) {
  const report = await buildClusterReport(cluster, signal)
  const diff = diffWithLast(report)
  // diff 随报告落盘：inspect_report 透传给 AI、首页读最新份即可显示「上次巡检 +N」
  const persisted = /** @type {any} */ (report)
  persisted.diff = { hasPrev: diff.hasPrev, added: diff.added, resolved: diff.resolved, prevGeneratedAt: diff.prevGeneratedAt }
  // 容量水位随报告落进日摘要：requests 承诺口径不依赖 metrics-server，「还能塞多少」的历史从此可查
  try {
    persisted.water = await clusterCapacity(cluster, signal)
  } catch { /* 容量缺位不拦异常巡检 */ }
  recordDaily(report, diff)
  try {
    const lines = existsSync(REPORT_FILE) ? readFileSync(REPORT_FILE, 'utf8').split('\n').filter(Boolean) : []
    lines.push(JSON.stringify(report))
    // 配额按集群算：共享全局 20 份时，常巡 A 集群会把 B 的历史挤光（diff 静默失忆）
    const perCluster = new Map()
    for (const ln of lines) {
      try {
        const c = JSON.parse(ln)?.cluster ?? '?'
        if (!perCluster.has(c)) perCluster.set(c, [])
        perCluster.get(c).push(ln)
      } catch { /* 半行丢弃 */ }
    }
    const kept = [...perCluster.values()].map((v) => v.slice(-REPORT_CAP)).flat()
    writeFileSync(REPORT_FILE, kept.join('\n') + '\n')
  } catch {
    /* 只读挂载：报告不落盘不影响本次返回 */
  }
  return { report, diff }
}

/**
 * 历史报告（新→旧）：巡检页「历史」下拉数据源。整份返回（REPORT_CAP=20 封顶、
 * 各段 entries 已截断），schema 与本次报告一致，前端选中原样渲染。
 * @param {string} cluster
 */
/** @param {string} [cluster] 省略=全部集群 */
export function listReports(cluster) {
  if (!existsSync(REPORT_FILE)) return []
  const out = []
  const lines = readFileSync(REPORT_FILE, 'utf8').split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i] ?? '')
      if (cluster && r?.cluster !== cluster) continue
      out.push(r)
    } catch { /* 半行跳过 */ }
  }
  return out
}
