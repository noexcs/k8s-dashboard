// nsq 字典：命名空间 ResourceQuota 用量 chip（components/NsQuotaChip.tsx）。ns = nsq
import type { Entry } from './strings'

export const STRINGS_NSQ: Record<string, Entry> = {
  'nsq:noQuota': { zh: '无配额', en: 'No quota' },
  'nsq:loading': { zh: '正在读取命名空间配额…', en: 'Loading namespace quota…' },

  // 指标名（芯片内极小字号，中文保持短词）
  'nsq:metricCpu': { zh: 'CPU', en: 'CPU' },
  'nsq:metricMemory': { zh: '内存', en: 'Mem' },
  'nsq:metricPods': { zh: 'Pod 数', en: 'Pods' },

  // 悬停提示：整颗芯片 + 单个指标行
  'nsq:chipTitle': {
    zh: '{ns} 的资源配额用量，点击查看 ResourceQuota',
    en: 'Resource quota usage in {ns}; click to open ResourceQuota',
  },
  'nsq:noQuotaTitle': {
    zh: '{ns} 未设置 ResourceQuota',
    en: 'No ResourceQuota set in {ns}',
  },
  'nsq:metricTitle': {
    zh: '{label} {key}：{used} / {hard}（{pct}%）',
    en: '{label} {key}: {used} / {hard} ({pct}%)',
  },

  // ns 快切下拉
  'nsq:switchNs': { zh: '切换命名空间', en: 'Switch namespace' },
  'nsq:switchHint': {
    zh: '在当前页面切换到其它命名空间',
    en: 'Switch to another namespace on this page',
  },

  // 无障碍标签
  'nsq:openQuota': {
    zh: '查看 {ns} 的资源配额',
    en: 'View resource quota of {ns}',
  },
}
