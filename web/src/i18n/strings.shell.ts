// shell 字典：节点 shell（helper Pod + 复用 Pod 终端）。ns = shell
import type { Entry } from './strings'

export const STRINGS_SHELL: Record<string, Entry> = {
  'shell:tab': { zh: 'Shell', en: 'Shell' },

  // ---- 警示条 ----
  'shell:warnTitle': { zh: '高危：在节点上以 root 执行命令', en: 'High risk: commands run as root on the node' },
  'shell:warnBody': {
    zh: '本功能在目标节点创建一个特权 Pod（hostPID + hostNetwork + 挂载节点根文件系统到 /host），随后 exec 进入宿主命名空间。你输入的任何命令都以 root 权限影响整个节点（含其他租户的 Pod、kubelet、容器运行时）。',
    en: 'This creates a privileged Pod on the target node (hostPID + hostNetwork, with the node root filesystem mounted at /host) and then execs into the host namespaces. Every command you type runs as root over the whole node, including other tenants\' Pods, kubelet and the container runtime.',
  },
  'shell:warnLifecycle': {
    zh: '会话仅存在于 helper Pod 运行期间：删除 Pod 即结束，不会在节点上留下进程。切走本 tab 只断开终端连接，helper Pod 本身不会随页面关闭而删除——用完请点「销毁」。',
    en: 'The session lives only while the helper Pod runs: deleting the Pod ends it and leaves no process on the node. Leaving this tab only drops the terminal connection — the Pod is NOT deleted when you leave the page. Press "Destroy" when you are done.',
  },
  'shell:warnPerm': {
    zh: '需要目标命名空间的 create pods 权限，且该命名空间允许 privileged 容器（PSA=privileged 或 PSP/准入策略放行）；否则 Pod 会停在 Pending 或被直接拒绝。',
    en: 'Requires create pods in the target namespace plus permission to run privileged containers (PSA=privileged or a permissive PSP/admission policy); otherwise the Pod is rejected or stuck in Pending.',
  },

  // ---- 表单 ----
  'shell:namespace': { zh: '命名空间', en: 'Namespace' },
  'shell:image': { zh: 'helper 镜像', en: 'Helper image' },
  'shell:imageHint': {
    zh: '离线集群请换成内网可用的镜像；镜像内需有 sh，nsenter（util-linux）缺失时请用下方 chroot 方式。',
    en: 'Air-gapped clusters: use an image from your registry. It needs sh; if nsenter (util-linux) is missing, use the chroot mode below.',
  },
  'shell:create': { zh: '创建并连接', en: 'Create & connect' },
  'shell:creating': { zh: '创建中…', en: 'Creating…' },
  'shell:created': { zh: 'helper Pod 已创建：{name}', en: 'Helper Pod created: {name}' },
  'shell:reused': { zh: '复用已存在的 helper Pod：{name}', en: 'Reusing existing helper Pod: {name}' },
  'shell:createFailed': { zh: '创建失败：{msg}', en: 'Create failed: {msg}' },

  // ---- helper Pod 状态 ----
  'shell:helper': { zh: 'helper Pod', en: 'Helper Pod' },
  'shell:noHelper': { zh: '当前命名空间没有本节点的 helper Pod', en: 'No helper Pod for this node in the current namespace' },
  'shell:gone': {
    zh: '已被删除（可能在本页面之外），点「创建并连接」重来',
    en: 'was deleted (possibly outside this page) — press "Create & connect" to start over',
  },
  'shell:waiting': { zh: '等待容器就绪（{phase}{reason}）…', en: 'Waiting for the container (phase {phase}{reason})…' },
  'shell:reasonSep': { zh: '，原因：', en: ', reason: ' },
  'shell:waitTimeout': {
    zh: '超过 60 秒仍未 Running。多半是镜像拉不下来、或节点污点/PSA 拒绝特权容器——删除它换个镜像重试，细节看 helper Pod 的事件。',
    en: 'Still not Running after 60s. Usually an image pull failure, or a node taint / PSA policy refusing privileged containers. Destroy it and retry with another image; check the helper Pod events.',
  },

  // ---- 终端 ----
  'shell:mode': { zh: '进入方式', en: 'Enter mode' },
  'shell:modeNsenter': { zh: 'nsenter 宿主', en: 'nsenter host' },
  'shell:modeChroot': { zh: 'chroot /host', en: 'chroot /host' },
  'shell:modeHint': {
    zh: 'nsenter 进入 PID 1 的命名空间（完整宿主视图）；镜像里没有 nsenter 时改用 chroot /host（仅文件系统，进程/网络仍是容器视角）。',
    en: 'nsenter joins PID 1 namespaces (full host view); if the image has no nsenter, use chroot /host (filesystem only — processes and network stay in the container view).',
  },

  // ---- 销毁 ----
  'shell:destroy': { zh: '销毁', en: 'Destroy' },
  'shell:destroying': { zh: '销毁中…', en: 'Destroying…' },
  'shell:destroyTitle': { zh: '销毁 helper Pod {name}？', en: 'Destroy helper Pod {name}?' },
  'shell:destroyDesc': {
    zh: '终端会话立即中断，节点上不再留有该 Pod。grace period 为 0，删除是立即的。',
    en: 'The terminal session ends immediately and the Pod is gone from the node. The grace period is 0, so deletion is immediate.',
  },
  'shell:destroyed': { zh: 'helper Pod 已销毁：{name}', en: 'Helper Pod destroyed: {name}' },
  'shell:cancel': { zh: '取消', en: 'Cancel' },
}
