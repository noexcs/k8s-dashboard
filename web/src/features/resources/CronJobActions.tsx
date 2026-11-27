// CronJob 头部动作：暂停/恢复调度（PATCH spec.suspend）+ 立即触发一次（等价
// kubectl create job --from=cronjob/<name>）：从 spec.jobTemplate 复制出一次性 Job，
// 挂 ownerReference 指向 CronJob，使手动 Job 随 CronJob 删除一起清理。
// 与 WorkloadActions 同款紧凑按钮；各自独立 RBAC 门控（suspend=cronjobs update，
// trigger=jobs create），外层 allowed 是父级粗粒度门（false 时整块不渲染）。
import { Loader2, Pause, Play, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { get, patchObject, postObject } from '@/api/client'
import { usePermissions, type PermissionCheck } from '@/hooks/usePermissions'
import { tf, useT } from '@/i18n'
import type { K8sObject } from '@/api/types'
import { detailRoute, itemPath, listPath, RESOURCE_MAP } from '@/resources/registry'
import { GatedButton } from '@/components/GatedButton'

// batch/v1 路径直接由 registry 的 def 字段拼出，避免手写出错
const CRONJOB_DEF = { group: 'batch', version: 'v1', resource: 'cronjobs', scope: 'namespaced' } as const
const JOBS_LIST_DEF = { group: 'batch', version: 'v1', resource: 'jobs', scope: 'namespaced' } as const

// RFC 1123 subdomain 上限；手动 Job 名尾部随机后缀（同 kubectl create job --from 风格）
const MAX_NAME_LEN = 63
const SUFFIX_CHARS = 'bcdfghjklmnpqrstvwxz23456789'

/** jobTemplate 是完整 PodTemplateSpec + Job 字段，前端只读取用到的分支，其余原样透传 */
interface CronJobFull extends K8sObject {
  spec?: {
    suspend?: boolean
    jobTemplate?: {
      metadata?: { labels?: Record<string, string> }
      spec?: {
        selector?: { matchLabels?: Record<string, string> }
        template?: { metadata?: { labels?: Record<string, string> } }
      } & Record<string, unknown>
    }
  }
}

/** 清洗成合法 RFC1123 名：小写、非法字符转 `-`、截到 63、首尾不留 `-`/`.` */
function sanitizeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
  return cleaned.slice(0, MAX_NAME_LEN).replace(/[.-]+$/, '')
}

function randSuffix(): string {
  let s = ''
  for (let i = 0; i < 5; i++) s += SUFFIX_CHARS[Math.floor(Math.random() * SUFFIX_CHARS.length)]
  return s
}

interface CronJobActionsProps {
  cluster: string
  ns: string
  name: string
  /** spec.suspend（父组件从 yaml 解析） */
  suspend: boolean
  /** 父级粗粒度门：false = 整块动作不渲染 */
  allowed: boolean
}

export function CronJobActions({ cluster, ns, name, suspend, allowed }: CronJobActionsProps) {
  const t = useT()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const cronjobPath = itemPath(CRONJOB_DEF, ns, name)

  // RBAC：暂停/恢复 = cronjobs update；触发 = 该 ns create jobs
  const checks = useMemo<PermissionCheck[]>(
    () => [
      { verb: 'update', group: 'batch', version: 'v1', resource: 'cronjobs', namespace: ns },
      { verb: 'create', group: 'batch', version: 'v1', resource: 'jobs', namespace: ns },
    ],
    [ns],
  )
  const { can } = usePermissions(cluster, checks)
  const canSuspend = can(checks[0])
  const canTrigger = can(checks[1])

  const [suspendBusy, setSuspendBusy] = useState(false)
  const [triggerBusy, setTriggerBusy] = useState(false)

  if (!allowed) return null

  const invalidate = () => {
    // 列表页走 useWatch（watch 帧自动更新）；详情页 yaml 缓存在此失效
    void queryClient.invalidateQueries({ queryKey: ['yaml', cluster, cronjobPath] })
  }

  const doSuspend = async () => {
    setSuspendBusy(true)
    try {
      await patchObject(cluster, cronjobPath, { spec: { suspend: !suspend } }, suspend ? '暂停调度（spec.suspend=true）' : '恢复调度')
      invalidate()
      toast.success(t(suspend ? 'cron:resumeDone' : 'cron:suspendDone'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSuspendBusy(false)
    }
  }

  const doTrigger = async () => {
    setTriggerBusy(true)
    try {
      const cj = await get<CronJobFull>(cluster, cronjobPath)
      const jobTemplate = cj.spec?.jobTemplate
      if (!jobTemplate?.spec) {
        toast.error(t('cron:noJobTemplate'))
        return
      }
      // spec 深拷贝后独立修改，绝不复用/污染 get 回来的对象
      const jobSpec = structuredClone(jobTemplate.spec)
      const jobLabels: Record<string, string> = {
        ...(jobTemplate.metadata?.labels ?? {}),
        'k8s-dashboard.dev/manual-trigger-from': name,
      }
      // selector 原样照抄（controller-uid 等由 Job 控制器注入，前端不伪造）；
      // 模板标签需覆盖 selector，故 selector 已管的 key 不重复塞，其余补上来源标签
      const selectorLabels = jobSpec.selector?.matchLabels ?? {}
      const templateMeta: { metadata?: { labels?: Record<string, string> } } = jobSpec.template ?? {}
      const extraLabels = Object.fromEntries(Object.entries(jobLabels).filter(([k]) => !(k in selectorLabels)))
      if (Object.keys(extraLabels).length > 0) {
        jobSpec.template = {
          ...templateMeta,
          metadata: { ...templateMeta.metadata, labels: { ...(templateMeta.metadata?.labels ?? {}), ...extraLabels } },
        }
      }
      const jobName = sanitizeName(`${name}-manual-${randSuffix()}`)
      await postObject(
        cluster,
        listPath(JOBS_LIST_DEF, ns),
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: {
            name: jobName,
            namespace: ns,
            labels: jobLabels,
            ownerReferences: [
              // controller:false：Job 本就被 CronJob 控制器管理，这里只是借用 GC 做级联清理
              { apiVersion: 'batch/v1', kind: 'CronJob', name, uid: cj.metadata.uid, controller: false, blockOwnerDeletion: false },
            ],
          },
          spec: jobSpec,
        } as unknown as K8sObject,
        `手动触发 CronJob「${name}」`,
      )
      invalidate()
      toast.success(tf('cron:triggerDone', { job: jobName }), {
        action: {
          label: t('cron:viewJob'),
          onClick: () => navigate(detailRoute(RESOURCE_MAP['Job'], cluster, ns, jobName)),
        },
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setTriggerBusy(false)
    }
  }

  return (
    <>
      <GatedButton allowed={canSuspend} variant="outline" busy={suspendBusy} onClick={() => void doSuspend()}>
        {suspendBusy ? <Loader2 className="size-3.5 animate-spin" /> : suspend ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
        {suspend ? t('cron:resume') : t('cron:suspend')}
      </GatedButton>
      <GatedButton allowed={canTrigger} variant="outline" busy={triggerBusy} onClick={() => void doTrigger()}>
        {triggerBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
        {triggerBusy ? t('cron:triggering') : t('cron:trigger')}
      </GatedButton>
    </>
  )
}
