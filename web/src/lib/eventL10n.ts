// 事件/条件枚举值的中文化：reason/type 是集群生成的枚举（不是 UI 文案），
// 常见值查表显示中文，未知值原样显示；message 永远是集群原文，不翻译。
import type { Lang } from '@/i18n'

const TYPE: Record<string, string> = { Normal: '正常', Warning: '警告' }

// k8s 核心 + 常见 controller/插件的事件 reason（按出现频率整理，未收录的回退原文）
const REASON_ZH: Record<string, string> = {
  Scheduled: '调度成功',
  FailedScheduling: '调度失败',
  FailedBinding: '绑定失败',
  Pulling: '拉取镜像中',
  Pulled: '镜像已拉取',
  ErrImagePull: '镜像拉取失败',
  ImagePullBackOff: '镜像拉取退避',
  Created: '容器已创建',
  Started: '容器已启动',
  Killing: '正在终止容器',
  Killed: '容器已终止',
  ExceededGracePeriod: '超过优雅终止期',
  Unhealthy: '健康检查失败',
  ProbeWarning: '探针警告',
  BackOff: '退避重试',
  Failed: '操作失败',
  FailedCreatePodSandBox: '创建 Pod 沙箱失败',
  SandboxChanged: '沙箱已重建',
  FailedMount: '挂载卷失败',
  FailedAttachVolume: '挂载卷失败',
  FailedDetachVolume: '卸载卷失败',
  VolumeBinding: '卷绑定中',
  ExternalProvisioning: '卷外部供给中',
  ProvisioningSucceeded: '卷供给成功',
  ProvisioningFailed: '卷供给失败',
  Evicted: '已驱逐',
  Preempted: '被抢占',
  OOMKilling: '内存超限终止',
  OOMKilled: '内存超限终止',
  NodeNotReady: '节点未就绪',
  NodeUnavailable: '节点不可用',
  Rebooted: '节点已重启',
  RegisterNodeWithControlPlane: '节点已注册到控制面',
  ListImages: '枚举镜像',
  FreeDiskSpaceFailed: '磁盘清理失败',
  ScalingReplicaSet: '副本集伸缩',
  SuccessfulCreate: '创建成功',
  SuccessfulDelete: '删除成功',
  SuccessfulCreatePod: 'Pod 创建成功',
  Deployed: '已部署',
  Deploy: '部署中',
  Synced: '已同步',
  Sync: '同步中',
  Reconcile: '已协调',
  Available: '已可用',
  Progressing: '进行中',
  ReplicaFailure: '副本异常',
  Mirrored: '已镜像',
  GarbageCollected: '已垃圾回收',
  ObjectIsInUse: '对象使用中',
}

/** 事件 type（Normal/Warning）中文标签 */
export function eventTypeLabel(type: string, lang: Lang): string {
  return lang === 'zh' ? (TYPE[type] ?? type) : type
}

/** 事件/条件 reason 中文标签；未知 reason 回退原文 */
export function eventReasonLabel(reason: string | undefined, lang: Lang): string | undefined {
  if (!reason) return reason
  return lang === 'zh' ? (REASON_ZH[reason] ?? reason) : reason
}
