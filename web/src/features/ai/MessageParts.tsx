// AI 聊天的消息片段渲染层（与 AiChat 主体分离：主体只管 useChat 会话/输入/历史）。
// 与服务端 UIMessageStream 的 part 形状同构：reasoning / tool-* / dynamic-tool。
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Check,
  CircleCheck,
  Copy,
  Pencil,
  RotateCcw,
  Search,
  ShieldAlert,
  Terminal,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AiChatMessage } from '@/api/ai'
import { tf, useT } from '@/i18n'
import { highlightCode } from '@/lib/highlighter'
import { clipboardWrite } from '@/lib/clipboard'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CodeBlock, CodeBlockContent, CodeBlockLine } from '@/components/ui/code-block'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'

export type ChatPart = AiChatMessage['parts'][number]
export type TextPart = Extract<ChatPart, { type: 'text' }>
export type ReasoningPart = Extract<ChatPart, { type: 'reasoning' }>
export type ToolPart = Extract<ChatPart, { type: `tool-${string}` } | { type: 'dynamic-tool' }>

/** 26 个工具 → 3 类字形(只读 Search/写 Pencil/执行 Terminal)。图标只分类不叙事,mono 工具名是
 * 唯一精确标识;中文标题已承载语义(unslop 二轮:26 字形超记忆容量,Stethoscope=诊断、
 * Wind=drain 属双关装饰,Send 与输入区发送语义撞车) */
const TOOL_META: Record<string, { icon: LucideIcon; label: string }> = {
  cluster_overview: { icon: Search, label: 'ai:toolClusterOverview' },
  top: { icon: Search, label: 'ai:toolTop' },
  list_pods: { icon: Search, label: 'ai:toolListPods' },
  get_pod: { icon: Search, label: 'ai:toolGetPod' },
  pod_logs: { icon: Search, label: 'ai:toolPodLogs' },
  list_events: { icon: Search, label: 'ai:toolListEvents' },
  list_deployments: { icon: Search, label: 'ai:toolListDeployments' },
  helm_releases: { icon: Search, label: 'ai:toolHelmReleases' },
  node_view: { icon: Search, label: 'ai:toolNodeView' },
  diff_yaml: { icon: Search, label: 'ai:toolDiffYaml' },
  diagnose: { icon: Search, label: 'ai:toolDiagnose' },
  inspect_report: { icon: Search, label: 'ai:toolInspectReport' },
  k8s_get: { icon: Search, label: 'ai:toolK8sGet' },
  drain: { icon: Pencil, label: 'ai:toolDrain' },
  disposition_set: { icon: Pencil, label: 'ai:toolDispositionSet' },
  k8s_request: { icon: Pencil, label: 'ai:toolK8sRequest' },
  apply_yaml: { icon: Pencil, label: 'ai:toolApplyYaml' },
  delete_resource: { icon: Pencil, label: 'ai:toolDeleteResource' },
  scale: { icon: Pencil, label: 'ai:toolScale' },
  rollout: { icon: Pencil, label: 'ai:toolRollout' },
  wait_rollout: { icon: Search, label: 'ai:toolWaitRollout' },
  patch_resource: { icon: Pencil, label: 'ai:toolPatchResource' },
  helm_install: { icon: Pencil, label: 'ai:toolHelmInstall' },
  helm_upgrade: { icon: Pencil, label: 'ai:toolHelmUpgrade' },
  helm_uninstall: { icon: Pencil, label: 'ai:toolHelmUninstall' },
  helm_rollback: { icon: Pencil, label: 'ai:toolHelmRollback' },
  exec_pod: { icon: Terminal, label: 'ai:toolExecPod' },
}

export function StepRow({ part, streaming, staleResend, onStaleResend }: { part: ReasoningPart | ToolPart; streaming: boolean; staleResend?: string; onStaleResend?: (text: string) => void }) {
  if (part.type === 'reasoning') {
    return <ReasoningRow text={part.text} running={part.state === 'streaming'} />
  }
  return <ToolRow part={part} streaming={streaming} staleResend={staleResend} onStaleResend={onStaleResend} />
}

/**
 * 思考行：shadcn 官方 Reasoning 模式（ui.shadcn.com/docs/ai-elements/base/reasoning）。
 * 一条 reasoning part 一行；文本到达前只渲染纯 TraceLine（无可展开内容）；
 * 流式中 open、结束 close（用户手动开关优先：open 未设置时跟随 running）；
 * 结束时在 TraceDescription 显示耗时（AI SDK 不计时，客户端近似；历史消息无起点不显示）。
 */
function ReasoningRow({ text, running }: { text: string; running: boolean }) {
  const t = useT()
  const [open, setOpen] = useState<boolean>()
  const startRef = useRef<number | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  useEffect(() => {
    if (running && startRef.current == null) startRef.current = Date.now()
    if (!running && text && startRef.current != null && duration == null) {
      setDuration(Math.max(1, Math.round((Date.now() - startRef.current) / 1000)))
    }
  }, [running, text, duration])

  const line = (
    <TraceLine status={running ? 'running' : undefined} className="text-[13px]">
      <TraceIcon>
        {running ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : <CircleCheck className="size-3.5" />}
      </TraceIcon>
      <TraceTitle className="text-[13px]">{running ? t('ai:thinking') : t('ai:thinkingDone')}</TraceTitle>
      {!running && duration != null && <TraceDescription className="font-mono text-xs">{duration}s</TraceDescription>}
    </TraceLine>
  )

  if (!text) return line

  return (
    <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      {/* 思考内容也是 markdown（列表/加粗/代码常见）：与正文同一 Markdown 组件，字号继承容器 text-[13px] */}
      <TraceCollapsibleContent className="text-[13px] leading-5">
        <Markdown>{text}</Markdown>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/** JSON 高亮代码块：可解析 JSON 用 json 语法，否则 yaml 兜底（yaml 词法宽容，
 *  普通文本/错误信息也能正常着色）；高亮器加载前按纯文本先渲染。 */
function JsonCode({ text, maxH }: { text: string; maxH?: string }) {
  const [lines, setLines] = useState<ReactNode[] | null>(null)
  useEffect(() => {
    let cancelled = false
    setLines(null)
    let lang = 'yaml'
    try {
      JSON.parse(text)
      lang = 'json'
    } catch {
      /* 非 JSON → yaml 兜底 */
    }
    void highlightCode(text, lang).then(l => {
      if (!cancelled) setLines(l)
    })
    return () => {
      cancelled = true
    }
  }, [text])
  return (
    <CodeBlock size="sm">
      <CodeBlockContent wrap className={maxH}>
        {lines == null ? (
          <CodeBlockLine>{text}</CodeBlockLine>
        ) : (
          lines.map((line, i) => <CodeBlockLine key={i}>{line}</CodeBlockLine>)
        )}
      </CodeBlockContent>
    </CodeBlock>
  )
}

export function CopyAnswer({ text }: { text: string }) {
  const t = useT()
  const [ok, setOk] = useState(false)
  return (
    <Button
      variant="ghost"
      size="xs"
      className="w-fit gap-1 px-1.5 text-muted-foreground"
      onClick={() => {
        void clipboardWrite(text).then(() => {
          setOk(true)
          setTimeout(() => setOk(false), 1200)
        })
      }}
    >
      {ok ? <Check className="size-3" /> : <Copy className="size-3" />}
      {ok ? t('ui:copied') : t('ui:copy')}
    </Button>
  )
}

function ToolRow({ part, streaming, staleResend, onStaleResend }: { part: ToolPart; streaming: boolean; staleResend?: string; onStaleResend?: (text: string) => void }) {
  const t = useT()
  // 服务端工具 part：type 为 tool-<name>（dynamic-tool 兜底）
  const name = part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length)
  const meta = TOOL_META[name] ?? { icon: Wrench, label: name }
  const Icon = meta.icon
  const denied = part.state === 'output-denied'
  const approved = part.state === 'approval-responded'
  const done = part.state === 'output-available' || part.state === 'output-error' || denied
  // 断线失效 ≠ 执行失败（未作用于集群）：中性状态+短标直显于行标题，不混进红色失败堆
  const isStale = 'stale' in part && part.stale === true
  const failed = (part.state === 'output-error' || denied) && !isStale
  // 执行参数（part.input）：input-streaming 期间 JSON 不完整，只展示在展开区（完成时）
  const hasInput =
    part.input !== undefined &&
    part.input !== null &&
    (typeof part.input === 'string'
      ? part.input.length > 0
      : typeof part.input === 'object' && Object.keys(part.input).length > 0)
  const inputText = hasInput
    ? typeof part.input === 'string'
      ? part.input
      : JSON.stringify(part.input, null, 2)
    : ''
  // 同类调用连排(list_pods×2/get_pod×3)不展开无法区分查了谁：行内追加首个关键参数
  const argHint = (() => {
    if (!hasInput || typeof part.input !== 'object' || part.input === null) return ''
    const o = part.input as Record<string, unknown>
    const v = o.name ?? o.namespace ?? o.label_selector ?? o.container ?? Object.values(o).find(x => typeof x === 'string')
    if (typeof v !== 'string' || !v) return ''
    return ` · ${v.length > 24 ? `${v.slice(0, 24)}…` : v}`
  })()

  if (approved) {
    // 已批准、等结果：审批续流（下一个 /chat 请求）会把 tool-output 流回本消息。
    // 续流失败（审批 TTL 过期 / 集群 403 / 会话丢失）时 part 永远停在 responded，
    // SDK 不提供回滚——挂起态如实给出自救口径（R2 P2-2），别伪装成"执行中"。
    return (
      <TraceLine status={streaming ? 'running' : 'pending'} className="text-[13px]">
        <TraceIcon>
          <Icon className="size-3.5" />
        </TraceIcon>
        <TraceTitle className="text-[13px]">{t(meta.label)}</TraceTitle>
        <TraceDescription className="font-mono text-xs text-muted-foreground">
          {name} · {streaming ? t('ai:approvedRunning') : t('ai:approvalStalled')}
        </TraceDescription>
      </TraceLine>
    )
  }

  if (!done) {
    // input-streaming / input-available：执行中 —— 行内只显示「中文标题 + 工具名」
    return (
      <TraceLine status={streaming ? 'running' : 'pending'} className="text-[13px]">
        <TraceIcon>
          <Icon className="size-3.5" />
        </TraceIcon>
        <TraceTitle className="text-[13px]">{t(meta.label)}</TraceTitle>
        <TraceDescription className="font-mono text-xs text-muted-foreground">{name}</TraceDescription>
      </TraceLine>
    )
  }

  // output-available / output-error / output-denied：行内「中文标题 + 工具名」，展开区看完整参数 + 结果（高亮）
  const body = denied
    ? t('ai:deniedBody')
    : failed
      ? part.errorText
      : typeof part.output === 'string'
        ? part.output
        : JSON.stringify(part.output, null, 2)
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={failed ? 'error' : undefined} className="text-[13px]">
          <TraceIcon>
            <Icon className="size-3.5" />
          </TraceIcon>
          <TraceTitle className="text-[13px]">{isStale ? tf('ai:staleLabel', { label: t(meta.label) }) : denied ? t('ai:denied') : failed ? tf('ai:failedLabel', { label: t(meta.label) }) : t(meta.label)}</TraceTitle>
          <TraceDescription className="min-w-0 truncate font-mono text-xs text-muted-foreground">{name}{argHint}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="space-y-2">
        {inputText && (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">{t('ai:params')}</div>
            <JsonCode text={inputText} maxH="max-h-40" />
          </div>
        )}
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">{failed ? t('ai:error') : t('ai:result')}</div>
          {body ? <JsonCode text={body} maxH="max-h-60" /> : <div className="text-[13px] text-muted-foreground">{t('ai:noOutput')}</div>}
          {staleResend && isStale && (
            // 断线失效的写操作：一键把原始请求灌回输入框（不自动发——写操作仍须用户过一遍确认门）
            <Button variant="outline" size="xs" className="gap-1" title={name} onClick={() => onStaleResend?.(staleResend)}>
              <RotateCcw className="size-3" />
              {t('ai:staleRefill')}
            </Button>
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/** 写确认批准卡（原生工具 part，state=approval-requested）：
 *  shadcn chat pattern：pending approval 是「提示」不是「活动」，渲染在 Trace 之外。
 *  批准/拒绝 → useChat 原生 addToolApprovalResponse（part 置 approval-responded）→
 *  sendAutomaticallyWhen 自动重发 /chat（approvals 续流请求，服务端 resolve 挂起的门）。
 *  历史消息里的同状态 part 已裁决完毕（output-*），不会走到这里。 */
export function ApprovalRow({
  part,
  onRespond,
  onAllowSession,
}: {
  part: ToolPart
  onRespond: (approvalId: string, approved: boolean, note?: string) => void
  /** 批准且本会话不再询问该工具（服务端登记会话级白名单）；无会话时不展示 */
  onAllowSession?: (approvalId: string, toolName: string) => void
}) {
  const t = useT()
  const [showNote, setShowNote] = useState(false)
  const [note, setNote] = useState('')
  const name = part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length)
  const meta = TOOL_META[name] ?? { icon: Wrench, label: name }
  const approvalId = 'state' in part && part.state === 'approval-requested' ? part.approval.id : undefined
  const inputText =
    part.input != null ? (typeof part.input === 'string' ? part.input : JSON.stringify(part.input, null, 2)) : ''
  // apply/patch 的主体是 YAML/JSON 文本，提出来裸渲染才是「预览」；其余工具走整体 JSON
  const rawBody = (() => {
    if (typeof part.input !== 'object' || part.input === null) return ''
    const o = part.input as Record<string, unknown>
    const v = o.yaml ?? o.manifest ?? o.patch
    return typeof v === 'string' ? v : ''
  })()
  return (
    <Item
      variant="outline"
      role="status"
      className="w-full flex-nowrap flex-col items-stretch gap-2 bg-muted/40"
    >
      <div className="flex items-start gap-2.5">
        <ItemMedia variant="icon" className="shrink-0 self-start pt-0.5 text-caution">
          <ShieldAlert className="size-4" />
        </ItemMedia>
        <ItemContent className="min-w-0 gap-1">
          <ItemTitle className="w-auto line-clamp-none text-[13px]">
            {t('ai:approvalTitle')}{t(meta.label)}
            <code className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">{name}</code>
          </ItemTitle>
          {(rawBody || inputText) && <JsonCode text={rawBody || inputText} maxH="max-h-40" />}
          <ItemDescription className="text-xs">{t('ai:approvalWarning')}</ItemDescription>
        </ItemContent>
      </div>
      <ItemActions className="flex-wrap justify-end">
        {showNote ? (
          // 拒绝理由是值班决策的一半：回灌模型（不再重提同一写）+ 进审计（交班可查「AI 提了什么、人否了什么」）
          <div className="flex w-full items-center gap-1.5">
            <Input
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('ai:denyNotePh')}
              maxLength={200}
              className="h-6 min-w-0 flex-1 text-xs"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && approvalId) onRespond(approvalId, false, note.trim() || undefined)
                if (e.key === 'Escape') {
                  // 只收这一段理由，不退整个 dock：阻止冒泡到 FAB 的全局 Esc（其 defaultPrevented 守卫正是为此准备）
                  e.preventDefault()
                  e.stopPropagation()
                  setShowNote(false)
                }
              }}
            />
            <Button size="xs" disabled={!approvalId} onClick={() => approvalId && onRespond(approvalId, false, note.trim() || undefined)}>
              {t('ai:deny')}
            </Button>
          </div>
        ) : (
          <>
        <Button
          size="xs"
          variant="outline"
          disabled={!approvalId}
          onClick={() => approvalId && onRespond(approvalId, false)}
        >
          {t('ai:deny')}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          disabled={!approvalId}
          onClick={() => setShowNote(true)}
        >
          {t('ai:denyWithNote')}
        </Button>
        {onAllowSession && (
          <Button
            size="xs"
            variant="outline"
            disabled={!approvalId}
            title={t('ai:approveSessionHint')}
            onClick={() => approvalId && onAllowSession(approvalId, name)}
          >
            {t('ai:approveSession')}
          </Button>
        )}
        <Button
          size="xs"
          disabled={!approvalId}
          onClick={() => approvalId && onRespond(approvalId, true)}
        >
          {t('ai:approve')}
        </Button>
          </>
        )}
      </ItemActions>
    </Item>
  )
}
