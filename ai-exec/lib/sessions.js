// @ts-check
/**
 * 会话注册表：sessionId 由服务端分配（pi SessionManager 用 uuidv7），
 * 持久 JSONL 存于 sessionDir；LRU 上限控制常驻内存的 AgentSession 数量。
 *
 * 一个会话 = 一条 pi 会话（JSONL）+ 一个可变 clusterRef（工具执行时读取当前集群）。
 * 业务字段（cluster）pi 会话格式不承载 → 侧车 meta 文件（metaDir/<id>.json）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAgentSession, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent'
import { config } from './config.js'
import { modelRuntime, resolveModel } from './model.js'
import { SYSTEM_PROMPT } from './prompt.js'
import { createK8sExtension } from './tools.js'
import { createPermState, clearPendingForSession } from './permissions.js'

/** @typedef {import('@earendil-works/pi-coding-agent').AgentSession} AgentSession */

/**
 * @typedef {object} SessionRecord
 * @property {AgentSession} session
 * @property {string} id
 * @property {{ value: string }} clusterRef 当前集群（每轮 /ai/chat 前更新）
 * @property {{ mode: 'readonly' | 'confirm' | 'full' }} permRef 工具执行权限（每轮 /ai/chat 前更新）
 * @property {{ write: null | ((chunk: Record<string, unknown>) => void),
 *              onPause: null | (() => void) }} sseRef 当前活跃请求的 SSE write + 确认门挂起回调（run 归属期间设置）
 * @property {number} lastActivity
 * @property {string | null} owner 当前 run 的归属请求 id（客户端断开时仅归属方触发 abort）
 */

/** 读会话侧车元数据（cluster）；不存在返回 null */
/** @param {string} sessionId @returns {string | null} */
export function readMeta(sessionId) {
  try {
    const raw = readFileSync(join(config.metaDir, `${sessionId}.json`), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.cluster === 'string' ? parsed.cluster : null
  } catch {
    return null
  }
}

/** 写会话侧车元数据 */
/** @param {string} sessionId @param {string} cluster */
export function writeMeta(sessionId, cluster) {
  writeFileSync(join(config.metaDir, `${sessionId}.json`), JSON.stringify({ cluster }, null, 0))
}

export class SessionRegistry {
  constructor() {
    /** @type {Map<string, SessionRecord>} */
    this.records = new Map()
  }

  /** @param {string} id @returns {SessionRecord | null} 已加载会话（不触发从磁盘恢复） */
  peek(id) {
    return this.records.get(id) ?? null
  }

  /**
   * 获取（必要时创建/恢复）会话。
   * @param {string | null} sessionId 缺省 → 新建（服务端分配 id）
   * @param {string} cluster
   * @param {string | undefined} modelId 每请求模型覆盖（P1 目录里只有默认模型）
   * @returns {Promise<SessionRecord>}
   */
  async acquire(sessionId, cluster, modelId) {
    this._evictIfFull()

    if (sessionId) {
      const existing = this.records.get(sessionId)
      if (existing) {
        existing.clusterRef.value = cluster
        existing.lastActivity = Date.now()
        if (modelId) await this._applyModel(existing, modelId)
        writeMeta(sessionId, cluster)
        return existing
      }
      const path = SessionManager.findById(config.workspaceDir, sessionId, config.sessionDir)
      if (!path) {
        const e = /** @type {Error & { code?: string }} */ (new Error('会话不存在'))
        e.code = 'NOT_FOUND'
        throw e
      }
      const sm = SessionManager.open(path, config.sessionDir, config.workspaceDir)
      const rec = await this._build(sm, sm.getSessionId(), cluster, modelId)
      this._put(rec)
      return rec
    }

    const sm = SessionManager.create(config.workspaceDir, config.sessionDir)
    const rec = await this._build(sm, sm.getSessionId(), cluster, modelId)
    this._put(rec)
    return rec
  }

  /** 全量释放（进程退出时） */
  disposeAll() {
    for (const rec of this.records.values()) {
      clearPendingForSession(rec.id)
      try {
        rec.session.dispose()
      } catch {
        /* 忽略 */
      }
    }
    this.records.clear()
  }

  // ---------- 内部 ----------

  /** @private */
  /** @param {SessionRecord} rec */
  _put(rec) {
    this.records.set(rec.id, rec)
  }

  /** @private */
  /** @param {SessionRecord} rec @param {string} modelId @returns {Promise<void>} */
  async _applyModel(rec, modelId) {
    const current = rec.session.model
    if (current && (current.id === modelId || `${current.provider}/${current.id}` === modelId)) return
    const model = await resolveModel(modelId)
    if (current && current.provider === model.provider && current.id === model.id) return
    try {
      await rec.session.setModel(model)
    } catch {
      // 目标模型无凭据等：保持当前模型
    }
  }

  /** @private */
  /**
   * @param {import('@earendil-works/pi-coding-agent').SessionManager} sm
   * @param {string} id
   * @param {string} cluster
   * @param {string | undefined} modelId
   * @returns {Promise<SessionRecord>}
   */
  async _build(sm, id, cluster, modelId) {
    const clusterRef = { value: cluster }
    // 默认写确认（真实集群写操作先过用户批准；每轮 /chat 可切换，见 server.js）
    const permRef = createPermState('confirm')
    const sseRef = { write: null, onPause: null }
    const loader = new DefaultResourceLoader({
      cwd: config.workspaceDir,
      agentDir: config.agentDir,
      extensionFactories: [createK8sExtension(clusterRef, permRef, id, sseRef)],
      // 集群身份进 system prompt：多集群轮值下 AI 的每条变更/结论必须点名集群（工具默认作用域=本会话绑定集群）
      systemPrompt: `${SYSTEM_PROMPT}\n\n本会话绑定集群「${cluster}」：所有工具默认作用于它；汇报任何变更或结论时点名该集群。`,
      // 本服务不需要 pi 的技能/模板/主题/上下文文件发现
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    await loader.reload()
    const model = await resolveModel(modelId ?? config.llmModel)
    const { session } = await createAgentSession({
      cwd: config.workspaceDir,
      agentDir: config.agentDir,
      modelRuntime: await modelRuntime(),
      model,
      // vLLM 关思考（配合 models.json samplingParams.reasoning_effort:"none"）
      thinkingLevel: 'off',
      // SDK 等价 --no-builtin-tools：禁默认内置工具，仅保留 extension 注册的 k8s 工具
      noTools: 'builtin',
      resourceLoader: loader,
      sessionManager: sm,
    })
    writeMeta(id, cluster)
    return { session, id, clusterRef, permRef, sseRef, lastActivity: Date.now(), owner: null }
  }

  /** 超出上限时淘汰最久未用的空闲会话（busy 的不动） */
  _evictIfFull() {
    if (this.records.size < config.maxActiveSessions) return
    const idle = [...this.records.values()]
      .filter((r) => !r.session.isStreaming)
      .sort((a, b) => a.lastActivity - b.lastActivity)
    const victim = idle[0]
    if (!victim) return
    this.records.delete(victim.id)
    clearPendingForSession(victim.id)
    try {
      victim.session.dispose()
    } catch {
      /* 忽略 */
    }
  }
}
