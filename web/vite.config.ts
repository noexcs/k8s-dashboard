import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))
const tokensDir = fileURLToPath(new URL('./design-tokens/dist', import.meta.url))

// 开发模式代理到容器后端（冒烟容器 :4467）；另起联调可用 K8S_PROXY_TARGET 覆盖
const proxyTarget = process.env.K8S_PROXY_TARGET ?? 'http://127.0.0.1:4467'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': srcDir,
      '@tokens': tokensDir,
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // 本地开发：headlamp-server 冒烟容器跑在 :4467
      '/config': proxyTarget,
      // AI 执行层（pi 服务端）：/ai/chat SSE 流式 + /ai/models + /ai/sessions
      '/ai': proxyTarget,
      // k8s 代理 + exec/节点 shell 的 WebSocket + 动态集群 /cluster 端点
      '^/clusters?(/|$)': { target: proxyTarget, ws: true },
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    // vendored design-tokens 的测试是 node:test（npm run tokens:test 跑），
    // 被 vitest 收集只会报 "No test suite found"，必须排除
    exclude: ['**/node_modules/**', '**/dist/**', 'design-tokens/**'],
  },
})
