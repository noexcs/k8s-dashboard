// cron 字典：CronJob 头部动作（暂停/恢复调度、手动触发一次）。ns = cron
import type { Entry } from '@/i18n/strings'

export const STRINGS_CRON: Record<string, Entry> = {
  'cron:suspend': { zh: '暂停', en: 'Suspend' },
  'cron:resume': { zh: '恢复', en: 'Resume' },
  'cron:suspendDone': { zh: '已暂停调度', en: 'Scheduling suspended' },
  'cron:resumeDone': { zh: '已恢复调度', en: 'Scheduling resumed' },
  'cron:trigger': { zh: '立即触发', en: 'Trigger now' },
  'cron:triggering': { zh: '创建中…', en: 'Creating…' },
  'cron:triggerDone': { zh: '已创建手动 Job {job}', en: 'Created manual Job {job}' },
  'cron:viewJob': { zh: '查看 Job', en: 'View Job' },
  'cron:noJobTemplate': {
    zh: '该 CronJob 缺少 spec.jobTemplate，无法手动触发',
    en: 'This CronJob has no spec.jobTemplate; cannot trigger manually',
  },
}
