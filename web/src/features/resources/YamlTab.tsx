// YAML 查看/编辑/Apply 共享逻辑：通用资源详情页 + Pod 详情页共用。
// 乐观锁由 API server 校验 resourceVersion；409 → conflict 对话框让用户重新加载。
// 查询缓存 key ['yaml', cluster, path] 与页面无关，同一路径跨页共享。
import { FileCodeIcon } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { parse } from 'yaml'
import { ApiError, getAsYaml, putObject } from '@/api/client'
import type { K8sObject } from '@/api/types'
import { cn } from '@/lib/utils'
import { diffLines } from '@/lib/diff'
import { useT } from '@/i18n'
import { useCodeActions } from '@/components/code-actions'
import { toast } from 'sonner'
import { useHighlightedCode } from '@/hooks/use-highlighted-code'
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from '@/components/ui/code-block'

/** YAML 数据 + 编辑态 + Apply/冲突处理（调用方用 usePermissions 自行门控按钮） */
export function useYamlEdit({ cluster, path }: { cluster: string; path: string }) {
  const t = useT()
  const queryClient = useQueryClient()
  const { data: yamlText, isLoading, error } = useQuery({
    queryKey: ['yaml', cluster, path],
    queryFn: () => getAsYaml(cluster, path),
    enabled: !!path,
  })

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)

  const startEdit = useCallback(() => {
    setEditing(true)
    setDraft(yamlText ?? '')
  }, [yamlText])

  const discard = useCallback(() => {
    setEditing(false)
    setDraft('')
    setApplyError(null)
  }, [])

  const doApply = useCallback(async () => {
    setApplying(true)
    setApplyError(null)
    try {
      const doc: unknown = parse(draft)
      if (!doc || typeof doc !== 'object' || !('kind' in doc)) {
        throw new Error(t('res:yamlMissingKind'))
      }
      const obj = doc as K8sObject
      // 乐观锁由 API server 校验 resourceVersion
      await putObject(cluster, path, obj, 'YAML 编辑 Apply')
      queryClient.invalidateQueries({ queryKey: ['yaml', cluster, path] })
      setEditing(false)
      toast.success(t('res:yamlApplied'))
    } catch (err) {
      if (err instanceof ApiError && err.isConflict) setConflict(true)
      else setApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }, [cluster, path, draft, queryClient, t])

  // 409 冲突后重新加载：放弃本地草稿，拉取服务端最新 YAML
  const reloadYaml = useCallback(() => {
    setConflict(false)
    setEditing(false)
    setDraft('')
    setApplyError(null)
    queryClient.invalidateQueries({ queryKey: ['yaml', cluster, path] })
  }, [cluster, path, queryClient])

  // 切换资源（path 变化）时由页面 effect 调用：清编辑态
  const reset = useCallback(() => {
    setEditing(false)
    setDraft('')
    setApplyError(null)
    setConflict(false)
  }, [])

  return {
    yamlText,
    isLoading,
    error,
    editing,
    draft,
    startEdit,
    discard,
    setDraft,
    applying,
    applyError,
    doApply,
    conflict,
    setConflict,
    reloadYaml,
    reset,
  }
}

/**
 * YAML 编辑：底层 = 预览同款 shiki 高亮层（只读显示），上层 = 文字透明的 textarea（真实输入）。
 * 单一滚动器 = 外层 tab 面板：卡片与 pre 都随内容全高展开（textarea 用 rows 撑满），
 * 整卡随外层一起滚——滚动条在面板外缘，与预览态一致。
 * 高亮 span 本身不可编辑（contentEditable 会切碎 token、光标需手动重算），
 * 这是 CodeMirror/Monaco 之外的轻量等价方案。
 */
export function YamlEditor({ value, onChange, title, filename, className }: {
  value: string
  onChange: (v: string) => void
  title: string
  filename: string
  /** 追加到 CodeBlock 根（对话框里传 min-h-48 给空白态保底高度） */
  className?: string
}) {
  const t = useT()
  // 与详情页 YAML 查看区同一套工具行（下载/复制）；软换行不提供——双层结构下必错位
  const { actions } = useCodeActions(value, filename, { wrapToggle: false })
  const lines = useHighlightedCode(value, 'yaml')
  // bg 是 absolute 不撑开宽度；textarea 的 cols 决定 code 的 min-w-max →
  // pre 横向滚动条必须覆盖到最长行，两层才能一起滚到行尾
  const maxLine = useMemo(() => value.split('\n').reduce((m, l) => Math.max(m, l.length), 0), [value])
  // 行号列宽随最大行号的位数变化（grid auto 列由行号内容撑开，与预览官方行为一致）。
  // 等宽字体下行号宽 = 位数 × 1ch，textarea 用同样的 ch 公式对齐文字列起点。
  const numDigits = String(Math.max(1, lines.length)).length
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [composing, setComposing] = useState(false)

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
    // 光标移出滚动视口时跟随：向上找第一个真正滚动的祖先（tab 面板）
    const ta = taRef.current
    let scroller = ta?.parentElement?.parentElement ?? null
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
    if (ta && scroller) {
      const lineEl = scroller.querySelector('[data-slot=code-block-line]')
      const lh = lineEl ? lineEl.getBoundingClientRect().height : 22.75
      const line = ta.value.slice(0, ta.selectionStart ?? 0).split('\n').length - 1
      const taTop = ta.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      const yTop = taTop + line * lh
      const yBot = yTop + lh
      if (yTop < scroller.scrollTop) scroller.scrollTop = yTop
      else if (yBot > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = yBot - scroller.clientHeight
    }
  }

  return (
    <CodeBlock className={className}>
      <CodeBlockHeader>
        <CodeBlockTitle>
          <FileCodeIcon />
          {title}
        </CodeBlockTitle>
        {actions}
      </CodeBlockHeader>
      <CodeBlockContent
        lineNumbers
        className="[&>code]:block [&>code]:relative"
      >
        {/* auto 行号列 + content-start，与预览官方 grid 完全同款：
            行号列宽随行号位数撑开；定高 grid 不拉伸 auto 行（拉伸会使行距漂移 0.12px/行） */}
        <div aria-hidden className="pointer-events-none absolute inset-0 grid grid-cols-[auto_1fr] content-start">
          {lines.map((line, i) => (
            <CodeBlockLine key={i}>{line}</CodeBlockLine>
          ))}
        </div>
        <textarea
          ref={taRef}
          value={value}
          onChange={handleChange}
          rows={Math.max(1, value.split('\n').length)}
          cols={Math.max(20, maxLine + 1)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          wrap="off"
          spellCheck={false}
          aria-label={t('res:editingHint')}
          style={{ paddingLeft: `calc(${numDigits}ch + 12px)` }}
          className={cn(
            // padding-left 走 style：行号列 auto 宽（位数×1ch）+ gap-x-3(12px)，与预览文字列起点一致
            'relative w-full resize-none border-0 bg-transparent py-0 pr-0 font-mono text-sm leading-relaxed caret-foreground outline-none',
            // 输入法组合期文字必须可见（未提交的字符还不在 value 里，高亮层没有）
            composing ? 'text-foreground' : 'text-transparent',
          )}
        />
      </CodeBlockContent>
    </CodeBlock>
  )
}

/** YAML 查看：shadcn CodeBlock（shiki 高亮 + 行号 + 复制）；编辑模式用 YamlEditor */
export function YamlView({ yamlText, kind, name }: { yamlText: string; kind: string; name: string }) {
  const lines = useHighlightedCode(yamlText, 'yaml')
  const { wrap, actions } = useCodeActions(yamlText, `${kind.toLowerCase()}-${name}.yaml`)
  return (
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>
          <FileCodeIcon />
          {kind}/{name}
        </CodeBlockTitle>
        {actions}
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers wrap={wrap}>
        {lines.map((line, i) => (
          <CodeBlockLine key={i}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

/** 编辑预览 diff：draft vs 服务端 yamlText（参考 CLI 保存前 diff）。折叠态仅显示改动行数 */
export function YamlDiff({ base, draft }: { base: string; draft: string }) {
  const t = useT()
  const ops = useMemo(() => diffLines(base, draft), [base, draft])
  const changed = ops.filter(o => o.type !== 'same').length
  if (changed === 0)
    return <div className="rounded-md border px-3 py-2 text-[13px] text-muted-foreground">{t('res:diffNone')}</div>
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-md border bg-card">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b bg-muted/40 px-2.5 text-xs text-muted-foreground">
        <FileCodeIcon className="size-3" />
        {t('res:diffTitle')}
        <span className="ml-auto font-mono">
          +{ops.filter(o => o.type === 'add').length} −{ops.filter(o => o.type === 'del').length}
        </span>
      </div>
      <div className="scrollbar-thin max-h-64 overflow-auto font-mono text-xs leading-5">
        {ops.map((o, i) =>
          o.type === 'same' ? null : (
            <div
              key={i}
              className={cn(
                'flex gap-2 whitespace-pre px-2',
                o.type === 'add' ? 'bg-positive/10 text-positive' : 'bg-destructive/10 text-destructive',
              )}
            >
              <span className="w-3 shrink-0 select-none">{o.type === 'add' ? '+' : '−'}</span>
              <span className="min-w-0">{o.text || ' '}</span>
            </div>
          ),
        )}
      </div>
    </div>
  )
}
