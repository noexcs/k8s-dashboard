// @ts-check
/**
 * tools 域：exec_pod（自 tools.js buildTools 拆出；聚合注册见 tools.js）。
 */
import { Type } from 'typebox'
import { postJson } from './k8s.js'
import { result, EXEC_STDOUT_LIMIT, EXEC_STDERR_LIMIT, safe } from './tools-helpers.js'

/** @typedef {import('./tools-helpers.js').Pod} Pod */

/** @param {{ value: string }} clusterRef @returns {Record<string, any>} */
export function buildExecTools(clusterRef) {
  const cluster = () => clusterRef.value
  return {
    exec_pod: {
      label: '容器执行',
      description:
        '在 Pod 容器内执行一次性命令（诊断取证用：ls/cat/env/ps/应用自带命令等；非交互、不分配 TTY；写操作命令直接生效）。注意视野限制：命令跑在容器里，看不到宿主机——查节点磁盘/内核/资源水位用 node_view（已含节点事件如 FreeDiskSpaceFailed、EvictionThresholdMet），不要挨个 exec 进业务容器跑 df。command 为参数数组（如 ["sh","-c","ls -la"]）；timeoutSeconds 缺省 30、上限 120。返回 {exitCode, stdout(尾部≤8000 字符), stderr(尾部≤4000 字符)}；不要用它执行破坏性 shell。',
      parameters: Type.Object({
        ns: Type.String(),
        pod: Type.String(),
        container: Type.Optional(Type.String({ description: '容器名；多容器 Pod 必填' })),
        command: Type.Array(Type.String({ description: '命令参数' }), { description: '如 ["sh","-c","ls -la"]' }),
        timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 120, description: '超时（秒），缺省 30' })),
      }),
      /** @param {string} _toolCallId @param {{ ns: string; pod: string; container?: string; command: string[]; timeoutSeconds?: number }} params @param {AbortSignal | undefined} signal */
      async execute(_toolCallId, params, signal) {
        const timeoutSeconds = Math.min(Math.max(Math.round(params.timeoutSeconds ?? 30), 1), 120)
        const data = await safe(async () => {
          // 外层超时比 Go 侧宽 15s（Go 侧到点返回 502，这里只是兜底防挂死）
          const ctrl = new AbortController()
          const timer = setTimeout(
            () => ctrl.abort(new Error(`exec 超时（${timeoutSeconds + 15}s 未见响应）`)),
            (timeoutSeconds + 15) * 1000,
          )
          const any = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal
          try {
            const { status, body } = await postJson(
              '/exec',
              {
                cluster: cluster(),
                namespace: params.ns,
                pod: params.pod,
                container: params.container ?? '',
                command: params.command,
                timeoutSeconds,
              },
              any,
            )
            if (status >= 400) {
              const b = body && typeof body === 'object' ? /** @type {{ error?: string }} */ (body) : {}
              throw new Error(typeof b.error === 'string' ? b.error : `exec 请求失败（HTTP ${status}）`)
            }
            const r = /** @type {{ exitCode?: number; stdout?: string; stderr?: string }} */ (body)
            const stdout = typeof r.stdout === 'string' ? r.stdout : ''
            const stderr = typeof r.stderr === 'string' ? r.stderr : ''
            return {
              exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
              stdout:
                stdout.length > EXEC_STDOUT_LIMIT
                  ? `…(已截断，显示尾部 ${EXEC_STDOUT_LIMIT} 字符)\n${stdout.slice(-EXEC_STDOUT_LIMIT)}`
                  : stdout || '(无输出)',
              stderr:
                stderr.length > EXEC_STDERR_LIMIT
                  ? `…(已截断，显示尾部 ${EXEC_STDERR_LIMIT} 字符)\n${stderr.slice(-EXEC_STDERR_LIMIT)}`
                  : stderr,
            }
          } finally {
            clearTimeout(timer)
          }
        })
        return result(data)
      },
    },
  }
}
