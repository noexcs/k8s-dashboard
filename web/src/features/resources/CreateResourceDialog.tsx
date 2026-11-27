// 资源创建/Apply（YAML → POST collection，409 已存在 → GET 最新 RV → PUT 更新）：
// 通用列表页「+ 创建」入口，等价 kubectl apply -f：多文档逐个处理，空/null 文档跳过，
// 每个文档单独上报，已存在的就地更新（参考 CLI Apply）。
// kind→路径解析复用注册表 + CRD 发现（两者都查不到 → 明确报错，不猜复数名）。
import { useEffect, useMemo, useState } from 'react'
import { parseAllDocuments, stringify } from 'yaml'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Check, ChevronDown, Layers, X } from 'lucide-react'
import { ApiError, get, postObject, putObject } from '@/api/client'
import type { K8sObject } from '@/api/types'
import { tf, useT } from '@/i18n'
import { RESOURCE_MAP, detailRoute, itemPath, kindIconFor, listPath, type AnyResourceDef } from '@/resources/registry'
import { useCrds } from '@/resources/crds'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { YamlEditor } from '@/features/resources/YamlTab'
import {
  BUILTIN_TEMPLATES,
  deleteUserTemplate,
  loadUserTemplates,
  saveUserTemplate,
  type UserTemplates,
} from '@/features/resources/kindTemplates'

/** YAML 单文档解析结果的最小形状（用户输入 → 运行时校验后才可信） */
interface YamlDoc {
  kind: string
  apiVersion: string
  name: string
  namespace?: string
  /** 已通过校验的请求体（kind/apiVersion/metadata.name 必有） */
  body: K8sObject
}

/** 解析 + 校验：形状不合当场报错（消息可直接给 toast） */
function parseDocs(text: string): YamlDoc[] {
  const out: YamlDoc[] = []
  for (const d of parseAllDocuments(text)) {
    const js = d.toJS()
    if (!js || typeof js !== 'object' || Array.isArray(js)) continue
    const rec = js as Record<string, unknown>
    const meta = typeof rec.metadata === 'object' && rec.metadata !== null ? (rec.metadata as Record<string, unknown>) : {}
    if (typeof rec.kind !== 'string' || typeof rec.apiVersion !== 'string') throw new Error(tf('res:createMissingKind'))
    if (typeof meta.name !== 'string' || !meta.name) throw new Error(tf('res:createMissingName'))
    out.push({
      kind: rec.kind,
      apiVersion: rec.apiVersion,
      name: meta.name,
      namespace: typeof meta.namespace === 'string' ? meta.namespace : undefined,
      // 字段已逐项运行时校验，K8sObject 仅描述这些必有字段（整体断言，一次到位）
      body: { ...rec, metadata: { ...meta, name: meta.name } } as unknown as K8sObject,
    })
  }
  if (out.length === 0) throw new Error(tf('res:createEmpty'))
  return out
}

/**
 * 克隆源对象 → 可提交的 YAML（参考 CLI Clone）：剥除服务端生成字段
 * （uid/rv/creationTimestamp/managedFields/status/ownerReferences/生成类 label 与注解），
 * 名称加 -copy 后缀提示用户改名。
 */
export function stripForClone(obj: Record<string, unknown>, newName?: string): string {
  const o: Record<string, unknown> = { ...obj }
  delete o.status
  const spec = o.spec as { template?: { metadata?: { annotations?: Record<string, unknown> } } } | undefined
  delete spec?.template?.metadata?.annotations?.['kubectl.kubernetes.io/last-applied-configuration']
  const m = { ...(o.metadata as Record<string, unknown>) }
  for (const k of ['uid', 'resourceVersion', 'creationTimestamp', 'deletionTimestamp', 'deletionGracePeriodSeconds', 'managedFields', 'ownerReferences', 'generateName', 'generation']) delete m[k]
  if (m.annotations) {
    const ann = { ...(m.annotations as Record<string, unknown>) }
    delete ann['kubectl.kubernetes.io/last-applied-configuration']
    delete ann['deployment.kubernetes.io/revision']
    if (Object.keys(ann).length) m.annotations = ann
    else delete m.annotations
  }
  if (m.labels) {
    const lb = { ...(m.labels as Record<string, unknown>) }
    delete lb['controller-revision-hash']
    delete lb['pod-template-hash']
    if (Object.keys(lb).length) m.labels = lb
    else delete m.labels
  }
  m.name = newName ?? `${String(m.name ?? 'resource')}-copy`
  o.metadata = m
  return stringify(o)
}

/** 编辑器文本 → 首个文档的 kind/apiVersion（用于模板下拉定位与「存为模板」归类；解析失败=手输态） */
function firstDocKind(text: string): { kind: string; apiVersion: string } | null {
  if (!text.trim()) return null
  try {
    for (const d of parseAllDocuments(text)) {
      const js = d.toJS()
      if (!js || typeof js !== 'object' || Array.isArray(js)) continue
      const rec = js as Record<string, unknown>
      if (typeof rec.kind !== 'string') continue
      return { kind: rec.kind, apiVersion: typeof rec.apiVersion === 'string' ? rec.apiVersion : '' }
    }
  } catch {
    // 半截 YAML（编辑中）解析失败 → 视作手输，不报错
  }
  return null
}

export function CreateResourceDialog({
  open,
  onOpenChange,
  cluster,
  ns,
  allDefs,
  initialText,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  cluster: string
  /** 列表页当前命名空间（undefined = 全部命名空间 → 提交用 default） */
  ns: string | undefined
  /** kind → def（RESOURCE_MAP + CRD 发现合并，调用方传入避免重复拉取） */
  allDefs: Record<string, AnyResourceDef>
  /** 预填 YAML（克隆入口用；打开时覆盖编辑器内容） */
  initialText?: string
}) {
  const t = useT()
  const navigate = useNavigate()
  const [text, setText] = useState(initialText ?? BUILTIN_TEMPLATES.ConfigMap)
  const [busy, setBusy] = useState(false)
  // 自定义模板（localStorage）：打开时重读，跨标签页/多次打开保持一致
  const [userTmpl, setUserTmpl] = useState<UserTemplates>({})
  // 「存为模板」小对话框（kind 在打开时定格，避免填名期间编辑器又被改动归错类）
  const [saveFor, setSaveFor] = useState<{ kind: string; name: string } | null>(null)
  // 删除确认（AlertDialog 目标）
  const [pendingDelete, setPendingDelete] = useState<{ kind: string; name: string } | null>(null)
  // 克隆：每次打开都用最新源对象 YAML 覆盖（同页克隆不同资源时 text 不残留）
  useEffect(() => {
    if (open && initialText) setText(initialText)
  }, [open, initialText])
  useEffect(() => {
    if (!open) return
    setUserTmpl(loadUserTemplates())
    setSaveFor(null)
    setPendingDelete(null)
  }, [open])

  const docKind = useMemo(() => firstDocKind(text), [text])
  const builtinKinds = useMemo(() => Object.keys(BUILTIN_TEMPLATES), [])
  const customKinds = useMemo(
    () => Object.keys(userTmpl).filter(k => (userTmpl[k]?.length ?? 0) > 0),
    [userTmpl],
  )
  // 下拉触发器文案：编辑器内容恰好命中某内置模板 → 显示该 kind，否则留空（手输/编辑态）
  const selectedKind = useMemo(() => {
    if (!text.trim()) return null
    return builtinKinds.find(k => BUILTIN_TEMPLATES[k] === text) ?? null
  }, [text, builtinKinds])

  const openSave = () => {
    if (!docKind) {
      toast.error(t('tmpl:saveNoKind'))
      return
    }
    setSaveFor({ kind: docKind.kind, name: `my-${docKind.kind.toLowerCase()}` })
  }
  const confirmSave = () => {
    if (!saveFor) return
    const name = saveFor.name.trim()
    if (!name) return
    const existed = (userTmpl[saveFor.kind] ?? []).some(x => x.name === name)
    setUserTmpl(saveUserTemplate(saveFor.kind, name, text))
    toast.success(tf(existed ? 'tmpl:overwritten' : 'tmpl:saved', { name }))
    setSaveFor(null)
  }
  const confirmDelete = () => {
    if (!pendingDelete) return
    setUserTmpl(deleteUserTemplate(pendingDelete.kind, pendingDelete.name))
    toast.success(tf('tmpl:deleted', { name: pendingDelete.name }))
    setPendingDelete(null)
  }

  const submit = async () => {
    setBusy(true)
    try {
      const docs = parseDocs(text)
      let firstHref: string | null = null
      let createdN = 0
      let updatedN = 0
      for (const doc of docs) {
        const def = allDefs[doc.kind]
        if (!def) throw new Error(tf('res:createUnknownKind', { kind: doc.kind }))
        const useNs = def.scope === 'cluster' ? 'cluster' : (doc.namespace ?? ns ?? 'default')
        // ns 未显式给出且列表页在某 ns 下 → 建到该 ns
        if (def.scope !== 'cluster' && !doc.namespace) doc.body.metadata.namespace = useNs
        const itemHref = itemPath(def, useNs, doc.body.metadata.name)
        try {
          const created = await postObject(cluster, listPath(def, def.scope === 'cluster' ? undefined : useNs), doc.body, '表单/编辑器创建资源')
          createdN += 1
          firstHref ??= detailRoute(def, cluster, useNs, created.metadata.name)
        } catch (e) {
          // 已存在 → apply 语义：取服务端最新 resourceVersion 覆盖本地值后 PUT
          if (!(e instanceof ApiError) || e.status !== 409) throw e
          const cur = await get<K8sObject>(cluster, itemHref)
          await putObject(cluster, itemHref, { ...doc.body, metadata: { ...doc.body.metadata, resourceVersion: cur.metadata.resourceVersion } }, '已存在→Apply 覆盖（YAML/编辑器）')
          updatedN += 1
          firstHref ??= detailRoute(def, cluster, useNs, cur.metadata.name)
        }
      }
      toast.success(tf(updatedN ? 'res:applySuccess' : 'res:createSuccess', { n: createdN, m: updatedN }))
      onOpenChange(false)
      if (firstHref) navigate(firstHref)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => !busy && onOpenChange(v)}>
      {/* 高度自适应内容、上限 85vh：短模板→紧凑弹窗；长内容→封顶后编辑器内部滚动。
          保留基类 p-4（footer 的 -mx-4/-mb-4 负边距抵消它贴边，是官方设计语义）；
          sm:max-w-4xl 不可省：基类 sm:max-w-lg 只在 sm 断点生效，会压过无前缀 max-w-4xl */}
      <DialogContent className="flex max-h-[85vh] w-[92vw] max-w-4xl flex-col gap-0 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('res:createTitle')}</DialogTitle>
          <DialogDescription>{t('res:createDesc')}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mt-3 mb-2 flex shrink-0 flex-wrap items-center gap-2">
            {/* kind 下拉：内置模板（registry 全量）+ 自定义模板分组；插入=整段替换 */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <Layers />
                  {selectedKind ?? t('tmpl:templates')}
                  <ChevronDown className="opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-[50vh] w-52">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('tmpl:builtIn')}</DropdownMenuLabel>
                  {builtinKinds.map(k => (
                    <DropdownMenuItem key={k} onSelect={() => setText(BUILTIN_TEMPLATES[k])}>
                      <Check className={selectedKind === k ? 'opacity-100' : 'opacity-0'} />
                      {(() => {
                        const Icon = kindIconFor(k)
                        return <Icon className="size-3.5 text-muted-foreground" />
                      })()}
                      {k}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                {customKinds.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{t('tmpl:custom')}</DropdownMenuLabel>
                      {customKinds.map(kind => (
                        <div key={kind}>
                          <div className="flex items-center gap-1.5 px-1.5 pt-1 text-[13px] font-medium text-muted-foreground">
                            {(() => {
                              const Icon = kindIconFor(kind)
                              return <Icon className="size-3.5" />
                            })()}
                            {kind}
                          </div>
                          {userTmpl[kind].map(tp => (
                            <DropdownMenuItem
                              key={`${kind}/${tp.name}`}
                              className="pr-1"
                              onSelect={() => setText(tp.yaml)}
                            >
                              <span className="flex-1 truncate">{tp.name}</span>
                              {/* 删除入口 stopPropagation 保住菜单焦点，弹确认后才真正删除 */}
                              <button
                                type="button"
                                className="hidden rounded-sm p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover/dropdown-menu-item:block"
                                aria-label={t('tmpl:delete')}
                                onPointerDown={e => e.stopPropagation()}
                                onClick={e => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  setPendingDelete({ kind, name: tp.name })
                                }}
                              >
                                <X className="size-3" />
                              </button>
                            </DropdownMenuItem>
                          ))}
                        </div>
                      ))}
                    </DropdownMenuGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* 追加（多文档）：非空时以 --- 分隔接在现有内容后，空则直接替换 */}
            <Button
              variant="ghost"
              disabled={!selectedKind}
              onClick={() => {
                // 追加只在当前内容恰好是内置模板时有意义（自定义/手输内容不知要追加什么）
                if (!selectedKind) return
                setText(prev => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n---\n${BUILTIN_TEMPLATES[selectedKind]}` : BUILTIN_TEMPLATES[selectedKind]))
              }}
            >
              + {t('tmpl:append')}
            </Button>
            <Button variant="ghost" onClick={() => setText('')}>
              {t('res:createBlank')}
            </Button>
            <div className="flex-1" />
            <Button variant="outline" disabled={!docKind} onClick={openSave}>
              {t('tmpl:saveAs')}
            </Button>
          </div>
          {/* 编辑器 auto-grow：内容短则弹窗收缩，到 85vh 封顶才轮到 wrapper 滚动；
              min-h-48 给空白态保底高度，避免一两条内容撑成细长条 */}
          <div className="min-h-0 flex-1 overflow-auto pb-2">
            <YamlEditor className="min-h-48" value={text} onChange={setText} title={t('res:createTitle')} filename="create.yaml" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('res:cancel')}
          </Button>
          <Button disabled={busy || !text.trim()} onClick={() => void submit()}>
            {busy ? t('res:creating') : t('res:createSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* 「存为模板」：嵌在创建对话框内（Radix 支持 Dialog 套 Dialog） */}
      <Dialog open={saveFor !== null} onOpenChange={v => !v && setSaveFor(null)}>
        <DialogContent className="max-w-sm gap-3">
          <DialogHeader>
            <DialogTitle>{t('tmpl:saveTitle')}</DialogTitle>
            <DialogDescription>{tf('tmpl:saveDesc', { kind: saveFor?.kind ?? '' })}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={saveFor?.name ?? ''}
            onChange={e => setSaveFor(s => (s ? { ...s, name: e.target.value } : s))}
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && confirmSave()}
            placeholder={t('tmpl:saveName')}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveFor(null)}>
              {t('tmpl:cancel')}
            </Button>
            <Button disabled={!saveFor?.name.trim()} onClick={confirmSave}>
              {t('tmpl:saveConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除自定义模板：hover ✕ 只置 pending，确认后才落盘 */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={v => !v && setPendingDelete(null)}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tmpl:deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tf('tmpl:deleteDesc', { name: pendingDelete?.name ?? '', kind: pendingDelete?.kind ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('tmpl:cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              {t('tmpl:delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}

/** RESOURCE_MAP 与 CRD 发现的 def 合并（内置优先） */
export function useDefMap(cluster: string | undefined): Record<string, AnyResourceDef> {
  const { defs } = useCrds(cluster)
  return useMemo(() => ({ ...Object.fromEntries(defs.map(d => [d.kind, d])), ...RESOURCE_MAP }), [defs])
}
