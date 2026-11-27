// @ts-check
/**
 * models.json 生成与模型解析。
 *
 * pi 从 agentDir 读 models.json（CreateAgentSessionOptions.agentDir 决定路径）。
 * baseUrl 字段不支持 $ENV 插值（只有 apiKey/headers 支持，见 models-configuration.md），
 * 所以在启动时用 env 的实值生成文件。
 *
 * 思考：spec 要求 vLLM 带 reasoning_effort。models.json 的 samplingParams
 * 会逐 key 合并进每个 openai-completions 请求体（packages/ai/src/api/openai-completions.ts
 * buildParams 末尾 Object.assign(params, samplingParams)），故在此配置即可，
 * 无需 provider extension 改请求体。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { config } from './config.js'

/** @typedef {import('@earendil-works/pi-ai').Model<import('@earendil-works/pi-ai').Api>} PiModel */
/** @typedef {import('@earendil-works/pi-coding-agent').ModelRuntime} PiModelRuntime */

/** 自定义 provider id（非内置 provider，走 compatible endpoint） */
export const LLM_PROVIDER = 'k8s'

/** 启动时（重）写 models.json，返回生成的绝对路径 */
/** @returns {string} */
export function writeModelsJson() {
  const modelsJson = {
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers: {
      [LLM_PROVIDER]: {
        name: 'K8S vLLM',
        baseUrl: config.llmGatewayBase,
        api: 'openai-completions',
        apiKey: config.llmApiKey,
        models: [
          {
            id: config.llmModel,
            name: config.llmModel,
            // 思考由 samplingParams.reasoning_effort 控制，不声明 reasoning，
            // 避免 pi 按 thinking 级别再叠加参数
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 16384,
            samplingParams: {
              // temperature 与浏览器侧 createAgent 保持一致
              temperature: 0.3,
              // vLLM 思考级别（Qwen3 系列；none 时响应无 reasoning 字段）
              reasoning_effort: 'medium',
            },
          },
        ],
      },
    },
  }
  const path = join(config.agentDir, 'models.json')
  writeFileSync(path, JSON.stringify(modelsJson, null, 2) + '\n')
  return path
}

/** 全局唯一的模型运行时（不联网刷新目录，静态 models.json 即可） */
/** @type {null | Promise<PiModelRuntime>} */
let runtimePromise = null
/** @returns {Promise<PiModelRuntime>} */
export function modelRuntime() {
  if (!runtimePromise) {
    writeModelsJson()
    runtimePromise = ModelRuntime.create({
      authPath: join(config.agentDir, 'auth.json'),
      modelsPath: join(config.agentDir, 'models.json'),
      refreshOnCreate: false,
    })
  }
  return runtimePromise
}

/** 按 id 解析模型（支持 "k8s/<id>" 或 "<id>"）；不存在时抛错 */
/** @param {string} modelId @returns {Promise<PiModel>} */
export async function resolveModel(modelId) {
  const rt = await modelRuntime()
  const normalized = String(modelId)
  const parts = normalized.includes('/') ? normalized.split('/', 2) : [LLM_PROVIDER, normalized]
  const prov = parts[0] ?? LLM_PROVIDER
  const id = parts[1] ?? ''
  if (!prov || !id) {
    throw new Error(`模型不可用：${modelId}（当前目录仅 ${config.llmModel}）`)
  }
  const model = rt.getModel(prov, id)
  if (!model) {
    throw new Error(`模型不可用：${modelId}（当前目录仅 ${config.llmModel}）`)
  }
  return model
}

/** /ai/models 目录 */
/** @returns {Promise<Array<{ id: string; name: string }>>} */
export async function listModels() {
  const rt = await modelRuntime()
  return rt.getModels(LLM_PROVIDER).map((m) => ({ id: m.id, name: m.name }))
}
