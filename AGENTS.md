# AGENTS.md — K8S Dashboard（fork 自 Headlamp）

布局：

- `web/`：Vite + React 19 + Tailwind + shadcn/ui（主战场；上游 frontend/ 已删除，不存在）
- `ai-exec/`：Node AI 执行层（`server.js` 路由、`lib/tools*.js` k8s 工具、`lib/adapter.js` 流协议）
- `backend/`：上游 Headlamp Go 后端，尽量不动（改动需说明理由）
- `qa/`：demo 夹具与冒烟脚本；`container/`：entrypoint；`Dockerfile` 为发布镜像

改动后的最小检查（跑所触领域对应项）：

```bash
cd web && npx tsc --noEmit && npx vitest run      # 前端
cd web && npm run build                            # 发布前
cd ai-exec && node --test lib/*.test.js            # AI 层
cd backend && go build ./cmd                       # 后端
```

铁律：

1. i18n：用户可见字符串一律进 `web/src/i18n/strings.*.ts`（`{ zh, en }`）；删代码必须同删孤儿字符串
2. 不许伪空/伪健康：数据未到时只渲染骨架，禁止编造空态或健康态
3. AI 写类工具必须过审批门（`lib/permissions.js`）并落审计（`lib/audit.js`）；新增工具两处都要接
4. 测试写操作只允许打在 `qa/demo-fixture.sh` 的夹具资源上，非夹具负载一律只读
5. `useWatch` 对外契约（items/map/lastSync/reconnecting/forbidden/error）不可破坏消费方
6. 来源优先级：照抄上游/权威源码 > 最小修改 > 自己写；UI 修复需用几何断言（rect/midY）而非只看截图
7. 样式取值只改 `web/design-tokens/tokens/**` 再 `npm run tokens:build`；组件/index.css/adapter 禁止色值字面量（规则详见 `web/design-tokens/AGENTS.md`，parity 测试会拦）

提交：默认本地 commit 不 push；commit 前跑对应检查命令。
