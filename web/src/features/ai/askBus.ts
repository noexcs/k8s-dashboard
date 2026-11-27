// 「问 AI」总线：页面（详情页/列表行）把一句诊断请求送进 AI 面板并唤起面板。
// 为什么不用路由/props：AI 面板挂在 AppLayout 的 FAB 层，与业务页面无父子关系；
// 且面板可能尚未挂载（open=false 时 AiChat 可能未渲染），所以 pending 存取放在
// 模块级——先 ask 后面板挂载时 subscribeAsk 也能取到这一次请求（一次性消费）。
// 上下文无需在这里拼：AiChat 发消息时按当前路由自动注入 [当前页面] 资源引用。

const EVENT = 'k8s-ai-ask'

let pending: string | null = null
const subs = new Set<(text: string) => void>()

/** 发起一次「问 AI」：唤起面板（Fab 订阅）+ 把文本预填进输入框（AiChat 订阅） */
export function askAi(text: string) {
  // pending 只服务「订阅者还没挂载」的窗口；已有订阅者时置 pending 会泄漏——
  // 之后新挂载的 AiChat（如跳整页 /ai）会把旧问题再次预填
  pending = subs.size > 0 ? null : text
  subs.forEach((f) => f(text))
  window.dispatchEvent(new CustomEvent(EVENT))
}

/** AiChat 侧订阅：立即消费未处理的 pending；返回取消函数 */
export function subscribeAsk(fn: (text: string) => void) {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

/** 面板挂载时取一次性 pending（取后即清） */
export function takePendingAsk(): string | null {
  const p = pending
  pending = null
  return p
}

/** Fab 侧监听面板唤起事件 */
export function onAskOpen(onAsk: () => void) {
  const h = () => onAsk()
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}
