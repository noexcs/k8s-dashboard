// 安装/升级 Helm chart 对话框（Charts tab「安装」与 Releases 行「升级」共用，挂载即重置）。
// 后端 install/upgrade 均为异步（202 秒回 → /action/status 轮询，无记录 500 = processing）：
// 提交后进入 running 态展示进度，只有 waitForAction 返回 success 才提示成功，绝不提前庆祝。
// 后端无 chart values 详情端点 → values 只能手输 YAML override（占位说明已写清）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { installRelease, listCharts, upgradeRelease, waitForAction, type HelmActionStatus } from '@/api/helm'
import { list, namespacesPath } from '@/api/client'
import type { K8sObject } from '@/api/types'
import { tf, useT } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** 对话框数据源：install = Charts tab 选中坐标；upgrade = Releases 行选中 release */
export type HelmDialogTarget =
  | { mode: 'install'; repo: string; name: string; versions: string[]; version: string }
  | { mode: 'upgrade'; releaseName: string; namespace: string; chartName: string; chartVersion: string }

// RFC 1123：release 名 = subdomain，namespace = label
const NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

function splitVersion(v: string): [number[], string] {
  const s = v.replace(/^v/, '')
  const [core = '', pre = ''] = s.split(/[-+]/, 2)
  return [core.split('.').map(x => (/^\d+$/.test(x) ? parseInt(x, 10) : 0)), pre]
}

/** 宽松 semver 降序比较：数字段逐段比，正式版 > 预发布版；给 ChartsTab / 版本下拉共用 */
export function compareVersionsDesc(a: string, b: string): number {
  const [ca, pa] = splitVersion(a)
  const [cb, pb] = splitVersion(b)
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const d = (cb[i] ?? 0) - (ca[i] ?? 0)
    if (d !== 0) return d
  }
  if (pa === pb) return b.localeCompare(a)
  if (pa === '') return -1
  if (pb === '') return 1
  return pb.localeCompare(pa)
}

export function InstallChartDialog({
  cluster,
  target,
  onClose,
  onDone,
}: {
  cluster: string
  target: HelmDialogTarget
  /** 关闭（成功或取消均经由此，父组件卸载本组件） */
  onClose: () => void
  /** 成功完成（install/upgrade）：父组件跳 Releases tab / 刷新列表 */
  onDone: (action: 'install' | 'upgrade') => void
}) {
  const t = useT()
  // 显式拆分两个分支：判别式窄化在闭包里对非 const 参数不生效，用具名变量代替
  const it = target.mode === 'install' ? target : null
  const ut = target.mode === 'upgrade' ? target : null

  // 后端 charts 的 name 可能已含仓库前缀（bitnami 索引=「bitnami/nginx」）：
  // 安装坐标不能重复拼 repo；release 默认名去掉前缀（RFC1123 不允许 /）
  const baseName = it && it.repo && it.name.startsWith(`${it.repo}/`) ? it.name.slice(it.repo.length + 1) : it?.name
  const [releaseName, setReleaseName] = useState(() => (it ? (baseName ?? '') : (ut?.releaseName ?? '')))
  const [createNs, setCreateNs] = useState(false)
  const [ns, setNs] = useState('default')
  const [newNs, setNewNs] = useState('')
  const [repo, setRepo] = useState(() => (it ? it.repo : ''))
  const [chartInput, setChartInput] = useState(() => (ut ? ut.chartName : ''))
  const [version, setVersion] = useState(() => (it ? it.version : ''))
  const [values, setValues] = useState('')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<HelmActionStatus | null>(null)
  // waitForAction 最长 5 分钟：关闭/跳转卸载后不得再 setState/toast
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  // 升级需要 repo 坐标与可选版本：后端没有 release→repo 反查，用 chart 名过滤 listCharts 匹配。
  // 未加仓库/索引缺失时 listCharts 500 → 不裸抛，切手动输入坐标。
  const upgradeChartName = ut?.chartName ?? ''
  const {
    data: chartData,
    isError: chartLookupFailed,
    isPending: chartLookupPending,
  } = useQuery({
    queryKey: ['helm-charts', cluster, upgradeChartName],
    queryFn: () => listCharts(cluster, upgradeChartName),
    enabled: ut != null && upgradeChartName !== '',
    retry: false,
  })
  const upgradeRows = useMemo(() => {
    // 索引 name 可能带 repo 前缀（bitnami），release chart 元数据不带 → 前缀感知匹配
    const m = (n: string) => n === upgradeChartName || n.endsWith(`/${upgradeChartName}`)
    return (chartData?.charts ?? []).filter(c => m(c.name))
  }, [chartData, upgradeChartName])
  const manualCoords = ut != null && (chartLookupFailed || (chartData != null && upgradeRows.length === 0))
  const repoChoices = useMemo(() => [...new Set(upgradeRows.map(r => r.repository))], [upgradeRows])
  const versionChoices = useMemo(() => {
    if (it) return it.versions
    return [...new Set(upgradeRows.map(r => r.version))].sort(compareVersionsDesc)
  }, [it, upgradeRows])

  // 升级：解析出唯一 repo 时直接选中；默认目标 = 最新可用版本
  useEffect(() => {
    if (ut && repo === '' && repoChoices.length > 0) setRepo(repoChoices[0]!)
  }, [ut, repo, repoChoices])
  useEffect(() => {
    if (ut && version === '' && versionChoices.length > 0) setVersion(versionChoices[0]!)
  }, [ut, version, versionChoices])

  const { data: nsData } = useQuery({
    queryKey: ['namespaces', cluster],
    queryFn: () => list<K8sObject>(cluster, namespacesPath),
    staleTime: 60_000,
  })
  const namespaces = useMemo(() => nsData?.items.map(i => i.metadata.name) ?? [], [nsData])
  // 命名空间列表到达后纠正默认值（default 不一定存在）
  useEffect(() => {
    if (!nsData) return
    setNs(prev => (namespaces.includes(prev) ? prev : namespaces.includes('default') ? 'default' : (namespaces[0] ?? prev)))
  }, [nsData, namespaces])

  const nameOk = NAME_RE.test(releaseName) && releaseName.length <= 253
  const nsOk = it == null ? true : createNs ? LABEL_RE.test(newNs.trim()) && newNs.length <= 63 : ns !== ''
  const coordOk = it != null ? it.repo !== '' && version !== '' : repo.trim() !== '' && chartInput.trim() !== '' && version.trim() !== ''
  const canSubmit = nameOk && nsOk && coordOk && !running

  const submit = async () => {
    setRunning(true)
    setStatus(null)
    const release = it ? releaseName : (ut?.releaseName ?? '')
    const action = it ? 'install' : 'upgrade'
    try {
      if (it) {
        await installRelease(cluster, {
          name: releaseName,
          namespace: createNs ? newNs.trim() : ns,
          // 索引 name 可能已含 repo 前缀（bitnami）：避免拼成 repo/repo/name
          chart: it.name.includes('/') ? it.name : `${it.repo}/${it.name}`,
          version,
          values,
          createNamespace: createNs,
        })
        if (!mounted.current) return
        toast.info(t('helm:installSubmitted'))
      } else if (ut) {
        await upgradeRelease(cluster, {
          name: ut.releaseName,
          namespace: ut.namespace,
          chart: `${repo.trim()}/${chartInput.trim()}`,
          version: version.trim(),
          values,
        })
        if (!mounted.current) return
        toast.info(t('helm:upgradeSubmitted'))
      }
      const s = await waitForAction(cluster, release, action, 5 * 60_000, next => {
        if (mounted.current) setStatus(next)
      })
      if (!mounted.current) return
      if (s.status === 'success') {
        toast.success(
          it
            ? tf('helm:installSuccess', { name: release })
            : tf('helm:upgradeSuccess', { name: release, version }),
        )
        onDone(action)
        onClose()
        return
      }
      toast.error(
        it
          ? tf('helm:installFailed', { msg: s.message ?? t('sys:unknownError') })
          : tf('helm:upgradeFailed', { msg: s.message ?? t('sys:unknownError') }),
      )
      setRunning(false)
    } catch (e) {
      if (!mounted.current) return
      // 提交期错误（400/409/超时）：回到表单，让用户改完重试，不显示成功
      toast.error(e instanceof Error ? e.message : String(e))
      setRunning(false)
    }
  }

  return (
    <Dialog open onOpenChange={v => { if (!running && !v) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {it ? tf('helm:installTitle', { chart: it.name.includes('/') ? it.name : `${it.repo}/${it.name}` }) : tf('helm:upgradeTitle', { name: ut?.releaseName ?? '' })}
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            {it
              ? `${t('helm:repoShort')}: ${it.repo}`
              : `${t('helm:currentVersion')}: ${ut?.chartName} ${ut?.chartVersion} · ${ut?.namespace}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-[13px]">
          {/* release 名：install 默认 chart 名（RFC1123 校验通过才可提交）；upgrade 固定不可改 */}
          {it && (
            <label className="block space-y-1">
              <span className="text-muted-foreground">{t('helm:releaseName')}</span>
              <Input
                value={releaseName}
                onChange={e => setReleaseName(e.target.value)}
                disabled={running}
                aria-invalid={!nameOk}
                className="h-8 font-mono"
              />
              {!nameOk && <span className="text-destructive">{t('helm:releaseNameInvalid')}</span>}
            </label>
          )}

          {/* 命名空间：install 选已有，或勾选「新建」→ createNamespace=true 由 helm 创建 */}
          {it && (
            <div className="space-y-1">
              <span className="block text-muted-foreground">{t('sys:colNamespace')}</span>
              {!createNs && (
                <Select value={ns} onValueChange={setNs} disabled={running}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('helm:chooseNamespace')} />
                  </SelectTrigger>
                  <SelectContent>
                    {namespaces.map(n => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {createNs && (
                <div>
                  <Input
                    value={newNs}
                    onChange={e => setNewNs(e.target.value)}
                    placeholder={t('helm:newNamespacePlaceholder')}
                    disabled={running}
                    aria-invalid={!nsOk}
                    className="h-8 font-mono"
                  />
                  {!nsOk && <div className="pt-1 text-destructive">{t('helm:namespaceInvalid')}</div>}
                </div>
              )}
              <label className="mt-1 flex items-center gap-2">
                <Checkbox checked={createNs} onCheckedChange={v => setCreateNs(v === true)} disabled={running} />
                <span>{t('helm:createNamespace')}</span>
              </label>
            </div>
          )}

          {/* 升级：chart 不在已添加仓库的索引里（或图表查询失败）→ 手动输入坐标，不裸抛 */}
          {ut && manualCoords && (
            <div className="space-y-1 rounded-md border border-caution/40 bg-caution/5 px-3 py-2">
              <span className="text-caution">{tf('helm:chartMissingInRepos', { chart: upgradeChartName })}</span>
              <div className="flex gap-2">
                <Input value={repo} onChange={e => setRepo(e.target.value)} placeholder={t('helm:repoShort')} disabled={running} className="h-8 min-w-0 flex-1 font-mono" />
                <Input value={chartInput} onChange={e => setChartInput(e.target.value)} placeholder="Chart" disabled={running} className="h-8 min-w-0 flex-1 font-mono" />
              </div>
            </div>
          )}
          {ut && !manualCoords && repoChoices.length > 1 && (
            <label className="block space-y-1">
              <span className="text-muted-foreground">{t('helm:repoShort')}</span>
              <Select value={repo} onValueChange={setRepo} disabled={running}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {repoChoices.map(r => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          {/* 版本：install 用行上带来的全部版本；upgrade 用索引解析结果（手动模式 = 自由输入） */}
          <label className="block space-y-1">
            <span className="text-muted-foreground">{ut ? t('helm:targetVersion') : t('helm:versionTarget')}</span>
            {ut && manualCoords ? (
              <Input
                value={version}
                onChange={e => setVersion(e.target.value)}
                placeholder={ut.chartVersion}
                disabled={running}
                className="h-8 font-mono"
              />
            ) : (
              <Select value={version} onValueChange={setVersion} disabled={running || (ut != null && chartLookupPending)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={ut && chartLookupPending ? t('sys:loading') : undefined} />
                </SelectTrigger>
                <SelectContent>
                  {versionChoices.map(v => (
                    <SelectItem key={v} value={v}>
                      {v}
                      {ut && v === ut.chartVersion ? t('sys:currentRevision') : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </label>

          {/* values：后端没有 chart 默认值端点，不做预拉取——只收 override */}
          <label className="block space-y-1">
            <span className="text-muted-foreground">{t('helm:valuesOverride')}</span>
            <Textarea
              value={values}
              onChange={e => setValues(e.target.value)}
              disabled={running}
              placeholder={tf('helm:valuesPlaceholder')}
              className="min-h-28 font-mono text-[13px]"
            />
            <span className="block text-muted-foreground">
              {ut ? t('helm:upgradeValuesHint') : t('helm:valuesHint')}
            </span>
          </label>

          {/* 异步进行中：展示轮询状态而非假成功；此时禁止关闭，避免误以为后台动作已结束 */}
          {running && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              <span>
                {t('helm:actionProcessing')}
                {status?.message ? `: ${status.message}` : ''}
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={running}>
            {t('sys:cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {running && <Loader2 className="size-3.5 animate-spin" />}
            {it ? t('helm:installSubmit') : t('helm:submitUpgrade')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
