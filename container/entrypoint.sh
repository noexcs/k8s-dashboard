#!/bin/sh
# K8S Dashboard 镜像入口（PID1）：同容器双进程
#   1) headlamp-server :4467（唯一对外端口）—— Go 后端（k8s 代理 / helm / 静态前端 / /ai/* 反代）
#   2) ai-exec         :4470（仅 127.0.0.1）—— Node AI 执行层（pi SDK，见 ai-exec/）
#
# 信号：docker stop / k8s 滚动更新发 SIGTERM → trap 双杀两个子进程。
# 日志：headlamp-server 原样打 stdout（Go logger）；ai-exec 每行自带 [ai-exec] 前缀，
#       合并日志按前缀区分（"两进程日志分开打"）。
# 容器命运绑定 headlamp-server（主进程）：ai-exec 挂掉不拖垮主服务，/ai/* 反代返回 503，
# 重建容器即恢复（会话 JSONL 在 /data/ai 卷上持久）。
set -u

# 全新 emptyDirectory 卷是空的：先建数据目录（pi 会话/agent 配置/工作目录，见 ai-exec/lib/config.js）
mkdir -p /data/ai

# --- ai-exec（Node AI 执行层，loopback:4470） ---
cd /opt/ai-exec
node server.js &
AI_EXEC_PID=$!

# --- headlamp-server（主进程；"$@" 来自镜像 CMD：静态目录/端口/helm/kubeconfig）---
# 二进制不在 PATH（node:22-slim base 无自定义 PATH），用绝对路径
/headlamp/headlamp-server "$@" &
SERVER_PID=$!

cleanup() {
    kill -TERM "$AI_EXEC_PID" "$SERVER_PID" 2>/dev/null || true
}
trap 'cleanup' TERM INT

# 等主进程退出，透传其退出码
SERVER_RC=0
wait "$SERVER_PID" || SERVER_RC=$?

# 主进程已退：收尾 ai-exec
kill -TERM "$AI_EXEC_PID" 2>/dev/null || true
wait "$AI_EXEC_PID" 2>/dev/null || true

exit "$SERVER_RC"
