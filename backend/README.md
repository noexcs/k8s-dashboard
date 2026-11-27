# backend/ — headlamp-server（Go）

上游 Headlamp 后端，本 fork 基本未改动；RBAC 代理、多集群、Helm、`/ai/*` 反代都在此进程。

```bash
go build -o headlamp-server ./cmd
./headlamp-server -html-static-dir ../web/dist -port 4467 --enable-helm --enable-dynamic-clusters
```

部署与配置见根 [README.md](../README.md)。
