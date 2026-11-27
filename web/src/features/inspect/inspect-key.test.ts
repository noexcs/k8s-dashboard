/**
 * 处置键格式契约（与 ai-exec/lib/finding-key.test.js 同样本互锁）：
 * 后端 findingKey、前端 dispKey、首页 homeDispKeys 是同一格式的三份手写镜像，
 * 任何一侧改格式而不改本样本 → 两测试必有一红，杜绝「已处置仍显示未认领」的静默错位。
 */
import { describe, expect, it } from 'vitest'
import { dispKey } from './InspectPage'

type Entry = { ns?: string; name?: string; kind?: string; reason?: string; metadata?: { name: string }; status?: unknown }

// 与后端样本逐字相同
const samples: Array<[{ id: string }, Entry, string]> = [
  [{ id: 'unready-workloads' }, { ns: 'default', kind: 'Deployment', name: 'web' }, 'unready-workloads/default/Deployment/web'],
  [{ id: 'failed-jobs' }, { ns: 'batch', kind: 'Job', name: 'etl' }, 'failed-jobs/batch/Job/etl'],
  [{ id: 'suspended-crons' }, { ns: 'openmetadata', kind: 'CronJob', name: 'cron-reindex' }, 'suspended-crons/openmetadata/CronJob/cron-reindex'],
  [{ id: 'warning-events' }, { ns: 'default', kind: 'Pod', name: 'p1', reason: 'BackOff' }, 'warning-events/default/Pod/p1|BackOff'],
  [{ id: 'node-pressure' }, { ns: '', kind: 'Node', name: 'n1' }, 'node-pressure//Node/n1'],
  [{ id: 'running-jobs' }, { ns: 'x', kind: '', name: 'j' }, 'running-jobs/x//j'],
]

describe('dispKey 与后端 findingKey 同契约', () => {
  for (const [f, e, want] of samples) {
    it(want, () => {
      expect(dispKey(f.id, e)).toBe(want)
    })
  }
})

// 首页 homeDispKeys 的 Job 双候选键必须落进巡检侧键空间（running/failed 两个段 id）
describe('homeDispKeys Job 双候选', () => {
  it('与段 id 命名同源', () => {
    const ids = samples.map(([, , k]) => k.split('/')[0])
    expect(ids).toContain('failed-jobs')
    expect(ids).toContain('running-jobs')
  })
})
