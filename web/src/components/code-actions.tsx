"use client"

import * as React from "react"
import { DownloadIcon, WrapTextIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { CodeBlockActions, CodeBlockCopyButton } from "@/components/ui/code-block"
import { useT } from "@/i18n"

// 官方文档站 demo 照抄（shadcn-ui/ui 仓库 CodeBlockDemo，仅 aria-label 走 i18n）：
// 标题行 = [换行切换][下载][复制]；wrap 状态由调用方传给 CodeBlockContent。

function download(value: string, filename: string) {
  const url = URL.createObjectURL(new Blob([value], { type: "text/plain" }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function useCodeActions(value: string, filename?: string) {
  const t = useT()
  const [wrap, setWrap] = React.useState(false)

  return {
    wrap,
    actions: (
      <CodeBlockActions>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("sys:wrapLines")}
          aria-pressed={wrap}
          className="aria-pressed:text-foreground"
          onClick={() => setWrap(!wrap)}
        >
          <WrapTextIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("sys:download")}
          onClick={() => download(value, filename ?? "code.txt")}
        >
          <DownloadIcon />
        </Button>
        <CodeBlockCopyButton value={value} />
      </CodeBlockActions>
    ),
  }
}
