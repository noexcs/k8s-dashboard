import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import { CheckIcon, CopyIcon, XIcon } from "lucide-react"
import { clipboardWrite } from "@/lib/clipboard"
import { useT } from "@/i18n"

// 与 ui.shadcn.com 线上部署版对齐(2026-11-20 从站点 DOM 提取类串):
// rounded-2xl / ring-1 ring-foreground/5(代替 border) / 双主题 bg-muted / padding px-4。
// 注意: shadcn CLI registry 版较旧(rounded-lg + border-input), 不要直接 --overwrite 覆盖本文件。
const codeBlockVariants = cva(
  "group/code-block relative flex w-full min-w-0 flex-col overflow-hidden rounded-xl text-sm has-[>[data-slot=code-block-content]:focus-visible]:ring-3 has-[>[data-slot=code-block-content]:focus-visible]:ring-ring/30 data-[size=sm]:rounded-xl data-[size=sm]:text-[13px]",
  {
    variants: {
      variant: {
        default:
          "bg-muted text-foreground ring-1 ring-foreground/5 dark:ring-foreground/10",
        destructive:
          "bg-destructive/5 text-destructive ring-1 ring-destructive/15 dark:bg-destructive/10 dark:ring-destructive/20",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function CodeBlock({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof codeBlockVariants> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="code-block"
      data-variant={variant}
      data-size={size}
      className={cn(codeBlockVariants({ variant }), className)}
      {...props}
    />
  )
}

function CodeBlockHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-header"
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-2 px-4 pt-4 text-muted-foreground group-data-[size=sm]/code-block:px-3 group-data-[size=sm]/code-block:pt-3 group-data-[variant=destructive]/code-block:text-destructive *:has-[>[data-slot=code-block-title]]:min-w-0",
        className
      )}
      {...props}
    />
  )
}

function CodeBlockTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-title"
      className={cn(
        "min-w-0 truncate font-sans text-sm font-medium text-foreground group-data-[size=sm]/code-block:text-[13px] group-data-[variant=destructive]/code-block:text-destructive [&_svg]:pointer-events-none [&_svg]:inline-block [&_svg]:align-middle [&_svg:not([class*='size-'])]:size-4 group-data-[size=sm]/code-block:[&_svg:not([class*='size-'])]:size-3.5 *:[svg]:me-1.5",
        className
      )}
      {...props}
    />
  )
}

function CodeBlockActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-actions"
      className={cn(
        "-my-1 ms-auto -me-1.5 flex shrink-0 items-center gap-1 *:data-[slot=button]:hover:bg-foreground/5 dark:*:data-[slot=button]:hover:bg-foreground/10 [[data-slot=code-block]>&]:absolute [[data-slot=code-block]>&]:end-3 [[data-slot=code-block]>&]:top-3 [[data-slot=code-block]>&]:z-10 [[data-slot=code-block]>&]:m-0 [[data-slot=code-block]>&]:opacity-0 [[data-slot=code-block]>&]:transition-opacity [[data-slot=code-block]>&]:group-focus-within/code-block:opacity-100 [[data-slot=code-block]>&]:group-hover/code-block:opacity-100 group-data-[size=sm]/code-block:[[data-slot=code-block]>&]:end-2 group-data-[size=sm]/code-block:[[data-slot=code-block]>&]:top-2 [[data-slot=code-block]>&]:pointer-coarse:opacity-100 [[data-slot=code-block]>&]:*:[button]:bg-background [[data-slot=code-block]>&]:*:[button]:ring-1 [[data-slot=code-block]>&]:*:[button]:ring-foreground/10",
        className
      )}
      {...props}
    />
  )
}

function CodeBlockCopyButton({
  value,
  variant = "ghost",
  size = "icon-xs",
  className,
  onClick,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<typeof Button> & { value: string }) {
  const t = useT()
  const [copied, setCopied] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (!copied && !failed) {
      return
    }

    const timeout = setTimeout(
      () => {
        setCopied(false)
        setFailed(false)
      },
      failed ? 1500 : 2000
    )
    return () => clearTimeout(timeout)
  }, [copied, failed])

  // aria-label 从 props 拆出：内部状态标签（Copied/Copy failed）优先级高于外层 spread
  return (
    <>
      <Button
        data-slot="code-block-copy-button"
        data-copied={copied || undefined}
        data-failed={failed || undefined}
        variant={variant}
        size={size}
        aria-label={
          failed ? t('ui:copyFailed') : copied ? t('ui:copied') : (ariaLabel ?? t('ui:copy'))
        }
        className={cn(className, failed && "text-negative")}
        onClick={(event) => {
          onClick?.(event)
          // 乐观置 copied：异步 clipboard 写失败再回退到 failed 态
          setFailed(false)
          setCopied(true)
          clipboardWrite(value).catch(() => {
            setCopied(false)
            setFailed(true)
          })
        }}
        {...props}
      >
        {/* 双图标叠放：切换只动 opacity+scale，无布局位移 */}
        <span aria-hidden className="relative inline-grid place-items-center">
          <CopyIcon
            className={cn(
              "col-start-1 row-start-1 transition-[opacity,transform] duration-[140ms] ease-out",
              copied || failed ? "scale-92 opacity-0" : "scale-100 opacity-100"
            )}
          />
          <CheckIcon
            className={cn(
              "col-start-1 row-start-1 transition-[opacity,transform] duration-[140ms] ease-out",
              copied ? "scale-100 opacity-100" : "scale-92 opacity-0"
            )}
          />
          <XIcon
            className={cn(
              "col-start-1 row-start-1 transition-[opacity,transform] duration-[140ms] ease-out",
              failed ? "scale-100 opacity-100" : "scale-92 opacity-0"
            )}
          />
        </span>
      </Button>
      <span aria-live="polite" className="sr-only">
        {failed ? t('ui:copyFailed') : copied ? t('ui:copied') : ''}
      </span>
    </>
  )
}

function CodeBlockContent({
  className,
  children,
  style,
  wrap = false,
  lineNumbers = false,
  startLine = 1,
  ...props
}: React.ComponentProps<"pre"> & {
  wrap?: boolean
  lineNumbers?: boolean
  startLine?: number
}) {
  return (
    <pre
      data-slot="code-block-content"
      data-wrap={wrap || undefined}
      data-numbered={lineNumbers || undefined}
      dir="ltr"
      tabIndex={0}
      style={{ counterReset: `line ${startLine - 1}`, ...style }}
      className={cn(
        "min-h-0 min-w-0 scroll-fade-x scrollbar-thin overflow-auto px-4 py-4 text-start font-mono leading-relaxed outline-none group-has-data-[slot=code-block-footer]/code-block:pb-2 group-has-data-[slot=code-block-header]/code-block:pt-2 group-data-[size=sm]/code-block:px-3 group-data-[size=sm]/code-block:py-3 group-data-[size=sm]/code-block:group-has-data-[slot=code-block-header]/code-block:pt-1.5 data-wrap:scroll-fade-y data-wrap:wrap-break-word data-wrap:whitespace-pre-wrap",
        className
      )}
      {...props}
    >
      <code
        data-slot="code-block-code"
        className="grid min-h-lh min-w-max content-start in-data-numbered:grid-cols-[auto_1fr] in-data-wrap:min-w-0"
      >
        {lineNumbers && typeof children === "string"
          ? children
              .replace(/\n$/, "")
              .split("\n")
              .map((line, index) => (
                <CodeBlockLine key={index}>{line}</CodeBlockLine>
              ))
          : children}
      </code>
    </pre>
  )
}

const codeBlockLineVariants = cva(
  "relative -mx-4 block min-h-lh px-4 group-data-[size=sm]/code-block:-mx-3 group-data-[size=sm]/code-block:px-3 before:min-w-6 before:text-end before:text-muted-foreground after:absolute after:start-1 after:top-0 after:text-muted-foreground after:select-none in-data-numbered:col-span-2 in-data-numbered:grid in-data-numbered:grid-cols-subgrid in-data-numbered:gap-x-3 in-data-numbered:[counter-increment:line] in-data-numbered:before:content-[counter(line)] in-data-numbered:before:select-none in-data-numbered:supports-[content:counter(line)_/_'']:before:content-[counter(line)_/_'']",
  {
    variants: {
      variant: {
        default: "",
        added: "bg-muted after:content-['+']",
        removed: "bg-destructive/10 after:text-destructive after:content-['−']",
        highlighted: "bg-muted",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function CodeBlockLine({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof codeBlockLineVariants>) {
  // An empty line holds a newline so copying a selection keeps blank lines.
  const empty =
    children === undefined ||
    children === null ||
    children === "" ||
    (Array.isArray(children) && children.length === 0)

  return (
    <span
      data-slot="code-block-line"
      data-variant={variant}
      className={cn(codeBlockLineVariants({ variant }), className)}
      {...props}
    >
      <span data-slot="code-block-line-content" className="min-w-0">
        {empty ? "\n" : children}
      </span>
    </span>
  )
}

function CodeBlockFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-footer"
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-2 px-4 pb-4 text-muted-foreground group-data-[size=sm]/code-block:px-3 group-data-[size=sm]/code-block:pb-3 justify-center",
        className
      )}
      {...props}
    />
  )
}

export {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockContent,
  CodeBlockLine,
  CodeBlockFooter,
}
