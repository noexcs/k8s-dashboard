// 全局资源搜索：Cmd/Ctrl+K 或 header 搜索按钮打开（Command 弹窗）。
// 后端无搜索端点（已 rg 确认）：对固定 12 种常用 kind 各发一次 list(limit=500)，
// react-query 缓存 60s，客户端按名称过滤，结果按 kind 分组；点击跳详情。
// 参考 CLI：`<kind前缀> <关键字>` 限定类型（po nginx / deploy api，别名照抄 CLI 工具 search.go）；
// 收藏（localStorage，useFavorites）：打开即置顶展示，结果行星标切换。
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Search, SearchX, Star } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { list } from '@/api/client'
import { tf, useT } from '@/i18n'
import type { K8sObject } from '@/api/types'
import { favMember, toggleFav, useFavs } from '@/hooks/useFavorites'
import { detailRoute, listPath, RESOURCE_MAP, type AnyResourceDef } from '@/resources/registry'
import { KIND_ALIASES } from '@/features/resources/kindTemplates'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'

/** 固定 12 种常用 kind（全量 kind 太多，无法全搜） */
const SEARCH_KINDS = [
  'Pod',
  'Deployment',
  'StatefulSet',
  'Job',
  'Service',
  'Ingress',
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
  'Node',
  'Namespace',
  'Event',
] as const

const PER_KIND_CAP = 30

/** `po nginx` → { kind: 'Pod', term: 'nginx' }；前缀不认识则整串当关键字 */
function parseQuery(raw: string): { kind: string | null; term: string } {
  const s = raw.trim()
  const m = /^(\S+)\s(.*)$/.exec(s)
  if (m) {
    const kind = KIND_ALIASES[m[1].toLowerCase()]
    if (kind) return { kind, term: m[2].trim() }
  }
  return { kind: null, term: s }
}

/** `app=x` / `app=x,tier=y` 形态 → 服务端 labelSelector 过滤：
 *  SRE 按标签思考（"app=payment 跨 ns 有哪些"），名称子串回答不了归属问题；
 *  且 list API 原生支持 labelSelector，顺带绕开「每 kind 截前 500 条」的静默盲区 */
const LABEL_RE = /^[A-Za-z0-9][\w.-]*(\/[\w.-]+)?=[^\s,=]+(?:,[A-Za-z0-9][\w.-]*(\/[\w.-]+)?=[^\s,=]+)*$/
function labelSelectorOf(term: string): string | null {
  return LABEL_RE.test(term) ? term : null
}

interface KindResult {
  def: AnyResourceDef
  items: K8sObject[]
  ok: boolean
}

interface Hit {
  key: string
  kind: string
  kindLabel: string
  name: string
  ns: string
  def: AnyResourceDef
}

export function GlobalSearch() {
  const t = useT()
  const { cluster } = useParams()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const favs = useFavs(cluster)

  const defs = useMemo(
    () => SEARCH_KINDS.map(k => RESOURCE_MAP[k]).filter((d): d is AnyResourceDef => d !== undefined),
    [],
  )
  const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

  // 全局 Cmd/Ctrl+K 打开/关闭；焦点在 xterm 终端 / 输入框 / YAML 编辑框内时不拦截（那些场景 Ctrl+K 是清行等编辑键）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) return
      const t = e.target
      if (
        t instanceof HTMLElement &&
        (t.closest('.xterm') || t.closest('input') || t.closest('textarea') || t.closest('[contenteditable]') || t.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      setOpen(v => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 每次打开重置关键字（数据走缓存）
  useEffect(() => {
    if (open) setQ('')
  }, [open])

  const minLen = q.trim().length >= 2
  const labelSel = minLen ? labelSelectorOf(parseQuery(q).term) : null
  const { data, isLoading } = useQuery({
    queryKey: ['global-search', cluster, labelSel],
    queryFn: async (): Promise<KindResult[]> => {
      const settled = await Promise.allSettled(
        defs.map(def => list<K8sObject>(cluster!, listPath(def), { limit: '500', ...(labelSel ? { labelSelector: labelSel } : {}) })),
      )
      return settled.map((r, i) => ({
        def: defs[i],
        items: r.status === 'fulfilled' ? r.value.items : [],
        ok: r.status === 'fulfilled',
      }))
    },
    // 懒触发：12 kind × 500 对象的首开成本只付给真的要搜的用户（大集群弹窗空转数秒）
    enabled: open && cluster !== undefined && minLen,
    staleTime: 60_000,
    retry: 0,
  })

  // 收藏 → Hit 列表（存储先于数据到达也要能展示：def 直接从注册表取）
  const favHits = useMemo<Hit[]>(() => {
    if (!cluster) return []
    const out: Hit[] = []
    for (const m of favs) {
      const [kind, ns, ...rest] = m.split('/')
      const name = rest.join('/')
      const def = RESOURCE_MAP[kind]
      if (def) out.push({ key: m, kind, kindLabel: def.label, name, ns, def })
    }
    return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  }, [favs, cluster])

  const { groups, searched, failed } = useMemo(() => {
    const { kind, term } = parseQuery(q)
    const lower = term.toLowerCase()
    let searched = 0
    let failed = 0
    const groups: { def: AnyResourceDef; hits: Hit[] }[] = []
    const favMatches = new Set<string>()
    for (const r of data ?? []) {
      if (!r.ok) {
        failed++
        continue
      }
      if (kind && r.def.kind !== kind) continue
      searched++
      const hits: Hit[] = []
      for (const o of r.items) {
        const name = o.metadata.name
        // label 模式服务端已按 labelSelector 过滤，客户端名称过滤会把全部结果误杀
        if (lower && !labelSel && !name.toLowerCase().includes(lower)) continue
        const m = favMember({ kind: r.def.kind, ns: o.metadata.namespace ?? '', name })
        if (favs.has(m)) favMatches.add(m)
        hits.push({ key: `${r.def.kind}/${o.metadata.namespace ?? ''}/${name}`, kind: r.def.kind, kindLabel: r.def.label, name, ns: o.metadata.namespace ?? '', def: r.def })
        if (hits.length >= PER_KIND_CAP) break
      }
      if (hits.length > 0) groups.push({ def: r.def, hits })
    }
    // 收藏组置顶（cmdk 按 DOM 顺序，组序即展示序）
    groups.sort((a, b) => {
      const fa = a.hits.every(h => favMatches.has(h.key)) ? 0 : 1
      const fb = b.hits.every(h => favMatches.has(h.key)) ? 0 : 1
      return fa - fb
    })
    return { groups, searched, failed }
  }, [data, q, favs, labelSel])

  const total = groups.reduce((n, g) => n + g.hits.length, 0)

  const go = (def: AnyResourceDef, name: string, ns: string) => {
    setOpen(false)
    navigate(detailRoute(def, cluster!, ns || 'cluster', name))
  }

  const hitRow = (h: Hit) => (
    <CommandItem key={h.key} className="py-2" onSelect={() => go(h.def, h.name, h.ns)}>
      <button
        type="button"
        className="shrink-0 p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        title={t('core:favToggle')}
        onPointerDown={e => e.stopPropagation()}
        onClick={e => {
          e.preventDefault()
          e.stopPropagation()
          if (cluster) toggleFav(cluster, { kind: h.kind, ns: h.ns, name: h.name })
        }}
      >
        <Star className={favs.has(h.key) ? 'size-3.5 fill-foreground text-foreground' : 'size-3.5'} />
      </button>
      <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">{h.kind}</span>
      <span className="truncate text-[13px]">{h.name}</span>
      {h.ns !== '' && (
        <span className="ml-auto max-w-28 shrink-0 truncate text-xs text-muted-foreground">{h.ns}</span>
      )}
    </CommandItem>
  )

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        title={t('core:search')}
        className="h-8 max-md:h-11 gap-1.5 px-2 text-[13px] font-normal text-muted-foreground"
      >
        <Search className="size-3.5" />
        {t('core:searchInput')}
        {isMac ? (
          <Kbd className="h-4 px-1 font-mono text-xs">⌘K</Kbd>
        ) : (
          <KbdGroup className="h-4">
            <Kbd className="h-4 px-1 font-mono text-xs">Ctrl</Kbd>
            <Kbd className="h-4 px-1 font-mono text-xs">K</Kbd>
          </KbdGroup>
        )}
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t('core:search')}
        description={t('core:search')}
        // ⌘K 面板瞬开瞬合(animate skill Raycast 规则,与 AI dock 定案同口径):
        // 键盘直达的 command palette 上 200ms fade+zoom 是输入路径上的税
        className="data-[state=open]:animate-none data-[state=closed]:animate-none"
      >
        <Command shouldFilter={false}>
          <CommandInput placeholder={t('core:searchName')} value={q} onValueChange={setQ} />
          <div className="flex items-center justify-between border-b px-3 py-1 text-xs tabular-nums text-muted-foreground">
            {minLen && isLoading ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner className="size-3" />
                {t('core:searching')}
              </span>
            ) : minLen ? (
              <span>
                {tf('core:searched', { n: searched })}
                {failed > 0 ? tf('core:searchedFailed', { f: failed }) : ''}
              </span>
            ) : (
              <span>{t('core:searchMinLen')}</span>
            )}
            {minLen && !isLoading && total > 0 && (
              <span className="shrink-0">{tf('core:resultsCount', { n: total })}</span>
            )}
            {!minLen && (
              <span className="inline-flex shrink-0 items-center gap-1">
                <Kbd className="h-4 px-1 text-xs">Esc</Kbd> {t('core:close')}
              </span>
            )}
          </div>
          <CommandList className="max-h-80">
            {minLen && isLoading ? (
              <div className="space-y-2 p-4">
                {[0, 1, 2].map(i => (
                  <div key={i} className="h-4 animate-pulse rounded bg-muted" />
                ))}
              </div>
            ) : !minLen || q.trim() === '' ? (
              favHits.length > 0 ? (
                <CommandGroup heading={t('core:favGroup')}>
                  {favHits.map(hitRow)}
                </CommandGroup>
              ) : (
                <div className="flex flex-col items-center justify-center gap-1 p-6 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    {t('core:searchEmpty')}
                    <Kbd className="h-4 px-1 text-xs">Esc</Kbd>
                    {t('core:close')}
                  </span>
                  <span>{t('core:searchSyntaxHint')}</span>
                </div>
              )
            ) : groups.length === 0 ? (
              <Empty className="min-h-44 p-4">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchX className="size-4" />
                  </EmptyMedia>
                  <EmptyTitle className="text-[13px]">
                    {tf('core:notFound', { q: q.trim() })}
                  </EmptyTitle>
                  <EmptyDescription className="text-xs">{t('core:notFoundHint')}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              groups.map(g => (
                <CommandGroup key={g.def.kind} heading={g.def.label}>
                  {g.hits.map(hitRow)}
                </CommandGroup>
              ))
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}
