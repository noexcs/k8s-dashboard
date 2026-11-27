// 官方 shadcn markdown 组件（shadcn-ui/ui monorepo apps/v4/components/markdown.tsx 照搬，改 import 路径；
// 本地调整：行内 code 样式不重复定义，交给 index.css .cn-markdown typeset 单一来源）。
// 基于 streamdown：专为 AI 流式输出设计（未闭合代码块安全渲染、增量解析），代码块走 shadcn CodeBlock + shiki 高亮。
"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import {
  Streamdown,
  useIsCodeFenceIncomplete,
  type ExtraProps,
} from "streamdown"

import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import { HScrollFade } from "@/components/HScrollFade"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block"

function MarkdownCodeBlock({
  code,
  language,
}: {
  code: string
  language: string
}) {
  // 收尾 fence 还没到达时为 true（流式中途），复制按钮禁用。
  const incomplete = useIsCodeFenceIncomplete()
  const lines = useHighlightedCode(code, language)

  return (
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>{language || "text"}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} disabled={incomplete} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

function MarkdownCode({
  className,
  children,
  ...props
}: React.ComponentProps<"code"> & ExtraProps) {
  // Streamdown marks fenced code with data-block. Inline code stays inline.
  // 行内 code 外观（bg-muted/圆角/padding/字号 0.85em/长 token 断行）唯一来源是
  // index.css 的 .cn-markdown typeset 规则；组件不再重复定义，避免两套值互相覆盖。
  if (!("data-block" in props)) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  return (
    <MarkdownCodeBlock
      code={typeof children === "string" ? children : ""}
      language={/language-(\S+)/.exec(className ?? "")?.[1] ?? ""}
    />
  )
}

// Streamdown memoizes on components, so keep the default stable.
function MarkdownTable({ children, ...props }: React.ComponentProps<"table"> & ExtraProps) {
  // 横滚渐隐罩只在表格上:罩 markdown 根会让宽表消息的全部正文行尾字被渐变洗淡(三轮 P1)。
  // streamdown 自带 table wrapper 被本组件整体替换、不再渲染——HScrollFade 内层即唯一滚动框
  // (常驻滚动条走 [data-hscroll-scroll] 规则);pre 的代码块渐隐由 CodeBlock 自带,互不干扰
  return (
    <HScrollFade className="w-full min-w-0">
      <table {...props}>{children}</table>
    </HScrollFade>
  )
}
const DEFAULT_COMPONENTS = { code: MarkdownCode, table: MarkdownTable }

function Markdown({
  className,
  components = DEFAULT_COMPONENTS,
  controls = false,
  ...props
}: React.ComponentProps<typeof Streamdown>) {
  return (
    <Streamdown
      data-slot="markdown"
      components={components}
      controls={controls}
      className={cn("cn-markdown w-full min-w-0 overflow-hidden", className)}
      {...props}
    />
  )
}

export { Markdown }
