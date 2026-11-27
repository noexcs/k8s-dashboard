import { useParams } from 'react-router-dom'
import { AiChat } from './AiChat'

// 全屏 AI 聊天页 /c/:cluster/ai
export function AiPage() {
  const { cluster } = useParams()
  return <AiChat key={cluster} cluster={cluster!} showHeader className="h-full" />
}
