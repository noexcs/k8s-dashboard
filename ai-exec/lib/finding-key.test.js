// @ts-check
/**
 * 处置键格式契约测试：后端 findingKey 与前端 dispKey/homeDispKeys 是同一格式的手写镜像，
 * 漂移不会报错、只会让「已处置项仍在待办、复发角标永远不亮」——值班台账静默错位。
 * 本测试钉死格式样本；前端 vitest（inspect-key.test.ts）用同样本断言，任一侧改动都会红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingKey } from './inspect.js'

const samples = /** @type {const} */ ([
  [{ id: 'unready-workloads' }, { ns: 'default', kind: 'Deployment', name: 'web' }, 'unready-workloads/default/Deployment/web'],
  [{ id: 'failed-jobs' }, { ns: 'batch', kind: 'Job', name: 'etl' }, 'failed-jobs/batch/Job/etl'],
  [{ id: 'suspended-crons' }, { ns: 'openmetadata', kind: 'CronJob', name: 'cron-reindex' }, 'suspended-crons/openmetadata/CronJob/cron-reindex'],
  [{ id: 'warning-events' }, { ns: 'default', kind: 'Pod', name: 'p1', reason: 'BackOff' }, 'warning-events/default/Pod/p1|BackOff'],
  [{ id: 'node-pressure' }, { ns: '', kind: 'Node', name: 'n1' }, 'node-pressure//Node/n1'],
  [{ id: 'running-jobs' }, { ns: 'x', kind: '', name: 'j' }, 'running-jobs/x//j'],
])

for (const [f, e, want] of samples) {
  test(`findingKey ${want}`, () => {
    assert.equal(findingKey(f, e), want)
  })
}
