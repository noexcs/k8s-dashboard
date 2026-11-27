/**
 * 处置（认领）是否作废 = 「复发」的唯一判定：处置时间早于对象最近一次 status 转态。
 * 首页与巡检页共用本函数——同一个键在两页必须给出同一个结论。
 * 无转态证据（lastTransition 空）= 保守维持认领（长时 Job 常无 conditions）。
 */
export function dispStale(dispTs?: string, lastTransition?: string): boolean {
  if (!dispTs || !lastTransition) return false
  return dispTs < lastTransition
}
