# Final container image. Override it with --build-arg IMAGE_BASE=<image>. The
# default is on its own FROM line so that Dependabot can update it.
ARG IMAGE_BASE=default-image-base
FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS default-image-base
FROM ${IMAGE_BASE} AS image-base

FROM --platform=${BUILDPLATFORM} golang:1.26.10@sha256:cfa27959837144bf4649802ba38e59daffd0dd2a7994aa83daaf113285b0f551 AS backend-build
WORKDIR /headlamp

ARG TARGETOS
ARG TARGETARCH
ARG GOFLAGS
ENV GOPATH=/go \
    GOPROXY=https://proxy.golang.org \
    GOFLAGS=${GOFLAGS} \
    GO111MODULE=on\
    CGO_ENABLED=0\ 
    GOOS=${TARGETOS}\
    GOARCH=${TARGETARCH}

# Keep go mod download separated so source changes don't trigger install
COPY ./backend/go.* /headlamp/backend/
RUN --mount=type=cache,target=/go/pkg/mod \
    cd ./backend && go mod download

COPY ./backend /headlamp/backend

RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    cd ./backend && go build -o ./headlamp-server ./cmd/

FROM --platform=${BUILDPLATFORM} node:25@sha256:78839ac448c23517f8eab2e8f7943d9b4f73979eb7f8bed2c73dbf72ff869e7b AS frontend-build

# Keep npm install separated so source changes don't trigger install
# web/ 构建需要 devDependencies（vite/tsc/tailwind），所以用完整 npm ci
COPY web/package*.json /headlamp/web/
WORKDIR /headlamp
RUN cd ./web && npm ci

# AI 执行层构建：ai-exec 纯 JS 依赖（pi SDK + typebox），npm ci 产物即运行目录
FROM --platform=${BUILDPLATFORM} node:25@sha256:78839ac448c23517f8eab2e8f7943d9b4f73979eb7f8bed2c73dbf72ff869e7b AS ai-exec-build
WORKDIR /opt/ai-exec
COPY ai-exec/package*.json /opt/ai-exec/
RUN npm ci --omit=dev
COPY ai-exec/ /opt/ai-exec/

FROM frontend-build AS frontend

COPY ./web /headlamp/web

WORKDIR /headlamp

RUN cd ./web && npm run build

RUN echo "*** Built K8S Dashboard (headlamp fork) ***"

FROM image-base AS final

# Create the non-root user
# uid/gid 钉死 1000：adduser --system 的分配随 base 镜像漂移（alpine:3.24 上 999 被
# ping 组占用）；k8s-ai-data 卷内文件属主须与之一致，迁移时 chown -R 1000:1000
RUN if command -v apt-get > /dev/null; then \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && addgroup --system --gid 1000 headlamp \
    && adduser --system --uid 1000 --ingroup headlamp headlamp \
    && rm -rf /var/lib/apt/lists/*; \
    else \
    # alpine：nodejs 走 apk（alpine 3.24 带 Node 24.x ≥ pi 要求的 22.19）
    addgroup -S -g 1000 headlamp \
    && adduser -S -u 1000 -G headlamp headlamp \
    && apk add --no-cache ca-certificates nodejs; \
    fi

COPY --from=backend-build --link /headlamp/backend/headlamp-server /headlamp/headlamp-server
# 静态目录仍叫 /headlamp/frontend：entrypoint 的 -html-static-dir 保持不变
COPY --from=frontend --link /headlamp/web/dist /headlamp/frontend
# AI 执行层（Node 服务，entrypoint 以 node server.js 启动）
COPY --from=ai-exec-build --link /opt/ai-exec /opt/ai-exec
# 双进程入口脚本（PID1，trap SIGTERM 双杀）
COPY ./container/entrypoint.sh /headlamp/entrypoint.sh
RUN chmod +x /headlamp/entrypoint.sh \
    && chown -R headlamp:headlamp /headlamp /opt/ai-exec \
    && mkdir -p /data/ai /home/headlamp/.config \
    && chown -R headlamp:headlamp /data/ai /home/headlamp

# 唯一对外端口：headlamp-server（含 /ai/* → ai-exec 反代）
EXPOSE 4467

# AI 执行层 LLM 网关（只被容器内 ai-exec 消费，不下发前端）。env 为底座默认：
# LLM_GATEWAY_BASE = OpenAI 兼容网关地址（…/v1），LLM_API_KEY（网关需要鉴权时）；
# 也可在「设置 → AI 服务」页配置（保存即生效，持久化到 /data/ai 卷）
ENV LLM_GATEWAY_BASE=""
ENV LLM_API_KEY=""
ENV LLM_MODEL=Qwen3.8-27B
# pi 数据目录（会话 JSONL / agent 配置）；建议挂载卷持久化（跨容器重建保留会话）
ENV PI_DATA_DIR=/data/ai

USER headlamp

ENTRYPOINT ["/headlamp/entrypoint.sh"]
CMD ["-html-static-dir", "/headlamp/frontend", "-port", "4467", "--enable-helm", "--enable-dynamic-clusters", "--allow-kubeconfig-changes"]
