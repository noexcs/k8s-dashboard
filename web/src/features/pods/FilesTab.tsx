// Pod 文件浏览（参考 CLI PVC/Pod File Browser 的 exec 通道方案）：
// 容器内跑 sh + ls/cat/head/base64/mv（GNU 与 busybox 都可用；distroless 无 sh →
// 与终端同款「容器无 shell」提示）。上传不依赖 stdin EOF（WS 无半关闭）：
// exec `head -c N | base64 -d > tmp && mv tmp target`，前端把 base64 精确 N 字节喂满
// head 即自然退出；分片 + 小间隔避免 WS 缓冲溢出。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, File as FileIcon, FileText, Folder, Home, Loader2, RefreshCw, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { execCapture, execPod } from '@/api/exec'
import { tf, useT } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface FileEntry {
  name: string
  type: '-' | 'd' | 'l' | string
  size: number
  /** ls -l 原始日期段（busybox/GNU 格式不一，展示原文不硬解析） */
  when: string
  /** 符号链接目标 */
  linkTo?: string
}

/** 单引号安全转义（shell 通用）：'a'b → 'a'\''b' */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

const joinPath = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)

function decode(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

const delay = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** 解析 ls -lA 行：perm links user group size month day time|year name[ -> target] */
function parseLsLine(line: string): FileEntry | null {
  if (!/^[dlcpsbStT-]/.test(line)) return null
  const parts = line.trim().split(/\s+/)
  if (parts.length < 8) return null
  let rest = parts.slice(8).join(' ')
  let linkTo: string | undefined
  const arrow = rest.lastIndexOf(' -> ')
  if (parts[0]!.startsWith('l') && arrow > 0) {
    linkTo = rest.slice(arrow + 4)
    rest = rest.slice(0, arrow)
  }
  return {
    name: rest,
    type: parts[0]![0]!,
    size: Number(parts[4]) || 0,
    when: `${parts[5]} ${parts[6]} ${parts[7]}`,
    linkTo,
  }
}

export function FilesTab({
  cluster,
  ns,
  pod,
  containers,
}: {
  cluster: string
  ns: string
  pod: string
  containers: string[]
}) {
  const t = useT()
  const [container, setContainer] = useState(containers[0] ?? '')
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ name: string; text?: string; binary?: boolean } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [jump, setJump] = useState<string | null>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

  const load = useCallback(
    async (p: string) => {
      setBusy(true)
      setError(null)
      try {
        const r = await execCapture(cluster, ns, pod, container, ['sh', '-c', `ls -lA ${q(p)} 2>&1`])
        const text = new TextDecoder().decode(decode(r.chunks))
        if (r.code !== 0 || text.includes('No such file') || text.includes('Not a directory')) {
          setError(text.trim() || tf('pods:filesLsFailed', { code: r.code ?? -1 }))
          setEntries(null)
          return
        }
        const es = text
          .split('\n')
          .map(parseLsLine)
          .filter((e): e is FileEntry => e !== null)
        // 目录在前、名称排序（busybox --group-directories-first 不可移植，前端排）
        es.sort((a, b) => (a.type === 'd' ? 0 : 1) - (b.type === 'd' ? 0 : 1) || a.name.localeCompare(b.name))
        setEntries(es)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [cluster, ns, pod, container],
  )

  useEffect(() => {
    void load(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, container])

  const open = (e: FileEntry) => {
    setPreview(null)
    if (e.type === 'd') setPath(joinPath(path, e.name))
    else void previewFile(e)
  }

  const previewFile = async (e: FileEntry) => {
    const full = joinPath(path, e.name)
    setBusy(true)
    try {
      const r = await execCapture(cluster, ns, pod, container, ['sh', '-c', `head -c 65536 ${q(full)} 2>&1`])
      const bytes = decode(r.chunks)
      const binary = bytes.subarray(0, 800).includes(0)
      setPreview({ name: e.name, binary, text: binary ? undefined : new TextDecoder().decode(bytes) })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const download = async (e: FileEntry) => {
    const full = joinPath(path, e.name)
    setBusy(true)
    try {
      const r = await execCapture(cluster, ns, pod, container, ['sh', '-c', `cat ${q(full)}`], 120_000)
      if (r.code !== 0) throw new Error(new TextDecoder().decode(decode(r.chunks)).trim() || `exit ${r.code}`)
      const blob = new Blob([decode(r.chunks).buffer as ArrayBuffer])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = e.name
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // 上传：head -c N 计数退出（无 stdin EOF 依赖）；base64 分片喂入
  const uploadFile = async (file: File) => {
    const target = joinPath(path, file.name)
    const tmp = `/tmp/.k8s-upload-${Math.random().toString(36).slice(2, 8)}.b64`
    setUploading(true)
    try {
      const b64: string = await new Promise((res, rej) => {
        const fr = new FileReader()
        fr.onload = () => res((fr.result as string).split('\n').join(''))
        fr.onerror = () => rej(fr.error)
        fr.readAsDataURL(file)
      })
      const payload = b64.slice(b64.indexOf(',') + 1) // 去 data:...;base64, 前缀
      const handle = await execPod(cluster, ns, pod, container, {
        tty: false,
        command: ['sh', '-c', `head -c ${payload.length} | base64 -d > ${q(tmp)} && mv ${q(tmp)} ${q(target)}`],
      })
      // holder 对象而非裸变量：闭包赋值不参与 TS 控制流窄化（属性窄化在函数调用处重置）
      const exitRef: { v: { code: number | null; reason: string } | null } = { v: null }
      handle.onExit((code, reason) => (exitRef.v = { code, reason }))
      const CHUNK = 131072
      for (let i = 0; i < payload.length; i += CHUNK) {
        handle.send(payload.slice(i, i + CHUNK))
        if (exitRef.v) break // 提前失败（无 sh/无写权限）就别再灌数据
        await delay(50)
      }
      // head 收满 N 字节自行退出；等待收尾
      for (let w = 0; w < 100 && !exitRef.v; w++) await delay(200)
      handle.close()
      const exit = exitRef.v
      if (!exit || exit.code !== 0) {
        throw new Error(exit?.reason || tf('pods:filesUploadFailed', { code: exit?.code ?? -1 }))
      }
      toast.success(tf('pods:filesUploaded', { name: file.name }))
      void load(path)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  const crumbs = path.split('/').filter(Boolean)

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {containers.length > 1 && (
          <Select value={container} onValueChange={setContainer}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {containers.map(c => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/* 面包屑：/ 分段可点 */}
        <button className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="/" onClick={() => setPath('/')}>
          <Home className="size-3.5" />
        </button>
        <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-[13px]">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <span className="text-muted-foreground">/</span>
              <button
                className="max-w-40 truncate rounded px-1 font-mono hover:bg-muted hover:text-foreground"
                onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}
              >
                {c}
              </button>
            </span>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={() => setJump(jump === null ? path : null)}>
            {t('pods:filesGo')}
          </Button>
          <Button variant="outline" size="icon" className="size-7" title={t('pods:filesRefresh')} onClick={() => void load(path)} disabled={busy}>
            <RefreshCw className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => uploadRef.current?.click()}
            disabled={busy || uploading}
          >
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            {t('pods:filesUpload')}
          </Button>
          <input
            ref={uploadRef}
            type="file"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void uploadFile(f)
            }}
          />
        </div>
      </div>
      {jump !== null && (
        <form
          className="flex gap-2"
          onSubmit={ev => {
            ev.preventDefault()
            const v = jump.trim()
            setJump(null)
            if (v.startsWith('/')) setPath(v.replace(/\/+$/, '') || '/')
          }}
        >
          <Input value={jump} onChange={e => setJump(e.target.value)} placeholder="/etc/nginx" className="h-7 max-w-96 font-mono text-[13px]" autoFocus />
        </form>
      )}
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">{error}</div>}
      {preview && (
        <div className="flex min-h-0 shrink-0 flex-col rounded-lg border bg-card">
          <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[13px]">
            <FileText className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono">{preview.name}</span>
            <button
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => setPreview(null)}
            >
              <X className="size-3.5" />
            </button>
          </div>
          <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed">
            {preview.binary ? t('pods:filesBinary') : preview.text || t('pods:filesEmpty')}
          </pre>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-card">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-8 text-xs">{t('pods:filesName')}</TableHead>
              <TableHead className="h-8 w-24 text-right text-xs">{t('pods:filesSize')}</TableHead>
              <TableHead className="h-8 w-36 text-xs">{t('pods:filesWhen')}</TableHead>
              <TableHead className="h-8 w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!entries ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-[13px] text-muted-foreground">
                  {error ? '' : t('pods:loading')}
                </TableCell>
              </TableRow>
            ) : entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-[13px] text-muted-foreground">
                  {t('pods:filesEmptyDir')}
                </TableCell>
              </TableRow>
            ) : (
              entries.map(e => (
                <TableRow key={e.name} className="cursor-pointer h-8" onClick={() => open(e)}>
                  <TableCell className="max-w-0 truncate py-1 font-mono text-[13px]">
                    <span className="flex items-center gap-1.5">
                      {e.type === 'd' ? (
                        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className={e.type === 'd' ? 'font-medium' : ''}>{e.name}</span>
                      {e.linkTo && <span className="truncate text-muted-foreground">→ {e.linkTo}</span>}
                    </span>
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs text-muted-foreground">
                    {e.type === 'd' ? '-' : e.size >= 1048576 ? `${(e.size / 1048576).toFixed(1)}M` : e.size >= 1024 ? `${(e.size / 1024).toFixed(0)}K` : e.size}
                  </TableCell>
                  <TableCell className="py-1 text-xs text-muted-foreground">{e.when}</TableCell>
                  <TableCell className="py-1 text-right">
                    {e.type !== 'd' && (
                      <button
                        className="rounded p-1 text-muted-foreground hover:text-foreground"
                        title={t('pods:filesDownload')}
                        onClick={ev => {
                          ev.stopPropagation()
                          void download(e)
                        }}
                      >
                        <Download className="size-3.5" />
                      </button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
