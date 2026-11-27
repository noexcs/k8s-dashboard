// 节点 shell 的 helper Pod：特权容器 + hostPath 挂节点 rootfs（/host），exec 后切到节点命名空间。
// 对齐 kubernetes-sigs/kubectl-node-shell 的做法：Pod 本身只负责「落到节点上并活着」，
// 真正的进入动作由 exec 命令完成（nsenter 进 PID1 的命名空间，或退路 chroot /host）。
// 本文件只做请求与纯函数（命名/构造 spec/轮询判定），不含 UI 状态。
import { ApiError, deleteObject, get, list, podsPath, postObject } from '@/api/client'
import type { K8sObject } from '@/api/types'

/** 默认镜像：alpine 有 sh，且 chroot（busybox applet）可用 → chroot /host 退路总走得通。
 *  注意 alpine 不自带 nsenter（属 util-linux），默认 nsenter 方式会失败并在终端里报
 *  executable file not found，切「chroot /host」即可；离线集群换内网镜像同理。 */
export const DEFAULT_SHELL_IMAGE = 'alpine:latest'

/** 镜像候选：netshoot 自带 util-linux(nsenter) 与网络排查工具，进节点首选 */
export const SHELL_IMAGES = ['alpine:latest', 'nicolaka/netshoot:latest', 'busybox:latest']

/** 标签：按节点找回自己建过的 helper Pod（复用/销毁），不依赖带随机后缀的名字 */
const NODE_SHELL_LABEL = 'k8s-dashboard.io/node-shell'

const NAME_PREFIX = 'node-shell'
/** DNS-1123 label 上限 */
const MAX_NAME = 63
const RAND_LEN = 4

/** 进入节点：进 PID1 的 mount/pid/net/ipc/uts 命名空间（等价 kubectl debug node 的 --target 1） */
export const HOST_NSENTER_CMD = ['nsenter', '-t', '1', '-m', '-p', '-n', '-i', '-u', '--', '/bin/sh']
/** 退路：镜像里没有 nsenter（缺 util-linux）时，用挂载的 rootfs 直接 chroot */
export const HOST_CHROOT_CMD = ['chroot', '/host', '/bin/sh']
/** helper Pod 里只有一个容器 */
export const SHELL_CONTAINER = 'shell'

/** 节点名 → 合法 DNS-1123 片段：小写、非法字符转 '-'、去首尾 '-'、限长 */
function sanitizeSegment(raw: string, max: number): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  // 截断可能留下尾随 '-'，再清一次；全空给 'node' 兜底（名字不能为空段）
  const cut = s.slice(0, Math.max(max, 1)).replace(/-$/g, '')
  return cut || 'node'
}

/** 4 位随机后缀 [a-z0-9]，避免同一节点重复创建时名字撞车 */
function randomSuffix(len = RAND_LEN): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const buf = new Uint8Array(len)
  crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += chars[b % chars.length]
  return out
}

/** helper Pod 名：node-shell-<节点名清洗>-<4 位随机>，总长 ≤63 */
function nodeShellPodName(nodeName: string, rand = randomSuffix()): string {
  const budget = MAX_NAME - NAME_PREFIX.length - 1 - 1 - rand.length
  return `${NAME_PREFIX}-${sanitizeSegment(nodeName, budget)}-${rand}`
}

/** 标签值同样受限（≤63、首尾字母数字） */
function nodeShellLabelValue(nodeName: string): string {
  return sanitizeSegment(nodeName, MAX_NAME)
}

/** helper Pod 的 spec/status 字段面（api/types 的 Pod 只覆盖列表列读取的字段） */
interface NodeShellSpec {
  nodeName?: string
  hostPID?: boolean
  hostNetwork?: boolean
  restartPolicy?: string
  terminationGracePeriodSeconds?: number
  containers?: {
    name: string
    image: string
    command?: string[]
    securityContext?: { privileged?: boolean }
    volumeMounts?: { name: string; mountPath: string }[]
  }[]
  volumes?: { name: string; hostPath?: { path: string } }[]
  tolerations?: { operator: string }[]
}

interface NodeShellStatus {
  phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown'
  containerStatuses?: { name: string; ready?: boolean; state?: { waiting?: { reason?: string } } }[]
}

/** 读取形状（apiserver 已回填 metadata/status） */
export interface NodeShellPod extends K8sObject {
  spec?: NodeShellSpec
  status?: NodeShellStatus
}

/** 请求体形状：ObjectMeta 的 uid/resourceVersion/creationTimestamp 由 apiserver 回填，创建时只有 name+labels */
interface NodeShellPodBody {
  apiVersion: 'v1'
  kind: 'Pod'
  metadata: { name: string; labels: Record<string, string> }
  spec: NodeShellSpec
}

/**
 * 构造 helper Pod 清单（纯函数，便于单测/审阅）。
 * - hostPID：exec 才能看到/进入宿主 PID1；hostNetwork：看到宿主网卡（排查网络必需）。
 * - tolerations Exists：不加则 master/带污点节点调度不上，功能直接不可用。
 * - restartPolicy Never + grace 0：一次性 Pod，删掉即散，不产生重启噪音。
 */
function buildNodeShellPod(
  nodeName: string,
  opts: { name: string; image?: string },
): NodeShellPodBody {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: opts.name,
      labels: { [NODE_SHELL_LABEL]: nodeShellLabelValue(nodeName) },
    },
    spec: {
      nodeName,
      hostPID: true,
      hostNetwork: true,
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 0,
      containers: [
        {
          name: SHELL_CONTAINER,
          image: opts.image?.trim() || DEFAULT_SHELL_IMAGE,
          // 容器只负责活着：进入节点的动作交给 exec（HOST_NSENTER_CMD / HOST_CHROOT_CMD）。
          // 不在这里 nsenter——PID1 若是容器自身，exec 进去仍是容器命名空间。
          command: ['sh', '-c', 'while true; do sleep 3600; done'],
          securityContext: { privileged: true },
          volumeMounts: [{ name: 'host', mountPath: '/host' }],
        },
      ],
      volumes: [{ name: 'host', hostPath: { path: '/' } }],
      tolerations: [{ operator: 'Exists' }],
    },
  }
}

/** 按标签找回本节点仍未结束的 helper Pod（取最新一个；Terminating/已结束的不算，exec 不上去） */
export async function findNodeShellPod(
  cluster: string,
  ns: string,
  nodeName: string,
): Promise<NodeShellPod | null> {
  const res = await list<NodeShellPod>(cluster, podsPath(ns), {
    labelSelector: `${NODE_SHELL_LABEL}=${nodeShellLabelValue(nodeName)}`,
  })
  const alive = res.items.filter(p => {
    if (p.metadata.deletionTimestamp) return false
    // spec.nodeName 兜底：节点名过长时标签值被截断，可能串到同名前缀的别的节点
    if (p.spec?.nodeName && p.spec.nodeName !== nodeName) return false
    const phase = p.status?.phase ?? 'Pending'
    return phase !== 'Failed' && phase !== 'Succeeded'
  })
  alive.sort((a, b) => (a.metadata.creationTimestamp < b.metadata.creationTimestamp ? 1 : -1))
  return alive[0] ?? null
}

export async function getShellPod(cluster: string, ns: string, name: string): Promise<NodeShellPod> {
  return get<NodeShellPod>(cluster, `${podsPath(ns)}/${encodeURIComponent(name)}`)
}

/**
 * 创建 helper Pod。同名 409（重复点击/上次残留）→ 按标签找回既有 Pod 复用，不报错。
 * 找不到可复用的（比如撞到一个无关的同名 Pod）则原样抛出，让 UI 说清原因。
 */
export async function createNodeShellPod(
  cluster: string,
  ns: string,
  nodeName: string,
  opts?: { image?: string; name?: string },
): Promise<NodeShellPod> {
  const body = buildNodeShellPod(nodeName, {
    name: opts?.name ?? nodeShellPodName(nodeName),
    image: opts?.image,
  })
  try {
    // 请求体 metadata 只有 name+labels（uid/resourceVersion 等由 apiserver 回填），
    // 而 client 的 ObjectMeta 是全量形状 → 按仓库既有惯例（WorkloadDeployActions）断言一次
    return await postObject<NodeShellPod>(cluster, podsPath(ns), body as unknown as NodeShellPod)
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const found = await findNodeShellPod(cluster, ns, nodeName).catch(() => null)
      if (found) return found
    }
    throw err
  }
}

/** 销毁 helper Pod（grace 0：立即散） */
export function deleteNodeShellPod(cluster: string, ns: string, name: string): Promise<void> {
  return deleteObject(cluster, `${podsPath(ns)}/${encodeURIComponent(name)}`)
}

/** 等待中/失败的具体原因（ImagePullBackOff、CreateContainerConfigError…），UI 直接回显 */
export function shellPodWaitingReason(pod: NodeShellPod | null | undefined): string {
  const cs = pod?.status?.containerStatuses?.find(c => c.name === SHELL_CONTAINER) ?? pod?.status?.containerStatuses?.[0]
  return cs?.state?.waiting?.reason ?? ''
}
