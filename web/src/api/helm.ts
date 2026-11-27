// Helm API 客户端。同源：/clusters/:cluster/helm/…（vite 开发期经 proxy 转发）。
//
// 后端契约（实测 2026-11-18，backend/README.md 的 --enable-helm 启动方式）：
// 路由注册见 backend/cmd/headlamp.go handleClusterHelm —— 仅 `--enable-helm` 启动时注册；
// 外层套 auth.NewBackendTokenMiddleware(useInCluster)：
//   - in-cluster 模式 → 直接放行；
//   - standalone 模式 + 环境变量 HEADLAMP_BACKEND_TOKEN 非空 → 请求必须带
//     `X-HEADLAMP_BACKEND-TOKEN: <token>` 头（桌面 app 注入），否则 403。
//   - 本地开发（无该 env）→ 无鉴权。
//
// 端点（clusterName = kubeconfig context 名）：
// | 方法/路径（/clusters/{c}/helm 前缀下） | 参数 | 响应 |
// |---|---|---|
// | GET  /releases/list | query: allNamespaces, namespace, all, byDate, limit, offset, filter, uninstalled, superseded, uninstalling, deployed, failed, pending（bool 传 "true"/"false"） | 200 {"releases": Release[]}；Short 列表（无 values 字段，manifest 有值） |
// | GET  /releases | query: name, namespace（均必填） | 200 Release（含 manifest/values/config）；404 不存在 |
// | GET  /release/history | query: name, namespace | 200 {"releases": Release[]}（旧→新，含 superseded） |
// | DELETE /releases/uninstall | query: name, namespace | 202 {"message":"uninstall request accepted"}（异步） |
// | PUT  /releases/rollback | body JSON: {name, namespace, revision(int)} | 202 {"message":"rollback request accepted"}（异步） |
// | PUT  /releases/upgrade | body JSON: {name, namespace, description, values, chart, version} | 202（异步） |
// | POST /release/install | body JSON: {name, namespace, description, values, chart, version, createNamespace, dependencyUpdate} | 202（异步） |
// 注：install/upgrade 的 values 后端按 base64 解码（release.go base64.StdEncoding），
//     调用方按契约传 YAML 字符串，本文件负责编码；description 后端 validate:"required"，必须非空。
// | GET  /charts?filter= | | 200 {"charts":[{name,description,version,appVersion,repository}]}（未添加任何仓库时 500） |
// | GET  /repositories | | 200 {"repositories":[{name,url}]} |
// | POST /repositories | body {name,url,username?,password?,insecureSkipTLSverify?,passCredentialsAll?} | 200（同名=替换并保留凭据；同步下载索引） |
// | PUT  /repositories/update | 同 add 的 body | 200（只改条目，**不**重新下载索引） |
// | DELETE /repositories/remove | query: name | 200；不存在 404 |
// | GET  /action/status | query: name, action∈{install,upgrade,uninstall,rollback} | 202 {"status":"processing"\|"success"\|"failed","message"?}；状态缓存 TTL 20min |
//
// Release JSON = helm.sh/helm/v3/pkg/release.Release：
// {name, version(int 修订号), namespace, chart:{metadata:{name,version,appVersion…}},
//  info:{first_deployed?, last_deployed?, deleted?, description, status}, manifest, values, config, notes?, hooks?}
// status ∈ deployed|uninstalled|failed|superseded|uninstalling|pending-install|pending-upgrade|pending-rollback
//
// 注意：list/get/history 同步打到 apiserver，tailnet 抖动时可能 30–65s；
// 变更操作 202 秒回、后台执行，前端轮询 /action/status。故超时一律放宽到 120s。

import { t, tf } from '@/i18n'
import { auditExtra } from './client'

const BASE_TIMEOUT_MS = 120_000

type HelmReleaseStatus =
  | 'unknown'
  | 'deployed'
  | 'uninstalled'
  | 'failed'
  | 'superseded'
  | 'uninstalling'
  | 'pending-install'
  | 'pending-upgrade'
  | 'pending-rollback'

interface HelmReleaseInfo {
  first_deployed?: string
  last_deployed?: string
  deleted?: string
  description?: string
  status?: HelmReleaseStatus
}

interface HelmChartMeta {
  name: string
  version: string
  appVersion?: string
  description?: string
  [k: string]: unknown
}

export interface HelmRelease {
  name: string
  /** 修订号（从 1 递增） */
  version: number
  namespace: string
  chart: { metadata: HelmChartMeta }
  info: HelmReleaseInfo
  /** 渲染后的完整 YAML（多文档）；list（Short）模式也有值 */
  manifest: string
  /** 有效 values（chart 默认 + 用户覆盖合并后）；list 模式下为 null */
  values: Record<string, unknown> | null
  /** 用户显式覆盖的 values（helm --values）；可能为空对象 */
  config?: Record<string, unknown>
  notes?: string
  hooks?: unknown[]
}

export interface HelmListParams {
  /** 列全部命名空间（默认 true；false 时按 namespace 过滤） */
  allNamespaces?: boolean
  namespace?: string
  /** 含 superseded/uninstalled 等全部状态 */
  all?: boolean
  byDate?: boolean
  limit?: number
  offset?: number
  filter?: string
  uninstalled?: boolean
  superseded?: boolean
  uninstalling?: boolean
  deployed?: boolean
  failed?: boolean
  pending?: boolean
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function withTimeout(ms: number): Promise<{ signal: AbortSignal; dispose: () => void }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error(t('sys:timeout'))), ms)
  return { signal: ctrl.signal, dispose: () => clearTimeout(timer) }
}

async function req<T>(cluster: string, path: string, init?: RequestInit): Promise<T> {
  const { signal, dispose } = await withTimeout(BASE_TIMEOUT_MS)
  try {
    const res = await fetch(`/clusters/${encodeURIComponent(cluster)}/helm${path}`, {
      ...init,
      signal,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    })
    const text = await res.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    if (!res.ok) {
      const msg =
        typeof body === 'string' && body
          ? body
          : body !== null && typeof body === 'object' && 'message' in body
            ? String(body.message)
            : tf('sys:httpStatus', { n: res.status })
      throw new HttpError(res.status, msg)
    }
    return body as T
  } finally {
    dispose()
  }
}

function qs(params: Record<string, string | boolean | number | undefined>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== false && v !== '') usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

/** 列出 releases。allNamespaces 缺省 true。tailnet 慢，调用方需容忍 30–65s。 */
export function listReleases(cluster: string, params: HelmListParams = {}): Promise<{ releases: HelmRelease[] }> {
  const allNamespaces = params.allNamespaces ?? true
  return req<{ releases: HelmRelease[] }>(
    cluster,
    `/releases/list${qs({ ...params, allNamespaces })}`,
  )
}

/** 单个 release 详情（含 manifest + values）。404 → HttpError(404)。 */
export function getRelease(cluster: string, namespace: string, name: string): Promise<HelmRelease> {
  return req<HelmRelease>(cluster, `/releases${qs({ name, namespace })}`)
}

/** 修订历史（旧→新）。 */
export function getReleaseHistory(cluster: string, namespace: string, name: string): Promise<{ releases: HelmRelease[] }> {
  return req<{ releases: HelmRelease[] }>(cluster, `/release/history${qs({ name, namespace })}`)
}

/** 卸载（异步：202 秒回，后续轮询 actionStatus）。 */
export function uninstallRelease(cluster: string, namespace: string, name: string): Promise<{ message: string }> {
  return req<{ message: string }>(cluster, `/releases/uninstall${qs({ name, namespace })}`, { method: 'DELETE' }).then(r => {
    auditExtra(cluster, 'helm-uninstall', `${namespace}/${name}`, 'Helm 卸载（异步受理）', 'HelmRelease')
    return r
  })
}

/** 回滚到指定修订（异步）。 */
export function rollbackRelease(
  cluster: string,
  namespace: string,
  name: string,
  revision: number,
): Promise<{ message: string }> {
  return req<{ message: string }>(cluster, '/releases/rollback', {
    method: 'PUT',
    body: JSON.stringify({ name, namespace, revision }),
  }).then(r => {
    auditExtra(cluster, 'helm-rollback', `${namespace}/${name}`, `Helm 回滚到 revision ${revision}（异步受理）`, 'HelmRelease')
    return r
  })
}

/**
 * 后端 release.go 对 install/upgrade 的 values 执行 base64.StdEncoding.DecodeString，
 * 直接发 YAML 会解码失败 → 状态 failed。调用方按契约传 YAML，这里统一编码（空串保持空）。
 */
function encodeValues(yaml: string | undefined): string {
  if (!yaml || !yaml.trim()) return ''
  // btoa 只吃 latin1；values 里的中文注释要先 UTF-8 转字节
  const bytes = new TextEncoder().encode(yaml)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * 升级（异步）。chart/version 为仓库内坐标（如 bitnami/busybox、1.x.y）。
 * values = YAML override（内部 base64 编码；空 = 保留上次 override）。
 * description 后端 validate:"required"，必须非空，故给默认值。
 */
export function upgradeRelease(
  cluster: string,
  body: { name: string; namespace: string; chart: string; version: string; description?: string; values?: string },
): Promise<{ message: string }> {
  return req<{ message: string }>(cluster, '/releases/upgrade', {
    method: 'PUT',
    body: JSON.stringify({
      description: 'Upgrade with K8S Dashboard',
      ...body,
      values: encodeValues(body.values),
    }),
  }).then(r => {
    auditExtra(cluster, 'helm-upgrade', `${body.namespace}/${body.name}`, `Helm 升级 ${body.chart}@${body.version}（异步受理）`, 'HelmRelease')
    return r
  })
}

/**
 * 安装（异步）。values = YAML override（内部 base64 编码）。
 * description 后端 validate:"required"，必须非空，故给默认值。
 */
export function installRelease(
  cluster: string,
  body: {
    name: string
    namespace: string
    chart: string
    version: string
    description?: string
    values?: string
    createNamespace?: boolean
    dependencyUpdate?: boolean
  },
): Promise<{ message: string }> {
  return req<{ message: string }>(cluster, '/release/install', {
    method: 'POST',
    body: JSON.stringify({
      description: 'Install with K8S Dashboard',
      createNamespace: false,
      dependencyUpdate: false,
      ...body,
      values: encodeValues(body.values),
    }),
  }).then(r => {
    auditExtra(cluster, 'helm-install', `${body.namespace}/${body.name}`, `Helm 安装 ${body.chart}（异步受理）`, 'HelmRelease')
    return r
  })
}

// ---------- 仓库 / 图表 ----------

/** listCharts 返回的一行 = 某 repo 内某 chart 的某版本（跨 repo 同名会多行，调用方按 name 聚合） */
export interface HelmChartSummary {
  name: string
  description: string
  version: string
  appVersion: string
  /** 所属仓库名（install 的 chart 坐标 = `${repository}/${name}`） */
  repository: string
}

export interface HelmRepository {
  name: string
  url: string
}

/** POST/PUT /repositories 的 body（可选字段后端是指针：省略=不动，别传 null 以外的假值） */
export interface HelmRepoRequest {
  name: string
  url: string
  username?: string
  password?: string
  insecureSkipTLSverify?: boolean
  passCredentialsAll?: boolean
}

/**
 * 列出已添加仓库的索引里的全部 chart 版本。
 * 注意：一个仓库都没加（或索引缺失）时后端 500，调用方需引导去 Repositories，不能裸抛。
 */
export function listCharts(cluster: string, filter?: string): Promise<{ charts: HelmChartSummary[] }> {
  return req<{ charts: HelmChartSummary[] }>(cluster, `/charts${qs({ filter })}`)
}

/** 列出已添加的 helm 仓库。 */
export function listRepos(cluster: string): Promise<{ repositories: HelmRepository[] }> {
  return req<{ repositories: HelmRepository[] }>(cluster, '/repositories')
}

/**
 * 添加仓库（后端同步下载索引 → tailnet 慢时可能几十秒，超时同 120s）。
 * 同名 = 替换条目并保留服务端凭据。
 */
export function addRepo(cluster: string, body: HelmRepoRequest): Promise<{ message: string }> {
  return req<{ message: string }>(cluster, '/repositories', { method: 'POST', body: JSON.stringify(body) }).then(r => {
    auditExtra(cluster, 'helm-repo-add', body.name, 'Helm 仓库条目新增/替换', 'HelmRepository')
    return r
  })
}

/** 删除仓库（仅删配置条目，不动已装 release）。不存在 → HelmHttpError(404)。 */
export function removeRepo(cluster: string, name: string): Promise<void> {
  return req<void>(cluster, `/repositories/remove${qs({ name })}`, { method: 'DELETE' }).then(r => {
    auditExtra(cluster, 'helm-repo-remove', name, 'Helm 仓库条目删除', 'HelmRepository')
    return r
  })
}

export type HelmAction = 'install' | 'upgrade' | 'uninstall' | 'rollback'

export interface HelmActionStatus {
  /** processing | success | failed（无记录时后端 500） */
  status: 'processing' | 'success' | 'failed'
  message?: string
}

/** 查询异步操作状态。操作刚触发前无记录 → HttpError(500)，调用方按 processing 处理。 */
function actionStatus(cluster: string, name: string, action: HelmAction): Promise<HelmActionStatus> {
  return req<HelmActionStatus>(cluster, `/action/status${qs({ name, action })}`)
}

/**
 * 轮询 actionStatus 直到 success/failed（或超时）。
 * 3s 间隔；timeoutMs 内未完成 reject。
 */
export async function waitForAction(
  cluster: string,
  name: string,
  action: HelmAction,
  timeoutMs = 5 * 60_000,
  onPoll?: (s: HelmActionStatus) => void,
): Promise<HelmActionStatus> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let s: HelmActionStatus
    try {
      s = await actionStatus(cluster, name, action)
    } catch (e) {
      // 状态尚未写入（缓存未命中）→ 视作 processing
      if (e instanceof HttpError && e.status === 500) {
        s = { status: 'processing' }
      } else {
        throw e
      }
    }
    onPoll?.(s)
    if (s.status === 'success' || s.status === 'failed') return s
    // 文案随实际 timeoutMs（默认 5 分钟）动态生成，避免文案与默认值漂移
    if (Date.now() > deadline) throw new Error(tf('sys:actionTimeout', { n: Math.round(timeoutMs / 60_000) }))
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 3000)
    await promise
  }
}

export { HttpError as HelmHttpError }
