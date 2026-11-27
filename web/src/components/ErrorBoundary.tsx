import { Component, type ReactNode } from 'react'

import { AlertTriangle } from 'lucide-react'

import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'

interface Props {
  children: ReactNode
}

/** 错误卡片（函数组件：class boundary 里不能调 useT 订阅语言切换） */
function PageErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const t = useT()
  return (
    <div className="flex h-full min-h-40 items-center justify-center">
      <div className="flex w-full max-w-md flex-col gap-3">
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t('core:pageError')}</AlertTitle>
          <AlertDescription>{t('core:pageErrorDesc')}</AlertDescription>
        </Alert>
        <CodeBlock variant="destructive" className="max-h-40">
          <CodeBlockContent wrap>{error.message}</CodeBlockContent>
        </CodeBlock>
        <div className="flex gap-2">
          <Button onClick={onRetry}>{t('core:retry')}</Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            {t('core:reload')}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface State {
  error: Error | null
}

/**
 * 路由级兜底：任一页面 render 抛错时渲染错误卡片，而不是让整个 React 树卸载变白屏。
 * 用法：在 AppLayout 里包 <Outlet />，key 用 pathname——切换路由即重置错误状态。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error) {
    // 保留完整堆栈供排查（浏览器控制台可见）
    console.error('页面渲染崩溃：', error)
  }

  render() {
    const { error } = this.state
    if (error) {
      return <PageErrorFallback error={error} onRetry={() => this.setState({ error: null })} />
    }
    return this.props.children
  }
}
