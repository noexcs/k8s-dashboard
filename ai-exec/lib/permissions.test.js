// 写操作权限门（AI 安全边界）契约测试：node --test lib/permissions.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  READ_TOOLS,
  decideApproval,
  pendingToolCallIds,
  gateWriteTool,
  isReadTool,
  isAutoAllowedGenericRead,
  clearPendingForSession,
  allowToolForSession,
  autoAllowedTools,
  clearAutoAllowForSession,
} from './permissions.js'

/** @param {'readonly'|'confirm'|'full'} mode @param {Record<string, unknown>} [extra] */
const baseCtx = (mode, extra = {}) => ({
  mode,
  toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
  sessionId: 's1',
  input: {},
  signal: /** @type {AbortSignal | undefined} */ (undefined),
  notify: () => {},
  ...extra,
})

test('full 模式写工具直通', async () => {
  assert.deepEqual(await gateWriteTool('k8s_apply', baseCtx('full')), { ok: true })
})

test('readonly 模式拒绝写工具且给出可执行指引', async () => {
  const r = await gateWriteTool('k8s_delete', baseCtx('readonly'))
  assert.equal(r.ok, false)
  assert.match(r.reason, /只读/)
})

test('confirm 模式：审批帧 + 批准后续跑', async () => {
  /** @type {Record<string, unknown>[]} */
  const frames = []
  const ctx = baseCtx('confirm', { notify: (/** @type {Record<string, unknown>} */ f) => frames.push(f) })
  const p = gateWriteTool('k8s_delete', ctx)
  // 门挂起期间：已发出审批请求帧（单一 id 空间：approvalId === toolCallId）
  await new Promise((r) => setImmediate(r))
  assert.equal(frames[0]?.type, 'tool-approval-request')
  assert.equal(frames[0]?.approvalId, ctx.toolCallId)
  assert.equal(decideApproval(ctx.toolCallId, true, ctx.sessionId), true)
  assert.deepEqual(await p, { ok: true })
})

test('confirm 模式：拒绝原因可见', async () => {
  const ctx = baseCtx('confirm')
  const p = gateWriteTool('k8s_apply', ctx)
  await new Promise((r) => setImmediate(r))
  decideApproval(ctx.toolCallId, false, ctx.sessionId)
  const r = await p
  assert.equal(r.ok, false)
  assert.match(r.reason, /拒绝/)
})

test('abort 中止未决审批（不泄漏挂起 Promise）', async () => {
  const ac = new AbortController()
  const ctx = baseCtx('confirm', { signal: ac.signal })
  const p = gateWriteTool('k8s_delete', ctx)
  await new Promise((r) => setImmediate(r))
  ac.abort()
  const r = await p
  assert.equal(r.ok, false)
  assert.match(r.reason, /中止/)
  // 已裁决项再裁决 = false
  assert.equal(decideApproval(ctx.toolCallId, true, ctx.sessionId), false)
})

test('会话释放拒绝其全部待批准项', async () => {
  const ctx = baseCtx('confirm', { sessionId: 'gone-session' })
  const p = gateWriteTool('k8s_exec', ctx)
  await new Promise((r) => setImmediate(r))
  clearPendingForSession('gone-session')
  assert.equal((await p).ok, false)
})

test('重复裁决幂等：第二次裁决返回 false，结果不变', async () => {
  const ctx = baseCtx('confirm')
  const p = gateWriteTool('k8s_delete', ctx)
  await new Promise((r) => setImmediate(r))
  assert.equal(decideApproval(ctx.toolCallId, true, ctx.sessionId), true)
  assert.equal(decideApproval(ctx.toolCallId, false, ctx.sessionId), false)
  assert.deepEqual(await p, { ok: true })
})

test('只读工具白名单：读取类直通，写/执行与泛型入口不在白名单', () => {
  assert.equal(isReadTool('list_pods'), true)
  assert.equal(isReadTool('pod_logs'), true)
  assert.equal(isReadTool('diagnose'), true)
  // 写/执行工具（含 drain 排障入口——会驱逐 Pod 故走确认门）
  for (const w of ['k8s_apply', 'k8s_delete', 'scale_workload', 'drain_node', 'exec_pod']) {
    assert.equal(READ_TOOLS.has(w), false, w)
  }
})

test('审批归属校验：他会话不得裁决他人挂起写（toolCallId 可被枚举，归属是唯一防线）', async () => {
  const ctx = baseCtx('confirm')
  const p = gateWriteTool('k8s_delete', ctx)
  await new Promise((r) => setImmediate(r))
  // 错误归属：拒绝且不消耗挂起项
  assert.equal(decideApproval(ctx.toolCallId, true, 'attacker-session'), false)
  // 正确归属仍可放行
  assert.equal(decideApproval(ctx.toolCallId, true, ctx.sessionId), true)
  assert.deepEqual(await p, { ok: true })
})

test('挂起审批集合按会话隔离（ui-message 还原审批卡的依据）', async () => {
  const a = baseCtx('confirm', { sessionId: 'sa' })
  const b = baseCtx('confirm', { sessionId: 'sb' })
  const pa = gateWriteTool('k8s_scale', a)
  const pb = gateWriteTool('k8s_scale', b)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual([...pendingToolCallIds('sa')], [a.toolCallId])
  assert.deepEqual([...pendingToolCallIds('sb')], [b.toolCallId])
  assert.deepEqual([...pendingToolCallIds('sc')], [])
  decideApproval(a.toolCallId, true, 'sa')
  decideApproval(b.toolCallId, true, 'sb')
  await Promise.all([pa, pb])
})

// ---- smart 门：泛型工具非敏感 GET 自动放行（用户决策 2026-11）----
test('isAutoAllowedGenericRead 放行非敏感只读', () => {
  assert.equal(isAutoAllowedGenericRead('k8s_get', { apiPath: '/api/v1/services' }), true)
  assert.equal(isAutoAllowedGenericRead('k8s_get', { apiPath: '/apis/apps/v1/namespaces/default/deployments' }), true)
  assert.equal(isAutoAllowedGenericRead('k8s_request', { method: 'GET', apiPath: '/api/v1/pods?limit=5' }), true)
  // 段精确匹配：含 secrets 字样的命名空间/资源名不误伤
  assert.equal(isAutoAllowedGenericRead('k8s_get', { apiPath: '/api/v1/namespaces/foo-secrets-x/configmaps' }), true)
})

test('isAutoAllowedGenericRead 拦 secrets 读取、明文解码与非 GET', () => {
  assert.equal(isAutoAllowedGenericRead('k8s_get', { apiPath: '/api/v1/secrets' }), false)
  assert.equal(isAutoAllowedGenericRead('k8s_get', { apiPath: '/api/v1/namespaces/default/secrets' }), false)
  assert.equal(isAutoAllowedGenericRead('k8s_get', { apiPath: '/API/V1/SECRETS' }), false)
  assert.equal(isAutoAllowedGenericRead('k8s_get', { apiPath: '/api/v1/configmaps', decodeSecret: true }), false)
  assert.equal(isAutoAllowedGenericRead('k8s_request', { method: 'DELETE', apiPath: '/api/v1/pods' }), false)
  assert.equal(isAutoAllowedGenericRead('k8s_request', { apiPath: '/api/v1/pods' }), false)
  // 形状异常一律保守走门
  assert.equal(isAutoAllowedGenericRead('k8s_get', undefined), false)
  assert.equal(isAutoAllowedGenericRead('k8s_get', {}), false)
  // 其他工具不受 smart 门影响
  assert.equal(isAutoAllowedGenericRead('delete_resource', { apiPath: '/api/v1/services' }), false)
})

// ---- 会话级同类自动放行（批准卡第三键）----
test('autoAllow：授权后同名工具免批，他名仍走门；档位清空', async () => {
  allowToolForSession('saa', 'scale')
  // 他名工具的挂起门：起 gate 后立刻拒绝收敛（不 await 挂起态，避免测试死等）
  const pg = gateWriteTool('delete_resource', {
    mode: 'confirm', sessionId: 'saa', toolCallId: 'g1', input: {}, signal: undefined,
    notify: () => {}, onPause: undefined,
  })
  const pass = await gateWriteTool('scale', {
    mode: 'confirm', sessionId: 'saa', toolCallId: 'g2', input: {}, signal: undefined,
    notify: () => {}, onPause: undefined,
  })
  assert.equal(pass.ok, true) // 同名直接放行，不发审批帧
  assert.equal(decideApproval('g1', false, 'saa'), true) // 他名仍进待批准队列
  assert.equal((await pg).ok, false)
  // readonly 档不受 autoAllow 影响
  const ro = await gateWriteTool('scale', {
    mode: 'readonly', sessionId: 'saa', toolCallId: 'g3', input: {}, signal: undefined,
    notify: () => {}, onPause: undefined,
  })
  assert.equal(ro.ok, false)
  assert.deepEqual(autoAllowedTools('saa'), ['scale'])
  clearAutoAllowForSession('saa')
  assert.deepEqual(autoAllowedTools('saa'), [])
})
