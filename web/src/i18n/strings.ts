// 字典合并入口：各模块 chunk（并行迁移，每块独立文件避免冲突）。
// key 约定 "ns:camelCase"；zh 为现状文案（不改变现有中文），en 为对应英文。
// 特殊文案（资源名 Pods/Deployments…、K8S Dashboard）zh/en 同值。
import { STRINGS_AICTX } from './strings.aictx'
import { STRINGS_AUDIT } from './strings.audit'
import { STRINGS_INSPECT } from './strings.inspect'
import { STRINGS_AI } from './strings.ai'
import { STRINGS_CORE } from './strings.core'
import { STRINGS_CRON } from './strings.cron'
import { STRINGS_EXPORT } from './strings.export'
import { STRINGS_HELM } from './strings.helm'
import { STRINGS_PODS } from './strings.pods'
import { STRINGS_PF } from './strings.pf'
import { STRINGS_RES } from './strings.res'
import { STRINGS_SECRET } from './strings.secret'
import { STRINGS_SHELL } from './strings.shell'
import { STRINGS_SYS } from './strings.sys'
import { STRINGS_TOPO } from './strings.topo'
import { STRINGS_UI } from './strings.ui'
import { STRINGS_NETPOL } from './strings.netpol'
import { STRINGS_NSQ } from './strings.nsq'
import { STRINGS_PVC } from './strings.pvc'
import { STRINGS_INGRESS } from './strings.ingress'
import { STRINGS_KV } from './strings.kv'
import { STRINGS_TMPL } from './strings.tmpl'
import { STRINGS_HPA } from './strings.hpa'

export type Entry = { zh: string; en: string }

export const STRINGS: Record<string, Entry> = {
  ...STRINGS_CORE,
  ...STRINGS_UI,
  ...STRINGS_AI,
  ...STRINGS_AICTX,
  ...STRINGS_AUDIT,
  ...STRINGS_INSPECT,
  ...STRINGS_CRON,
  ...STRINGS_EXPORT,
  ...STRINGS_HELM,
  ...STRINGS_PODS,
  ...STRINGS_PF,
  ...STRINGS_RES,
  ...STRINGS_SECRET,
  ...STRINGS_SHELL,
  ...STRINGS_SYS,
  ...STRINGS_TOPO,
  ...STRINGS_NETPOL,
  ...STRINGS_NSQ,
  ...STRINGS_PVC,
  ...STRINGS_INGRESS,
  ...STRINGS_KV,
  ...STRINGS_TMPL,
  ...STRINGS_HPA,
}
