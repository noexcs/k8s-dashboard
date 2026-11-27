// @ts-check
/**
 * tools 域：list_deployments / apply_yaml / delete_resource / scale / rollout / patch_resource（自 tools.js buildTools 拆出；聚合注册见 tools.js）。
 */
import { Type } from 'typebox'
import { parse as yamlParse } from 'yaml'
import { list, get, request } from './k8s.js'
import { listControllerRevisions, cleanCrTemplate, currentCrRevision } from './workloads.js'
import { result, MAX_ITEMS, resolveResource, resourcePath, revisionOf, rollbackTemplate, templateImages, matchLabelsToSelector, listOwnedReplicaSets, cap, splitYamlDocs, safe, pageParams, pageResult } from './tools-helpers.js'

/** @typedef {import('./tools-helpers.js').Pod} Pod */
/** @typedef {import('./tools-helpers.js').Node} Node */
/** @typedef {import('./tools-helpers.js').Deployment} Deployment */
/** @typedef {import('./tools-helpers.js').ReplicaSet} ReplicaSet */
/** @typedef {import('./tools-helpers.js').WorkloadStatus} WorkloadStatus */
/** @typedef {import('./workloads.js').ControllerRevision} ControllerRevision */
/** @typedef {import('./tools-helpers.js').YamlDoc} YamlDoc */

/** @param {{ value: string }} clusterRef @returns {Record<string, any>} */
export function buildDeployTools(clusterRef) {
  const cluster = () => clusterRef.value
  return {
    list_deployments: {
      label: '查询 Deployment',
      description:
        '列出 Deployments 及其就绪度。可选按命名空间 ns 过滤。分页：limit 缺省 20、上限 200；truncated=true 时带 continueToken 续拉下一页。',
      parameters: Type.Object({
        ns: Type.Optional(Type.String({ description: '命名空间，缺省为全部' })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: '本页条数，缺省 20、上限 200' })),
        continueToken: Type.Optional(Type.String({ description: '上一页返回的 continueToken（续拉下一页）' })),
      }),
      /** @param {string} _toolCallId @param {{ ns?: string; limit?: number; continueToken?: string }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const { ns } = params
        const data = await safe(async () => {
          const res = /** @type {{ items: Deployment[] }} */ (
            await list(
              cluster(),
              ns ? `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments` : '/apis/apps/v1/deployments',
              pageParams(params),
              signal,
            )
          )
          const page = pageResult(res)
          return {
            returned: page.returned,
            truncated: page.truncated,
            continueToken: page.continueToken,
            deployments: page.items.map((d) => ({
              name: d.metadata.name,
              namespace: d.metadata?.namespace,
              ready: d.status?.readyReplicas ?? 0,
              desired: d.spec?.replicas ?? 0,
              available: d.status?.availableReplicas ?? 0,
            })),
          }
        })
        return result(data)
      },
    },

    apply_yaml: {
      label: '应用 YAML',
      description:
        'server-side apply 一份或多份完整 YAML 文档（--- 分隔）：新建资源，或用户直接给了整份 YAML 让你下发时用。只改现有资源的少量字段（镜像/env/副本/标签）优先 patch_resource——apply 是整份文档的字段级合并，只写一小段容易把数组字段（容器/volume/env）整体替换掉。每文档需 apiVersion/kind/metadata.name；namespace 缺省 default；cluster-scoped 资源（ClusterRole/CR 等）经 discovery 自动识别。破坏性变更（删字段/改关键配置）建议先 dryRun=true 预览。逐文档返回 {name, namespace, status, ...}。想看变更影响先用 diff_yaml。',
      parameters: Type.Object({
        yaml: Type.String({ description: 'YAML 内容（多文档用 --- 分隔）' }),
        dryRun: Type.Optional(Type.Boolean({ description: 'true = dryRun=All 预览，不生效' })),
        fieldManager: Type.Optional(Type.String({ description: 'apply 字段管理器名，缺省 ai-assistant' })),
      }),
      /** @param {string} _toolCallId @param {{ yaml: string; dryRun?: boolean; fieldManager?: string }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const fieldManager = params.fieldManager ?? 'ai-assistant'
        const data = await safe(async () => {
          const docs = splitYamlDocs(params.yaml)
          if (docs.length === 0) throw new Error('yaml 中没有有效文档')
          /** @type {Array<Record<string, unknown>>} */
          const results = []
          for (const doc of docs) {
            try {
              const obj = /** @type {YamlDoc | null} */ (yamlParse(doc))
              if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('文档不是有效的对象')
              const { apiVersion, kind, metadata } = obj
              if (!apiVersion || !kind || !metadata?.name) throw new Error('文档缺少 apiVersion/kind/metadata.name')
              const { plural, namespaced } = await resolveResource(cluster(), apiVersion, kind, signal)
              const ns = namespaced ? metadata.namespace ?? 'default' : null
              const path = resourcePath(apiVersion, plural, ns, metadata.name)
              /** @type {Record<string, string>} */
              const q = { fieldManager, force: 'true' }
              if (params.dryRun) q.dryRun = 'All'
              const { status, body } = await request(cluster(), 'PATCH', path, {
                body: doc,
                contentType: 'application/apply-patch+yaml',
                params: q,
                signal,
              })
              const b = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {}
              results.push(
                status < 300
                  ? {
                      kind,
                      name: metadata.name,
                      namespace: ns,
                      dryRun: params.dryRun ?? false,
                      status,
                      generation:
                        b.metadata && typeof b.metadata === 'object'
                          ? /** @type {{ generation?: number }} */ (b.metadata).generation ?? null
                          : null,
                    }
                  : {
                      kind,
                      name: metadata.name,
                      namespace: ns,
                      dryRun: params.dryRun ?? false,
                      status,
                      message: typeof b.message === 'string' ? b.message : undefined,
                      reason: typeof b.reason === 'string' ? b.reason : undefined,
                    },
              )
            } catch (e) {
              results.push({ error: e instanceof Error ? e.message : String(e) })
            }
          }
          return { results }
        })
        return result(data)
      },
    },

    delete_resource: {
      label: '删除资源',
      description:
        '删除 k8s 资源（写操作，直接生效！）——删资源一律用本工具，不要用 k8s_request DELETE。name 或 labelSelector 二选一：labelSelector 为批量删除（≤20 个，超出部分进 skipped）；ns 缺省 default（cluster-scoped 资源如 Node/Namespace 不填），labelSelector 且 ns 缺省时跨全部命名空间删除。删之前先读一次现值（list_*/k8s_get）确认 kind、ns 与名字，并在回复里说明将删掉什么、影响多大；批量或拿不准的范围先 dryRun=true 预览（dryRun 也走批准门）。返回 {deleted, skipped}，skipped 里带失败原因。',
      parameters: Type.Object({
        apiVersion: Type.String({ description: '如 v1 / apps/v1 / {crd group}/{version}' }),
        kind: Type.String({ description: '如 ConfigMap / Deployment' }),
        ns: Type.Optional(Type.String({ description: '命名空间，缺省 default（仅 namespaced 资源）' })),
        name: Type.Optional(Type.String({ description: '资源名（与 labelSelector 二选一）' })),
        labelSelector: Type.Optional(Type.String({ description: '按 label 批量删除（≤20，与 name 二选一）' })),
        dryRun: Type.Optional(Type.Boolean({ description: 'true = dryRun=All 预览，不生效' })),
        gracePeriodSeconds: Type.Optional(Type.Number({ description: '宽限期（秒）；缺省由 API 决定' })),
      }),
      /** @param {string} _toolCallId @param {{ apiVersion: string; kind: string; ns?: string; name?: string; labelSelector?: string; dryRun?: boolean; gracePeriodSeconds?: number }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const data = await safe(async () => {
          if (!params.name && !params.labelSelector) throw new Error('需要 name 或 labelSelector（二选一）')
          const { plural, namespaced } = await resolveResource(cluster(), params.apiVersion, params.kind, signal)
          /** @type {Record<string, string>} */
          const q = {}
          if (params.dryRun) q.dryRun = 'All'
          if (params.gracePeriodSeconds != null) q.gracePeriodSeconds = String(params.gracePeriodSeconds)
          /** @type {Array<{ ns: string | null; name: string }>} */
          const targets = []
          /** @type {Array<{ kind: string; name: string; namespace: string | null }>} */
          const skipped = []
          if (params.name) {
            if (namespaced && !params.ns) throw new Error('namespaced 资源删除需要 ns')
            targets.push({ ns: namespaced ? (params.ns ?? null) : null, name: params.name })
          } else {
            const listPath = resourcePath(params.apiVersion, plural, namespaced ? (params.ns ?? null) : null)
            const res = await list(cluster(), listPath, { labelSelector: params.labelSelector ?? '' }, signal)
            const items = /** @type {Array<{ metadata: { name: string; namespace?: string } }>} */ (res.items ?? [])
            for (const it of items) {
              if (targets.length < MAX_ITEMS) targets.push({ ns: it.metadata.namespace ?? null, name: it.metadata.name })
              else skipped.push({ kind: params.kind, name: it.metadata.name, namespace: it.metadata.namespace ?? null })
            }
            if (targets.length === 0) return { dryRun: params.dryRun ?? false, deleted: [], skipped, note: 'labelSelector 没有匹配到资源' }
          }
          /** @type {Array<{ kind: string; name: string; namespace: string | null }>} */
          const deleted = []
          for (const t of targets) {
            const path = resourcePath(params.apiVersion, plural, t.ns, t.name)
            const { status, body } = await request(cluster(), 'DELETE', path, { params: q, signal })
            if (status < 300) deleted.push({ kind: params.kind, name: t.name, namespace: t.ns })
            else {
              const b = body && typeof body === 'object' ? /** @type {{ message?: string }} */ (body) : {}
              skipped.push({ kind: params.kind, name: t.name, namespace: t.ns, ...(typeof b.message === 'string' ? { message: b.message } : {}) })
            }
          }
          return { dryRun: params.dryRun ?? false, deleted, skipped }
        })
        return result(data)
      },
    },

    scale: {
      label: '扩缩容',
      description:
        '调整 Deployment/StatefulSet 副本数（PATCH scale 子资源，写操作直接生效）——改副本数只用它，不要 patch spec.replicas 也不要 k8s_request。replicas=0 即缩零（会停服，谨慎）。工具内部已读改前副本数并返回 before/after，无需先自查现值；dryRun=true 可预览。想确认扩缩是否收敛，随后用 rollout status 看一次即可。',
      parameters: Type.Object({
        ns: Type.String(),
        name: Type.String(),
        replicas: Type.Number({ minimum: 0, description: '目标副本数（0=缩零）' }),
        kind: Type.Optional(
          Type.Union([Type.Literal('Deployment'), Type.Literal('StatefulSet')], { description: '缺省 Deployment' }),
        ),
        dryRun: Type.Optional(Type.Boolean({ description: 'true = dryRun=All 预览' })),
      }),
      /** @param {string} _toolCallId @param {{ ns: string; name: string; replicas: number; kind?: 'Deployment' | 'StatefulSet'; dryRun?: boolean }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const kind = params.kind ?? 'Deployment'
        const plural = kind === 'StatefulSet' ? 'statefulsets' : 'deployments'
        const base = `/apis/apps/v1/namespaces/${encodeURIComponent(params.ns)}/${plural}/${encodeURIComponent(params.name)}`
        const data = await safe(async () => {
          // HPA 托管防护（与行内弹层同口径）：replicas 会被 reconcile 按 min/max 抹掉，直写=假成功
          if (!params.dryRun) {
            const hpaPath = (/** @type {string} */ v) => `/apis/autoscaling/${v}/namespaces/${encodeURIComponent(params.ns)}/horizontalpodautoscalers`
            let r = await request(cluster(), 'GET', hpaPath('v2'), { signal })
            if (r.status === 404) r = await request(cluster(), 'GET', hpaPath('v1'), { signal })
            if (r.status >= 300) {
              // 「读不到≠没有」：探测失败就放行写入可能正好抹掉用户的 HPA 决策(fail-open 事故)
              return {
                name: params.name,
                namespace: params.ns,
                skipped: true,
                guidance: `无法确认该负载是否由 HPA 托管(HPA 列表读取失败 HTTP ${r.status})。请先用 k8s_request 读 autoscaling 列表确认;确认无 HPA 后可重试 scale。`,
              }
            }
            /** @type {any[]} */
            const hItems = r.body?.items ?? []
            const owner = hItems.find((h) => h.spec?.scaleTargetRef?.name === params.name && h.spec?.scaleTargetRef?.kind === kind)
            if (owner) {
              return {
                name: params.name,
                namespace: params.ns,
                skipped: true,
                hpa: `${owner.metadata?.namespace}/${owner.metadata?.name}`,
                min: owner.spec?.minReplicas ?? null,
                max: owner.spec?.maxReplicas ?? null,
                guidance: `该负载由 HPA「${owner.metadata?.name}」托管(${owner.spec?.minReplicas ?? '?'}–${owner.spec?.maxReplicas ?? '?'}),直接改 replicas 会被控制器按区间抹掉(假成功)。要改变容量请调整该 HPA 的 min/max/edit HPA 资源(走审批门),或先解除托管。`,
              }
            }
          }
          const beforeObj = /** @type {{ spec?: { replicas?: number } }} */ (await get(cluster(), base, signal))
          const { status, body } = await request(cluster(), 'PATCH', `${base}/scale`, {
            body: { spec: { replicas: params.replicas } },
            // k8s scale 子资源 PATCH 只认 merge 系 Content-Type：application/json 会被 415 拒绝
            contentType: 'application/strategic-merge-patch+json',
            params: params.dryRun ? { dryRun: 'All' } : {},
            signal,
          })
          if (status >= 300) {
            const b = body && typeof body === 'object' ? /** @type {{ message?: string }} */ (body) : {}
            throw new Error(typeof b.message === 'string' ? b.message : `scale 失败（HTTP ${status}）`)
          }
          const scale = body && typeof body === 'object' ? /** @type {{ spec?: { replicas?: number } }} */ (body) : {}
          return {
            name: params.name,
            namespace: params.ns,
            kind,
            before: beforeObj.spec?.replicas ?? null,
            after: scale.spec?.replicas ?? null,
            dryRun: params.dryRun ?? false,
          }
        })
        return result(data)
      },
    },

    wait_rollout: {
      label: '等发布收敛',
      description:
        '轮询等待 Deployment/StatefulSet/DaemonSet 收敛(observedGeneration 追平且新版本 ready),只读无需审批。专用于 scale / rollout undo / restart 等写操作后的「改后验证」闭环:一次调用等到结果,不要自己连查 rollout status。默认 120 秒、上限 600 秒;滚动本来就要分钟级,超时未收敛(converged=false)不等于失败——stuck 非空才是卡住(附原因),为空则仍在进行,可再等一次或继续观察。',
      parameters: Type.Object({
        ns: Type.String(),
        name: Type.String(),
        kind: Type.Optional(
          Type.Union([Type.Literal('Deployment'), Type.Literal('StatefulSet'), Type.Literal('DaemonSet')], {
            description: '缺省 Deployment',
          }),
        ),
        timeoutSec: Type.Optional(Type.Number({ description: '等待上限秒数,默认 120,上限 600' })),
      }),
      /** @param {string} _toolCallId @param {{ ns: string; name: string; kind?: 'Deployment' | 'StatefulSet' | 'DaemonSet'; timeoutSec?: number }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const kind = params.kind ?? 'Deployment'
        const plural = kind === 'StatefulSet' ? 'statefulsets' : kind === 'DaemonSet' ? 'daemonsets' : 'deployments'
        const path = `/apis/apps/v1/namespaces/${encodeURIComponent(params.ns)}/${plural}/${encodeURIComponent(params.name)}`
        const cap = Math.min(Math.max(params.timeoutSec ?? 120, 10), 600)
        const started = Date.now()
                /** 快照即判定:同一响应里判收敛(此前每 tick 双 GET,快照与判定来自两个响应) */
        const converged = (/** @type {any} */ o) => {
          const lag = (o.status?.observedGeneration ?? 0) < (o.metadata?.generation ?? 0)
          if (lag) return false
          if (kind === 'DaemonSet') {
            const d = o.status?.desiredNumberScheduled ?? 0
            return (o.status?.updatedNumberScheduled ?? 0) >= d && (o.status?.numberReady ?? 0) >= d
          }
          const want = o.spec?.replicas ?? 0
          return (o.status?.updatedReplicas ?? 0) >= want && (o.status?.readyReplicas ?? 0) >= want
        }
        const data = await safe(async () => {
          let last = null
          let ticks = 0
          for (;;) {
            if (signal?.aborted) throw new Error('aborted')
            const o = /** @type {any} */ (await get(cluster(), path, signal))
            const ready = kind === 'DaemonSet' ? o.status?.numberReady : o.status?.readyReplicas
            const updated = kind === 'DaemonSet' ? o.status?.updatedNumberScheduled : o.status?.updatedReplicas
            const desired = kind === 'DaemonSet' ? o.status?.desiredNumberScheduled : o.spec?.replicas
            const stuck = (o.status?.conditions ?? [])
              .filter((/** @type {any} */ c) => c.type === 'Progressing' || c.type === 'FailedCreate')
              .filter((/** @type {any} */ c) => c.status !== 'True')
              .map((/** @type {any} */ c) => `${c.type}: ${c.reason || c.message || '非 True'}`)
            last = {
              name: params.name,
              namespace: params.ns,
              kind,
              desired: desired ?? null,
              ready: ready ?? null,
              updated: updated ?? null,
              stuck: stuck.length ? stuck : null,
            }
            if (converged(o)) return { ...last, converged: true, waitedSec: Math.round((Date.now() - started) / 1000) }
            if (Date.now() - started > cap * 1000)
              return {
                ...last,
                converged: false,
                waitedSec: cap,
                hint: stuck.length
                  ? '已卡住:按 cause 修复或用 rollout undo 回滚(走审批),继续等待无意义'
                  : '仍在滚动:可再等一次或告知用户继续观察,勿重复空转',
              }
            // 前 10 拍 3s 快采样,之后 8s 退避:600s 上限下对 apiserver 约 70 次而非 200 次
            ticks++
            await new Promise((res) => setTimeout(res, ticks < 10 ? 3000 : 8000))
          }
        })
        return result(data)
      },
    },

    rollout: {
      label: '发布管理',
      description:
        'Deployment/StatefulSet/DaemonSet 发布（rollout）动作本身：status/restart/history/undo/pause/resume 六种。改 spec 内容（换镜像、改 env、调资源）不属于 rollout，用 patch_resource；改副本数用 scale。status = 发布状态即时快照（副本数 + conditions，Progressing=False 表示卡住；滚动要时间收敛，同一参数马上再查一次只会拿到同样的数据，别连着查）；restart = 滚动重启（strategic merge patch 模板注解 kubectl.kubernetes.io/restartedAt 为当前时间，触发全量滚动更新，写操作直接生效，可 dryRun 预览）；pause/resume = 暂停/恢复 Deployment 滚动更新（spec.paused，仅 Deployment，写操作可 dryRun；暂停期间新的 spec 变更不会下发）；history = 修订历史（≤10 条：revision/副本数/镜像，并直接给出 currentRevision 与可回滚的 previousRevision；Deployment 走 ReplicaSet，StatefulSet/DaemonSet 走 ControllerRevision）；undo = 回滚到旧修订（写操作直接生效）。undo 语义对齐 kubectl rollout undo：revision 缺省回到次新修订，给了 revision 就回到那一版（对齐 --to-revision）；Deployment 实现是把目标 ReplicaSet 的 Pod 模板**整份替换**回 spec.template 并删除 revision 注解让 controller 重新 +1，SS/DS 同样整份替换目标 ControllerRevision 的模板（SS 的 volumeClaimTemplates 不受影响）。不可逆点：回滚会产生一个 revision 号更大的新修订（历史不被删除，但旧修订的 ReplicaSet/ControllerRevision 可能被 revisionHistoryLimit 清理掉，届时无法再回同一版）；整份替换意味着目标修订之后新增的容器/卷/env 会被删除——与 kubectl rollout undo 同语义，回滚前先 history/dryRun 确认目标版本内容。undo 前用 history 看一次（目标版直接取 previousRevision，别自己按号猜），破坏性变更前先 dryRun=true 预览。',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('status'),
          Type.Literal('restart'),
          Type.Literal('history'),
          Type.Literal('undo'),
          Type.Literal('pause'),
          Type.Literal('resume'),
        ]),
        ns: Type.String(),
        name: Type.String(),
        kind: Type.Optional(
          Type.Union([Type.Literal('Deployment'), Type.Literal('StatefulSet'), Type.Literal('DaemonSet')], {
            description: '缺省 Deployment；history/undo 三种都支持，pause/resume 仅 Deployment',
          }),
        ),
        revision: Type.Optional(
          Type.Number({ description: '仅 undo 有效：目标修订号（kubectl --to-revision）；缺省为次新修订' }),
        ),
        dryRun: Type.Optional(Type.Boolean({ description: '仅 restart/undo/pause/resume 有效：dryRun=All 预览' })),
      }),
      /** @param {string} _toolCallId @param {{ action: 'status' | 'restart' | 'history' | 'undo' | 'pause' | 'resume'; ns: string; name: string; kind?: 'Deployment' | 'StatefulSet' | 'DaemonSet'; revision?: number; dryRun?: boolean }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const kind = params.kind ?? 'Deployment'
        const plural = kind === 'StatefulSet' ? 'statefulsets' : kind === 'DaemonSet' ? 'daemonsets' : 'deployments'
        const base = `/apis/apps/v1/namespaces/${encodeURIComponent(params.ns)}/${plural}/${encodeURIComponent(params.name)}`
        const data = await safe(async () => {
          if (params.action === 'status') {
            const d = /** @type {WorkloadStatus & { status?: { desiredNumberScheduled?: number; numberReady?: number } }} */ (
              await get(cluster(), base, signal)
            )
            return {
              name: params.name,
              namespace: params.ns,
              kind,
              // DS 无 spec.replicas/status.readyReplicas：用 desiredNumberScheduled/numberReady 同口径
              replicas: d.spec?.replicas ?? d.status?.desiredNumberScheduled ?? null,
              ready: d.status?.readyReplicas ?? d.status?.numberReady ?? 0,
              updated: d.status?.updatedReplicas ?? 0,
              available: d.status?.availableReplicas ?? 0,
              observedGeneration: d.status?.observedGeneration ?? null,
              conditions: (d.status?.conditions ?? []).map((c) => ({
                type: c.type,
                status: c.status,
                reason: c.reason ?? null,
                message: c.message?.slice(0, 200) ?? null,
              })),
            }
          }
          if (params.action === 'restart') {
            const restartedAt = new Date().toISOString()
            const { status, body } = await request(cluster(), 'PATCH', base, {
              body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': restartedAt } } } } },
              contentType: 'application/strategic-merge-patch+json',
              params: params.dryRun ? { dryRun: 'All' } : {},
              signal,
            })
            if (status >= 300) {
              const b = body && typeof body === 'object' ? /** @type {{ message?: string }} */ (body) : {}
              throw new Error(typeof b.message === 'string' ? b.message : `restart 失败（HTTP ${status}）`)
            }
            return {
              name: params.name,
              namespace: params.ns,
              restartedAt,
              dryRun: params.dryRun ?? false,
              note: params.dryRun ? '仅预览，未生效' : '已触发滚动重启',
            }
          }
          // pause/resume：Deployment 独有（SS/DS 无 spec.paused 语义）
          if (params.action === 'pause' || params.action === 'resume') {
            if (kind !== 'Deployment') throw new Error('pause/resume 仅支持 Deployment（StatefulSet/DaemonSet 无 spec.paused）')
            const paused = params.action === 'pause'
            const { status, body } = await request(cluster(), 'PATCH', base, {
              body: { spec: { paused } },
              contentType: 'application/strategic-merge-patch+json',
              params: params.dryRun ? { dryRun: 'All' } : {},
              signal,
            })
            if (status >= 300) {
              const b = body && typeof body === 'object' ? /** @type {{ message?: string }} */ (body) : {}
              throw new Error(typeof b.message === 'string' ? b.message : `${params.action} 失败（HTTP ${status}）`)
            }
            const spec = body && typeof body === 'object' ? /** @type {{ spec?: { paused?: boolean } }} */ (body).spec : undefined
            return {
              name: params.name,
              namespace: params.ns,
              kind,
              action: params.action,
              paused: spec?.paused ?? paused,
              dryRun: params.dryRun ?? false,
              note: params.dryRun
                ? '仅预览，未生效'
                : paused
                  ? '已暂停滚动更新：此后 spec 变更不会下发 Pod，恢复用 resume'
                  : '已恢复滚动更新',
            }
          }
          // undo：对齐 kubectl rollout undo deployment/x [--to-revision=N]
          if (params.action === 'undo') {
            if (kind !== 'Deployment') {
              // SS/DS：修订在 ControllerRevision（data.spec.template 是当版模板快照），
              // CR 名的 hash 后缀不可依赖，按 revision 字段排序/选择（workloads.js）
              const wl = /** @type {{ status?: { currentRevision?: string } }} */ (await get(cluster(), base, signal))
              const revs = await listControllerRevisions(cluster(), params.ns, kind, params.name, undefined, signal)
              const currentRev = currentCrRevision(wl, revs)
              const revisions = revs.map((r) => ({ revision: r.revision, name: r.name }))
              /** @type {(typeof revs)[number] | undefined} */
              let crTarget
              if (params.revision == null) {
                // 缺省＝严格低于当前的最大修订（kubectl「上一版」），避免把更新的修订当回滚目标
                const older = revs.filter((r) => r.revision < currentRev || currentRev === 0)
                crTarget = older[older.length - 1]
              } else {
                crTarget = revs.find((r) => r.revision === params.revision)
              }
              if (!crTarget) {
                return {
                  error:
                    params.revision == null
                      ? 'no older revision found'
                      : `no ControllerRevision found for revision ${params.revision}`,
                  currentRevision: currentRev,
                  revisions,
                }
              }
              // 整份替换 PUT（与 UI 历史 tab/kubectl 同语义）：strategic-merge 写回旧模板
              // 不会删 revision N 之后新增的容器/卷（merge-key 列表「未提及≠删除」），
              // 「回滚」实为旧新嵌合体而账面宣称按旧版下发——功能实测19 实测坐实。
              // GET 现对象→只换 spec.template→带 rv PUT，volumeClaimTemplates 等原样保留
              const curObj = /** @type {Record<string, unknown>} */ (await get(cluster(), base, signal))
              const { status: _st, ...restTop } = curObj
              const curMeta = /** @type {Record<string, unknown>} */ ({ ...(curObj.metadata ?? {}) })
              delete curMeta.managedFields
              const { status, body } = await request(cluster(), 'PUT', base, {
                body: {
                  ...restTop,
                  metadata: curMeta,
                  spec: {
                    ...(/** @type {Record<string, unknown>} */ (curObj.spec ?? {})),
                    template: cleanCrTemplate(crTarget.template),
                  },
                },
                params: params.dryRun ? { dryRun: 'All' } : {},
                signal,
              })
              if (status >= 300) {
                const b = body && typeof body === 'object' ? /** @type {{ message?: string }} */ (body) : {}
                throw new Error(typeof b.message === 'string' ? b.message : `undo 失败（HTTP ${status}）`)
              }
              return {
                name: params.name,
                namespace: params.ns,
                kind,
                fromRevision: currentRev,
                toRevision: crTarget.revision,
                targetControllerRevision: crTarget.name,
                patched: params.dryRun ? undefined : true,
                dryRun: params.dryRun ?? false,
                templateImages: crTarget.images,
                note: params.dryRun
                  ? '仅预览，未生效'
                  : `已按 revision ${crTarget.revision} 的模板下发；controller 会按新模板滚动并生成新修订`,
              }
            }
            const dep = /** @type {Deployment} */ (await get(cluster(), base, signal))
            const currentRevision = revisionOf(dep)
            // 候选＝名下带修订号、且不是当前修订的 RS（全 0 副本的旧 RS 正是回滚目标，不按副本数筛掉）
            const owned = await listOwnedReplicaSets(
              cluster(),
              params.ns,
              params.name,
              matchLabelsToSelector(dep.spec?.selector?.matchLabels),
              signal,
            )
            const candidates = owned
              .map((rs) => ({ name: rs.metadata.name, revision: revisionOf(rs), template: rs.spec?.template }))
              .filter((c) => c.revision > 0 && c.revision !== currentRevision && c.template !== undefined)
              .sort((a, b) => a.revision - b.revision)
            const revisions = candidates.map((c) => ({ revision: c.revision, name: c.name }))
            /** @type {{ name: string; revision: number; template: unknown } | undefined} */
            let target
            if (params.revision == null) {
              // 缺省目标＝严格低于当前修订的最大值（kubectl 的「上一版」）；
              // 只取更旧的，避免当前修订注解缺失/被改时误把修订号更大的 RS 当回滚目标
              const older = candidates.filter((c) => c.revision < currentRevision || currentRevision === 0)
              target = older[older.length - 1]
            } else {
              target = candidates.find((c) => c.revision === params.revision)
            }
            if (!target) {
              return {
                error:
                  params.revision == null
                    ? 'no older revision found'
                    : `no ReplicaSet found for revision ${params.revision}`,
                currentRevision,
                revisions,
              }
            }
            // 同 CR 分支：整份替换避免嵌合体（功能实测19#1）
            const curObj = /** @type {Record<string, unknown>} */ (await get(cluster(), base, signal))
            const { status: _st2, ...restTop } = curObj
            const curMeta = /** @type {Record<string, unknown>} */ ({ ...(curObj.metadata ?? {}) })
            delete curMeta.managedFields
            // 删 revision 注解：controller 按最大 RS 修订 +1，回滚产生新修订而非复用旧号
            if (curMeta.annotations && typeof curMeta.annotations === 'object') {
              const ann = /** @type {Record<string, unknown>} */ ({ .../** @type {Record<string, unknown>} */ (curMeta.annotations) })
              delete ann['deployment.kubernetes.io/revision']
              curMeta.annotations = ann
            }
            const { status, body } = await request(cluster(), 'PUT', base, {
              body: {
                ...restTop,
                metadata: curMeta,
                spec: {
                  ...(/** @type {Record<string, unknown>} */ (curObj.spec ?? {})),
                  template: rollbackTemplate(target.template),
                },
              },
              params: params.dryRun ? { dryRun: 'All' } : {},
              signal,
            })
            if (status >= 300) {
              const b = body && typeof body === 'object' ? /** @type {{ message?: string }} */ (body) : {}
              throw new Error(typeof b.message === 'string' ? b.message : `undo 失败（HTTP ${status}）`)
            }
            return {
              name: params.name,
              namespace: params.ns,
              kind,
              fromRevision: currentRevision,
              toRevision: target.revision,
              targetReplicaSet: target.name,
              patched: params.dryRun ? undefined : true,
              dryRun: params.dryRun ?? false,
              templateImages: templateImages(target.template),
              note: params.dryRun
                ? '仅预览，未生效'
                : `已按 revision ${target.revision} 的模板下发；controller 会另起一个新修订号（约 ${currentRevision + 1}）而不是复用旧号`,
            }
          }
          // history：Deployment 走 ReplicaSet 修订；SS/DS 走 ControllerRevision
          if (kind !== 'Deployment') {
            const [wl, crs] = await Promise.all([
              get(cluster(), base, signal).catch(() => null),
              listControllerRevisions(cluster(), params.ns, kind, params.name, undefined, signal),
            ])
            const currentRev = wl ? currentCrRevision(/** @type {{ status?: { currentRevision?: string } }} */ (wl), crs) : 0
            const olderCr = crs.map((r) => r.revision).filter((r) => r > 0 && r < currentRev)
            return {
              name: params.name,
              namespace: params.ns,
              kind,
              currentRevision: currentRev,
              previousRevision: olderCr.length ? Math.max(...olderCr) : null,
              revisions: crs
                .slice(-10)
                .reverse()
                .map((r) => ({
                  revision: r.revision,
                  name: r.name,
                  created: r.created,
                  images: r.images,
                  ...(r.revision === currentRev ? { current: true } : {}),
                })),
            }
          }
          const [dep, mine] = await Promise.all([
            // 修订历史本身不带「哪一版是当前版」：模型只能靠 revision 号猜，
            // 实测因此把 undo 目标选错、白跑一次 dryRun → 这里直接标出来
            get(cluster(), base, signal).catch(() => null),
            listOwnedReplicaSets(cluster(), params.ns, params.name, '', signal),
          ])
          mine.sort((a, b) => revisionOf(b) - revisionOf(a))
          const currentRevision = dep ? revisionOf(/** @type {Deployment} */ (dep)) : 0
          const older = mine.map(revisionOf).filter((r) => r > 0 && r < currentRevision)
          const previousRevision = older.length ? Math.max(...older) : null
          return {
            name: params.name,
            namespace: params.ns,
            currentRevision,
            previousRevision,
            note:
              previousRevision == null
                ? '没有更早的修订可回滚'
                : `undo 回滚「上一版」就是 previousRevision=${previousRevision}（当前版 currentRevision=${currentRevision} 不可作为回滚目标）`,
            revisions: mine.slice(0, 10).map((rs) => ({
              revision: revisionOf(rs),
              name: rs.metadata.name,
              replicas: rs.spec?.replicas ?? 0,
              ready: rs.status?.readyReplicas ?? 0,
              images: templateImages(rs.spec?.template),
              ...(revisionOf(rs) === currentRevision ? { current: true } : {}),
            })),
          }
        })
        return result(data)
      },
    },

    patch_resource: {
      label: '补丁资源',
      description:
        '对单个资源打补丁（写操作直接生效；可 dryRun 预览）。改已有资源的少量字段就用它：换容器镜像、改环境变量/资源限制、加 label/annotation、改 tolerations、cordon 节点（apiVersion=v1 kind=Node patch={"spec":{"unschedulable":true}}）——比 apply_yaml 安全（只动列出的字段，不会覆盖整份文档），也不要用 k8s_request PATCH。改之前先用 k8s_get/list_* 读现值确认容器名与当前值（容器数组按 name 合并，名字写错会新增容器而不是改容器）。patchType=json 时 patch 为操作数组 [{op,path,value}]。返回 status 与响应体。',
      parameters: Type.Object({
        apiVersion: Type.String({ description: '如 v1 / apps/v1' }),
        kind: Type.String({ description: '如 Node / Deployment' }),
        ns: Type.Optional(Type.String({ description: '命名空间，缺省 default（仅 namespaced 资源）' })),
        name: Type.String(),
        patch: Type.Object({}, { description: '补丁内容（JSON）；json 类型为操作数组' }),
        patchType: Type.Optional(
          Type.Union([Type.Literal('strategic'), Type.Literal('merge'), Type.Literal('json')], {
            description: '缺省 strategic（strategic merge patch）',
          }),
        ),
        dryRun: Type.Optional(Type.Boolean({ description: 'true = dryRun=All 预览' })),
      }),
      /** @param {string} _toolCallId @param {{ apiVersion: string; kind: string; ns?: string; name: string; patch: Record<string, unknown>; patchType?: 'strategic' | 'merge' | 'json'; dryRun?: boolean }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const data = await safe(async () => {
          const { plural, namespaced } = await resolveResource(cluster(), params.apiVersion, params.kind, signal)
          const ns = namespaced ? (params.ns ?? 'default') : null
          const path = resourcePath(params.apiVersion, plural, ns, params.name)
          const patchType = params.patchType ?? 'strategic'
          const contentType =
            patchType === 'json'
              ? 'application/json-patch+json'
              : patchType === 'merge'
                ? 'application/merge-patch+json'
                : 'application/strategic-merge-patch+json'
          const { status, body } = await request(cluster(), 'PATCH', path, {
            body: params.patch,
            contentType,
            params: params.dryRun ? { dryRun: 'All' } : {},
            signal,
          })
          return { name: params.name, namespace: ns, dryRun: params.dryRun ?? false, status, body: cap(body) }
        })
        return result(data)
      },
    },

  }
}
