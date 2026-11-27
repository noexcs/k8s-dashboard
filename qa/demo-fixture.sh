#!/usr/bin/env bash
# K8S QA 夹具（铁律 2026-11-26：测试写操作只允许打在自部署 demo 资源上；
# 集群内非本夹具部署的工作负载一律只读）。
# 用法: ./qa/demo-fixture.sh up|down|status|hpa-on|hpa-off   [PANEL=http://127.0.0.1:4467]
set -euo pipefail
PANEL="${PANEL:-http://127.0.0.1:4467}"
P="$PANEL/clusters/default"
NS=k8s-demo
CT='content-type: application/json'

post() { curl -sS -m 15 -X POST "$P$1" -H "$CT" -d "$2" -o /dev/null -w "%{http_code} "; }
del()  { curl -sS -m 15 -X DELETE "$P$1?propagationPolicy=Background" -o /dev/null -w "%{http_code} "; }

case "${1:-up}" in
up)
  curl -sS -m 15 -X POST "$P/api/v1/namespaces" -H "$CT" \
    -d '{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"'"$NS"'"}}' -o /dev/null -w "ns:%{http_code} "
  # demo-web：伸缩/重启/回滚/确认弹层的受控对象（夹具专用受控对象，勿指向非夹具服务）
  post /apis/apps/v1/namespaces/$NS/deployments '{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"demo-web","namespace":"'"$NS"'"},"spec":{"replicas":2,"selector":{"matchLabels":{"app":"demo-web"}},"template":{"metadata":{"labels":{"app":"demo-web"}},"spec":{"containers":[{"name":"c","image":"nginx:1.27-alpine","ports":[{"containerPort":80}]}]}}}}'
  # crash / 失败 Job / 运行 Job / OnDelete 可切换 STS：巡检与三态徽标的活体样本
  post /apis/apps/v1/namespaces/$NS/deployments '{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"demo-crash","namespace":"'"$NS"'"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"demo-crash"}},"template":{"metadata":{"labels":{"app":"demo-crash"}},"spec":{"containers":[{"name":"c","image":"busybox:1.36","command":["sh","-c","exit 1"]}]}}}}'
  post /apis/batch/v1/namespaces/$NS/jobs '{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"demo-fail","namespace":"'"$NS"'"},"spec":{"backoffLimit":2,"template":{"metadata":{"labels":{"app":"demo-fail"}},"spec":{"restartPolicy":"OnFailure","containers":[{"name":"c","image":"busybox:1.36","command":["sh","-c","exit 1"]}]}}}}'
  post /apis/batch/v1/namespaces/$NS/jobs '{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"demo-run","namespace":"'"$NS"'"},"spec":{"template":{"metadata":{"labels":{"app":"demo-run"}},"spec":{"restartPolicy":"Never","containers":[{"name":"c","image":"busybox:1.36","command":["sh","-c","sleep 3600"]}]}}}}'
  post /apis/apps/v1/namespaces/$NS/statefulsets '{"apiVersion":"apps/v1","kind":"StatefulSet","metadata":{"name":"demo-sts","namespace":"'"$NS"'"},"spec":{"serviceName":"demo-sts","replicas":1,"selector":{"matchLabels":{"app":"demo-sts"}},"template":{"metadata":{"labels":{"app":"demo-sts"}},"spec":{"containers":[{"name":"c","image":"busybox:1.36","command":["sh","-c","sleep 3600"]}]}}}}'
  echo "(up)"
  ;;
down)
  for r in deployments statefulsets; do del /apis/apps/v1/namespaces/$NS/$r/demo-web >/dev/null 2>&1; done
  del /apis/apps/v1/namespaces/$NS/deployments/demo-web
  del /apis/apps/v1/namespaces/$NS/deployments/demo-crash
  del /apis/batch/v1/namespaces/$NS/jobs/demo-fail
  del /apis/batch/v1/namespaces/$NS/jobs/demo-run
  del /apis/apps/v1/namespaces/$NS/statefulsets/demo-sts
  del /apis/autoscaling/v2/namespaces/$NS/horizontalpodautoscalers/demo-hpa >/dev/null 2>&1
  curl -sS -m 15 -X DELETE "$P/api/v1/namespaces/$NS" -o /dev/null -w "ns:%{http_code}"
  echo " (down)"
  ;;
hpa-on)
  post /apis/autoscaling/v2/namespaces/$NS/horizontalpodautoscalers '{"apiVersion":"autoscaling/v2","kind":"HorizontalPodAutoscaler","metadata":{"name":"demo-hpa","namespace":"'"$NS"'"},"spec":{"scaleTargetRef":{"apiVersion":"apps/v1","kind":"Deployment","name":"demo-web"},"minReplicas":2,"maxReplicas":4,"metrics":[{"resource":{"name":"cpu","target":{"type":"Utilization","averageUtilization":60}}}]}}'
  echo "(hpa-on: demo-web 进入 HPA 托管，验证 ± 只读行/对话框禁用/AI scale fail-closed)"
  ;;
hpa-off)
  del /apis/autoscaling/v2/namespaces/$NS/horizontalpodautoscalers/demo-hpa
  echo "(hpa-off)"
  ;;
status)
  curl -sS -m 15 "$P/apis/apps/v1/namespaces/$NS/deployments" | python3 -c "import json,sys;print('deploy:',[(d['metadata']['name'],str(d['spec']['replicas'])+'/'+str(d['status'].get('readyReplicas') or 0)) for d in json.load(sys.stdin).get('items',[])])"
  curl -sS -m 15 "$P/apis/batch/v1/namespaces/$NS/jobs" | python3 -c "import json,sys;print('jobs:',[j['metadata']['name'] for j in json.load(sys.stdin).get('items',[])])"
  curl -sS -m 15 "$P/apis/autoscaling/v2/namespaces/$NS/horizontalpodautoscalers" | python3 -c "import json,sys;print('hpa:',[h['metadata']['name'] for h in json.load(sys.stdin).get('items',[])])"
  ;;
*) echo "usage: $0 up|down|status|hpa-on|hpa-off"; exit 2 ;;
esac
