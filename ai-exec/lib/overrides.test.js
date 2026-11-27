// @ts-check
/**
 * 设置页覆盖层契约：LLM 三键进了白名单后，「保存即生效/还原回 env/校验拒绝」
 * 是配置链路的承重墙——写坏一个语义（比如空串当还原）会让网关静默变空、AI 全体 404。
 * 隔离 dataDir 跑，不碰真实卷。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PI_DATA_DIR = mkdtempSync(join(tmpdir(), 'kcts-overrides-'))
const { writeOverrides, readOverrides, effective } = await import('./overrides.js')

test('LLM 三键写入后 effective 返回覆盖值，env 保留在 config 底座', () => {
  const r = writeOverrides({ llmGatewayBase: 'https://gw.example.com/v1/', llmApiKey: 'sk-test', llmModel: 'MyModel-7B' })
  assert.equal(r.ok, true)
  assert.equal(effective('llmGatewayBase'), 'https://gw.example.com/v1') // 尾斜杠被规范化
  assert.equal(effective('llmApiKey'), 'sk-test')
  assert.equal(effective('llmModel'), 'MyModel-7B')
})

test('非法值整体拒绝：非 http(s) 网关 / 空模型名 / 带空格的模型名', () => {
  for (const patch of [
    { llmGatewayBase: 'gw.example.com' },
    { llmGatewayBase: 'ftp://gw.example.com' },
    { llmModel: '' },
    { llmModel: 'a b' },
    { llmModel: 'a,b' },
  ]) {
    const before = JSON.stringify(readOverrides())
    const r = writeOverrides(patch)
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(patch)}`)
    assert.equal(JSON.stringify(readOverrides()), before, `拒绝时不得留下半写状态: ${JSON.stringify(patch)}`)
  }
})

test('null 还原回 env 底座；空串是显式置空（网关允许显式停用，密钥允许显式无密钥）', () => {
  writeOverrides({ llmGatewayBase: 'https://gw.example.com/v1' })
  assert.equal(writeOverrides({ llmGatewayBase: null }).ok, true)
  assert.equal('llmGatewayBase' in readOverrides(), false)
  // 显式空串：网关=停用 AI、密钥=无鉴权，都是合法运行态，不是还原
  assert.equal(writeOverrides({ llmGatewayBase: '' }).ok, true)
  assert.equal(effective('llmGatewayBase'), '')
  assert.equal(writeOverrides({ llmApiKey: '' }).ok, true)
  assert.equal(effective('llmApiKey'), '')
})

test('白名单外键名整体拒绝，不写盘', () => {
  const before = JSON.stringify(readOverrides())
  for (const patch of [{ port: 9999 }, { dataDir: '/etc' }]) {
    const r = writeOverrides(patch)
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(patch)}`)
  }
  assert.equal(JSON.stringify(readOverrides()), before)
})
