// aictx 字典：AI 聊天「当前页面资源」上下文条 + 消息注入行 + FAB 徽标提示 + 空会话引导 chips。
// ns = aictx（AiChat 既有文案在 ai ns 不动，见 strings.ai.ts）
import type { Entry } from './strings'

export const STRINGS_AICTX: Record<string, Entry> = {
  // ---- 上下文条（输入框上方） ----
  'aictx:barLabel': { zh: '上下文', en: 'Context' },
  'aictx:dismiss': { zh: '本会话忽略此资源', en: 'Ignore this resource for the session' },

  // ---- 发送时拼进用户消息首行的注入文本（用户可见可编辑，非隐藏 system 注入） ----
  'aictx:injectLine': {
    zh: '参考上下文：{kind} {ref}（请先用工具查看该资源再回答）',
    en: 'Reference context: {kind} {ref} (inspect this resource with tools before answering)',
  },

  // ---- FAB 徽标：悬浮按钮提示将携带当前页面资源 ----
  'aictx:fabCarries': {
    zh: '将携带当前页面资源：{kind}',
    en: 'Will carry the current page resource: {kind}',
  },

  // ---- 空会话引导 chips（点击即作为消息发送，随上下文注入行一并带上） ----
  'aictx:chipPodRestarts': { zh: '这个 Pod 为什么在重启？', en: 'Why is this pod restarting?' },
  'aictx:chipPodLogs': { zh: '看看它最近的日志', en: 'Show its recent logs' },
  'aictx:chipPodOwner': { zh: '它属于哪个工作负载？', en: 'Which workload owns it?' },
  'aictx:chipPodEvents': { zh: '它最近有什么事件？', en: 'Any recent events for it?' },

  'aictx:chipDeployStuck': { zh: '发布卡住了吗？', en: 'Is the rollout stuck?' },
  'aictx:chipDeployHistory': {
    zh: '最近一次 rollout 改了什么？',
    en: 'What changed in the last rollout?',
  },
  'aictx:chipDeployPods': { zh: '它的 Pod 都正常吗？', en: 'Are all of its pods healthy?' },

  'aictx:chipStsStuck': { zh: '它启动或调度卡住了吗？', en: 'Is it stuck starting or scheduling?' },
  'aictx:chipStsPods': { zh: '它的 Pod 状态如何？', en: 'What is the status of its pods?' },
  'aictx:chipStsPvc': { zh: '它绑定的 PVC 正常吗？', en: 'Are its bound PVCs healthy?' },

  'aictx:chipSvcEndpoints': { zh: '后端 Endpoint 就绪吗？', en: 'Are the backend endpoints ready?' },
  'aictx:chipSvcPods': { zh: '它关联的 Pod 正常吗？', en: 'Are its backing pods healthy?' },

  'aictx:chipNodeLoad': { zh: '这个节点的资源水位如何？', en: 'What are this node\u2019s CPU/memory levels?' },
  'aictx:chipNodePods': { zh: '这个节点上有哪些 Pod？', en: 'Which pods run on this node?' },
  'aictx:chipNodeIssues': { zh: '节点有什么异常状况？', en: 'Any abnormal conditions on this node?' },

  'aictx:chipHelmStatus': { zh: '这个 Release 状态正常吗？', en: 'Is this release healthy?' },
  'aictx:chipHelmHistory': { zh: '它的发布历史是什么？', en: 'What is its release history?' },
  'aictx:chipHelmValues': {
    zh: '它当前的 values 有哪些覆盖？',
    en: 'What values overrides does it currently have?',
  },

  // ---- 未命中 kind 的通用兜底 ----
  'aictx:chipDefaultIssues': {
    zh: '帮我看看这个 {kind} 有什么问题',
    en: 'Check what\u2019s wrong with this {kind}',
  },
  'aictx:chipDefaultEvents': {
    zh: '检查它的状态和最近事件',
    en: 'Check its status and recent events',
  },

  // ---- 无上下文（列表页/dashboard）的集群级通用问题 ----
  'aictx:chipGeneralHealth': { zh: '集群整体健康？', en: 'Is the cluster healthy overall?' },
  'aictx:chipGeneralCrashloop': { zh: '哪些 Pod 在 CrashLoop？', en: 'Which pods are in CrashLoop?' },
  'aictx:chipGeneralEvents': { zh: '最近有什么 Warning 事件？', en: 'Any recent Warning events?' },
}
