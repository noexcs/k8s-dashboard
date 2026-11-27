// 最小 k8s 类型面：只覆盖 v1 视图用到的字段（后端为 headlamp-server /clusters 代理）

export interface ClusterConfig {
  name: string
  server: string
  auth_type: string
  meta_data: { namespace?: string; source?: string; origin?: { kubeconfig?: string } }
}

export interface ConfigResponse {
  clusters: ClusterConfig[]
  isDynamicClusterEnabled: boolean
}

interface ObjectMeta {
  name: string
  namespace?: string
  uid: string
  resourceVersion: string
  creationTimestamp: string
  /** 世代（spec 代际计数）；status.observedGeneration < generation = 控制器未消化 */
  generation?: number
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: { kind: string; name: string; uid: string }[]
  deletionTimestamp?: string
  /** 代理透传原样带来，展示层一律剥离 */
  managedFields?: unknown
}

export interface K8sObject {
  apiVersion: string
  kind: string
  metadata: ObjectMeta
}

export interface ListResult<T extends K8sObject> {
  apiVersion: string
  kind: string
  metadata: { resourceVersion?: string; continue?: string; remainingItemCount?: number }
  items: T[]
}

// --- Pod ---
interface ContainerState {
  running?: { startedAt: string }
  waiting?: { reason: string; message?: string }
  terminated?: { exitCode: number; reason?: string; message?: string; startedAt?: string; finishedAt?: string }
}

interface ContainerStatus {
  name: string
  image: string
  ready: boolean
  restartCount: number
  containerID?: string
  state: ContainerState
  /** 上一次退出记录：崩溃循环的第一证据（exitCode/reason/finishedAt） */
  lastState?: ContainerState
}

interface PodCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime: string
}

export interface Pod extends K8sObject {
  spec: {
    nodeName?: string
    serviceAccountName?: string
    priority?: number
    containers: {
      name: string
      image: string
      ports?: { containerPort: number; name?: string; protocol?: string }[]
      resources?: { requests?: Record<string, string>; limits?: Record<string, string> }
    }[]
    initContainers?: { name: string; image: string }[]
  }
  status: {
    phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown'
    podIP?: string
    hostIP?: string
    startTime?: string
    qosClass?: string
    containerStatuses?: ContainerStatus[]
    initContainerStatuses?: ContainerStatus[]
    conditions?: PodCondition[]
    message?: string
    reason?: string
  }
}

// --- Event ---
export interface Event extends K8sObject {
  involvedObject: { kind: string; name: string; namespace?: string; uid: string; apiVersion?: string; fieldPath?: string }
  reason: string
  message: string
  type: 'Normal' | 'Warning'
  count?: number
  firstTimestamp?: string
  lastTimestamp?: string
  source: { component?: string; host?: string }
  action?: string
}

// --- 通用资源页：各 kind 只声明列表列读取的字段 ---

export interface Deployment extends K8sObject {
  spec?: { replicas?: number }
  status?: { availableReplicas?: number; updatedReplicas?: number; readyReplicas?: number }
}
export interface StatefulSet extends K8sObject {
  spec?: { replicas?: number }
  status?: { readyReplicas?: number }
}
export interface DaemonSet extends K8sObject {
  status?: { desiredNumberScheduled?: number; numberReady?: number }
}
export interface ReplicaSet extends K8sObject {
  spec?: { replicas?: number }
  status?: { readyReplicas?: number }
}
export interface Job extends K8sObject {
  spec?: { completions?: number }
  status?: { succeeded?: number; failed?: number }
}
export interface CronJob extends K8sObject {
  spec?: { schedule?: string; suspend?: boolean }
  status?: { lastScheduleTime?: string }
}
export interface Service extends K8sObject {
  spec?: { type?: string; clusterIP?: string; ports?: { port: number; protocol?: string }[] }
}
export interface Ingress extends K8sObject {
  spec?: { ingressClassName?: string; rules?: { host?: string }[] }
}
export interface NetworkPolicy extends K8sObject {
  spec?: { policyTypes?: string[] }
}
export interface Endpoints extends K8sObject {
  subsets?: { addresses?: { ip: string }[] }[]
}
export interface PersistentVolumeClaim extends K8sObject {
  spec?: { storageClassName?: string }
  status?: { phase?: string; capacity?: { storage?: string } }
}
export interface PersistentVolume extends K8sObject {
  spec?: { capacity?: { storage?: string }; persistentVolumeReclaimPolicy?: string; storageClassName?: string }
  status?: { phase?: string }
}
export interface StorageClass extends K8sObject {
  provisioner?: string
  reclaimPolicy?: string
}
export interface Node extends K8sObject {
  status?: {
    conditions?: { type: string; status: string }[]
    capacity?: { cpu?: string; memory?: string }
    nodeInfo?: { kubeletVersion?: string }
  }
}
export interface Namespace extends K8sObject {
  status?: { phase?: string }
}
export interface ConfigMap extends K8sObject {
  data?: Record<string, string>
}
export interface Secret extends K8sObject {
  type?: string
}
export interface HorizontalPodAutoscaler extends K8sObject {
  spec?: { minReplicas?: number; maxReplicas?: number }
  status?: { currentReplicas?: number }
}
export interface Role extends K8sObject {
  rules?: unknown[]
}
export interface RoleBinding extends K8sObject {
  subjects?: unknown[]
}
export interface PodDisruptionBudget extends K8sObject {
  spec?: { minAvailable?: number; maxUnavailable?: number | string }
}
export interface PriorityClass extends K8sObject {
  value?: number
  globalDefault?: boolean
}
export interface RuntimeClass extends K8sObject {
  handler?: string
}

// --- 通用 ---
export interface WatchEvent<T extends K8sObject = K8sObject> {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR'
  object: T & { metadata?: { resourceVersion?: string } }
}
