// Prompt Input：shadcn AI Elements 官方 pattern（ui.shadcn.com/docs/ai-elements/radix/prompt-input.md）的组件化落盘。
// 消息输入区 = InputGroup + 附件行（sr-only file input + Attachment chips）+ 模型选择器 + 发送/停止。
// 附件状态组件内部自持：文本类文件（≤50KB）读内容，二进制/超限只留文件名；发送时随 onSend 交给调用方拼消息。
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { ArrowUp, ChevronDown, FileText, Lock, Plus, ShieldCheck, Square, X, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AiPermission } from '@/api/ai'
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { tf, useT } from '@/i18n'

/** 传给 onSend 的附件：content 仅文本类文件有值（二进制/超限不带该字段） */
export interface PromptInputFile {
  name: string
  content?: string
}

interface PromptInputProps {
  value: string
  onChange: (value: string) => void
  /** 发送：text 未 trim；files 为已读附件（content 可缺省），调用方负责拼消息与清空 value */
  onSend: (text: string, files: PromptInputFile[]) => void
  /** busy：发送按钮变停止按钮（Square），调用方传 stop 行为 */
  busy: boolean
  onStop: () => void
  /** 网关未配置等场景：禁用输入/附件/模型选择 */
  disabled: boolean
  models: { id: string; name: string }[]
  selectedModel: string
  onModelChange: (id: string) => void
  /** 工具执行权限（只读/写确认/完全权限），随每次发送下发 */
  permission: AiPermission
  onPermissionChange: (p: AiPermission) => void
  placeholder?: string
  /** 输入框附加 class（紧凑模式收缩高度等，twMerge 覆盖内置 min-h） */
  className?: string
  /** dock 悬浮面板等窄容器（420px）：隐藏 Enter 提示——md: 是视口断点不随容器，hint 会折 3 行挤掉发送钮 */
  compact?: boolean
}

/** 权限三档（与服务端 PERMISSION_MODES 对应；图标仅 UI；label 为 i18n key，渲染处 t() 取值） */
const PERMISSION_OPTIONS: { id: AiPermission; label: string; icon: LucideIcon }[] = [
  { id: 'readonly', label: 'ui:permReadonly', icon: Lock },
  { id: 'confirm', label: 'ui:permConfirm', icon: ShieldCheck },
  { id: 'full', label: 'ui:permFull', icon: Zap },
]

/** 内部附件条目：id 仅组件内做 key/删除用（计数生成，不依赖 secure context 的 crypto.randomUUID） */
interface InternalFile extends PromptInputFile {
  id: string
}

/** 单附件 50KB 上限（控上下文）；超限不读内容 */
const MAX_ATTACH_BYTES = 50 * 1024

export function PromptInput({
  value,
  onChange,
  onSend,
  busy,
  onStop,
  disabled,
  models,
  selectedModel,
  onModelChange,
  permission,
  onPermissionChange,
  placeholder = 'ui:promptPlaceholder',
  className,
  compact = false,
}: PromptInputProps) {
  const t = useT()
  const [files, setFiles] = useState<InternalFile[]>([])
  // 「完全权限」需菜单内二次确认：pendingFull = 已点选但未确认
  const [pendingFull, setPendingFull] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const attachUid = useRef(0)
  const canSend = value.trim().length > 0 && !busy && !disabled

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!canSend) return
    // 无内容的附件不带 content 字段，由调用方决定如何呈现
    onSend(value, files.map(({ name, content }) => (content == null ? { name } : { name, content })))
    setFiles([])
  }

  // 附件：文本类文件（≤50KB）读入内容；二进制/超限只留文件名（k8s 场景：贴 YAML 问 AI）
  const onAttach = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files
    if (!selected) return
    // 先快照再清空：FileList 是活动引用，value 一旦清空会原地清空列表（重复选同一文件也会丢）
    const list = Array.from(selected)
    e.target.value = ''
    if (list.length === 0) return
    void (async () => {
      const items: InternalFile[] = []
      for (const f of list) {
        let content: string | null = null
        const name = f.name.toLowerCase()
        const textLike =
          f.type.startsWith('text/') || f.type === '' || /\.(ya?ml|json|md|txt|log|csv)$/.test(name)
        if (textLike && f.size <= MAX_ATTACH_BYTES) {
          try {
            const t = await f.text()
            content = t.includes('\uFFFD') ? null : t // 替换符 = 二进制被误标为文本
          } catch {
            content = null
          }
        }
        attachUid.current += 1
        items.push({ id: `attach-${attachUid.current}`, name: f.name, content: content ?? undefined })
      }
      setFiles(cur => [...cur, ...items])
    })()
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="w-full">
      {/* 附件选择：sr-only（pattern 同款），multiple，点击 Plus 触发 */}
      <input
        ref={fileRef}
        type="file"
        multiple
        tabIndex={-1}
        className="sr-only"
        aria-label={t('ui:attachFile')}
        onChange={onAttach}
      />
      <InputGroup className="has-[[data-slot=input-group-control]:focus-visible]:border-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring">
        {files.length > 0 && (
          <InputGroupAddon align="block-start" className="flex-wrap">
            {files.map(f => (
              <Attachment key={f.id} size="sm">
                <AttachmentMedia>
                  <FileText />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{f.name}</AttachmentTitle>
                  {f.content == null && <AttachmentDescription>{t('ui:attachNoContent')}</AttachmentDescription>}
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction
                    aria-label={tf('ui:removeFile', { name: f.name })}
                    onClick={() => setFiles(cur => cur.filter(x => x.id !== f.id))}
                  >
                    <X />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            ))}
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          value={value}
          rows={1}
          onChange={e => onChange(e.target.value)}
          placeholder={t(placeholder)}
          aria-label={t('ui:message')}
          disabled={disabled}
          className={cn('max-h-32 min-h-10 text-sm', className)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              formRef.current?.requestSubmit()
            }
          }}
        />
        <InputGroupAddon align="block-end">
          <InputGroupButton
            type="button"
            size="icon-sm"
            variant="outline"
            className="rounded-full"
            aria-label={t('ui:attachFile')}
            onClick={() => fileRef.current?.click()}
          >
            <Plus />
          </InputGroupButton>
          {models.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <InputGroupButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={tf('ui:modelAria', { v: selectedModel })}
                >
                  {/* 随机前缀的模型全名可达 30+ 字符：截断，否则 addon 行 min-content 撑爆 dock */}
                  <span className="max-w-[8.5rem] truncate" title={selectedModel}>
                    {selectedModel}
                  </span>
                  <ChevronDown />
                </InputGroupButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuRadioGroup value={selectedModel} onValueChange={onModelChange}>
                  {models.map(m => (
                    <DropdownMenuRadioItem key={m.id} value={m.id}>
                      {m.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* 工具执行权限：只读（写操作拒绝）/ 写确认（写操作逐个批准）/ 完全权限（直接执行） */}
          <DropdownMenu onOpenChange={o => { if (!o) setPendingFull(false) }}>
            <DropdownMenuTrigger asChild>
              <InputGroupButton
                type="button"
                size="sm"
                variant="ghost"
                aria-label={tf('ui:permissionAria', { v: t(PERMISSION_OPTIONS.find(p => p.id === permission)?.label ?? permission) })}
              >
                {(() => {
                  const PermIcon = PERMISSION_OPTIONS.find(p => p.id === permission)?.icon ?? ShieldCheck
                  return <PermIcon className={cn('size-3.5', permission === 'full' && 'text-caution')} />
                })()}
                {t(PERMISSION_OPTIONS.find(p => p.id === permission)?.label ?? permission)}
                <ChevronDown />
              </InputGroupButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuRadioGroup
                value={permission}
                onValueChange={v => {
                  // Radix 点击 RadioItem 的 onClick 会直接推 onValueChange，onSelect 的
                  // preventDefault 拦不住值变更，只拦得住关菜单——档位生效必须在这层挡（ux#36）
                  if (v === 'full' && permission !== 'full') return
                  setPendingFull(false)
                  onPermissionChange(v as AiPermission)
                }}
              >
                {PERMISSION_OPTIONS.map(p => (
                  <DropdownMenuRadioItem
                    key={p.id}
                    value={p.id}
                    className={p.id === 'full' ? 'text-caution' : undefined}
                    // full 首次点选：不关菜单，就地露出确认项，点确认才真正生效
                    onSelect={p.id === 'full' && permission !== 'full' ? e => { e.preventDefault(); setPendingFull(true) } : undefined}
                  >
                    <p.icon className="size-3.5" />
                    {t(p.label)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {pendingFull && (
                <DropdownMenuItem className="gap-1.5 text-caution focus:text-caution" onClick={() => { setPendingFull(false); onPermissionChange('full') }}>
                  <Zap className="size-3.5" />
                  {t('ui:permFullConfirm')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {!compact && (
            // 与全局搜索 ⌘K 同一 keycap 签名(仓库已有 Kbd + index.css keycap 样式),纯文本会读成正文
            <span className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground md:flex">
              <Kbd className="h-4 text-[10px]">Enter</Kbd> {t('ui:kbdSend')} ·{' '}
              <Kbd className="h-4 px-1 text-[10px]">⇧</Kbd>
              <Kbd className="h-4 px-1 text-[10px]">⏎</Kbd> {t('ui:kbdNewline')}
            </span>
          )}
          {/* 发送↔停止单按钮双图标叠放：纯 opacity crossfade（键盘触发路径,去 scale） */}
          <InputGroupButton
            type={busy ? 'button' : 'submit'}
            variant={busy ? 'secondary' : 'default'}
            size="icon-sm"
            className="rounded-full"
            aria-label={busy ? t('ui:stopGeneration') : t('ui:send')}
            disabled={!busy && !canSend}
            onClick={busy ? onStop : undefined}
          >
            <span aria-hidden className="relative inline-grid place-items-center">
              <ArrowUp className={cn('col-start-1 row-start-1 transition-opacity duration-100', busy ? 'opacity-0' : 'opacity-100')} />
              <Square className={cn('col-start-1 row-start-1 transition-opacity duration-100', busy ? 'opacity-100' : 'opacity-0')} />
            </span>
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}
