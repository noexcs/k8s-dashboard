// 设置页 Prometheus 配置卡（参考 CLI per-cluster Prometheus）：按集群存 localStorage。
// 两种寻址：服务发现（ns/svc，浏览器经集群 API service-proxy，无需集群网络直连）优先；
// 或显式 URL（集群外可达地址）。保存后 usePrometheus 探测 up 反馈连通性。
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Activity, Loader2, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { readPromConfig, usePrometheus, writePromConfig, type PromConfig } from '@/hooks/usePrometheus'
import { tf, useT } from '@/i18n'

interface Form {
  url: string
  ns: string
  svc: string
  port: string
}

const toForm = (c: PromConfig | null): Form => ({
  url: c?.url ?? '',
  ns: c?.ns ?? '',
  svc: c?.svc ?? '',
  port: c?.port ?? '',
})

export function PromSettingsCard() {
  const t = useT()
  const { cluster } = useParams()
  const queryClient = useQueryClient()
  const [cfg, setCfg] = useState<Form>(() => toForm(readPromConfig(cluster)))
  const [saved, setSaved] = useState(() => !!readPromConfig(cluster))
  const { reachable, checking } = usePrometheus(saved ? cluster : undefined)

  if (!cluster) return null

  const stored = toForm(readPromConfig(cluster))
  const dirty = cfg.url.trim() !== stored.url || cfg.ns.trim() !== stored.ns || cfg.svc.trim() !== stored.svc || cfg.port.trim() !== stored.port

  const save = () => {
    const url = cfg.url.trim()
    const ns = cfg.ns.trim()
    const svc = cfg.svc.trim()
    const port = cfg.port.trim()
    const has = !!url || !!(ns && svc)
    writePromConfig(cluster, has ? { url: url || undefined, ns: ns || undefined, svc: svc || undefined, port: port || undefined } : null)
    setSaved(has)
    // 立即重探：绕过 60s probe 缓存，保存后 badge 秒级反馈
    void queryClient.invalidateQueries({ queryKey: ['prom-probe', cluster] })
  }

  const clear = () => {
    writePromConfig(cluster, null)
    setCfg({ url: '', ns: '', svc: '', port: '' })
    setSaved(false)
  }

  return (
    <Card className="gap-3 [--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="size-4 text-muted-foreground" />
          {t('settings:promTitle')}
          {saved &&
            (checking ? (
              <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-xs font-normal">
                <Loader2 className="size-2.5 animate-spin" />
                {t('settings:promChecking')}
              </Badge>
            ) : (
              <Badge
                variant="secondary"
                className={
                  reachable
                    ? 'bg-positive/10 px-1.5 py-0 text-xs font-normal text-positive'
                    : 'bg-destructive/10 px-1.5 py-0 text-xs font-normal text-destructive'
                }
              >
                {reachable ? t('settings:promUp') : t('settings:promDown')}
              </Badge>
            ))}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[13px] text-muted-foreground">{t('settings:promHint')}</p>
        <div className="grid gap-3 sm:grid-cols-[1fr_1.6fr_.8fr]">
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">{t('settings:promNsLabel')}</span>
            <Input value={cfg.ns} onChange={e => setCfg({ ...cfg, ns: e.target.value })} placeholder="monitoring" className="h-8 font-mono text-[13px]" />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">{t('settings:promSvcLabel')}</span>
            <Input value={cfg.svc} onChange={e => setCfg({ ...cfg, svc: e.target.value })} placeholder="kube-prometheus-stack-prometheus" className="h-8 font-mono text-[13px]" />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">{t('settings:promPortLabel')}</span>
            <Input value={cfg.port} onChange={e => setCfg({ ...cfg, port: e.target.value })} placeholder={t('settings:promPortPh')} className="h-8 font-mono text-[13px]" />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="block text-xs text-muted-foreground">{t('settings:promUrlLabel')}</span>
          <Input value={cfg.url} onChange={e => setCfg({ ...cfg, url: e.target.value })} placeholder="http://prom.local:9090" className="h-8 font-mono text-[13px]" />
        </label>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-7 text-[13px]" onClick={save} disabled={!dirty}>
            {t('settings:promSave')}
          </Button>
          {saved && (
            <Button size="sm" variant="ghost" className="h-7 text-[13px]" onClick={clear}>
              <Trash2 className="size-3" />
              {t('settings:promClear')}
            </Button>
          )}
          <span className="text-xs text-muted-foreground">{tf('settings:promSavedTo', { cluster })}</span>
        </div>
      </CardContent>
    </Card>
  )
}
