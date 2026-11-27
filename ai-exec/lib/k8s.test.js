// assertClusterPath 回归测试：R2 复审（FeatureAuditR2）攻击判定表逐条固化为
// 测试用例——白名单被 WHATWG 点段规整 + undici 的 %2e 解码/反斜杠归一实测绕过过
// 两轮，任何"简化"这段检查的改动必须先过这里。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assertClusterPath } from './k8s.js'

const REJECT = [
  // 点段逃出 /clusters/{c}/ 代理前缀（R1 修的就是这组）
  '/clusters/prod/../../config',
  '/api/../config',
  '/apis/../exec',
  '/api/./v1',
  '/api//v1',
  '/apis/x/../secrets',
  // 非 API 前缀
  '/config',
  '/exec',
  '/plugins',
  'api/v1',
  '/apiv1',
  '/apisx/v1',
  '/helmx',
  // 编码绕过（R2 判定表 #3-#6：fetch 发送时先解 %xx、把 \ 当 /）
  '/api/%2e%2e/config',
  '/api/%2E%2E/exec',
  '/api/..%2fconfig',
  '/api\\..\\config',
  '/api/%2e/v1',
  // 归一化后才违规（原始串看着合法）
  '/api/v1/namespaces/default/pods/..%2F..%2Fsecrets',
]

const ALLOW = [
  '/api',
  '/api/v1',
  '/api/v1/namespaces/default/pods',
  '/apis/apps/v1/namespaces/default/deployments',
  '/apis/apiextensions.k8s.io/v1/customresourcedefinitions',
  '/helm/releases',
  '/helm/repos',
  '/api/v1/namespaces/default/pods/nginx-1.labels尾.',
  // query 里允许编码（只约束路径段）
  '/api/v1/pods?labelSelector=app%3Dweb',
  '/apis/apps/v1/deployments?fieldSelector=metadata.name%3Dweb',
]

test('assertClusterPath 拒绝全部攻击判定表变体', () => {
  for (const p of REJECT) {
    assert.throws(() => assertClusterPath(p), /apiPath/, `应拒绝: ${p}`)
  }
})

test('assertClusterPath 放行合法 k8s/helm 透传路径', () => {
  for (const p of ALLOW) {
    assert.doesNotThrow(() => assertClusterPath(p), `应放行: ${p}`)
  }
})
