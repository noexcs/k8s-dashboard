// 内置 kind 起始模板库：覆盖 registry.tsx 全部 31 个内置 kind（顺序与 RESOURCES 一致，
// 下拉直接按 Object.keys 顺序渲染）。每份示例都带占位名 my-xxx，解析即可直接 apply；
// Node/Event/Lease 等手工创建无真实意义的 kind 只给最小合法示例。
// 自定义模板存 localStorage（键 k8s-templates，{kind: [{name, yaml}]}）：
// 用户数据损坏一律 try/catch 退化为空，绝不让创建对话框白屏。

/** 用户自建模板（localStorage 单条） */
export interface UserTemplate {
  name: string
  yaml: string
}

/** kind → 该 kind 下的自定义模板列表 */
export type UserTemplates = Record<string, UserTemplate[]>

const STORAGE_KEY = 'k8s-templates'

/** 读全部自定义模板；JSON 损坏/形状异常 → 空（不抛错） */
export function loadUserTemplates(): UserTemplates {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: UserTemplates = {}
    for (const [kind, list] of Object.entries(parsed)) {
      if (!Array.isArray(list)) continue
      out[kind] = list.filter(
        (it): it is UserTemplate =>
          !!it && typeof (it as UserTemplate).name === 'string' && typeof (it as UserTemplate).yaml === 'string',
      )
    }
    return out
  } catch {
    return {}
  }
}

function persist(all: UserTemplates): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // 隐私模式/配额写失败不致命：本次会话内仍可用（state 已更新）
  }
}

/** 保存（同名覆盖）；返回写入后的全量，供调用方直接 setState */
export function saveUserTemplate(kind: string, name: string, yaml: string): UserTemplates {
  const all = loadUserTemplates()
  const list = all[kind] ?? []
  const next = [...list.filter(t => t.name !== name), { name, yaml }]
  const out = { ...all, [kind]: next }
  persist(out)
  return out
}

/** 删除一条；kind 桶空则连 kind 一起移除 */
export function deleteUserTemplate(kind: string, name: string): UserTemplates {
  const all = loadUserTemplates()
  const rest = (all[kind] ?? []).filter(t => t.name !== name)
  const out = { ...all }
  if (rest.length) out[kind] = rest
  else delete out[kind]
  persist(out)
  return out
}

/** kind 前缀别名（对齐 GlobalSearch 的思路，覆盖全部内置 kind 的常用缩写） */
export const KIND_ALIASES: Record<string, string> = {
  po: 'Pod', pod: 'Pod', pods: 'Pod',
  deploy: 'Deployment', deployment: 'Deployment', deployments: 'Deployment',
  sts: 'StatefulSet', statefulset: 'StatefulSet', statefulsets: 'StatefulSet',
  ds: 'DaemonSet', daemonset: 'DaemonSet', daemonsets: 'DaemonSet',
  rs: 'ReplicaSet', replicaset: 'ReplicaSet', replicasets: 'ReplicaSet',
  job: 'Job', jobs: 'Job',
  cj: 'CronJob', cronjob: 'CronJob', cronjobs: 'CronJob',
  svc: 'Service', service: 'Service', services: 'Service',
  ing: 'Ingress', ingress: 'Ingress', ingresses: 'Ingress',
  netpol: 'NetworkPolicy', networkpolicy: 'NetworkPolicy', networkpolicies: 'NetworkPolicy',
  ep: 'Endpoints', endpoint: 'Endpoints', endpoints: 'Endpoints',
  pvc: 'PersistentVolumeClaim', persistentvolumeclaim: 'PersistentVolumeClaim', persistentvolumeclaims: 'PersistentVolumeClaim',
  pv: 'PersistentVolume', persistentvolume: 'PersistentVolume', persistentvolumes: 'PersistentVolume',
  sc: 'StorageClass', storageclass: 'StorageClass', storageclasses: 'StorageClass',
  node: 'Node', nodes: 'Node', no: 'Node',
  ns: 'Namespace', namespace: 'Namespace', namespaces: 'Namespace',
  cm: 'ConfigMap', configmap: 'ConfigMap', configmaps: 'ConfigMap',
  secret: 'Secret', secrets: 'Secret',
  sa: 'ServiceAccount', serviceaccount: 'ServiceAccount', serviceaccounts: 'ServiceAccount',
  role: 'Role', roles: 'Role',
  rolebinding: 'RoleBinding', rolebindings: 'RoleBinding', rb: 'RoleBinding',
  clusterrole: 'ClusterRole', clusterroles: 'ClusterRole', cr: 'ClusterRole',
  clusterrolebinding: 'ClusterRoleBinding', clusterrolebindings: 'ClusterRoleBinding', crb: 'ClusterRoleBinding',
  ev: 'Event', event: 'Event', events: 'Event',
  hpa: 'HorizontalPodAutoscaler', horizontalpodautoscaler: 'HorizontalPodAutoscaler', horizontalpodautoscalers: 'HorizontalPodAutoscaler',
  limitrange: 'LimitRange', limitranges: 'LimitRange', lr: 'LimitRange',
  quota: 'ResourceQuota', resourcequota: 'ResourceQuota', resourcequotas: 'ResourceQuota', rq: 'ResourceQuota',
  pdb: 'PodDisruptionBudget', poddisruptionbudget: 'PodDisruptionBudget', poddisruptionbudgets: 'PodDisruptionBudget',
  lease: 'Lease', leases: 'Lease',
  pc: 'PriorityClass', priorityclass: 'PriorityClass', priorityclasses: 'PriorityClass',
  runtimeclass: 'RuntimeClass', runtimeclasses: 'RuntimeClass',
}

/**
 * 内置 kind → 起始 YAML（键顺序 = registry RESOURCES 顺序）。
 * ConfigMap/Secret/Deployment/Service 沿用迁移前 CreateResourceDialog 内的原文，行为不回退。
 */
export const BUILTIN_TEMPLATES: Record<string, string> = {
  Pod: `apiVersion: v1
kind: Pod
metadata:
  name: my-pod
  labels:
    app: my-pod
spec:
  containers:
    - name: app
      image: nginx:latest
`,
  Deployment: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:latest
`,
  StatefulSet: `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-app
spec:
  serviceName: my-app
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:latest
`,
  DaemonSet: `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: my-app
spec:
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:latest
`,
  ReplicaSet: `apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:latest
`,
  Job: `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
spec:
  backoffLimit: 3
  template:
    metadata:
      labels:
        job: my-job
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:latest
          command: ["echo", "done"]
`,
  CronJob: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-cronjob
spec:
  schedule: "*/5 * * * *"
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            job: my-cronjob
        spec:
          restartPolicy: OnFailure
          containers:
            - name: job
              image: busybox:latest
              command: ["echo", "done"]
`,
  Service: `apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 80
`,
  Ingress: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
spec:
  ingressClassName: nginx
  rules:
    - host: my-app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-service
                port:
                  number: 80
`,
  NetworkPolicy: `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: my-netpol
spec:
  podSelector:
    matchLabels:
      app: my-app
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: my-frontend
      ports:
        - port: 80
          protocol: TCP
`,
  Endpoints: `apiVersion: v1
kind: Endpoints
metadata:
  name: my-service
subsets:
  - addresses:
      - ip: 10.244.0.10
    ports:
      - port: 80
`,
  PersistentVolumeClaim: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`,
  PersistentVolume: `apiVersion: v1
kind: PersistentVolume
metadata:
  name: my-pv
spec:
  capacity:
    storage: 1Gi
  accessModes:
    - ReadWriteOnce
  hostPath:
    path: /mnt/my-pv
`,
  StorageClass: `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: my-storageclass
provisioner: kubernetes.io/no-provisioner
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
`,
  Node: `apiVersion: v1
kind: Node
metadata:
  name: my-node
`,
  Namespace: `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
`,
  ConfigMap: `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
data:
  key: value
`,
  Secret: `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
type: Opaque
stringData:
  username: admin
  password: changeme
`,
  ServiceAccount: `apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-sa
`,
  Role: `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: my-role
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
`,
  RoleBinding: `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-rolebinding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: my-role
subjects:
  - kind: ServiceAccount
    name: my-sa
`,
  ClusterRole: `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: my-clusterrole
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
`,
  ClusterRoleBinding: `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: my-clusterrolebinding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: my-clusterrole
subjects:
  - kind: ServiceAccount
    name: my-sa
    namespace: default
`,
  Event: `apiVersion: v1
kind: Event
metadata:
  name: my-event
involvedObject:
  kind: Pod
  name: my-pod
reason: MyReason
type: Normal
message: something happened
`,
  HorizontalPodAutoscaler: `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 1
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80
`,
  LimitRange: `apiVersion: v1
kind: LimitRange
metadata:
  name: my-limits
spec:
  limits:
    - type: Container
      default:
        cpu: 200m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
`,
  ResourceQuota: `apiVersion: v1
kind: ResourceQuota
metadata:
  name: my-quota
spec:
  hard:
    requests.cpu: "1"
    requests.memory: 1Gi
    limits.cpu: "2"
    limits.memory: 2Gi
`,
  PodDisruptionBudget: `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-pdb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: my-app
`,
  Lease: `apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: my-lease
spec:
  holderIdentity: my-holder
  leaseDurationSeconds: 40
`,
  PriorityClass: `apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: my-priority
value: 1000
globalDefault: false
description: my priority class
`,
  RuntimeClass: `apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: my-runtimeclass
handler: runc
`,
}
