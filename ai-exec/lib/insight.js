// @ts-check
/**
 * 洞察类只读工具（diff_yaml / diagnose）：把「改动前先看影响」「命名空间为何起不来」
 * 这两类需要多次取数 + 关联推理的问题收敛成一次调用。
 *
 * 模块纪律（见批次契约）：纯导出、不 import tools.js——resolveResource / splitYamlDocs /
 * result / safe 都在本文件自带本地等价实现，避免和 tools.js 的私有 helper 互相牵制。
 * 两者都不写集群：diff_yaml 只在本地算 merge 结果，diagnose 全是 GET。
 */
import { Type } from 'typebox'
import { parse as yamlParse } from 'yaml'
import { list, get, BackendError } from './k8s.js'

/** diff 里单个值序列化上限（字符） */
const VALUE_LIMIT = 200
/** 事件 message 初始截断（字符）；超输出预算时逐级下调 */
const EVENT_MSG_LIMIT = 180
/** diagnose 输出硬预算（JSON 字符数）：整命名空间摘要不该挤占模型上下文 */
const DIAG_LIMIT = 6_000
/** 参与关联/输出的 Warning 事件条数上限 */
const EVENT_CAP = 15

// ---------- 通用小工具（与 tools.js 同形，本地自带） ----------

/** 出错不抛：返回 { error } 供模型如实转述（与 tools.js 的 safe 一致） */
/** @template T @param {() => Promise<T>} fn @returns {Promise<T | { error: string }>} */
async function safe(fn) {
  try {
    return await fn()
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** 按行 --- 切多文档 YAML（容错开头 ---、空段、注释段） */
/** @param {string} yamlText @returns {string[]} */
function splitYamlDocs(yamlText) {
  /** @type {string[]} */ const docs = []
  /** @type {string[]} */ let cur = []
  for (const line of yamlText.split('\n')) {
    if (/^---\s*$/.test(line)) {
      const t = cur.join('\n').trim()
      if (t) docs.push(t)
      cur = []
    } else {
      cur.push(line)
    }
  }
  const t = cur.join('\n').trim()
  if (t) docs.push(t)
  return docs
}

/** 逐层取字段：任一层不是对象就返回 undefined，省掉层层判空（k8s 对象层级深且字段全可缺） */
/** @param {unknown} root @param {...string} keys @returns {unknown} */
function at(root, ...keys) {
  let cur = root
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = /** @type {Record<string, unknown>} */ (cur)[k]
  }
  return cur
}

/** @param {unknown} v @returns {Record<string, unknown> | null} */
function asObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : null
}

/** @param {unknown} v @returns {unknown[]} */
function asArr(v) {
  return Array.isArray(v) ? v : []
}

/** @param {unknown} v @returns {string | null} */
function asStr(v) {
  return typeof v === 'string' ? v : null
}

/** @param {unknown} v @returns {number | null} */
function asNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 值 → diff 里的可读片段（≤VALUE_LIMIT 字符，数组折叠成「N 项」前缀） */
/** @param {unknown} v @returns {unknown} */
function brief(v) {
  if (v === undefined) return undefined
  if (Array.isArray(v)) return `${v.length} 项: ${cut(serialize(v), VALUE_LIMIT - 12)}`
  if (v !== null && typeof v === 'object') return cut(serialize(v), VALUE_LIMIT)
  return cut(serialize(v), VALUE_LIMIT)
}

/** @param {unknown} v @returns {string} */
function serialize(v) {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/** @param {string} s @param {number} n @returns {string} */
function cut(s, n) {
  if (n <= 0) return ''
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

// ---------- discovery（本实例缓存：/apis 聚合 + 各 groupVersion 文档按需加载） ----------

/** @typedef {{ plural: string; namespaced: boolean; apiVersion: string; kind: string }} ResourceInfo */

/**
 * kind → 复数名 + namespaced 的解析器。
 * 与 tools.js 版差异：契约要求自带且更宽容——kind 大小写、写成复数名（deployments）、
 * apiVersion 写错组版本都能靠聚合 discovery（含 CRD）兜住，并在结果里说明实际用的 apiVersion。
 * 缓存粒度是「每实例」，但会话换集群不重建工厂——靠入口 rebind() 检测集群变化
 * 作废全部缓存（见 boundCluster），避免跨集群串 discovery。
 * @param {() => string} cluster
 */
function createResolver(cluster) {
  /** @type {Map<string, Promise<ResourceInfo[]>>} groupVersion → 该版本全部资源 */
  const docs = new Map()
  /** @type {Map<string, ResourceInfo>} `${groupVersion}|${kind 或复数名的下划线形式}` */
  const index = new Map()
  /** @type {Promise<string[]> | null} 全部 groupVersion（含内置 v1） */
  let gvsPromise = null
  /** @type {Promise<void> | null} 全量扫描（仅在精确 apiVersion 未命中时触发一次） */
  let scanPromise = null
  /** @type {Map<string, string>} group → preferred groupVersion */
  const preferred = new Map()
  /**
   * 缓存绑定的集群。工厂只在会话 _build 时构建一次，审批续流换集群只改
   * clusterRef.value（sessions.js acquire）——工厂不重建，所以旧注释
   * 「换集群工厂会重建」不成立；改为入口检测集群变化即整体作废缓存。
   */
  /** @type {string} */
  let boundCluster = ''
  /** @type {number} rebind 代数：作废在途 discovery 的异步回写（R2 P2-3：
   * A 集群慢扫描未回完时换集群，回写会污染 B 集群的 index/docs） */
  let generation = 0
  function rebind() {
    const c = cluster()
    if (c !== boundCluster) {
      boundCluster = c
      generation++
      docs.clear()
      index.clear()
      gvsPromise = null
      scanPromise = null
      preferred.clear()
    }
  }

  /** @param {AbortSignal | undefined} signal @returns {Promise<string[]>} */
  function groupVersions(signal) {
    if (!gvsPromise) {
      const gen = generation
      gvsPromise = (async () => {
        try {
          const disc = /** @type {{ groups?: Array<{ preferredVersion?: { groupVersion?: string } }> }} */ (
            await get(cluster(), '/apis', signal)
          )
          const out = ['v1']
          for (const g of disc.groups ?? []) {
            const gv = g.preferredVersion?.groupVersion
            if (!gv) continue
            if (gen === generation) preferred.set(g.preferredVersion?.groupVersion?.split('/')[0] ?? '', gv)
            out.push(gv)
          }
          return out
        } catch (e) {
          if (gen === generation) gvsPromise = null
          throw e
        }
      })()
    }
    return gvsPromise
  }

  /** @param {string} gv @param {AbortSignal | undefined} signal @returns {Promise<ResourceInfo[]>} */
  function loadDoc(gv, signal) {
    const hit = docs.get(gv)
    if (hit) return hit
    const gen = generation
    const p = (async () => {
      try {
        const disc = /** @type {{ resources?: Array<{ name: string; kind: string; singularName?: string; namespaced?: boolean }> }} */ (
          await get(cluster(), gv === 'v1' ? '/api/v1' : `/apis/${gv}`, signal)
        )
        /** @type {ResourceInfo[]} */
        const rows = []
        for (const r of disc.resources ?? []) {
          // 子资源（pods/log、deployments/scale）名里带 /：会污染别名索引，也从不作为 apply 目标
          if (!r.name || r.name.includes('/')) continue
          /** @type {ResourceInfo} */
          const info = { plural: r.name, namespaced: r.namespaced !== false, apiVersion: gv, kind: r.kind }
          rows.push(info)
          for (const alias of [r.kind, r.singularName ?? '', r.name]) {
            const key = alias.trim().toLowerCase()
            // rebind 已发生（gen 变化）：旧集群的回写作废，防污染新集群 index
            if (gen !== generation) break
            if (key && !index.has(`${gv}|${key}`)) index.set(`${gv}|${key}`, info)
          }
          if (gen !== generation) break
        }
        return rows
      } catch (e) {
        if (gen === generation) docs.delete(gv)
        throw e
      }
    })()
    if (gen === generation) docs.set(gv, p)
    return p
  }

  /** 全量扫描各 groupVersion：只在精确 apiVersion 未命中时做一次（CRD/写错组版本的兜底） */
  /** @param {AbortSignal | undefined} signal @returns {Promise<void>} */
  function fullScan(signal) {
    if (!scanPromise) {
      const gen = generation
      scanPromise = (async () => {
        const gvs = await groupVersions(signal)
        // 并发拉全部 discovery 文档（本地后端，单文档很小）；个别失败不影响其余
        await Promise.all(gvs.map((gv) => loadDoc(gv, signal).catch(() => [])))
      })().catch((e) => {
        if (gen === generation) scanPromise = null
        throw e
      })
    }
    return scanPromise
  }

  /**
   * @param {string} apiVersion @param {string} kind @param {AbortSignal | undefined} signal
   * @returns {Promise<ResourceInfo>}
   */
  async function resolve(apiVersion, kind, signal) {
    rebind()
    const key = kind.trim().toLowerCase()
    await loadDoc(apiVersion, signal).catch(() => [])
    const direct = index.get(`${apiVersion}|${key}`)
    if (direct) return direct
    await fullScan(signal)
    /** @type {ResourceInfo[]} */
    const cands = []
    for (const [k, v] of index) {
      if (k.endsWith(`|${key}`)) cands.push(v)
    }
    if (cands.length === 0) {
      throw new Error(`discovery 未找到 kind=${kind}（apiVersion=${apiVersion}），请核对 apiVersion/kind 拼写`)
    }
    const group = apiVersion.includes('/') ? apiVersion.split('/')[0] ?? '' : ''
    // 候选优先级：精确 groupVersion → 同 group 的 preferred 版本 → 首个（发现顺序稳定）
    return (
      cands.find((c) => c.apiVersion === apiVersion) ??
      cands.find((c) => group !== '' && c.apiVersion.startsWith(`${group}/`)) ??
      cands.find((c) => c.apiVersion === preferred.get(group)) ??
      /** @type {ResourceInfo} */ (cands[0])
    )
  }

  return { resolve }
}

/**
 * 拼资源路径：/apis/{group}/{version}[/namespaces/{ns}]/{plural}[/{name}]（cluster-scoped 传 ns=null）。
 * @param {string} apiVersion @param {string} plural @param {string | null} ns @param {string | undefined} [name]
 */
function resourcePath(apiVersion, plural, ns, name) {
  const base = apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`
  const mid = ns ? `/namespaces/${encodeURIComponent(ns)}` : ''
  const suffix = name ? `/${encodeURIComponent(name)}` : ''
  return `${base}${mid}/${plural}${suffix}`
}

// ---------- diff_yaml ----------

/** @typedef {{ path: string; op: 'add' | 'remove' | 'change' | 'replace-array'; from?: unknown; to?: unknown; fromLen?: number; toLen?: number }} DiffEntry */

/** @param {unknown} v @returns {v is Record<string, unknown>} 是否为可逐键合并的 JSON 对象（数组/null 不是） */
function isMergeObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 数组能否按元素对齐比较：等长，且每对元素要么同为带同名 `name` 的对象（containers/env/
 * ports 这类 k8s 按 name 合并的列表），要么完全相等。满足时递归到 `path[i].键` 出细粒度
 * change，比「整数组替换」更贴近真实 apply 结果；不满足（长度变、name 换了）就退回整体替换。
 * @param {unknown[]} base @param {unknown[]} patch @returns {boolean}
 */
function alignable(base, patch) {
  if (base.length !== patch.length) return false
  for (let i = 0; i < patch.length; i++) {
    const a = asObj(base[i])
    const b = asObj(patch[i])
    if (a && b) {
      const an = asStr(a['name'])
      if (an == null || an !== asStr(b['name'])) return false
    } else if (serialize(base[i]) !== serialize(patch[i])) {
      return false
    }
  }
  return true
}

/**
 * 身份字段不参与 diff：kind/apiVersion 是 discovery 寻址依据（写复数或小写别名也算同一资源），
 * metadata.name/namespace 是 GET 定位依据（必然相等），比出来只会制造噪音。
 */
const IDENTITY_PATHS = new Set(['kind', 'apiVersion', 'metadata.name', 'metadata.namespace'])

/**
 * 按 merge/SSA 的字段语义算「输入打到 current 上的结果」并输出路径级 diff。
 * 只走输入里出现的键——输入缺失的键 merge 语义下不动，所以不需要比对 current 独有字段；
 * 数组默认整体替换（merge patch 语义），长度变化即抹除，附 warning。
 * @param {Record<string, unknown>} patch
 * @param {unknown} base
 * @param {string} path
 * @param {DiffEntry[]} diffs
 * @param {string[]} warnings
 * @returns {void}
 */
function walkDiff(patch, base, path, diffs, warnings) {
  for (const [k, pv] of Object.entries(patch)) {
    const p = path ? `${path}.${k}` : k
    if (IDENTITY_PATHS.has(p)) continue
    const has = isMergeObject(base) && Object.hasOwn(base, k)
    const bv = has ? /** @type {Record<string, unknown>} */ (base)[k] : undefined
    if (pv === null) {
      // merge patch 显式 null = 删键
      if (has) diffs.push({ path: p, op: 'remove', from: brief(bv), to: null })
      continue
    }
    if (!has) {
      diffs.push({ path: p, op: 'add', to: brief(pv) })
      continue
    }
    if (isMergeObject(pv)) {
      if (!isMergeObject(bv)) {
        diffs.push({ path: p, op: 'change', from: brief(bv), to: brief(pv) })
        continue
      }
      walkDiff(pv, bv, p, diffs, warnings)
      continue
    }
    if (Array.isArray(pv)) {
      if (!Array.isArray(bv)) {
        diffs.push({ path: p, op: 'change', from: brief(bv), to: brief(pv) })
        continue
      }
      if (serialize(bv) === serialize(pv)) continue
      if (alignable(bv, pv)) {
        // 能对齐的列表逐元素递归：标量对相等（否则整数组就相等了）无差异，只递归对象对
        for (let i = 0; i < pv.length; i++) {
          const a = asObj(bv[i])
          const b = asObj(pv[i])
          if (a && b) walkDiff(b, a, `${p}[${i}]`, diffs, warnings)
        }
        continue
      }
      diffs.push({ path: p, op: 'replace-array', from: brief(bv), to: brief(pv), fromLen: bv.length, toLen: pv.length })
      // 抹除风险：数组是整体替换，current 里没被输入覆盖到的元素会消失
      const keep = new Set(pv.map((x) => serialize(x)))
      const dropped = bv.filter((x) => !keep.has(serialize(x))).length
      if (dropped > 0) {
        warnings.push(
          `${p}：数组按整体替换语义处理（${bv.length}→${pv.length} 项），current 里 ${dropped} 项未在输入中出现、将被删除。` +
            '若该字段是 env/containers/ports/volumeMounts 这类服务端按 name 合并的列表，真实 apply 可能只增改不删——以 apply_yaml dryRun 为准。',
        )
      }
      continue
    }
    if (bv !== pv) diffs.push({ path: p, op: 'change', from: brief(bv), to: brief(pv) })
  }
}

// ---------- diagnose 取数/摘要 helper ----------

/**
 * 子查询降级：任一维度失败（CRD 未装、RBAC 拒绝、apiserver 抖动）不该拖垮整个诊断——
 * 失败转成 note + 空数据，其余维度照常出结论。
 * @template T @param {string} label @param {() => Promise<T>} fn @param {T} empty
 * @returns {Promise<{ data: T; note: string | null }>}
 */
async function attempt(label, fn, empty) {
  try {
    return { data: await fn(), note: null }
  } catch (e) {
    return { data: empty, note: `${label}查询失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** @typedef {{ kind: string; name: string; base: string; ev: string | null }} AnomalyPart */

/**
 * 事件索引：kind/name 与裸 name 各留一条「最该看」的 Warning。
 * 按对象逐个查 events 成本高（每个 workload 一次请求），这里一次拉命名空间全量再本地 join。
 * @param {unknown[]} events
 */
function eventIndex(events) {
  const sorted = [...events].sort((a, b) => evTime(b).localeCompare(evTime(a)))
  /** @type {Map<string, Record<string, unknown>>} */
  const byKindName = new Map()
  /** @type {Map<string, Record<string, unknown>>} */
  const byName = new Map()
  for (const raw of sorted) {
    const e = asObj(raw)
    if (!e) continue
    const name = asStr(at(e, 'involvedObject', 'name'))
    if (!name) continue
    // 事件里 kind 是首字母大写（Pod/Deployment），我们的摘要用小写——索引键统一小写才能 join 上
    const kind = asStr(at(e, 'involvedObject', 'kind')) ?? 'Object'
    const kn = `${kind.toLowerCase()}/${name}`
    if (!byKindName.has(kn)) byKindName.set(kn, e)
    if (!byName.has(name)) byName.set(name, e)
  }
  /** @param {string} kind @param {string} name @returns {Record<string, unknown> | null} */
  const lookup = (kind, name) => byKindName.get(`${kind.toLowerCase()}/${name}`) ?? byName.get(name) ?? null
  return { lookup }
}

/** @param {unknown} e @returns {string} */
function evTime(e) {
  return (
    asStr(at(e, 'lastTimestamp')) ??
    asStr(at(e, 'eventTime')) ??
    asStr(at(e, 'metadata', 'creationTimestamp')) ??
    ''
  )
}

/** @param {Record<string, unknown> | null} e @returns {string | null} 事件的 reason: message */
function evText(e) {
  if (!e) return null
  const reason = asStr(at(e, 'reason')) ?? 'Event'
  const message = asStr(at(e, 'message')) ?? ''
  return message ? `${reason}: ${message}` : reason
}

/**
 * condition → {status, reason, message}。
 * @param {unknown} owner @param {string} type
 */
function condition(owner, type) {
  for (const raw of asArr(at(owner, 'status', 'conditions'))) {
    const c = asObj(raw)
    if (c && at(c, 'type') === type) {
      return {
        status: asStr(at(c, 'status')),
        reason: asStr(at(c, 'reason')),
        message: asStr(at(c, 'message')),
      }
    }
  }
  return null
}

/**
 * 构造洞察工具集（diff_yaml + diagnose，均只读）。
 * @param {{ value: string }} clusterRef 当前会话的集群名（可变引用，execute 时读取）
 */
export function buildInsightTools(clusterRef) {
  const cluster = () => clusterRef.value
  const { resolve } = createResolver(cluster)

  /** 工具统一出口：结果同时给模型（JSON 文本）与 UI（details 结构化） */
  /** @template T @param {T} value @returns {{ content: Array<{ type: 'text'; text: string }>, details: T }} */
  const result = (value) => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
    details: value,
  })

  /**
   * 单文档：解析 → discovery → GET 现资源 → merge diff。
   * @param {string} docText @param {AbortSignal | undefined} signal @returns {Promise<Record<string, unknown>>}
   */
  async function diffOne(docText, signal) {
    const input = /** @type {Record<string, unknown> | null} */ (yamlParse(docText))
    if (!isMergeObject(input)) throw new Error('文档不是有效的对象')
    const apiVersion = asStr(at(input, 'apiVersion'))
    const kindRaw = asStr(at(input, 'kind'))
    const name = asStr(at(input, 'metadata', 'name'))
    if (!apiVersion || !kindRaw || !name) throw new Error('文档缺少 apiVersion/kind/metadata.name')
    const info = await resolve(apiVersion, kindRaw, signal)
    const ns = info.namespaced ? asStr(at(input, 'metadata', 'namespace')) ?? 'default' : null
    const current = await get(cluster(), resourcePath(info.apiVersion, info.plural, ns, name), signal)
      .then((v) => asObj(v))
      .catch((e) => {
        // 404 是正常分支（首次部署）；其余错误照抛给 per-doc 兜底
        if (e instanceof BackendError && e.status === 404) return null
        throw e
      })
    const base = { kind: info.kind, apiVersion: info.apiVersion, name, namespace: ns }
    if (!current) {
      return {
        ...base,
        change: 'create',
        diffs: [],
        warnings: [],
        note: '集群里没有该资源：apply 将新建，服务端会补默认值与生成字段（status/uid/resourceVersion 等），这些不出现在 diff 里',
      }
    }
    /** @type {DiffEntry[]} */
    const diffs = []
    /** @type {string[]} */
    const warnings = []
    if (at(input, 'status') !== undefined) {
      warnings.push('输入里的 status 段 apply 到主资源时会被 API 忽略（status 需经 /status 子资源写），相关 diff 不代表真会生效')
    }
    if (info.apiVersion !== apiVersion) {
      warnings.push(`apiVersion=${apiVersion} 下没发现 kind=${kindRaw}，已按 discovery 命中的 ${info.apiVersion} 比较（apply 请用该 apiVersion）`)
    }
    walkDiff(input, current, '', diffs, warnings)
    return { ...base, change: diffs.length === 0 ? 'same' : 'modify', diffs, warnings }
  }

  return {
    diff_yaml: {
      label: 'YAML 变更预演',
      description:
        '只读预演：把 YAML（--- 分隔多文档）与集群现状比对，返回字段路径级 diff（op=add|remove|change|replace-array）与抹除风险 warning，不写集群。' +
        '每文档需 apiVersion/kind/metadata.name；资源不存在→change=create，无差异→same。' +
        '语义是本地 merge 近似（对象逐键合并、输入缺失的键不动、null 删键、数组整体替换），不是 server-side 真 diff：数组字段（env/volumes/containers 等）未列出的现有元素有被抹掉的风险，会以 warning 明示，最终以 apply_yaml dryRun 为准。' +
        'apply_yaml 前想确认影响（改哪个镜像、会不会删掉 env）先用本工具。返回 {results:[{kind,name,namespace,change,diffs,warnings}]}。',
      parameters: Type.Object({
        yaml: Type.String({ description: '要预演的 YAML 文本（多文档用 --- 分隔）' }),
      }),
      /** @param {string} _toolCallId @param {{ yaml: string }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const data = await safe(async () => {
          const docs = splitYamlDocs(params.yaml)
          if (docs.length === 0) throw new Error('yaml 中没有有效文档')
          /** @type {Record<string, unknown>[]} */
          const results = []
          // 逐文档互不影响：某一个解析/发现失败只让它自己返回 error
          for (const doc of docs) {
            try {
              results.push(await diffOne(doc, signal))
            } catch (e) {
              results.push({ error: e instanceof Error ? e.message : String(e) })
            }
          }
          return { results }
        })
        return result(data)
      },
    },

    diagnose: {
      label: '命名空间诊断',
      description:
        '诊断一个命名空间「为什么起不来/为什么不健康/是不是在掉容量」的首选工具：一次并发拉取 deployments、statefulsets、pods、services、ingresses（含后端 service 与端点数）、endpoints、pvcs、HPA、jobs/cronjobs、Warning 事件，' +
        '返回扁平结论 summary（人话，含就绪副本比与根因）与 anomalies（每条带关联到的事件 message），不写集群、不返回原始对象。' +
        '一次调用就覆盖了该命名空间的 pods+deployments+events，拿到 summary 后直接据此回答——别对同一个 ns 再调一次，也别再连发 list_pods + list_events + top 自己拼原因（要具体 Pod 用 get_pod，要看某个发布的卡点用 rollout status）。' +
        '某维度查询失败会降级成 notes 里的说明，其余结论照常给。' +
        'compact=true 只要 summary + counts（更省上下文）。事件有 1h TTL 且被聚合，历史故障可能只剩 reason。',
      parameters: Type.Object({
        ns: Type.String({ description: '命名空间（必填，如 k8s-infra）' }),
        compact: Type.Optional(Type.Boolean({ description: 'true = 只返回 summary 与计数，省略 anomalies 明细' })),
      }),
      /** @param {string} _toolCallId @param {{ ns: string; compact?: boolean }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const { ns } = params
        const compact = params.compact === true
        const enc = encodeURIComponent(ns)
        /** @param {string} res */
        const core = (res) => `/api/v1/namespaces/${enc}/${res}`
        /** @param {string} res */
        const apps = (res) => `/apis/apps/v1/namespaces/${enc}/${res}`
        const data = await safe(async () => {
          /** 各维度共用的空结果；宽松元素类型让 attempt 的 T 与 list 返回类型兼容 */
          /** @type {{ items: any[] }} */
          const EMPTY = { items: [] }
          const [deps, ssets, pods, svcs, ingresses, endpoints, pvcs, hpas, jobs, crons, events, nsMissing] = await Promise.all([
            attempt('deployments', () => list(cluster(), apps('deployments'), {}, signal), EMPTY),
            attempt('statefulsets', () => list(cluster(), apps('statefulsets'), {}, signal), EMPTY),
            attempt('pods', () => list(cluster(), core('pods'), {}, signal), EMPTY),
            attempt('services', () => list(cluster(), core('services'), {}, signal), EMPTY),
            attempt('ingresses', () => list(cluster(), `/apis/networking.k8s.io/v1/namespaces/${enc}/ingresses`, {}, signal), EMPTY),
            attempt('endpoints', () => list(cluster(), core('endpoints'), {}, signal), EMPTY),
            attempt('persistentvolumeclaims', () => list(cluster(), core('persistentvolumeclaims'), {}, signal), EMPTY),
            attempt('HPA', async () => {
              // v2 未注册的集群（老版本/精简安装）回退 v1
              try {
                return await list(cluster(), `/apis/autoscaling/v2/namespaces/${enc}/horizontalpodautoscalers`, {}, signal)
              } catch (e) {
                if (!(e instanceof BackendError) || e.status !== 404) throw e
                return await list(cluster(), `/apis/autoscaling/v1/namespaces/${enc}/horizontalpodautoscalers`, {}, signal)
              }
            }, EMPTY),
            attempt('jobs', () => list(cluster(), `/apis/batch/v1/namespaces/${enc}/jobs`, {}, signal), EMPTY),
            attempt('cronjobs', () => list(cluster(), `/apis/batch/v1/namespaces/${enc}/cronjobs`, {}, signal), EMPTY),
            attempt(
              'events',
              () => list(cluster(), core('events'), { fieldSelector: 'type=Warning', limit: '200' }, signal),
              EMPTY,
            ),
            // 命名空间不存在时各子查询都返回空列表（k8s 语义），会被读成「一切正常」——单独探一次
            get(cluster(), `/api/v1/namespaces/${enc}`, signal)
              .then(() => false)
              .catch((e) => (e instanceof BackendError && e.status === 404 ? true : false)),
          ])
          const parts = [deps, ssets, pods, svcs, ingresses, endpoints, pvcs, hpas, jobs, crons, events]
          const notes = parts.map((p) => p.note).filter((n) => typeof n === 'string')
          if (notes.length === parts.length) {
            throw new Error(`命名空间 ${ns} 全部查询失败（检查拼写与访问权限）：${notes[0]}`)
          }
          if (nsMissing) {
            return {
              namespace: ns,
              abnormal: 1,
              summary: [`命名空间 ${ns} 不存在（k8s 对不存在的命名空间返回空列表，不是「一切正常」）`],
              anomalies: [{ kind: 'namespace', name: ns, why: 'GET /api/v1/namespaces 返回 404，请核对命名空间名' }],
              counts: { exists: false },
              ...(notes.length > 0 ? { notes } : {}),
            }
          }
          const evRows = asArr(events.data.items).slice(0, EVENT_CAP)
          const evs = eventIndex(asArr(events.data.items))
          /** @type {string[]} */ const summary = []
          /** @type {AnomalyPart[]} */ const anomalies = []
          /** @param {string} kind @param {string} name @param {string} base @param {Record<string, unknown> | null} [ev] */
          const bad = (kind, name, base, ev) => {
            const e = ev ?? evs.lookup(kind, name)
            anomalies.push({ kind, name, base: base || '状态异常（无更多细节）', ev: evText(e ?? null) })
          }
          /** @param {unknown[]} items */
          const nameSet = (items) => new Set(items.map((i) => asStr(at(i, 'metadata', 'name')) ?? ''))

          const depItems = asArr(deps.data.items)
          const ssItems = asArr(ssets.data.items)
          const podItems = asArr(pods.data.items)
          const svcItems = asArr(svcs.data.items)
          const ingItems = asArr(ingresses.data.items)
          const epItems = asArr(endpoints.data.items)
          const pvcItems = asArr(pvcs.data.items)
          const hpaItems = asArr(hpas.data.items)
          const jobItems = asArr(jobs.data.items)
          const cronItems = asArr(crons.data.items)

          /** 端点对象 → {地址数, 端点组数}；端点数 0 的 Service 是「起不来」最常见的下游症状 */
          /** @param {string} svcName */
          const epStat = (svcName) => {
            const ep = epItems.map((r) => asObj(r)).find((o) => o && at(o, 'metadata', 'name') === svcName)
            if (!ep) return null
            const subsets = asArr(at(ep, 'subsets'))
            const addresses = subsets.reduce((/** @type {number} */ n, s) => n + asArr(at(s, 'addresses')).length, 0)
            return { addresses, groups: subsets.length }
          }

          // 工作负载：就绪比 + Progressing 卡住的真实原因
          /** @param {unknown[]} items @param {string} kind */
          const scanRollout = (items, kind) => {
            let unhealthy = 0
            let zeroed = 0
            for (const raw of items) {
              const o = asObj(raw)
              if (!o) continue
              const name = asStr(at(o, 'metadata', 'name')) ?? '?'
              const desired = asNum(at(o, 'spec', 'replicas')) ?? 0
              const ready = asNum(at(o, 'status', 'readyReplicas')) ?? 0
              const updated = asNum(at(o, 'status', 'updatedReplicas')) ?? 0
              const prog = condition(o, 'Progressing')
              const avail = condition(o, 'Available')
              const stuck = prog !== null && prog.status === 'False'
              const avFalse = avail !== null && avail.status === 'False'
              if (ready === desired && !stuck && !avFalse) {
                if (desired === 0) zeroed++
                const note = desired === 0 ? '（副本数 0，未运行）' : updated < desired ? `（滚动更新中，已更新 ${updated}）` : ''
                summary.push(`${kind}/${name} 就绪 ${ready}/${desired}${note}`)
                continue
              }
              unhealthy++
              const bits = [`就绪 ${ready}/${desired}`]
              if (updated < desired && desired > 0) bits.push(`已更新 ${updated}/${desired}`)
              if (stuck) bits.push(`Progressing=False${prog?.reason ? `(${prog.reason})` : ''}`)
              else if (avFalse) bits.push(`Available=False${avail?.reason ? `(${avail.reason})` : ''}`)
              const own = evs.lookup('deployment', name) ?? evs.lookup('statefulset', name)
              bad(kind, name, bits.join('，'), own)
            }
            if (items.length === 0) return
            // 缩到 0 的负载 ready==desired 不代表「在服务」，单独计数免得聚合行误导
            summary.push(
              `${kind} 共 ${items.length} 个，${items.length - unhealthy - zeroed} 个全副本就绪${zeroed ? `，${zeroed} 个副本数 0` : ''}${unhealthy ? `，${unhealthy} 个未就绪` : ''}`,
            )
          }
          scanRollout(depItems, 'deployment')
          scanRollout(ssItems, 'statefulset')

          // Pod：相态 / 容器未就绪 / 反复重启，waiting-terminated 原因 + 关联事件
          let podAbnormal = 0
          let totalRestarts = 0
          /** @type {Record<string, number>} */ const phaseCount = {}
          for (const raw of podItems) {
            const p = asObj(raw)
            if (!p) continue
            const name = asStr(at(p, 'metadata', 'name')) ?? '?'
            const phase = asStr(at(p, 'status', 'phase')) ?? 'Unknown'
            phaseCount[phase] = (phaseCount[phase] ?? 0) + 1
            const cs = asArr(at(p, 'status', 'containerStatuses')).map((c) => asObj(c)).filter((c) => c !== null)
            const restarts = cs.reduce((n, c) => n + (asNum(at(c, 'restartCount')) ?? 0), 0)
            totalRestarts += restarts
            const notReady = cs.filter((c) => at(c, 'ready') !== true).length
            const terminating = at(p, 'metadata', 'deletionTimestamp') !== undefined
            const waiting = cs.map((c) => asObj(at(c, 'state', 'waiting'))).find((w) => w !== null)
            const terminated = cs.map((c) => asObj(at(c, 'state', 'terminated'))).find((t) => t !== null && asStr(at(t, 'reason')) !== 'Completed')
            const badPhase = phase !== 'Running' && phase !== 'Succeeded'
            // Succeeded（Job 跑完）容器的 ready 本就是 false，不能按未就绪算故障
            if (phase === 'Succeeded') continue
            if (!badPhase && notReady === 0 && restarts < 3) continue
            if (terminating) continue // 正在优雅退出，不算故障
            podAbnormal++
            /** @type {string[]} */ const bits = []
            if (badPhase) bits.push(`phase=${phase}`)
            if (waiting) bits.push(`容器 ${asStr(at(waiting, 'reason')) ?? 'Waiting'}`)
            if (terminated) bits.push(`容器终止 ${asStr(at(terminated, 'reason')) ?? 'Terminated'}${asNum(at(terminated, 'exitCode')) != null ? `(exit ${asNum(at(terminated, 'exitCode'))})` : ''}`)
            if (phase === 'Running' && notReady > 0) bits.push(`容器未就绪 ${cs.length - notReady}/${cs.length}`)
            if (restarts >= 3) bits.push(`累计重启 ${restarts} 次`)
            // waiting/terminated 的 message 常为空，真正的报错在 Pod 自己的事件里
            const podEv = evs.lookup('Pod', name)
            const msg = asStr(at(waiting, 'message')) ?? asStr(at(terminated, 'message')) ?? asStr(at(p, 'status', 'message'))
            bad('pod', name, bits.join('，'), msg ? { message: msg, reason: asStr(at(podEv, 'reason')) ?? asStr(at(waiting, 'reason')) ?? asStr(at(terminated, 'reason')) ?? 'Pod' } : podEv)
          }
          const phaseText = Object.entries(phaseCount).map(([k, v]) => `${k} ${v}`).join('/') || '无'
          summary.push(`pods 共 ${podItems.length}（${phaseText}），异常 ${podAbnormal}，累计重启 ${totalRestarts} 次`)

          // Service / Endpoints：selector 命中不到地址＝后端空
          const runningPods = podItems.filter((p) => at(p, 'status', 'phase') === 'Running').length
          let svcEmpty = 0
          for (const raw of svcItems) {
            const o = asObj(raw)
            if (!o) continue
            const name = asStr(at(o, 'metadata', 'name')) ?? '?'
            const type = asStr(at(o, 'spec', 'type')) ?? 'ClusterIP'
            if (type === 'ExternalName') continue // 不依赖端点，无健康语义
            const selector = asObj(at(o, 'spec', 'selector'))
            const st = epStat(name)
            const addresses = st?.addresses ?? 0
            const groups = st?.groups ?? 0
            if (addresses === 0 && (selector === null || Object.keys(selector).length > 0)) {
              svcEmpty++
              bad('service', name, `可用端点 0（type=${type}${st === null ? '，无 Endpoints 对象' : `，端点组 ${groups}`}）——后端没有可路由的 Pod（命名空间 Running pod ${runningPods} 个）`)
            }
          }
          if (svcItems.length > 0) summary.push(`services 共 ${svcItems.length}，其中 ${svcItems.length - svcEmpty} 个有可用端点`)

          // Ingress：后端 service 存在性与端点数（DNS 通但 503 的根因常在这里）
          const svcNames = nameSet(svcItems)
          for (const raw of ingItems) {
            const o = asObj(raw)
            if (!o) continue
            const name = asStr(at(o, 'metadata', 'name')) ?? '?'
            /** @type {string[]} */ const backends = []
            /** @type {string[]} */ const refs = []
            for (const rule of asArr(at(o, 'spec', 'rules'))) {
              for (const hp of asArr(at(rule, 'http', 'paths'))) {
                const svc = asStr(at(hp, 'backend', 'service', 'name'))
                if (svc) refs.push(svc)
              }
            }
            const defSvc = asStr(at(o, 'spec', 'defaultBackend', 'service', 'name'))
            if (defSvc) refs.push(defSvc)
            let broken = false
            for (const svc of new Set(refs)) {
              if (!svcNames.has(svc)) {
                broken = true
                bad('ingress', name, `后端引用本命名空间不存在的服务 service/${svc}（DNS 解析不到，流量必失败）`)
                backends.push(`${svc}=缺失`)
                continue
              }
              const st = epStat(svc)
              const addresses = st?.addresses ?? 0
              backends.push(`${svc}:${addresses} 端点/${st?.groups ?? 0} 组`)
              if (addresses === 0) {
                broken = true
                bad('ingress', name, `后端 service/${svc} 无可用端点（规则匹配得上但没人接，通常 503）`)
              }
            }
            if (!broken) summary.push(`ingress/${name} 后端 ${backends.join('、') || '无 http 后端'}`)
          }

          // PVC：非 Bound（Pending 多半是 storageclass/配额问题）
          let pvcBad = 0
          for (const raw of pvcItems) {
            const o = asObj(raw)
            if (!o) continue
            const name = asStr(at(o, 'metadata', 'name')) ?? '?'
            const phase = asStr(at(o, 'status', 'phase')) ?? 'Unknown'
            if (phase === 'Bound') continue
            pvcBad++
            bad('persistentvolumeclaim', name, `phase=${phase}${asStr(at(o, 'spec', 'storageClassName')) ? `，storageClass=${asStr(at(o, 'spec', 'storageClassName'))}` : ''}`)
          }
          if (pvcItems.length > 0) summary.push(`pvcs 共 ${pvcItems.length}，${pvcItems.length - pvcBad} 个 Bound`)

          // HPA：ScalingActive=False＝指标取不到，扩缩容根本没在工作
          for (const raw of hpaItems) {
            const o = asObj(raw)
            if (!o) continue
            const name = asStr(at(o, 'metadata', 'name')) ?? '?'
            const cur = asNum(at(o, 'status', 'currentReplicas'))
            const want = asNum(at(o, 'status', 'desiredReplicas'))
            const min = asNum(at(o, 'spec', 'minReplicas')) ?? 1
            const max = asNum(at(o, 'spec', 'maxReplicas'))
            const active = condition(o, 'ScalingActive')
            summary.push(`hpa/${name} 副本 当前 ${cur ?? '?'}/期望 ${want ?? '?'}（区间 ${min}-${max ?? '?'}）`)
            if (active !== null && active.status === 'False') {
              bad('horizontalpodautoscaler', name, `ScalingActive=False${active.reason ? `(${active.reason})` : ''}——指标拿不到，不会扩缩容`, evs.lookup('horizontalpodautoscaler', name))
            }
          }

          // Jobs / CronJobs：失败计数（CronJob 按前缀归属的子 Job 汇总）
          let jobFailed = 0
          for (const raw of jobItems) {
            const o = asObj(raw)
            if (!o) continue
            const name = asStr(at(o, 'metadata', 'name')) ?? '?'
            const failed = asNum(at(o, 'status', 'failed')) ?? 0
            const succeeded = asNum(at(o, 'status', 'succeeded')) ?? 0
            if (failed > 0) {
              jobFailed += failed
              bad('job', name, `失败 ${failed} 次${succeeded ? `，成功 ${succeeded}` : '，尚无可成功实例'}`, evs.lookup('Job', name))
            }
          }
          let cronBad = 0
          for (const raw of cronItems) {
            const o = asObj(raw)
            if (!o) continue
            const name = asStr(at(o, 'metadata', 'name')) ?? '?'
            const kids = jobItems.filter((j) => (asStr(at(j, 'metadata', 'name')) ?? '').startsWith(`${name}-`))
            const failed = kids.reduce((/** @type {number} */ n, j) => n + (asNum(at(j, 'status', 'failed')) ?? 0), 0)
            const neverOk = at(o, 'status', 'lastSuccessfulTime') === undefined && at(o, 'status', 'lastScheduleTime') !== undefined
            if (failed > 0) {
              cronBad++
              bad('cronjob', name, `名下 Job 累计失败 ${failed} 次`, evs.lookup('CronJob', name) ?? evs.lookup('Job', kids.map((j) => asStr(at(j, 'metadata', 'name')) ?? '')[0] ?? ''))
            } else if (neverOk) {
              cronBad++
              bad('cronjob', name, `已调度但从未成功（lastSuccessfulTime 缺失）`)
            }
          }
          if (jobItems.length > 0 || cronItems.length > 0) {
            summary.push(`jobs ${jobItems.length}（失败 ${jobFailed} 次）/ cronjobs ${cronItems.length}（异常 ${cronBad}）`)
          }

          // 只剩事件可见的对象（pod 已重建/删除）：不丢线索
          const known = new Set([
            ...nameSet(podItems), ...nameSet(depItems), ...nameSet(ssItems), ...nameSet(svcItems),
            ...nameSet(ingItems), ...nameSet(pvcItems), ...nameSet(hpaItems), ...nameSet(jobItems), ...nameSet(cronItems),
          ])
          let orphans = 0
          for (const raw of evRows) {
            const e = asObj(raw)
            if (!e) continue
            const name = asStr(at(e, 'involvedObject', 'name')) ?? '?'
            if (known.has(name) || orphans >= 5) continue
            orphans++
            const kind = (asStr(at(e, 'involvedObject', 'kind')) ?? 'object').toLowerCase()
            anomalies.push({ kind, name, base: `仅事件可见（对象已不在当前列表，可能是已重建/删除的实例）`, ev: evText(e) })
          }

          const abnormalKinds = new Set(anomalies.map((a) => a.kind))
          summary.unshift(
            anomalies.length === 0
              ? `命名空间 ${ns}：未发现异常（workload ${depItems.length + ssItems.length}、pods ${podItems.length}、services ${svcItems.length}）`
              : `命名空间 ${ns}：${anomalies.length} 项异常，涉及 ${[...abnormalKinds].join('/')}`,
          )

          const counts = {
            deployments: depItems.length,
            statefulsets: ssItems.length,
            pods: { total: podItems.length, abnormal: podAbnormal, restarts: totalRestarts },
            services: { total: svcItems.length, emptyEndpoint: svcEmpty },
            ingresses: ingItems.length,
            persistentvolumeclaims: { total: pvcItems.length, unbound: pvcBad },
            horizontalpodautoscalers: hpaItems.length,
            jobs: { total: jobItems.length, failed: jobFailed },
            cronjobs: { total: cronItems.length, abnormal: cronBad },
            warningEvents: { total: asArr(events.data.items).length, listed: evRows.length },
          }
          /** @param {string[]} lines @param {number} width @returns {string[]} */
          const capped = (lines, width) => lines.map((s) => cut(s, width))
          /** notes 也占预算：宽度与条数都封死，避免子项大面积失败时 notes 反向撑爆输出 */
          const notesOut = notes.length > 0 ? { notes: capped(notes, 160).slice(0, 6) } : {}
          /**
           * 装预算：骨架（counts/anomalies 等）固定，summary 取「能整体塞进 DIAG_LIMIT 的最大前缀」，
           * 装不下的换成一行省略说明。倒序逐档试——省略说明本身也占空间，有时要多退一行才塞得下。
           * @param {Record<string, unknown>} base @param {string[]} lines @returns {Record<string, unknown>}
           */
          const fit = (base, lines) => {
            for (let i = lines.length; i >= 0; i--) {
              const keep = i === lines.length ? lines : [...lines.slice(0, i), `其余 ${lines.length - i} 行因输出预算省略`]
              if (JSON.stringify({ ...base, summary: keep }).length <= DIAG_LIMIT) return { ...base, summary: keep }
            }
            return { ...base, summary: ['输出超出预算，仅保留计数'] }
          }

          if (compact) {
            // compact：只要 summary + 计数，逐级压 summary 宽度，最窄档仍超预算就截行数
            for (const width of [240, 140, 80]) {
              const out = { namespace: ns, abnormal: anomalies.length, summary: capped(summary, width), counts, ...notesOut }
              if (JSON.stringify(out).length <= DIAG_LIMIT) return out
            }
            return fit({ namespace: ns, abnormal: anomalies.length, counts, ...notesOut }, capped(summary, 60))
          }

          /**
           * 逐级降预算渲染：事件 message 截断长度 + anomalies 条数一起收，
           * 直到该级明细能整体塞进预算（宁可少几条明细也不丢整体结论）；
           * 明细放得下之后，summary 再取最大前缀装满剩余空间，保证 <6000 是硬上限。
           */
          for (const [msgLimit, anomLimit] of /** @type {Array<[number, number]>} */ (
            [[EVENT_MSG_LIMIT, 40], [110, 25], [60, 15], [30, 10], [12, 6]]
          )) {
            const rows = anomalies.slice(0, anomLimit).map((a) => ({
              kind: a.kind,
              name: a.name,
              why: a.ev ? `${a.base}；${cut(a.ev, msgLimit)}` : a.base,
            }))
            const trimmed = anomLimit < anomalies.length ? anomalies.length - anomLimit : 0
            const base = { namespace: ns, abnormal: anomalies.length, anomalies: rows, counts, ...notesOut }
            if (JSON.stringify({ ...base, summary: [] }).length > DIAG_LIMIT) continue
            return fit(base, capped(trimmed > 0 ? [...summary, `另有 ${trimmed} 条异常明细因输出预算省略`] : summary, 240))
          }
          // 连最小一级的明细骨架都放不下：只留计数与结论行
          return fit(
            { namespace: ns, abnormal: anomalies.length, counts, ...notesOut },
            capped([...summary, `异常明细超出 ${DIAG_LIMIT} 字符预算已省略，可用 compact=true 或缩小命名空间范围再查`], 120),
          )
        })
        return result(data)
      },
    },
  }
}
