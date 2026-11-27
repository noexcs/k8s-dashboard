// @ts-check
/**
 * StatefulSet/DaemonSet 修订历史（ControllerRevision 路线，供 tools.js rollout 的 history/undo 用）。
 * Deployment 的修订走 ReplicaSet（tools.js 私有 helper，零回归）；SS/DS 没有 RS，
 * 修订记录在 policy 之外的 apps/v1 ControllerRevision：CR data.spec.template 是当版
 * Pod 模板快照，revision 字段是修订号。CR 名的 hash 后缀由 controller 生成，
 * 不可依赖——一律按 revision 字段排序/匹配。
 * 纯导出模块：不 import tools.js。
 */
import { list } from './k8s.js'

/** @typedef {object} ControllerRevision
 * @property {{ name: string; namespace?: string; ownerReferences?: Array<{ kind?: string; name?: string; controller?: boolean }>; creationTimestamp?: string }} metadata
 * @property {number} [revision]
 * @property {{ spec?: { template?: unknown } }} [data]
 */

/**
 * Pod 模板里的容器镜像（history 摘要，便于模型确认「回到的是哪个版本」）。
 * @param {unknown} template @returns {string[]}
 */
function templateImages(template) {
  const t = /** @type {{ spec?: { containers?: Array<{ image?: string }> } } | null} */ (
    template && typeof template === 'object' ? /** @type {object} */ (template) : null
  )
  const images = (t?.spec?.containers ?? []).map((c) => c.image).filter((v) => typeof v === 'string')
  return [...new Set(images)]
}

/**
 * 回滚写回 spec.template 前要清的 controller 注入 label：
 * controller-revision-hash / pod-template-hash 由 controller 按新模板重算，
 * 旧快照里带的 hash 写回去会让 SS/DS controller 误判版本归属。
 * strategic merge 的 map 按键合并，「不写」删不掉现模板上已有的同名键，所以显式写 null。
 * @param {unknown} template @returns {Record<string, unknown>}
 */
export function cleanCrTemplate(template) {
  const t = /** @type {Record<string, unknown>} */ (template && typeof template === 'object' ? template : {})
  const meta = /** @type {Record<string, unknown>} */ (t.metadata && typeof t.metadata === 'object' ? t.metadata : {})
  // PUT 整份替换语义下 null 不删键（会落成空字符串脏键，diff/GitOps 幻影漂移）——
  // 直接解构剔除，与 UI 历史 tab（RevisionsTab）同实现（FL20#4 实测 dryRun 回显坐实）
  const { 'controller-revision-hash': _h1, 'pod-template-hash': _h2, ...labels } =
    /** @type {Record<string, string>} */ (
      /** @type {Record<string, unknown>} */ (meta.labels && typeof meta.labels === 'object' ? meta.labels : {})
    )
  return {
    ...t,
    metadata: { ...meta, labels },
  }
}

/**
 * @typedef {object} CrRevision
 * @property {number} revision
 * @property {string} name
 * @property {unknown} template CR data.spec.template（当版 Pod 模板快照）
 * @property {string[]} images 模板里的镜像（去重）
 * @property {string | null} created
 */

/**
 * 某 StatefulSet/DaemonSet 名下的 ControllerRevision，按 revision 升序。
 * labelSelector 只作少拉数据的优化；权威过滤按 ownerReferences（同 ns 别的工作负载
 * 或孤儿 CR 可能命中同一组 label，且 CR 的 controller owner 才是真归属）。
 * @param {string} cluster @param {string} ns
 * @param {'StatefulSet' | 'DaemonSet'} kind @param {string} name
 * @param {string} [labelSelector] @param {AbortSignal | undefined} [signal]
 * @returns {Promise<CrRevision[]>}
 */
export async function listControllerRevisions(cluster, ns, kind, name, labelSelector, signal) {
  const { items } = /** @type {{ items: ControllerRevision[] }} */ (
    await list(
      cluster,
      `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/controllerrevisions`,
      labelSelector ? { labelSelector } : {},
      signal,
    )
  )
  return items
    .filter((cr) => (cr.metadata.ownerReferences ?? []).some((o) => o.kind === kind && o.name === name && o.controller === true))
    .map((cr) => ({
      revision: cr.revision ?? 0,
      name: cr.metadata.name,
      template: cr.data?.spec?.template,
      images: templateImages(cr.data?.spec?.template),
      created: cr.metadata.creationTimestamp ?? null,
    }))
    // revision 字段是权威修订号；CR 名的 hash 后缀与版本新旧无关，不做字符串排序
    .sort((a, b) => a.revision - b.revision)
    .filter((c) => c.revision > 0 && c.template !== undefined)
}

/**
 * 当前修订号：SS 用 status.currentRevision（值是 CR 名）反查 revision；
 * DS 无该字段/查不到时回退「最大 revision」（最新 CR 即现行模板）。
 * @param {{ status?: { currentRevision?: string } }} workload
 * @param {CrRevision[]} revisions 升序
 * @returns {number}
 */
export function currentCrRevision(workload, revisions) {
  const cur = workload.status?.currentRevision
  if (cur) {
    const hit = revisions.find((r) => r.name === cur)
    if (hit) return hit.revision
  }
  return revisions.length > 0 ? /** @type {CrRevision} */ (revisions[revisions.length - 1]).revision : 0
}
