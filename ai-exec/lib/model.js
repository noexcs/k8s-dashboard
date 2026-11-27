// @ts-check
/**
 * models.json 生成与模型解析（多 Provider）。
 *
 * pi 从 agentDir 读 models.json（CreateAgentSessionOptions.agentDir 决定路径）。
 * baseUrl 字段不支持 $ENV 插值（只有 apiKey/headers 支持，见 models-configuration.md），
 * 所以在启动/配置变更时用生效值生成文件。
 *
 * 多 Provider：设置页的 provider 列表 + env 底座（配置了才写）各成一个 pi provider
 * （键 `k8s` / `k8s-<id>`），聊天面板的 /ai/models 全量列出，modelId 带 provider
 * 前缀路由到各自 baseUrl/key。activeLlm 只决定「未配置」判定与聊天默认序。
 *
 * 容器语义：网关填 127.0.0.1/localhost 时容器内指向容器自身——运行时改写到
 * host.docker.internal（Docker Desktop）。仅容器内改写；宿主机 dev 跑不受影响。
 *
 * 思考：spec 要求 vLLM 带 reasoning_effort。models.json 的 samplingParams
 * 会逐 key 合并进每个 openai-completions 请求体（packages/ai/src/api/openai-completions.ts
 * buildParams 末尾 Object.assign(params, samplingParams)），故在此配置即可，
 * 无需 provider extension 改请求体。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { config } from './config.js'
import { activeLlm, effective, normalizeModelEntry, PROVIDER_APIS, readOverrides } from './overrides.js'

/** @typedef {import('@earendil-works/pi-ai').Model<import('@earendil-works/pi-ai').Api>} PiModel */
/** @typedef {import('@earendil-works/pi-coding-agent').ModelRuntime} PiModelRuntime */

/** env 底座 provider id（历史兼容：旧 models.json 只有这一个） */
export const LLM_PROVIDER = 'k8s'
/** 容器内跑（/.dockerenv 存在）才做 loopback 改写 */
const IN_CONTAINER = existsSync('/.dockerenv')

/**
 * 运行时 baseUrl：容器内把 loopback 改写为宿主。
 * @param {string} base
 */
export function runtimeBaseUrl(base) {
  const b = String(base ?? '')
  if (!IN_CONTAINER) return b
  return b.replace(/^(https?:\/\/)(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?=[:/]|$)/, '$1host.docker.internal')
}

/** provider 键：聊天/解析与 models.json 共用的路由 id */
/** @param {string | null | undefined} providerId */
export function providerKey(providerId) {
  return providerId ? `${LLM_PROVIDER}-${providerId}` : LLM_PROVIDER
}

/** 模型条目模板：vLLM OpenAI 兼容端点的统一假设；上下文/输出上限优先取网关上报值（/models 自动获取） */
/** @param {{ id: string, contextWindow?: number, maxTokens?: number }} entry */
function modelEntry(entry) {
  // 拿不到上报值时回落历史默认（256k 窗口，兼容旧行为）
  const ctx = entry.contextWindow ?? 262144
  return {
    id: entry.id,
    name: entry.id,
    // 思考由 samplingParams.reasoning_effort 控制，不声明 reasoning，
    // 避免 pi 按 thinking 级别再叠加参数
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ctx,
    // 输出上限不超过窗口一半（256k 时=16384，与旧固定值一致）
    maxTokens: entry.maxTokens ?? Math.min(16384, Math.floor(ctx / 2)),
    samplingParams: {
      // temperature 与浏览器侧 createAgent 保持一致
      temperature: 0.3,
      // vLLM 思考级别（Qwen3 系列；none 时响应无 reasoning 字段）
      reasoning_effort: 'medium',
    },
  }
}

/** 全部 provider 的生成输入：env 底座（配置了才有）+ UI provider 列表 */
export function providerSpecs() {
  /** @type {Array<{ key: string, name: string, baseUrl: string, api: string, apiKey: string, models: Array<{ id: string, contextWindow?: number, maxTokens?: number }> }>} */
  const specs = []
  const ov = readOverrides()
  const list = Array.isArray(ov.llmProviders) ? ov.llmProviders : []
  if (String(config.llmGatewayBase)) {
    // env 底座的模型集：llmModel 覆盖值（旧 UI 单覆盖也算进底座视图）
    const envModel = String(effective('llmModel'))
    specs.push({
      key: LLM_PROVIDER,
      name: 'env 网关',
      baseUrl: String(ov.llmGatewayBase ?? config.llmGatewayBase),
      api: 'openai-completions',
      apiKey: String(ov.llmApiKey ?? config.llmApiKey),
      models: envModel ? [{ id: envModel }] : [],
    })
  }
  for (const p of list) {
    if (!p || !String(p.baseUrl ?? '')) continue
    specs.push({
      key: providerKey(String(p.id)),
      name: String(p.name ?? p.id),
      baseUrl: String(p.baseUrl),
      api: PROVIDER_APIS.has(String(p.api)) ? String(p.api) : 'openai-completions',
      apiKey: String(p.apiKey ?? ''),
      models: (Array.isArray(p.models) ? p.models : []).map(normalizeModelEntry).filter((/** @type {{ id: string }} */ m) => m.id),
    })
  }
  return specs
}

/** 启动时（重）写 models.json，返回生成的绝对路径 */
/** @returns {string} */
export function writeModelsJson() {
  /** @type {Record<string, any>} */
  const providers = {}
  for (const s of providerSpecs()) {
    if (!s.models.length) continue
    providers[s.key] = {
      name: s.name,
      baseUrl: runtimeBaseUrl(s.baseUrl),
      api: s.api,
      // pi schema: apiKey minLength 1——免鉴权网关省略字段而非写空串
      // （空串会让整个 models.json 校验失败，连坐丢全部 provider）
      ...(s.apiKey ? { apiKey: s.apiKey } : {}),
      models: s.models.map(modelEntry),
    }
  }
  const modelsJson = {
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers,
  }
  const path = join(config.agentDir, 'models.json')
  writeFileSync(path, JSON.stringify(modelsJson, null, 2) + '\n')
  return path
}

/** 全局唯一的模型运行时（不联网刷新目录，静态 models.json 即可） */
/** @type {null | Promise<PiModelRuntime>} */
let runtimePromise = null
/** @returns {Promise<PiModelRuntime>} */
function createRuntime() {
  return ModelRuntime.create({
    authPath: join(config.agentDir, 'auth.json'),
    modelsPath: join(config.agentDir, 'models.json'),
    refreshOnCreate: false,
  })
}
/** @returns {Promise<PiModelRuntime>} */
export function modelRuntime() {
  if (!runtimePromise) {
    writeModelsJson()
    runtimePromise = createRuntime()
  }
  return runtimePromise
}

/**
 * 设置页改了网关/密钥/模型后的热重建：重写 models.json 并替换运行时。
 * 已建立的会话继续用旧模型对象走完当轮；新会话/新请求即用新配置。
 * @returns {Promise<void>}
 */
export async function refreshLlmRuntime() {
  writeModelsJson()
  runtimePromise = createRuntime()
  await runtimePromise
}

/** 按 id 解析模型：带前缀精确路由；裸 id 跨 provider 查找（先 active 后其余） */
/** @param {string} modelId @returns {Promise<PiModel>} */
export async function resolveModel(modelId) {
  const rt = await modelRuntime()
  const normalized = String(modelId)
  const active = activeLlm()
  if (normalized.includes('/')) {
    const [prov = LLM_PROVIDER, ...rest] = normalized.split('/')
    const id = rest.join('/')
    const model = rt.getModel(prov, id)
    if (model) return model
    throw new Error(`模型不可用：${modelId}（当前目录：${allModelIds().join(', ') || '空'}）`)
  }
  // 裸 id：active provider 优先，其次目录序——旧前端/旧会话只带模型名不受影响
  const activeKey = providerKey(active.providerId)
  const specs = providerSpecs()
  const ordered = [activeKey, ...specs.map(s => s.key).filter(k => k !== activeKey)]
  for (const key of ordered) {
    const m = rt.getModel(key, normalized)
    if (m) return m
  }
  throw new Error(`模型不可用：${modelId}（当前目录：${allModelIds().join(', ') || '空'}）`)
}

/** /ai/models 目录：全 provider 汇总；默认模型排第一（聊天面板默认选第一个=设置页默认模型） */
/** @returns {Promise<Array<{ id: string; name: string }>>} */
export async function listModels() {
  await modelRuntime()
  const active = activeLlm()
  const activeKey = providerKey(active.providerId)
  const defaultModel = String(effective('llmModel'))
  const specs = providerSpecs()
  const ordered = [...specs].sort((a, b) => (a.key === activeKey ? -1 : b.key === activeKey ? 1 : 0))
  /** @type {Array<{ id: string; name: string }>} */
  const out = []
  for (const s of ordered) {
    // 默认模型置顶：AiChat「默认取列表第一个」的约定要真的落到设置页选的模型上
    const models = s.key === activeKey ? [...s.models].sort((a, b) => (a.id === defaultModel ? -1 : b.id === defaultModel ? 1 : 0)) : s.models
    for (const m of models) {
      out.push({ id: `${s.key}/${m.id}`, name: specs.length > 1 || s.key !== LLM_PROVIDER ? `${m.id} · ${s.name}` : m.id })
    }
  }
  return out
}

/** 目录里全部 "provider/model" id（resolveModel 报错文案用）；须在 writeModelsJson 后调用 */
function allModelIds() {
  return providerSpecs().flatMap(s => s.models.map(m => `${s.key}/${m.id}`))
}
