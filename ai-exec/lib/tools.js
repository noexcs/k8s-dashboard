// @ts-check
/**
 * k8s extension 聚合层：域工具定义拆分在 tools-{overview,pods,helm,deploy,exec}.js，
 * 共享纯函数与 discovery 缓存在 tools-helpers.js；本文件只做聚合与权限门包装注册。
 * 原 24 个工具语义照搬（名称/描述/截断/dryRun 不变），迁移由等价性脚本逐工具 diff 验证。
 *
 * 集群名是每会话动态的：工厂接收可变的 clusterRef，execute 时读 .value，
 * /ai/chat 每轮请求前由服务端更新（见 sessions.js）。
 * 写/执行工具安全基线见 lib/permissions.js（三档权限 + confirm 挂起审批）。
 */
import { isReadTool, gateWriteTool, isAutoAllowedGenericRead } from './permissions.js'
import { record } from './audit.js'
import { buildNodeTools } from './nodes.js'
import { buildInsightTools } from './insight.js'
import { buildOverviewTools } from './tools-overview.js'
import { buildPodTools } from './tools-pods.js'
import { buildHelmTools } from './tools-helm.js'
import { buildDeployTools } from './tools-deploy.js'
import { buildExecTools } from './tools-exec.js'

/** @param {{ value: string }} clusterRef @param {string} sessionId @param {{ mode: string }} permRef */
function buildTools(clusterRef, sessionId, permRef) {
  return {
    ...buildOverviewTools(clusterRef, sessionId, permRef),
    ...buildPodTools(clusterRef),
    ...buildDeployTools(clusterRef),
    ...buildHelmTools(clusterRef),
    ...buildExecTools(clusterRef),
    // nodes.js：node_view/drain；insight.js：diff_yaml/diagnose
    ...buildNodeTools(clusterRef),
    ...buildInsightTools(clusterRef),
  }
}

/**
 * 构造 inline extension 工厂：pi.registerTool() 注册 26 个工具（12 只读 + 14 写/执行；
 * 其中 node_view/drain/diff_yaml/diagnose 来自 lib/nodes.js 与 lib/insight.js）。
 * 每个会话一个独立工厂实例（闭包持有该会话的 clusterRef 与权限状态）。
 * 写/执行工具的 execute 外包权限闸门（permissions.gateWriteTool）：
 * 只读放行；只读模式拒绝；写确认模式挂起等批准（SSE custom 帧 + HTTP 裁决）。
 * @param {{ value: string }} clusterRef
 * @param {{ mode: 'readonly' | 'confirm' | 'full' }} permRef 每会话可变权限状态
 * @param {string} sessionId 本 pi 会话 id（待批准项归属，会话释放时批量拒绝）
 * @param {{ write: null | ((chunk: Record<string, unknown>) => void),
 *          onPause: null | (() => void) }} sseRef
 *   当前活跃请求的 SSE write（server.js 在 run 归属期间设置；无活跃流时通知丢弃）
 *   + onPause（确认门挂起时由 server.js 提前收尾当前 SSE，run 保持 parked）
 */
export function createK8sExtension(clusterRef, permRef, sessionId, sseRef) {
  const tools = buildTools(clusterRef, sessionId, permRef)
  /** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
  return function k8sExtension(pi) {
    for (const [name, def] of Object.entries(tools)) {
      const origExecute = def.execute
      /** @type {import('@earendil-works/pi-coding-agent').ToolDefinition['execute']} */
      let execute = /** @type {import('@earendil-works/pi-coding-agent').ToolDefinition['execute']} */ (origExecute)
      if (!isReadTool(name)) {
        /** @type {(toolCallId: string, params: any, signal: AbortSignal | undefined) => Promise<any>} */
        const inner = /** @type {any} */ (origExecute)
        /** @type {import('@earendil-works/pi-coding-agent').ToolDefinition['execute']} */
        execute = async (toolCallId, params, signal) => {
          // smart 门：泛型工具的「非敏感路径 GET」直接执行（permissions.js 头注，
          // 用户决策 2026-11）；secrets 读取、decodeSecret、任何写方法仍走批准门。
          // 仅 confirm 档生效——readonly 档泛型入口仍整体禁用（用户显式收紧的契约）
          if (permRef.mode === 'confirm' && isAutoAllowedGenericRead(name, params)) {
            return /** @type {any} */ (origExecute)(toolCallId, params, signal)
          }
          const decision = await gateWriteTool(name, {
            cluster: clusterRef.value,
            mode: permRef.mode,
            sessionId,
            toolCallId,
            input: params,
            signal,
            notify: (chunk) => {
              const w = sseRef.write
              if (w) w(chunk)
            },
            onPause: () => {
              const p = sseRef.onPause
              if (p) p()
            },
          })
          if (!decision.ok) {
            return {
              content: [{ type: 'text', text: decision.reason }],
              details: undefined,
              isError: true,
            }
          }
          const out = await inner(toolCallId, params, signal)
          // 审计只记「真实改变了集群」的执行：
          // ① 被拒/报错不留痕——注意：审批被拒/超时的 deny/expired 由权限层**主动**进审计
          //    （permissions.js），此处不留的是工具执行报错，两套口径别混
          // ② dryRun 预览不留痕——工具描述主动建议先 dryRun，若预览也记，
          //    每次谨慎流程都注入假「已删除」，污染「谁改了什么」口径
          // ③ full 模式的泛型读（k8s_get / k8s_request GET）不是变更，
          //    记进去会把真实变更挤出 2MB 轮换窗口
          const p = /** @type {Record<string, unknown>} */ (params ?? {})
          const isGenericRead =
            name === 'k8s_get' || (name === 'k8s_request' && String(p.method ?? 'GET').toUpperCase() === 'GET')
          // F2（实测）：域工具报错走 safe() 返回 {error}、HPA 托管/零命中走
          // skipped——这些「没发生的写」以前照样入账，制造「把无关服务缩到 3」式幽灵条目。
          // isError 由 result() 永远不置位，判据必须看 details
          const d = /** @type {Record<string, unknown> | undefined} */ (out?.details)
          const changed =
            !!d &&
            d.error === undefined &&
            d.skipped !== true &&
            !(Array.isArray(d.deleted) && d.deleted.length === 0) &&
            !(name === 'scale' && d.before !== undefined && d.before === d.after) &&
            // k8s_request 非 GET 的被拒写（403/422）；apply_yaml 多文档全失败；helm 后端 failed
            !(typeof d.status === 'number' && d.status >= 300) &&
            !(Array.isArray(d.results) && d.results.length > 0 &&
              d.results.every((r) => r == null || typeof r !== 'object' || (typeof /** @type {any} */ (r).status === 'number' && /** @type {any} */ (r).status >= 300) || /** @type {any} */ (r).error !== undefined)) &&
            !(/failed/i.test(String(/** @type {any} */ (d).actionStatus?.status ?? '')))
          const brief =
            name === 'scale' && d?.before !== undefined
              ? `副本 ${d.before}→${d.after}`
              : name === 'delete_resource' && Array.isArray(d?.deleted)
                ? `删除 ${d.deleted.length} 个：${d.deleted.slice(0, 5).map((x) => String(typeof x === 'object' && x !== null && 'name' in x ? /** @type {any} */ (x).name : x)).join(', ')}`
                : name === 'rollout' && d?.toRevision !== undefined
                  ? `→ 版本 ${d.toRevision}`
                  : undefined
          // disposition_set 在 execute 内自记（带完整 target 与 actor），包装器跳过防双写
          if (!out?.isError && changed && p.dryRun !== true && !isGenericRead && name !== 'disposition_set') {
            record({
              summary: brief,
              source: 'ai',
              actor: sessionId,
              // 权限档盖章：full 档写与逐条批准的写在审计里必须可区分（事后唯一制衡）
              mode: permRef.mode,
              cluster: clusterRef.value,
              verb: name,
              // kind 供审计页跳详情；params 里不带的工具（helm/ssh 类）留空不强猜
              kind: typeof p.kind === 'string' ? p.kind : undefined,
              ns: typeof (p.namespace ?? p.ns) === 'string' ? String(p.namespace ?? p.ns) : undefined,
              name: typeof p.name === 'string' ? p.name : undefined,
              target:
                [p.namespace ?? p.ns, p.name].filter((/** @type {unknown} */ v) => typeof v === 'string').join('/') ||
                apiPathTarget(p.apiPath) ||
                undefined,
            })
          }
          return out
        }
      }
      pi.registerTool(
        /** @type {import('@earendil-works/pi-coding-agent').ToolDefinition} */ ({
          name,
          ...def,
          execute,
          // 写工具串行执行：确认门一次至多挂一个，审批卡不重叠（审批协议按单挂起设计）
          ...(!isReadTool(name) ? { executionMode: 'sequential' } : {}),
        }),
      )
    }
  }
}

/** 泛型工具（k8s_request）无 ns/name 参数，从 apiPath 位置解析：namespaces/{ns}/{res}/{name} */
function apiPathTarget(/** @type {unknown} */ apiPath) {
  if (typeof apiPath !== 'string') return undefined
  const head = apiPath.split('?')[0] ?? apiPath
  const seg = head.split('/').filter(Boolean)
  const i = seg.indexOf('namespaces')
  const ns = i >= 0 ? seg[i + 1] : undefined
  const objName = i >= 0 ? seg[i + 3] : undefined
  if (ns && objName) return `${ns}/${objName}`
  const kindSeg = /** @type {string|undefined} */ (seg[seg.length - 2])
  const nameSeg = /** @type {string|undefined} */ (seg[seg.length - 1])
  return kindSeg && nameSeg && !['namespaces'].includes(nameSeg) ? nameSeg : undefined
}
