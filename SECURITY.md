# Security Policy

本项目是 [Headlamp](https://github.com/kubernetes-sigs/headlamp) 的独立 fork。

## 报告漏洞

请使用 GitHub 的 **Report a vulnerability**（仓库 Security 页的私密漏洞报告）提交，
不要开公开 Issue。我们收到后 7 天内回复评估；确认修复后协同披露。

上游 Headlamp 自身的漏洞请按
[kubernetes-sigs/headlamp 的安全流程](https://github.com/kubernetes-sigs/headlamp/blob/main/SECURITY.md)
报告。

## 范围提示

- 本看板不绕过集群 RBAC：所有 API 以服务端凭据（kubeconfig / in-cluster）转发
- AI 助手的写类工具需要人工二次审批；部署时请以最小权限 kubeconfig 运行本服务
- LLM 网关凭据仅存服务端；请为持久卷（`/data/ai`，含会话与审计）配置相应访问控制
