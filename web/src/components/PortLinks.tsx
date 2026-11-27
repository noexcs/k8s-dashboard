// Kube-Proxy 端口直访（参考 CLI 的 Kube Proxy）：经集群 API 的 pods/svc :port/proxy 子资源
// 在新标签打开 Pod/Service 的 HTTP 端口，无需本机 port-forward。
// 已实测 headlamp-server 代理透传数字与命名端口两种形式（:8080/proxy、:http/proxy 均 200）。
// 仅 HTTP 有交互意义（新标签直接渲染响应体）；非 HTTP 端口显示为不可点。
// 容器结构与详情页其他 Card 区块一致（Card + CardHeader/CardTitle），端口行是普通文本链接，
// 不再用独立描边 chip（与其他区块的纯文本行风格冲突）。
import { ExternalLink, Network } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useT } from '@/i18n'
import { Card, CardContent } from '@/components/ui/card'
import { SectionTitle } from '@/components/SectionTitle'

export interface PortItem {
  port: number
  name?: string
  protocol?: string
}

/** API 代理 URL：Service 支持 :命名端口（已实测），Pod 仅数字端口 */
export function proxyUrl(
  cluster: string,
  target: { kind: 'Pod' | 'Service'; ns: string; name: string },
  p: PortItem,
): string {
  const ns = encodeURIComponent(target.ns)
  const portSeg =
    target.kind === 'Service' && p.name ? `:${encodeURIComponent(p.name)}` : `:${p.port}`
  const resource = target.kind === 'Service' ? 'services' : 'pods'
  return `/clusters/${encodeURIComponent(cluster)}/api/v1/namespaces/${ns}/${resource}/${encodeURIComponent(target.name)}${portSeg}/proxy/`
}

export function PortLinks({
  cluster,
  ns,
  name,
  kind,
  ports,
}: {
  cluster: string
  ns: string
  name: string
  kind: 'Pod' | 'Service'
  ports: PortItem[]
}) {
  const t = useT()
  if (ports.length === 0) return null
  return (
    <Card>
      <CardContent className="pt-3">
        {/* 标题与容器/资源/所有者区块同款（13px muted），端口用同款可点行 */}
        <SectionTitle>{t('res:portsTitle')}</SectionTitle>
        <div className="space-y-1">
          {ports.map((p, i) => {
            const url = proxyUrl(cluster, { kind, ns, name }, p)
            // 已知非 HTTP 协议（如 DNS 53）不给链接；
            // Service 代理的端口段只接受**端口名**（数字必 503 "no service port X found"，实测），
            // 无名端口的 Service 无代理路径可拼，只能走 port-forward
            const clickable =
              p.protocol !== 'SCTP' && p.port !== 53 && !(kind === 'Service' && !p.name)
            const label = p.name ? `${p.name} · ${p.port}` : `${p.port}${p.protocol && p.protocol !== 'TCP' ? `/${p.protocol}` : ''}`
            return clickable ? (
              <a
                key={i}
                href={url}
                target="_blank"
                rel="noreferrer"
                title={url}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 transition-colors hover:bg-accent/40"
              >
                <span className="truncate font-mono text-xs" title={label}>{label}</span>
                <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
              </a>
            ) : (
              <div key={i} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5">
                <span className="truncate font-mono text-xs text-muted-foreground" title={label}>{label}</span>
              </div>
            )
          })}
        </div>
        <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{t('res:portsHint')}</p>
        {/* 逃生通道：proxy 直链打不开（非 HTTP 响应/apiserver 拒绝）时走真 TCP 端口转发（Pod 详情页 tab） */}
        {kind === 'Pod' && (
          <Link
            to={`/c/${encodeURIComponent(cluster)}/ns/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}?tab=portforward`}
            className="mt-1 inline-flex items-center gap-1 text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <Network className="size-3.5" />
            {t('pf:proxyFallbackHint')}
          </Link>
        )}
      </CardContent>
    </Card>
  )
}
