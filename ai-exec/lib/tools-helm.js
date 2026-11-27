// @ts-check
/**
 * tools 域：helm_releases / install / upgrade / uninstall / rollback（自 tools.js buildTools 拆出；聚合注册见 tools.js）。
 */
import { Type } from 'typebox'
import { list, get, request, listReleases } from './k8s.js'
import {
  result,
  MAX_ITEMS,
  insertNs,
  cap,
  capList,
  slimItem,
  slimObject,
  helmValuesB64,
  helmActionStatus,
  helmTriggered,
  safe,
  pageParams,
  pageResult,
  decodeB64,
} from './tools-helpers.js'

/** @typedef {import('./tools-helpers.js').HelmRelease} HelmRelease */

/** @param {{ value: string }} clusterRef @returns {Record<string, any>} */
export function buildHelmTools(clusterRef) {
  const cluster = () => clusterRef.value
  return {
    helm_releases: {
      label: '查询 Helm 发布',
      description: '列出 Helm releases（最多 20 条）：名称、命名空间、状态、chart 版本。可选按命名空间 ns 过滤。',
      parameters: Type.Object({
        ns: Type.Optional(Type.String({ description: '命名空间，缺省为全部' })),
      }),
      /** @param {string} _toolCallId @param {{ ns?: string }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const { ns } = params
        const data = await safe(async () => {
          // 后端返回 { releases: [] } 信封（helm.ts 契约），不是裸数组——直接 .filter 会炸
          const { releases } = /** @type {{ releases: HelmRelease[] }} */ (
            await listReleases(
              cluster(),
              ns ? { namespace: ns, allNamespaces: false } : { allNamespaces: true },
              signal,
            )
          )
          const rows = (releases ?? [])
            .filter((r) => !ns || r.namespace === ns)
            .slice(0, MAX_ITEMS)
            .map((r) => ({
              name: r.name,
              namespace: r.namespace,
              status: r.info?.status ?? 'unknown',
              chart: r.chart?.metadata?.name,
              chartVersion: r.chart?.metadata?.version,
              appVersion: r.chart?.metadata?.appVersion ?? null,
              revision: r.version,
              lastDeployed: r.info?.last_deployed ?? null,
            }))
          return { total: rows.length, releases: rows }
        })
        return result(data)
      },
    },

    // ---------- 写 / 执行工具（全权限；dryRun 优先，无审批门） ----------

    k8s_get: {
      label: '泛型读取',
      description:
        '泛型 k8s 资源读取（CRD/专用工具覆盖不到的资源才用它；Pod/Deployment/事件/日志/Helm 发布请直接用 list_pods、list_deployments、list_events、pod_logs、helm_releases）。apiPath 形如 /api/v1/namespaces/default/configmaps 或 /apis/{group}/{version}/...；路径末尾已经是资源名（如 .../deployments/web）时直接 list 该路径即可拿到对象，不要再往 name 里重复一遍；name 给出时取单资源，否则 list（limit/continueToken 分页）。ns 在 apiPath 未含命名空间段时自动补全；过滤用 labelSelector/fieldSelector 参数，不要把 ?fieldSelector= 拼进 apiPath（labelSelector 只认 label，metadata.name 之类的字段要放 fieldSelector）。列表返回瘦身后的摘要（去掉 spec.template、uid、证书正文等大块），需要完整对象用 full=true；decodeSecret=true 且目标是 Secret 时返回解码后的明文值（谨慎：凭据会进入对话上下文）。',
      parameters: Type.Object({
        apiPath: Type.String({ description: '资源路径，如 /api/v1/configmaps 或 /apis/{group}/{version}/namespaces/{ns}/{plural}' }),
        name: Type.Optional(Type.String({ description: '资源名；给出则取单资源，否则 list' })),
        ns: Type.Optional(Type.String({ description: '命名空间；apiPath 未含 /namespaces/ 段时插入' })),
        labelSelector: Type.Optional(Type.String({ description: 'labelSelector（仅 list）' })),
        fieldSelector: Type.Optional(Type.String({ description: 'fieldSelector（仅 list）' })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: 'list 本页条数，缺省 20、上限 200' })),
        continueToken: Type.Optional(Type.String({ description: 'list 上一页返回的 continueToken（续拉下一页）' })),
        decodeSecret: Type.Optional(Type.Boolean({ description: 'true 且对象是 Secret：data 解码为 stringData 明文（非 Secret 忽略此参数）' })),
        full: Type.Optional(Type.Boolean({ description: 'true = 返回未瘦身的原始对象（默认列表返回摘要，省上下文）' })),
      }),
      /** @param {string} _toolCallId @param {{ apiPath: string; name?: string; ns?: string; labelSelector?: string; fieldSelector?: string; limit?: number; continueToken?: string; decodeSecret?: boolean; full?: boolean }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const { apiPath, name, ns, labelSelector, fieldSelector } = params
        const data = await safe(async () => {
          let path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
          if (ns && !path.includes('/namespaces/')) path = insertNs(path, ns)
          if (name) {
            const obj = await get(cluster(), `${path}/${encodeURIComponent(name)}`, signal)
            // decodeSecret 仅对 Secret 生效：opt-in 解码（凭据进上下文需模型/用户知情）
            const o = /** @type {{ kind?: string; data?: Record<string, string> }} */ (
              obj && typeof obj === 'object' ? /** @type {unknown} */ (obj) : {}
            )
            if (params.decodeSecret && o.kind === 'Secret' && o.data) {
              /** @type {Record<string, string>} */ const stringData = {}
              /** @type {string[]} */ const undecodable = []
              for (const [k, v] of Object.entries(o.data)) {
                const dec = typeof v === 'string' ? decodeB64(v) : null
                if (dec == null) {
                  undecodable.push(k)
                  stringData[k] = typeof v === 'string' ? v : String(v)
                } else stringData[k] = dec
              }
              const { data: _raw, ...rest } = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (obj))
              return {
                data: cap({ ...rest, stringData, ...(undecodable.length ? { _undecodable: undecodable } : {}) }),
                note: 'decodeSecret=true：stringData 为解码明文，凭据已进入上下文',
              }
            }
            return { data: cap(params.full ? obj : slimObject(obj)) }
          }
          /** @type {Record<string, string>} */
          const q = { ...pageParams(params) }
          if (labelSelector) q.labelSelector = labelSelector
          if (fieldSelector) q.fieldSelector = fieldSelector
          const res = await list(cluster(), path, q, signal)
          const page = pageResult(res)
          // apiPath 指到单个资源时，服务端返回的是对象而不是 List：
          // 老实现按 list 解 items 得到空数组，模型据此判断「资源不存在」而绕路
          // （实测 4 个场景各浪费 1-3 次调用）→ 这里回退成单对象读取。
          if (page.returned === 0 && !Array.isArray(/** @type {{ items?: unknown[] }} */ (res).items)) {
            const single = /** @type {Record<string, unknown> | null} */ (
              res && typeof res === 'object' && typeof (/** @type {{ kind?: unknown }} */ (res).kind) === 'string' ? res : null
            )
            if (single) return { kind: single.kind, data: cap(params.full ? single : slimObject(single)) }
          }
          if (params.full) return { returned: page.returned, truncated: page.truncated, continueToken: page.continueToken, items: cap(page.items) }
          const slim = capList(page.items.map(slimItem))
          return {
            returned: page.returned,
            truncated: page.truncated,
            continueToken: page.continueToken,
            slimmed: true,
            items: slim.items,
            ...(slim.note ? { note: slim.note } : {}),
          }
        })
        return result(data)
      },
    },

    k8s_request: {
      label: '泛型请求',
      description:
        '任意 k8s API 调用（兜底通道：CRD/自定义资源、子资源、没有专用工具的 API）。有专用工具时别用它：删资源用 delete_resource（不要用 k8s_request DELETE），改字段/镜像/标签用 patch_resource（不要用 k8s_request PATCH），整份 YAML 用 apply_yaml，扩缩容用 scale，发布动作用 rollout，读 Pod/Deployment/事件用 list_pods/list_deployments/list_events——实测这些泛型调用既多花上下文（一次 GET 集群 Deployment 列表 39KB）又容易漏掉专用工具的现值校验。写操作直接生效，破坏性的先 dryRun=true 预览。body 为请求体（JSON 对象或字符串）；contentType 默认 application/json，server-side apply 用 application/apply-patch+yaml、strategic merge 用 application/strategic-merge-patch+json。GET 成功时 body 已瘦身（去掉 spec.template、uid、镜像清单等大块，full=true 取原样）；非 2xx 时 body 为 k8s Status（含 message/reason），保持原样。',
      parameters: Type.Object({
        method: Type.Union([
          Type.Literal('GET'),
          Type.Literal('POST'),
          Type.Literal('PATCH'),
          Type.Literal('PUT'),
          Type.Literal('DELETE'),
        ]),
        apiPath: Type.String({ description: '资源路径，如 /api/v1/namespaces/default/configmaps/x 或 /apis/...' }),
        body: Type.Optional(Type.Union([Type.Object({}), Type.String()], { description: '请求体（写方法）' })),
        dryRun: Type.Optional(Type.Boolean({ description: 'true = 追加 dryRun=All（预览，不生效）' })),
        contentType: Type.Optional(Type.String({ description: 'Content-Type，默认 application/json' })),
        full: Type.Optional(Type.Boolean({ description: 'true = GET 返回未瘦身的原始响应（默认成功响应返回摘要）' })),
      }),
      /** @param {string} _toolCallId @param {{ method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; apiPath: string; body?: unknown; dryRun?: boolean; contentType?: string; full?: boolean }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const { method, apiPath, body, dryRun, contentType } = params
        const data = await safe(async () => {
          /** @type {Record<string, string>} */
          const q = {}
          if (dryRun) q.dryRun = 'All'
          const { status, body: respBody } = await request(cluster(), method, apiPath, { body, contentType, params: q, signal })
          // 只给成功响应瘦身；错误 Status 的 message/reason 必须原样给模型转述
          if (method !== 'GET' || status >= 300 || params.full) return { method, status, dryRun: dryRun ?? false, body: cap(respBody) }
          const rec = /** @type {Record<string, unknown> | null} */ (
            respBody && typeof respBody === 'object' && !Array.isArray(respBody) ? respBody : null
          )
          const items = Array.isArray(rec?.items) ? /** @type {unknown[]} */ (rec.items) : undefined
          if (items) {
            const slim = capList(items.map(slimItem))
            return {
              method,
              status,
              dryRun: dryRun ?? false,
              slimmed: true,
              returned: items.length,
              items: slim.items,
              ...(slim.note ? { note: slim.note } : {}),
            }
          }
          return { method, status, dryRun: dryRun ?? false, body: cap(rec ? slimObject(rec) : respBody) }
        })
        return result(data)
      },
    },

    helm_install: {
      label: '安装 Helm',
      description:
        '安装 Helm release（写操作，直接生效）。chart 为仓库坐标（bitnami/redis）或 chart URL；ns 缺省 default（命名空间必须已存在，本工具不会创建）；values 为对象（后端要求 base64(YAML)，工具内部转换）；version 缺省=最新。后端异步执行，本工具已轮询 /helm/action/status 直到出终态并在 actionStatus 给出 status/message——actionStatus.status=failed 时直接把 message 转述给用户（实测常见值：repo X not found＝该仓库未在本集群 helm repo add 过，此时换 chart 来源或让用户提供已配置仓库，不要反复重装、也不用去翻 helm secret/ConfigMap，release 存在与否查 helm_releases 一次即可）。后端不支持 helm --dry-run：装新 release 前先向用户确认 chart/version。',
      parameters: Type.Object({
        name: Type.String({ description: 'release 名' }),
        chart: Type.String({ description: 'repo/chart（如 bitnami/redis）或 chart URL' }),
        ns: Type.Optional(Type.String({ description: '命名空间，缺省 default' })),
        values: Type.Optional(Type.Object({}, { description: 'values 对象' })),
        version: Type.Optional(Type.String({ description: 'chart 版本（semver 约束），缺省最新' })),
      }),
      /** @param {string} _toolCallId @param {{ name: string; chart: string; ns?: string; values?: Record<string, unknown>; version?: string }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const data = await safe(async () => {
          const ns = params.ns ?? 'default'
          const { status, body } = await request(cluster(), 'POST', '/helm/release/install', {
            body: {
              name: params.name,
              namespace: ns,
              description: 'installed by ai-assistant',
              values: helmValuesB64(params.values),
              chart: params.chart,
              version: params.version || '*',
            },
            signal,
          })
          helmTriggered(status, body)
          const actionStatus = await helmActionStatus(cluster(), params.name, 'install', signal)
          return { name: params.name, namespace: ns, chart: params.chart, version: params.version || 'latest', triggered: true, actionStatus }
        })
        return result(data)
      },
    },

    helm_upgrade: {
      label: '升级 Helm',
      description:
        '升级 Helm release（写操作，直接生效）。chart/version 缺省时复用该 release 现有 chart 坐标（后端按 semver 约束校验）；values 缺省=沿用该 release 现有用户 values（helm 语义：新 values 为空时自动复用旧 Config），给出则整体替换用户 values——只想改一两个 key 也要把完整 values 传进来，并在回复里说明会覆盖其余自定义值。后端不支持 --dry-run / --reset-values。异步执行：本工具已轮询到终态，actionStatus.status=failed 时直接转述 actionStatus.message（release 不存在＝之前的安装没落地，别再重试），不要靠反复查 helm_releases 判断结果。',
      parameters: Type.Object({
        name: Type.String(),
        ns: Type.String(),
        chart: Type.Optional(Type.String({ description: '缺省=复用现有 release 的 chart' })),
        version: Type.Optional(Type.String({ description: '缺省=现有 chart 版本约束 *' })),
        values: Type.Optional(Type.Object({}, { description: 'values 对象；缺省=沿用现有' })),
      }),
      /** @param {string} _toolCallId @param {{ name: string; ns: string; chart?: string; version?: string; values?: Record<string, unknown> }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const data = await safe(async () => {
          let chart = params.chart
          let version = params.version
          if (!chart || !version) {
            // 后端要求 chart/version 非空：取现有 release 的 chart 坐标补齐
            const { status, body } = await request(
              cluster(),
              'GET',
              '/helm/releases',
              { params: { name: params.name, namespace: params.ns }, signal },
            )
            if (status >= 300) throw new Error(`release ${params.name} 不存在（HTTP ${status}）`)
            const r = /** @type {{ chart?: { metadata?: { name?: string; version?: string } } }} */ (body)
            chart = chart ?? r.chart?.metadata?.name
            version = version ?? r.chart?.metadata?.version ?? '*'
            if (!chart) throw new Error('无法确定 release 的 chart（release 缺少 chart metadata）')
          }
          const { status, body } = await request(cluster(), 'PUT', '/helm/releases/upgrade', {
            body: {
              name: params.name,
              namespace: params.ns,
              description: 'upgraded by ai-assistant',
              values: helmValuesB64(params.values),
              chart,
              version,
            },
            signal,
          })
          helmTriggered(status, body)
          const actionStatus = await helmActionStatus(cluster(), params.name, 'upgrade', signal)
          return { name: params.name, namespace: params.ns, chart, version, triggered: true, actionStatus }
        })
        return result(data)
      },
    },

    helm_uninstall: {
      label: '卸载 Helm',
      description:
        '卸载 Helm release（写操作，直接生效！会删除该 release 创建的资源；异步执行，触发后查一次状态）。后端不支持 --dry-run：执行前请先向用户确认。',
      parameters: Type.Object({
        name: Type.String(),
        ns: Type.String(),
      }),
      /** @param {string} _toolCallId @param {{ name: string; ns: string }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const data = await safe(async () => {
          const { status, body } = await request(cluster(), 'DELETE', '/helm/releases/uninstall', {
            params: { name: params.name, namespace: params.ns },
            signal,
          })
          helmTriggered(status, body)
          const actionStatus = await helmActionStatus(cluster(), params.name, 'uninstall', signal)
          return { name: params.name, namespace: params.ns, triggered: true, actionStatus }
        })
        return result(data)
      },
    },

    helm_rollback: {
      label: '回滚 Helm',
      description:
        '回滚 Helm release 到指定修订（写操作，直接生效；异步执行，触发后查一次状态）。可用 k8s_get / helm_releases 或 GET /release/history（k8s_request）先查修订列表。',
      parameters: Type.Object({
        name: Type.String(),
        ns: Type.String(),
        toRevision: Type.Number({ description: '目标修订号（1 起，来自 release history）' }),
      }),
      /** @param {string} _toolCallId @param {{ name: string; ns: string; toRevision: number }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const data = await safe(async () => {
          const { status, body } = await request(cluster(), 'PUT', '/helm/releases/rollback', {
            body: { name: params.name, namespace: params.ns, revision: params.toRevision },
            signal,
          })
          helmTriggered(status, body)
          const actionStatus = await helmActionStatus(cluster(), params.name, 'rollback', signal)
          return { name: params.name, namespace: params.ns, toRevision: params.toRevision, triggered: true, actionStatus }
        })
        return result(data)
      },
    },

  }
}
