# Changelog

## 0.1.0（2026-11-27）

首个公开版本。基于 Headlamp fork(上游 LICENSE/NOTICE 保留)。

- 前端重写：Vite + React 19 + Tailwind + shadcn/ui，中文优先，深/浅主题
- AI 助手（ai-exec 执行层）：流式对话、页面上下文注入、k8s 工具集与写操作二次审批、审计流水
- 集群巡检与值班交接单；变更审计页
- 资源列表实时 watch + 断线增量恢复、CPU/内存用量列（metrics-server）
- YAML 就地编辑、HPA 向导、CronJob 操作、节点 shell / 文件传输、Secret 解码
- Helm 应用管理与升级回滚；全局 ⌘K 搜索（内嵌标签语法）；资源拓扑
- 多集群 + 动态集群接入；单容器部署（Go 后端 + Node AI 层）
- 移除：上游前端遗留物与内置默认 LLM 网关地址
