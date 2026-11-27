import { describe, expect, it } from 'vitest'
import { eventReasonLabel, eventTypeLabel } from './eventL10n'

// 事件枚举中文化的契约：已知值翻译、未知值原样回退（operator 自定义 reason 不可丢）、
// message 不经此层（调用方保证）。未知回退是数据完整性红线。
describe('eventTypeLabel', () => {
  it('zh 翻译标准 type', () => {
    expect(eventTypeLabel('Normal', 'zh')).toBe('正常')
    expect(eventTypeLabel('Warning', 'zh')).toBe('警告')
  })
  it('en 返回原文', () => {
    expect(eventTypeLabel('Normal', 'en')).toBe('Normal')
  })
  it('未知 type 任意语言原样回退', () => {
    expect(eventTypeLabel('Degraded', 'zh')).toBe('Degraded')
  })
})

describe('eventReasonLabel', () => {
  it('常见 reason 中文化', () => {
    expect(eventReasonLabel('BackOff', 'zh')).toBeTypeOf('string')
    expect(eventReasonLabel('BackOff', 'zh')).not.toBe('BackOff')
    expect(eventReasonLabel('Scheduled', 'zh')).not.toBe('Scheduled')
  })
  it('未知 reason 原样回退（自定义 operator 事件不丢信息）', () => {
    expect(eventReasonLabel('MyCustomOperatorReason', 'zh')).toBe('MyCustomOperatorReason')
  })
  it('en 返回原文；undefined 透传', () => {
    expect(eventReasonLabel('BackOff', 'en')).toBe('BackOff')
    expect(eventReasonLabel(undefined, 'zh')).toBeUndefined()
  })
})
