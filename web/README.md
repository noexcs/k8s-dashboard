# web/ — K8S Dashboard 前端

自研前端（替代上游 `frontend/` CRA+MUI）：Vite 8 + React 19 + TypeScript +
Tailwind CSS v4 + shadcn/ui（radix-ui）；TanStack react-query（缓存）/
react-table（列表）；react-router v7；`yaml`。中文优先（`src/i18n/`）。

k8s API 一律走 headlamp-server 的 `/clusters/:name/...` 同源代理，不直连 API server；
AI 端点走 `/ai/*`（Go 侧反代到同容器 ai-exec，见根 README）。

## 本地开发

```bash
npm ci
npm run dev    # :5173；vite 代理默认 127.0.0.1:4467，K8S_PROXY_TARGET 可覆盖
npx tsc --noEmit && npx vitest run && npm run build   # 检查 + 产物 dist/
```

## 结构要点

- `src/resources/registry.tsx`：内置 kind 的 `ResourceDef`（group/version/resource/
  scope/列表列/侧栏分组）+ 路由 helper；`crds.ts` 运行时把 CRD 合并进 RESOURCE_MAP
- `src/hooks/useWatch.ts`：list+watch 快照缓存（模块级 LRU），410 Gone 用 list 的
  `metadata.resourceVersion` 断点续传；对外契约见 AGENTS.md
- `src/features/resources/`：通用列表/详情页（YAML Apply 乐观锁 + 409 冲突对话框）
- 列宽用运行时 `gridTemplateColumns` 内联样式（Tailwind 扫不到动态类名）
