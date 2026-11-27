// 设置页 Prometheus 配置卡（参考 CLI per-cluster Prometheus）：按集群存 localStorage。
// 版式：服务发现（ns/svc/port，浏览器经集群 API service-proxy，无需集群网络直连）为主面板
// （inset 分组 + 双列字段）；显式 URL 为次级细节项，两者都填时 URL 优先（卡内即时提示）。
// 卡头 action = 连通性徽标（探测中/已连接/不可达）；卡底 = 常驻实体按钮行（清除/保存）+ 脚注。
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Info, Loader2, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FADE, INSET, SectionCard, SettingTile } from './parts'
import { readPromConfig, usePrometheus, writePromConfig, type PromConfig } from '@/hooks/usePrometheus'
import { tf, useT } from '@/i18n'
import { cn } from '@/lib/utils'

interface Form {
  url: string
  ns: string
  svc: string
  port: string
}

const EMPTY: Form = { url: '', ns: '', svc: '', port: '' }

const toForm = (c: PromConfig | null): Form => ({
  url: c?.url ?? '',
  ns: c?.ns ?? '',
  svc: c?.svc ?? '',
  port: c?.port ?? '',
})

/** 字段瓦片：与外观节自定义组同构（inset 面板内嵌实体边框瓦片，全页一种容器语言） */
function Field({ id, label, children, className }: { id: string; label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <SettingTile className={cn('bg-card', className)} label={<label htmlFor={id}>{label}</label>}>
      {children}
    </SettingTile>
  )
}

export function PromSettingsCard({ id }: { id?: string }) {
  const t = useT()
  const { cluster } = useParams()
  const queryClient = useQueryClient()
  const [cfg, setCfg] = useState<Form>(() => toForm(readPromConfig(cluster)))
  const [saved, setSaved] = useState(() => !!readPromConfig(cluster))
  const [confirmClear, setConfirmClear] = useState(false)
  const clearTimer = useRef<number | undefined>(undefined)
  const { reachable, checking } = usePrometheus(saved ? cluster : undefined)

  if (!cluster) return null

  const stored = toForm(readPromConfig(cluster))
  const dirty = cfg.url.trim() !== stored.url || cfg.ns.trim() !== stored.ns || cfg.svc.trim() !== stored.svc || cfg.port.trim() !== stored.port
  // 二选一冲突：URL 与服务发现都填了（服务端规则：url 优先），当场说清楚
  const urlWins = !!cfg.url.trim() && !!(cfg.ns.trim() && cfg.svc.trim())
  // 半套配置（无 URL 时 ns/svc 不齐，或只有孤立端口）保存后等价于「清除」——静默丢弃等于骗人，禁保存并就地说明
  const invalid = !cfg.url.trim() && !(cfg.ns.trim() && cfg.svc.trim()) && !!(cfg.ns.trim() || cfg.svc.trim() || cfg.port.trim())
  // 端口须为 1-5 位数字或 k8s 服务端口名；abc/99999 这类垃圾不许落盘
  const port = cfg.port.trim()
  const badPort = port !== '' && !/^(\d{1,5}|[a-z0-9]([-a-z0-9]*[a-z0-9])?)$/.test(port)
  // 四框全空 = 想清空：保存键语义切换为「清除」，走同一二段确认——否则空表单+保存=绕过确认的静默清除
  const allEmpty = !cfg.url.trim() && !cfg.ns.trim() && !cfg.svc.trim() && !port
  const saveActsAsClear = allEmpty && saved

  const save = () => {
    const url = cfg.url.trim()
    const ns = cfg.ns.trim()
    const svc = cfg.svc.trim()
    writePromConfig(cluster, { url: url || undefined, ns: ns || undefined, svc: svc || undefined, port: port || undefined })
    setSaved(!!readPromConfig(cluster))
    // 立即重探：绕过 60s probe 缓存，保存后 badge 秒级反馈
    void queryClient.invalidateQueries({ queryKey: ['prom-probe', cluster] })
  }

  const clear = () => {
    writePromConfig(cluster, null)
    setCfg(EMPTY)
    setSaved(false)
  }

  // 一键清空是破坏性操作：二段内联确认（3s 回退），不弹全局对话框。
  // detail>1 = 双击的第二次点击：真实双击会跳过确认直接清除，必须吃掉
  const onClearClick = (e: { detail: number }) => {
    if (e.detail > 1) return
    if (confirmClear) {
      clearTimeout(clearTimer.current)
      setConfirmClear(false)
      clear()
      return
    }
    setConfirmClear(true)
    clearTimeout(clearTimer.current)
    clearTimer.current = window.setTimeout(() => setConfirmClear(false), 3000)
  }

  // 卡头徽标区：role=status——保存/「重新探测」后的 探测中→已连接/不可达 是异步结果，读屏必须能听到
  const statusBadge = saved ? (
    checking ? (
      <Badge variant="secondary" className={cn(FADE, 'gap-1.5 px-2 py-0.5 font-normal text-muted-foreground')}>
        <Loader2 className="size-3 animate-spin" />
        {t('settings:promChecking')}
      </Badge>
    ) : (
      <Badge
        variant="secondary"
        className={cn(
          FADE,
          'gap-1.5 px-2 py-0.5 font-normal',
          reachable ? 'bg-positive/10 text-positive' : 'bg-destructive/10 text-destructive',
        )}
      >
        <span className="size-2 rounded-full bg-current" />
        {reachable ? t('settings:promUp') : t('settings:promDown')}
      </Badge>
    )
  ) : (
    // 未配置是缺省态不是错误：中性徽标直接说「未配置」，不让人从灰色 placeholder 反推
    <Badge variant="secondary" className="px-2 py-0.5 font-normal text-muted-foreground">
      {t('settings:promUnconfigured')}
    </Badge>
  )

  return (
    <SectionCard id={id} title={t('settings:promTitle')} desc={t('settings:promHint')} action={<span role="status" aria-live="polite">{statusBadge}</span>}>
      {/* 单一 inset 面板=与外观节同款容器语言；服务发现（主路径）与直连 URL 同组瓦片排布 */}
      <div className={cn(INSET, 'grid gap-2 p-3 sm:grid-cols-2')}>
        <Field id="prom-svc" label={t('settings:promSvcLabel')} className="sm:col-span-2">
          <Input
            id="prom-svc"
            value={cfg.svc}
            onChange={e => setCfg({ ...cfg, svc: e.target.value })}
            placeholder="kube-prometheus-stack-prometheus"
            aria-invalid={(invalid && !cfg.svc.trim()) || undefined}
            aria-describedby={invalid ? 'prom-group-err' : undefined}
            className="h-8 font-mono text-[13px] md:text-[13px]"
          />
        </Field>
        <Field id="prom-ns" label={t('settings:promNsLabel')}>
          <Input
            id="prom-ns"
            value={cfg.ns}
            onChange={e => setCfg({ ...cfg, ns: e.target.value })}
            placeholder="monitoring"
            aria-invalid={(invalid && !cfg.ns.trim()) || undefined}
            aria-describedby={invalid ? 'prom-group-err' : undefined}
            className="h-8 font-mono text-[13px] md:text-[13px]"
          />
        </Field>
        <Field
          id="prom-port"
          label={
            <>
              {t('settings:promPortLabel')} <span className="font-normal">· {t('settings:promPortHttp')}</span>
            </>
          }
        >
          <Input
            id="prom-port"
            value={cfg.port}
            onChange={e => setCfg({ ...cfg, port: e.target.value })}
            placeholder={t('settings:promPortPh')}
            inputMode="numeric"
            aria-invalid={badPort || undefined}
            aria-describedby={badPort ? 'prom-port-err' : undefined}
            className="h-8 font-mono text-[13px] md:text-[13px]"
          />
        </Field>
        <Field id="prom-url" label={t('settings:promUrlLabel')} className="sm:col-span-2">
          <Input
            id="prom-url"
            value={cfg.url}
            onChange={e => setCfg({ ...cfg, url: e.target.value })}
            placeholder="http://prom.local:9090"
            className="h-8 font-mono text-[13px]"
          />
        </Field>
        {invalid && (
          <p id="prom-group-err" role="alert" className={cn(FADE, 'text-xs text-destructive sm:col-span-2')}>
            {t('settings:promNeedNsSvc')}
          </p>
        )}
        {badPort && (
          <p id="prom-port-err" role="alert" className={cn(FADE, 'text-xs text-destructive sm:col-span-2')}>
            {t('settings:promPortBad')}
          </p>
        )}
        {urlWins && (
          <p className={cn(FADE, 'flex items-start gap-1.5 text-xs leading-4 text-muted-foreground sm:col-span-2')}>
            <Info className="mt-0.5 size-3 shrink-0" />
            {t('settings:promUrlWins')}
          </p>
        )}
      </div>

      {/* footer 操作行：常驻实体按钮，清除靠左、保存靠右（builder Cancel/Save 同款） */}
      <div className="mt-4 flex items-center justify-between gap-2 border-t pt-3">
        <div className="min-w-0">
          {saved && (
            <Button size="sm" variant={confirmClear ? 'destructive' : 'outline'} className="min-w-[6.5rem] justify-center" onClick={onClearClick}>
              <Trash2 className="size-3.5" />
              {confirmClear ? t('settings:promClearConfirm') : t('settings:promClear')}
            </Button>
          )}
        </div>
        <Button
          size="sm"
          disabled={!dirty || invalid || badPort}
          onClick={e => {
            // 全空表单时保存键=清除语义，必须同样走二段确认
            if (saveActsAsClear) onClearClick(e)
            else save()
          }}
        >
          {saveActsAsClear ? t('settings:promClear') : t('settings:promSave')}
        </Button>
      </div>
      {saved && (
        <p className="mt-2 truncate text-xs text-muted-foreground">{tf('settings:promSavedTo', { cluster })}</p>
      )}
    </SectionCard>
  )
}
