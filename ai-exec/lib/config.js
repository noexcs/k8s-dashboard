// @ts-check
/**
 * 运行配置：env 在进程启动时读取一次（轮换 key 需重建容器/重启进程，
 * 与容器 "recreate 生效" 模型一致；key 只存在于本进程 env，不下发前端）。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** LLM_MODEL 缺省值 */
export const DEFAULT_LLM_MODEL = 'Qwen3.8-27B'
/**
 * LLM_GATEWAY_BASE 缺省值：空 = 未配置。AI 助手/巡检在未配置时给出明确提示；
 * 仅通过环境变量 LLM_GATEWAY_BASE 注入 OpenAI 兼容网关地址（…/v1），重启生效。
 */
export const DEFAULT_LLM_GATEWAY_BASE = ''
/**
 * headlamp-server（k8s 数据代理）地址。
 * 容器内 headlamp-server 监听 4467（同容器同端口族）；本地测试指向宿主机映射端口
 * （冒烟容器: docker -p 4467:4467 → http://127.0.0.1:4467）。两者同值。
 */
export const DEFAULT_BACKEND_BASE = 'http://127.0.0.1:4467'
/** pi 内置工具（read/bash/edit/write…）全部禁用，仅保留 k8s extension 工具 */
export const BUILTIN_TOOLS_DISABLED = true

/** 读 env 字符串，空值/未设置回退缺省 */
/** @param {string} name @param {string} dft @returns {string} */
function envStr(name, dft) {
  const v = process.env[name]
  return v !== undefined && v !== '' ? v : dft
}

/** 根数据目录：容器内 /data/ai（挂载卷），本地默认 ~/.k8s-ai（PI_DATA_DIR 可覆盖） */
const dataDir = resolve(envStr('PI_DATA_DIR', join(homedir(), '.k8s-ai')))

export const config = {
  dataDir,
  /** pi 全局配置目录（models.json/auth.json/settings 全在此，与用户 ~/.pi 隔离） */
  agentDir: join(dataDir, 'agent'),
  /** pi 会话 JSONL 持久化目录（/data/ai/sessions） */
  sessionDir: join(dataDir, 'sessions'),
  /** pi 工作目录（资源发现隔离；本服务不读写此目录内容） */
  workspaceDir: join(dataDir, 'workspace'),
  /** 会话侧车元数据目录：sessionId → { cluster }（pi 会话格式不承载业务字段） */
  metaDir: join(dataDir, 'meta'),
  /** vLLM OpenAI-compatible 网关 */
  llmGatewayBase: envStr('LLM_GATEWAY_BASE', DEFAULT_LLM_GATEWAY_BASE).replace(/\/+$/, ''),
  /** 只被本进程消费 */
  llmApiKey: envStr('LLM_API_KEY', ''),
  llmModel: envStr('LLM_MODEL', DEFAULT_LLM_MODEL),
  /** 工具取数走 headlamp-server 代理（唯一 k8s 访问点） */
  backendBase: envStr('K8S_BACKEND_BASE', DEFAULT_BACKEND_BASE).replace(/\/+$/, ''),
  /** 只监听 loopback（Go 反代是唯一入口；鉴权点也在 Go 侧） */
  host: envStr('AI_EXEC_HOST', '127.0.0.1'),
  port: Number(envStr('AI_EXEC_PORT', '4470')),
  /** 常驻内存的 AgentSession 上限（超出淘汰最久未用的空闲会话） */
  maxActiveSessions: Number(envStr('AI_EXEC_MAX_SESSIONS', '8')),
  /** 后台定时巡检间隔（分钟，0=关闭）：只扫用户打开过巡检的集群；diff/复发/留档不再依赖人记得点按钮 */
  inspectIntervalMin: Number(envStr('INSPECT_INTERVAL_MIN', '30')),
  /** 站外通知旁路（可选）：新审批挂起过半仍未裁决/自动拒绝/巡检发现节点·负载异常时 POST 摘要 */
  notifyWebhookUrl: envStr('NOTIFY_WEBHOOK_URL', ''),
  /** 面板对外地址（webhook 消息里的深链前缀，如 http://100.x.x.x:4467；未配则消息不带链接） */
  panelBaseUrl: envStr('PANEL_BASE_URL', '').replace(/\/+$/, ''),
}

/** 启动时建目录（pi 的 SessionManager 也会自建 sessionDir，这里保证 meta 等存在） */
for (const dir of [config.dataDir, config.agentDir, config.sessionDir, config.workspaceDir, config.metaDir]) {
  mkdirSync(dir, { recursive: true })
}
