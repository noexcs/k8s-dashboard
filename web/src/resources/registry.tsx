// 资源注册表：全部内置 kind 的元信息 + 列表列定义。
// 通用列表页/详情页/侧栏导航都从这里取数（Phase A 核心）。
// 列渲染按 kind 窄类型（types.ts「通用资源页」节）；列表页在唯一渲染边界做一次转换。
import type { ReactNode } from 'react'
import {
  Anchor,
  Bell,
  CalendarClock,
  Clock,
  Container,
  Copy,
  Cylinder,
  Database,
  FileText,
  Flag,
  Folder,
  Gauge,
  GitBranch,
  Globe,
  HardDrive,
  Key,
  Layers,
  LifeBuoy,
  Link,
  Link2,
  Lock,
  LockKeyhole,
  MapPin,
  Radio,
  Scale,
  Server,
  Shield,
  SlidersHorizontal,
  Timer,
  UserRound,
  Waypoints,
  type LucideIcon,
  Activity,
  Aperture,
  Archive,
  Atom,
  BadgeCheck,
  Braces,
  BellRing,
  Binary,
  Blocks,
  Cable,
  Compass,
  Diamond,
  Disc3,
  Fingerprint,
  Flame,
  Gem,
  GitMerge,
  Hexagon,
  Octagon,
  Orbit,
  Pentagon,
  Puzzle,
  Rocket,
  Shapes,
  Stamp,
  Terminal,
  Triangle,
  Unlock,
  Unplug,
  Webhook,
  Wind,
} from 'lucide-react'
import type {
  ConfigMap,
  CronJob,
  DaemonSet,
  Deployment,
  Endpoints,
  HorizontalPodAutoscaler,
  Ingress,
  Job,
  K8sObject,
  Namespace,
  NetworkPolicy,
  Node,
  PersistentVolume,
  PersistentVolumeClaim,
  PodDisruptionBudget,
  PriorityClass,
  ReplicaSet,
  Role,
  RoleBinding,
  RuntimeClass,
  Secret,
  Service,
  StatefulSet,
  StorageClass,
} from '@/api/types'
import { age, fmtTime, shortTime } from '@/lib/format'
import { NodeUsageCell } from '@/components/UsageCell'
import { t } from '@/i18n'

type ResourceScope = 'namespaced' | 'cluster'
export type NavSection = 'workloads' | 'network' | 'storage' | 'nodes' | 'config' | 'other'

export interface Col<T extends K8sObject = K8sObject> {
  key: string
  label: string
  width?: string // 未填 = 1fr（留给 name 列）
  align?: 'left' | 'right'
  /** 排序/筛选用的原始值；不填 = 该列不可排序/筛选（ResourceDataTable 读取） */
  value?: (o: T) => string | number | undefined
  /** 列筛选形态：select = 低基数字段用取值复选列表；缺省 text = 子串输入 */
  filter?: 'text' | 'select'
  render: (o: T) => ReactNode
}

export interface ResourceDef<T extends K8sObject = K8sObject> {
  kind: string
  /** 侧栏显示名 */
  label: string
  group: string // '' = core
  version: string
  resource: string // 复数资源名
  scope: ResourceScope
  section: NavSection
  /** 链接到专用列表页（相对 /c/:cluster/ 的路径段）；不填走通用页 */
  dedicated?: string
  /** 专用详情页路由前缀（相对 /c/:cluster/，接 /:name）；不填走通用详情 */
  dedicatedDetail?: string
  columns?: Col<T>[]
  /** CRD printer columns：追加在通用基础列（name/ns/age）之后（colsFor 组装） */
  printer?: Col<T>[]
  /** CRD 注解 k8s-dashboard.dev/icon 声明的图标名（lucide 白名单，小写匹配）；内置 kind 不填 */
  iconName?: string
}

// ---------- 列渲染工具（多调用点共享同一视觉规则） ----------

function cell(node: ReactNode, cls = ''): ReactNode {
  if (node == null || node === '' || node === '-') return <span className="text-muted-foreground">-</span>
  return <span className={cls}>{node}</span>
}

function readyRatio(a: number | undefined, d: number | undefined): ReactNode {
  const avail = a ?? 0
  const total = d ?? 0
  const ok = total > 0 && avail >= total
  return <span className={`tabular-nums ${ok ? 'text-positive' : total > 0 && avail === 0 ? 'text-negative' : 'text-caution'}`}>{avail}/{total}</span>
}

// ---------- 各 kind 的列 ----------

const deploymentCols: Col<Deployment>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'ready', label: 'res:colReady', width: '60px', render: o => cell(readyRatio(o.status?.availableReplicas, o.spec?.replicas)) },
  { key: 'updated', label: 'res:colUpdated', width: '56px', align: 'right', value: o => o.status?.updatedReplicas, filter: 'select', render: o => cell(o.status?.updatedReplicas, 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const statefulSetCols: Col<StatefulSet>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'ready', label: 'res:colReady', width: '60px', render: o => cell(readyRatio(o.status?.readyReplicas, o.spec?.replicas)) },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const daemonSetCols: Col<DaemonSet>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'ready', label: 'res:colReadyDesired', width: '80px', render: o => cell(readyRatio(o.status?.numberReady, o.status?.desiredNumberScheduled)) },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const replicaSetCols: Col<ReplicaSet>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'ready', label: 'res:colReady', width: '60px', render: o => cell(readyRatio(o.status?.readyReplicas, o.spec?.replicas)) },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const jobCols: Col<Job>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'done', label: 'res:colSucceeded', width: '70px', render: o => cell(readyRatio(o.status?.succeeded, o.spec?.completions ?? 1)) },
  { key: 'failed', label: 'res:colFailed', width: '48px', align: 'right', value: o => o.status?.failed ?? 0, filter: 'select', render: o => cell(o.status?.failed ?? 0, 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const cronJobCols: Col<CronJob>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'schedule', label: 'res:colSchedule', width: '110px', value: o => o.spec?.schedule, filter: 'text', render: o => cell(o.spec?.schedule, 'font-mono text-xs') },
  { key: 'suspend', label: 'res:colStatus', width: '56px', value: o => (o.spec?.suspend ? 'suspended' : 'active'), filter: 'select', render: o => (o.spec?.suspend ? cell(t('res:valSuspended'), 'text-caution') : cell(t('res:valActive'), 'text-positive')) },
  { key: 'last', label: 'res:colLastSchedule', width: '110px', value: o => o.status?.lastScheduleTime, render: o => cell(shortTime(o.status?.lastScheduleTime)) },
  {
    // 「active 但从未跑成功」此前显示绿色「启用」——列只看 spec.suspend，结果面全无
    key: 'lastok',
    label: 'sys:lastSuccess',
    width: '120px',
    value: o => (o.status as { lastSuccessTime?: string } | undefined)?.lastSuccessTime,
    render: o => {
      const okT = (o.status as { lastSuccessTime?: string } | undefined)?.lastSuccessTime
      const schT = o.status?.lastScheduleTime
      if (!okT) return cell(t('sys:neverSucceeded'), 'text-destructive')
      // active>0 = 最近调度派生的 Job 仍在正常跑——长任务期间 schT>okT 是常态不是事故，
      // 备份类 CronJob 不该每天有大段时间顶琥珀假警示（与 Job 三态同口吻）
      const activeN = (o.status as { active?: unknown[] } | undefined)?.active?.length ?? 0
      if (activeN > 0) return cell(t('sys:jobRunning'), 'text-muted-foreground')
      if (schT && schT > okT) return cell(t('sys:latestRunPending'), 'text-caution')
      return cell(shortTime(okT))
    },
  },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const serviceCols: Col<Service>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'type', label: 'res:colType', width: '80px', value: o => o.spec?.type ?? 'ClusterIP', filter: 'select', render: o => cell(o.spec?.type ?? 'ClusterIP') },
  { key: 'ip', label: 'res:colClusterIp', width: '120px', value: o => o.spec?.clusterIP, filter: 'text', render: o => cell(o.spec?.clusterIP, 'font-mono text-xs') },
  {
    key: 'ports', label: 'res:colPorts', width: '110px',
    render: o => cell((o.spec?.ports ?? []).map(p => `${p.port}${p.protocol ? ':' + p.protocol : ''}`).join(' '), 'font-mono text-xs'),
  },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const ingressCols: Col<Ingress>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'class', label: 'res:colClass', width: '90px', value: o => o.spec?.ingressClassName, filter: 'text', render: o => cell(o.spec?.ingressClassName, 'font-mono text-xs') },
  { key: 'host', label: 'res:colHost', width: '120px', value: o => o.spec?.rules?.[0]?.host, filter: 'text', render: o => cell(o.spec?.rules?.[0]?.host, 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const networkPolicyCols: Col<NetworkPolicy>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'types', label: 'res:colPolicyTypes', width: '140px', value: o => (o.spec?.policyTypes ?? []).join(', '), filter: 'text', render: o => cell((o.spec?.policyTypes ?? []).join(', ')) },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const endpointsCols: Col<Endpoints>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'addrs', label: 'res:colAddrCount', width: '60px', align: 'right', value: o => o.subsets?.[0]?.addresses?.length ?? 0, filter: 'select', render: o => cell(o.subsets?.[0]?.addresses?.length ?? 0, 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const pvcCols: Col<PersistentVolumeClaim>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'phase', label: 'res:colPhase', width: '80px', value: o => o.status?.phase, filter: 'select', render: o => cell(o.status?.phase) },
  { key: 'cap', label: 'res:colCapacity', width: '70px', align: 'right', value: o => o.status?.capacity?.storage, filter: 'text', render: o => cell(o.status?.capacity?.storage, 'font-mono text-xs') },
  { key: 'sc', label: 'res:colStorageClass', width: '130px', value: o => o.spec?.storageClassName, filter: 'text', render: o => cell(o.spec?.storageClassName, 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const pvCols: Col<PersistentVolume>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'phase', label: 'res:colPhase', width: '90px', value: o => o.status?.phase, filter: 'select', render: o => cell(o.status?.phase) },
  { key: 'cap', label: 'res:colCapacity', width: '70px', align: 'right', value: o => o.spec?.capacity?.storage, filter: 'text', render: o => cell(o.spec?.capacity?.storage, 'font-mono text-xs') },
  { key: 'reclaim', label: 'res:colReclaim', width: '80px', value: o => o.spec?.persistentVolumeReclaimPolicy, filter: 'select', render: o => cell(o.spec?.persistentVolumeReclaimPolicy) },
  { key: 'sc', label: 'res:colStorageClass', width: '130px', value: o => o.spec?.storageClassName, filter: 'text', render: o => cell(o.spec?.storageClassName, 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const storageClassCols: Col<StorageClass>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'prov', label: 'res:colProvisioner', width: '180px', value: o => o.provisioner, filter: 'text', render: o => cell(o.provisioner, 'font-mono text-xs') },
  { key: 'reclaim', label: 'res:colReclaim', width: '80px', value: o => o.reclaimPolicy, filter: 'select', render: o => cell(o.reclaimPolicy) },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const nodeCols: Col<Node>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  {
    key: 'status', label: 'res:colStatus', width: '80px',
    value: o => (o.status?.conditions?.find(c => c.type === 'Ready')?.status === 'True' ? 'ready' : 'notready'),
    filter: 'select',
    render: o => {
      const ready = o.status?.conditions?.find(c => c.type === 'Ready')
      return ready?.status === 'True' ? <span className="text-positive">Ready</span> : <span className="text-caution">NotReady</span>
    },
  },
  {
    key: 'role', label: 'res:colRole', width: '80px',
    value: o => Object.keys(o.metadata.labels ?? {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]).join(','),
    filter: 'text',
    render: o => cell(Object.keys(o.metadata.labels ?? {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]).join(',')),
  },
  { key: 'ver', label: 'res:colKubelet', width: '90px', value: o => o.status?.nodeInfo?.kubeletVersion, filter: 'text', render: o => cell(o.status?.nodeInfo?.kubeletVersion, 'font-mono text-xs') },
  {
    key: 'cpuUsage', label: 'res:colCpuUsage', width: '60px', align: 'right',
    // 用量来自 metrics-server（Context 注入，ResourceListPage kind=Node 时提供）；不可排序（异步数据混入同步 value 会乱）
    render: o => <NodeUsageCell name={o.metadata.name} usageKey="cpu" capacity={o.status?.capacity?.cpu} cpu />,
  },
  {
    key: 'memUsage', label: 'res:colMemUsage', width: '70px', align: 'right',
    render: o => <NodeUsageCell name={o.metadata.name} usageKey="memory" capacity={o.status?.capacity?.memory} />,
  },
  { key: 'cpu', label: 'res:colCpu', width: '50px', align: 'right', value: o => o.status?.capacity?.cpu, filter: 'text', render: o => cell(o.status?.capacity?.cpu, 'font-mono text-xs') },
  { key: 'mem', label: 'res:colMemory', width: '70px', align: 'right', value: o => o.status?.capacity?.memory, filter: 'text', render: o => cell(o.status?.capacity?.memory, 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const namespaceCols: Col<Namespace>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'status', label: 'res:colStatus', width: '80px', value: o => o.status?.phase, filter: 'select', render: o => cell(o.status?.phase) },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const configMapCols: Col<ConfigMap>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'keys', label: 'res:colKeys', width: '60px', align: 'right', value: o => Object.keys(o.data ?? {}).length, filter: 'select', render: o => cell(Object.keys(o.data ?? {}).length, 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const secretCols: Col<Secret>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'type', label: 'res:colType', width: '140px', value: o => o.type ?? 'Opaque', filter: 'select', render: o => cell(o.type ?? 'Opaque', 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const hpaCols: Col<HorizontalPodAutoscaler>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'range', label: 'res:colMinMax', width: '70px', value: o => `${o.spec?.minReplicas ?? 0}/${o.spec?.maxReplicas}`, filter: 'text', render: o => cell(`${o.spec?.minReplicas ?? 0}/${o.spec?.maxReplicas}`, 'font-mono text-xs') },
  { key: 'cur', label: 'res:colCurrent', width: '50px', align: 'right', value: o => o.status?.currentReplicas ?? 0, filter: 'select', render: o => cell(o.status?.currentReplicas ?? 0, 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const roleCols: Col<Role>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'rules', label: 'res:colRules', width: '60px', align: 'right', value: o => o.rules?.length ?? 0, filter: 'select', render: o => cell(o.rules?.length ?? 0, 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const roleBindingCols: Col<RoleBinding>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  { key: 'subjects', label: 'res:colSubjects', width: '80px', align: 'right', value: o => o.subjects?.length ?? 0, filter: 'select', render: o => cell(o.subjects?.length ?? 0, 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const pdbCols: Col<PodDisruptionBudget>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'ns', label: 'res:colNs', width: '100px', value: o => o.metadata.namespace, filter: 'select', render: o => cell(o.metadata.namespace, 'text-muted-foreground') },
  {
    key: 'budget', label: 'res:colBudget', width: '100px',
    value: o => (o.spec?.minAvailable != null ? `min ${o.spec.minAvailable}` : o.spec?.maxUnavailable != null ? `max ${o.spec.maxUnavailable}` : undefined),
    filter: 'text',
    render: o => cell(o.spec?.minAvailable != null ? `min ${o.spec.minAvailable}` : o.spec?.maxUnavailable != null ? `max ${o.spec.maxUnavailable}` : undefined, 'font-mono text-xs'),
  },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const priorityClassCols: Col<PriorityClass>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'value', label: 'res:colPriority', width: '70px', align: 'right', value: o => o.value, filter: 'select', render: o => cell(o.value, 'font-mono text-xs') },
  { key: 'global', label: 'res:colDefault', width: '50px', render: o => (o.globalDefault ? cell(t('res:valYes')) : null) },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]
const runtimeClassCols: Col<RuntimeClass>[] = [
  { key: 'name', label: 'res:colName', value: o => o.metadata.name, filter: 'text', render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  { key: 'handler', label: 'res:colHandler', width: '140px', value: o => o.handler, filter: 'text', render: o => cell(o.handler, 'font-mono text-xs') },
  { key: 'age', label: 'res:colAge', width: '60px', align: 'right', value: o => o.metadata.creationTimestamp, render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') },
]

// ---------- 注册表 ----------

const RESOURCES: (
  | ResourceDef<K8sObject>
  | ResourceDef<Deployment>
  | ResourceDef<StatefulSet>
  | ResourceDef<DaemonSet>
  | ResourceDef<ReplicaSet>
  | ResourceDef<Job>
  | ResourceDef<CronJob>
  | ResourceDef<Service>
  | ResourceDef<Ingress>
  | ResourceDef<NetworkPolicy>
  | ResourceDef<Endpoints>
  | ResourceDef<PersistentVolumeClaim>
  | ResourceDef<PersistentVolume>
  | ResourceDef<StorageClass>
  | ResourceDef<Node>
  | ResourceDef<Namespace>
  | ResourceDef<ConfigMap>
  | ResourceDef<Secret>
  | ResourceDef<HorizontalPodAutoscaler>
  | ResourceDef<Role>
  | ResourceDef<RoleBinding>
  | ResourceDef<PodDisruptionBudget>
  | ResourceDef<PriorityClass>
  | ResourceDef<RuntimeClass>
)[] = [
  // 工作负载
  { kind: 'Pod', label: 'Pods', group: '', version: 'v1', resource: 'pods', scope: 'namespaced', section: 'workloads', dedicated: 'pods' },
  { kind: 'Deployment', label: 'Deployments', group: 'apps', version: 'v1', resource: 'deployments', scope: 'namespaced', section: 'workloads', columns: deploymentCols },
  { kind: 'StatefulSet', label: 'StatefulSets', group: 'apps', version: 'v1', resource: 'statefulsets', scope: 'namespaced', section: 'workloads', columns: statefulSetCols },
  { kind: 'DaemonSet', label: 'DaemonSets', group: 'apps', version: 'v1', resource: 'daemonsets', scope: 'namespaced', section: 'workloads', columns: daemonSetCols },
  { kind: 'ReplicaSet', label: 'ReplicaSets', group: 'apps', version: 'v1', resource: 'replicasets', scope: 'namespaced', section: 'workloads', columns: replicaSetCols },
  { kind: 'Job', label: 'Jobs', group: 'batch', version: 'v1', resource: 'jobs', scope: 'namespaced', section: 'workloads', columns: jobCols },
  { kind: 'CronJob', label: 'CronJobs', group: 'batch', version: 'v1', resource: 'cronjobs', scope: 'namespaced', section: 'workloads', columns: cronJobCols },
  // 网络
  { kind: 'Service', label: 'Services', group: '', version: 'v1', resource: 'services', scope: 'namespaced', section: 'network', columns: serviceCols },
  { kind: 'Ingress', label: 'Ingresses', group: 'networking.k8s.io', version: 'v1', resource: 'ingresses', scope: 'namespaced', section: 'network', columns: ingressCols },
  { kind: 'NetworkPolicy', label: 'NetworkPolicies', group: 'networking.k8s.io', version: 'v1', resource: 'networkpolicies', scope: 'namespaced', section: 'network', columns: networkPolicyCols },
  { kind: 'Endpoints', label: 'Endpoints', group: '', version: 'v1', resource: 'endpoints', scope: 'namespaced', section: 'network', columns: endpointsCols },
  // 存储
  { kind: 'PersistentVolumeClaim', label: 'PVCs', group: '', version: 'v1', resource: 'persistentvolumeclaims', scope: 'namespaced', section: 'storage', columns: pvcCols },
  { kind: 'PersistentVolume', label: 'PVs', group: '', version: 'v1', resource: 'persistentvolumes', scope: 'cluster', section: 'storage', columns: pvCols },
  { kind: 'StorageClass', label: 'StorageClasses', group: 'storage.k8s.io', version: 'v1', resource: 'storageclasses', scope: 'cluster', section: 'storage', columns: storageClassCols },
  // 节点
  { kind: 'Node', label: 'Nodes', group: '', version: 'v1', resource: 'nodes', scope: 'cluster', section: 'nodes', dedicatedDetail: 'r/Node/cluster', columns: nodeCols },
  // 配置与权限
  { kind: 'Namespace', label: 'Namespaces', group: '', version: 'v1', resource: 'namespaces', scope: 'cluster', section: 'config', columns: namespaceCols },
  { kind: 'ConfigMap', label: 'ConfigMaps', group: '', version: 'v1', resource: 'configmaps', scope: 'namespaced', section: 'config', columns: configMapCols },
  { kind: 'Secret', label: 'Secrets', group: '', version: 'v1', resource: 'secrets', scope: 'namespaced', section: 'config', columns: secretCols },
  { kind: 'ServiceAccount', label: 'ServiceAccounts', group: '', version: 'v1', resource: 'serviceaccounts', scope: 'namespaced', section: 'config' },
  { kind: 'Role', label: 'Roles', group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'roles', scope: 'namespaced', section: 'config', columns: roleCols },
  { kind: 'RoleBinding', label: 'RoleBindings', group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'rolebindings', scope: 'namespaced', section: 'config', columns: roleBindingCols },
  { kind: 'ClusterRole', label: 'ClusterRoles', group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'clusterroles', scope: 'cluster', section: 'config' },
  { kind: 'ClusterRoleBinding', label: 'ClusterRoleBindings', group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'clusterrolebindings', scope: 'cluster', section: 'config' },
  // 其他
  { kind: 'Event', label: 'Events', group: '', version: 'v1', resource: 'events', scope: 'namespaced', section: 'other', dedicated: 'events' },
  { kind: 'HorizontalPodAutoscaler', label: 'HPAs', group: 'autoscaling', version: 'v2', resource: 'horizontalpodautoscalers', scope: 'namespaced', section: 'other', columns: hpaCols },
  { kind: 'LimitRange', label: 'LimitRanges', group: '', version: 'v1', resource: 'limitranges', scope: 'namespaced', section: 'other' },
  { kind: 'ResourceQuota', label: 'Quotas', group: '', version: 'v1', resource: 'resourcequotas', scope: 'namespaced', section: 'other' },
  { kind: 'PodDisruptionBudget', label: 'PDBs', group: 'policy', version: 'v1', resource: 'poddisruptionbudgets', scope: 'namespaced', section: 'other', columns: pdbCols },
  { kind: 'Lease', label: 'Leases', group: 'coordination.k8s.io', version: 'v1', resource: 'leases', scope: 'namespaced', section: 'other' },
  { kind: 'PriorityClass', label: 'PriorityClasses', group: 'scheduling.k8s.io', version: 'v1', resource: 'priorityclasses', scope: 'cluster', section: 'other', columns: priorityClassCols },
  { kind: 'RuntimeClass', label: 'RuntimeClasses', group: 'node.k8s.io', version: 'v1', resource: 'runtimeclasses', scope: 'cluster', section: 'other', columns: runtimeClassCols },
]

export type AnyResourceDef = (typeof RESOURCES)[number]

export const RESOURCE_MAP: Record<string, AnyResourceDef> = Object.fromEntries(
  RESOURCES.map(r => [r.kind, r] as const),
) as Record<string, AnyResourceDef>

/**
 * 侧栏导航图标：按 kind 分配，同族内也不重样（图标语义对齐资源语义，
 * 图标列宽与行内 gap 在 AppLayout 统一；CRD 兜底图标见 AppSidebar）。
 */
const NAV_ICONS: Record<string, LucideIcon> = {
  Pod: Container,
  Deployment: Layers, // 滚动发布的堆叠
  StatefulSet: Anchor, // 稳定标识
  DaemonSet: Radio, // 广播到每个节点
  ReplicaSet: Copy, // 副本
  Job: Timer,
  CronJob: CalendarClock,
  Service: Waypoints,
  Ingress: Globe,
  NetworkPolicy: Shield,
  Endpoints: MapPin, // 后端位置
  PersistentVolumeClaim: HardDrive,
  PersistentVolume: Database, // 物理卷
  StorageClass: Cylinder,
  Node: Server,
  Namespace: Folder,
  ConfigMap: FileText,
  Secret: Key,
  ServiceAccount: UserRound,
  HorizontalPodAutoscaler: Gauge,
  Role: Lock,
  RoleBinding: Link, // 绑定 = 把主体链到角色
  ClusterRole: LockKeyhole,
  ClusterRoleBinding: Link2,
  Event: Bell,
  LimitRange: SlidersHorizontal,
  ResourceQuota: Scale,
  PodDisruptionBudget: LifeBuoy, // 可用性保护（与 NetworkPolicy 的 Shield 区分）
  Lease: Clock,
  PriorityClass: Flag,
  RuntimeClass: GitBranch,
  // —— 常见 operator CR（CRD 无官方图标字段，按 kind 语义收录；其余 CRD 走 hash 兜底）——
  Certificate: BadgeCheck, // cert-manager
  Issuer: Fingerprint,
  ClusterIssuer: Stamp,
  Prometheus: Activity, // monitoring.coreos.com
  Alertmanager: BellRing,
  ServiceMonitor: Cable,
  Application: Rocket, // argo-cd
  Rollout: GitMerge, // argo-rollouts 渐进发布
  Backup: Archive, // velero
  ExternalSecret: Unlock, // external-secrets：从外部密钥库解锁注入
}

/**
 * CRD 图标库：k8s-dashboard.dev/icon 注解的白名单（键 = lucide 名小写），
 * values 同时是未知 kind 的 hash 兜底池——同一 kind 永远落在同一图标，
 * 避免以前「所有 CRD 一把 Puzzle」的一刀切。
 */
const CRD_ICON_LIBRARY: Record<string, LucideIcon> = {
  aperture: Aperture,
  archive: Archive,
  atom: Atom,
  braces: Braces,
  binary: Binary,
  blocks: Blocks,
  compass: Compass,
  diamond: Diamond,
  disc: Disc3,
  flame: Flame,
  gem: Gem,
  hexagon: Hexagon,
  octagon: Octagon,
  orbit: Orbit,
  pentagon: Pentagon,
  puzzle: Puzzle,
  rocket: Rocket,
  shapes: Shapes,
  stamp: Stamp,
  terminal: Terminal,
  triangle: Triangle,
  unplug: Unplug,
  webhook: Webhook,
  wind: Wind,
}
const CRD_ICON_POOL = Object.values(CRD_ICON_LIBRARY)

/** FNV-1a：kind → 稳定 32bit，跨会话/跨集群同 kind 同图标 */
const fnv1a = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * 资源图标三层解析：CRD 注解 k8s-dashboard.dev/icon（白名单内）→ kind 内置映射 → kind hash。
 * 与 kindIcon 的区别：永远返回非空，CRD 不再统一 Puzzle。
 */
export function kindIconFor(kindOrDef: string | { kind: string; iconName?: string }): LucideIcon {
  const kind = typeof kindOrDef === 'string' ? kindOrDef : kindOrDef.kind
  const def = typeof kindOrDef === 'string' ? (RESOURCE_MAP[kind] as { iconName?: string } | undefined) : kindOrDef
  const anno = def?.iconName?.trim().toLowerCase()
  if (anno && CRD_ICON_LIBRARY[anno]) return CRD_ICON_LIBRARY[anno]
  return NAV_ICONS[kind] ?? CRD_ICON_POOL[fnv1a(kind) % CRD_ICON_POOL.length]
}

/**
 * 列定义（未定义 kind 用默认列：名称 + ns + age）。
 * kind 由注册表定死，行数据就是该 kind 的窄类型；此处是唯一的不受检转换点，
 * 列表页拿到的 Col<K8sObject> 直接可渲染。
 */
export function colsFor(d: AnyResourceDef): Col<K8sObject>[] {
  if (d.columns && d.columns.length > 0) return d.columns as unknown as Col<K8sObject>[]
  const cols: Col<K8sObject>[] = [
    { key: 'name', label: d.label, render: o => <span className="min-w-0 truncate font-medium" title={o.metadata.name}>{o.metadata.name}</span> },
  ]
  if (d.scope === 'namespaced') {
    cols.push({ key: 'ns', label: 'res:colNs', width: '100px', render: o => cell(o.metadata.namespace, 'text-muted-foreground') })
  }
  // CRD printer columns 在 age 之前插入（kubectl 顺序：自定义列在前、Age 收尾）
  if (d.printer?.length) cols.push(...(d.printer as unknown as Col<K8sObject>[]))
  cols.push({ key: 'age', label: 'res:colAge', width: '60px', align: 'right', render: o => cell(age(o.metadata.creationTimestamp), 'text-xs text-muted-foreground') })
  return cols
}

// ---------- 路径 ----------

export function apiBase(d: Pick<ResourceDef, 'group'>): string {
  return d.group ? `apis/${d.group}` : 'api'
}

/** 列表路径。ns 省略 = 全部命名空间（namespaced kind）。 */
export function listPath(d: Pick<ResourceDef, 'group' | 'version' | 'resource' | 'scope'>, ns?: string): string {
  if (d.scope === 'cluster') return `/${apiBase(d)}/${d.version}/${d.resource}`
  return ns ? `/${apiBase(d)}/${d.version}/namespaces/${ns}/${d.resource}` : `/${apiBase(d)}/${d.version}/${d.resource}`
}

/** 单对象路径。cluster scope 忽略 ns（传 'cluster'）。 */
export function itemPath(d: Pick<ResourceDef, 'group' | 'version' | 'resource' | 'scope'>, ns: string, name: string): string {
  return d.scope === 'cluster'
    ? `/${apiBase(d)}/${d.version}/${d.resource}/${name}`
    : `/${apiBase(d)}/${d.version}/namespaces/${ns}/${d.resource}/${name}`
}

/** 路由：列表 */
export function listRoute(d: Pick<ResourceDef, 'kind' | 'scope'>, cluster: string, ns?: string): string {
  // 段值统一 encode：集群名可含空格（动态集群用户随意起名），不编码会把路由切散
  const c = encodeURIComponent(cluster)
  if (d.scope === 'cluster') return `/c/${c}/r/${d.kind}`
  return ns ? `/c/${c}/r/${d.kind}/${encodeURIComponent(ns)}` : `/c/${c}/r/${d.kind}`
}

/** 路由：详情。cluster scope 用 'cluster' 占位段；dedicatedDetail 优先（如 Node）。 */
export function detailRoute(
  d: Pick<ResourceDef, 'kind' | 'scope' | 'dedicatedDetail'>,
  cluster: string,
  ns: string,
  name: string,
): string {
  if (d.dedicatedDetail) return `/c/${encodeURIComponent(cluster)}/${d.dedicatedDetail}/${encodeURIComponent(name)}`
  const c = encodeURIComponent(cluster)
  const n = encodeURIComponent(name)
  return d.scope === 'cluster'
    ? `/c/${c}/r/${d.kind}/cluster/${n}`
    : `/c/${c}/r/${d.kind}/${encodeURIComponent(ns)}/${n}`
}

/** 侧栏分组 */
export const NAV_SECTIONS: { section: NavSection; label: string }[] = [
  { section: 'workloads', label: 'res:sectionWorkloads' },
  { section: 'network', label: 'res:sectionNetwork' },
  { section: 'storage', label: 'res:sectionStorage' },
  { section: 'nodes', label: 'res:sectionNodes' },
  { section: 'config', label: 'res:sectionConfig' },
  { section: 'other', label: 'res:sectionOther' },
]

export function sectionItems(section: NavSection): AnyResourceDef[] {
  return RESOURCES.filter(r => r.section === section)
}

/** 详情页概览用 */
export function fmtCreated(o: K8sObject): string {
  return fmtTime(o.metadata.creationTimestamp)
}
