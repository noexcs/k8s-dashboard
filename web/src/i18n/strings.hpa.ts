// hpa 字典：HPA 表单编辑器（目标工作负载/副本区间/指标行/behavior/有损告警/保存确认）。ns = hpa
import type { Entry } from './strings'

export const STRINGS_HPA: Record<string, Entry> = {
  // ---- 入口与标题 ----
  'hpa:edit': { zh: '编辑弹性伸缩', en: 'Edit autoscaler' },
  'hpa:create': { zh: '新建弹性伸缩', en: 'New autoscaler (HPA)' },
  'hpa:titleEdit': { zh: '编辑 HorizontalPodAutoscaler：{name}', en: 'Edit HorizontalPodAutoscaler: {name}' },
  'hpa:titleCreate': { zh: '新建 HorizontalPodAutoscaler', en: 'Create HorizontalPodAutoscaler' },
  'hpa:desc': {
    zh: '表单只覆盖 autoscaling/v2 常用字段；Object/Pods/External 指标等复杂字段请用 YAML 页编辑。',
    en: 'The form covers common autoscaling/v2 fields only. Use the YAML tab for advanced fields (Object/Pods/External metrics, ...).',
  },
  'hpa:namespaceLabel': { zh: '命名空间 {ns}', en: 'Namespace {ns}' },

  // ---- 名称 ----
  'hpa:name': { zh: '名称', en: 'Name' },
  'hpa:namePlaceholder': { zh: 'hpa 名称', en: 'hpa name' },
  'hpa:invalidName': {
    zh: '名称必填：小写字母/数字/-/.，且以字母或数字开头结尾',
    en: 'Name is required: lowercase alphanumerics, "-" and ".", must start and end alphanumeric',
  },

  // ---- 目标工作负载 ----
  'hpa:targetTitle': { zh: '目标工作负载（scaleTargetRef）', en: 'Target workload (scaleTargetRef)' },
  'hpa:targetSelectPlaceholder': { zh: '选择工作负载', en: 'Select a workload' },
  'hpa:targetNamePlaceholder': { zh: '手动输入名称', en: 'Type a name manually' },
  'hpa:targetLoadFailed': {
    zh: '工作负载列表加载失败，已退化为手动输入（名称请自行确认）。',
    en: 'Failed to load the workload list; fell back to manual input (double-check the name).',
  },

  // ---- 副本区间 ----
  'hpa:replicasTitle': { zh: '副本区间', en: 'Replica range' },
  'hpa:minReplicas': { zh: '最小副本（minReplicas）', en: 'Min replicas (minReplicas)' },
  'hpa:maxReplicas': { zh: '最大副本（maxReplicas）', en: 'Max replicas (maxReplicas)' },
  'hpa:minPlaceholder': { zh: '缺省 = 1', en: 'default = 1' },
  'hpa:maxPlaceholder': { zh: '必填，≥ 1', en: 'required, >= 1' },
  'hpa:replicasHint': {
    zh: 'minReplicas 留空 = 不写该字段（服务端按 1 处理）；min 可设为 0（允许缩到无副本，需集群启用对应特性）。',
    en: 'Empty minReplicas omits the field (server treats it as 1); min can be 0 (scale to zero requires the cluster feature gate).',
  },

  // ---- 指标 ----
  'hpa:metricsTitle': { zh: '扩缩指标（metrics）', en: 'Metrics' },
  'hpa:addMetric': { zh: '添加指标', en: 'Add metric' },
  'hpa:metricCustom': { zh: '自定义…', en: 'Custom...' },
  'hpa:metricNamePlaceholder': { zh: '如 requests.cpu', en: 'e.g. requests.cpu' },
  'hpa:targetUtilization': { zh: 'Utilization 百分比', en: 'Utilization (%)' },
  'hpa:targetAverageValue': { zh: 'AverageValue 数量', en: 'AverageValue (quantity)' },
  'hpa:utilizationPlaceholder': { zh: '如 80（占 request 的百分比）', en: 'e.g. 80 (percent of request)' },
  'hpa:averageValuePlaceholder': { zh: '如 500m、1Gi', en: 'e.g. 500m, 1Gi' },
  'hpa:metricsEmptyHint': {
    zh: '没有任何指标：HPA 将只受 min/max 约束，不会因负载扩缩。',
    en: 'No metrics: the HPA is bounded by min/max only and never reacts to load.',
  },

  // ---- behavior ----
  'hpa:behaviorTitle': { zh: '扩缩行为（behavior，可选）', en: 'Scaling behavior (optional)' },
  'hpa:scaleDownWindow': { zh: '缩容稳定窗口（秒）', en: 'scaleDown stabilizationWindowSeconds' },
  'hpa:scaleUpWindow': { zh: '扩容稳定窗口（秒）', en: 'scaleUp stabilizationWindowSeconds' },
  'hpa:behaviorHint': {
    zh: '两个都留空 = 不写 spec.behavior（走集群默认行为）；behavior 的其他子字段（policies、selectPolicy 等）编辑时会原样保留。',
    en: 'Leaving both empty omits spec.behavior (cluster defaults apply). Other behavior sub-fields (policies, selectPolicy, ...) are preserved on save.',
  },

  // ---- 就地校验 ----
  'hpa:errTargetName': { zh: '必须选择目标工作负载', en: 'A target workload is required' },
  'hpa:errMaxRequired': { zh: 'maxReplicas 必填', en: 'maxReplicas is required' },
  'hpa:errMaxInvalid': { zh: 'maxReplicas 必须是 ≥ 1 的整数', en: 'maxReplicas must be an integer >= 1' },
  'hpa:errMinInvalid': { zh: 'minReplicas 必须是 ≥ 0 的整数', en: 'minReplicas must be an integer >= 0' },
  'hpa:errMinGtMax': { zh: 'minReplicas 不能大于 maxReplicas', en: 'minReplicas must not exceed maxReplicas' },
  'hpa:errMetricName': { zh: '指标名不能为空', en: 'Metric name is required' },
  'hpa:errUtilization': { zh: 'Utilization 必须是 ≥ 1 的整数百分比', en: 'Utilization must be an integer percentage >= 1' },
  'hpa:errAverageValue': { zh: 'AverageValue 不能为空（如 500m、1Gi）', en: 'AverageValue is required (e.g. 500m, 1Gi)' },
  'hpa:errWindow': { zh: '稳定窗口必须是非负整数（秒）或留空', en: 'Stabilization window must be a non-negative integer (seconds) or empty' },

  // ---- 有损告警 ----
  'hpa:lossyWarning': {
    zh: '检测到表单不支持的字段：{fields}。保存会按上方 YAML 整体替换，请对照确认；不确定请改走 YAML 页编辑。',
    en: 'Fields unsupported by this form detected: {fields}. Saving replaces the object with the YAML below — verify it, or use the YAML tab if unsure.',
  },
  'hpa:lossApiVersion': {
    zh: 'apiVersion 为 {apiVersion}（非 autoscaling/v2），将按原值提交',
    en: 'apiVersion is {apiVersion} (not autoscaling/v2); it will be submitted as-is',
  },
  'hpa:lossTargetKind': {
    zh: '目标类型 {kind} 不在表单支持范围内，将按原值提交',
    en: 'Target kind {kind} is outside the form\'s scope; it will be submitted as-is',
  },
  'hpa:lossMetricType': {
    zh: '存在非 Resource 类型指标（Object/Pods/External），保存会被移除',
    en: 'Non-Resource metrics (Object/Pods/External) exist and will be dropped on save',
  },
  'hpa:lossCustomMetric': {
    zh: '存在自定义指标名（非 cpu/memory），请确认目标名称与目标值没有被改错',
    en: 'Custom metric names (other than cpu/memory) exist; verify their names and targets were kept intact',
  },
  'hpa:lossBehavior': {
    zh: 'behavior 含本表单不生成的子字段（policies、selectPolicy 等），保存时这些子字段会原样保留',
    en: 'behavior contains sub-fields this form does not generate (policies, selectPolicy, ...); they are kept verbatim on save',
  },
  'hpa:lossUnknownSpec': {
    zh: 'spec 含无法识别的字段，保存会被移除',
    en: 'spec contains unrecognized fields that will be dropped on save',
  },

  // ---- 通用 ----
  'hpa:removeRow': { zh: '删除该行', en: 'Remove row' },
  'hpa:preview': { zh: 'YAML 预览', en: 'YAML preview' },

  // ---- 保存 ----
  'hpa:save': { zh: '保存', en: 'Save' },
  'hpa:confirmTitle': { zh: '确认保存该弹性伸缩配置？', en: 'Save this autoscaler?' },
  'hpa:confirmDesc': {
    zh: 'HPA 会持续接管目标工作负载的副本数：负载升高时可扩到 maxReplicas，空闲时最低压到 minReplicas（设为 0 会把 Pod 全部删光）。请对照下方 YAML 确认副本区间与指标阈值符合预期。',
    en: 'An HPA continuously owns the target workload\'s replica count: it scales out toward maxReplicas under load and down to minReplicas when idle (0 removes all pods). Check the YAML below so the replica range and metric thresholds match your intent.',
  },
  'hpa:confirmSave': { zh: '我已确认，保存', en: 'I understand, save' },
  'hpa:savedCreate': { zh: '已创建 HPA {name}', en: 'Created HPA {name}' },
  'hpa:savedUpdate': { zh: '已更新 HPA {name}', en: 'Updated HPA {name}' },
  'hpa:saveFailed': { zh: '保存失败：{error}', en: 'Save failed: {error}' },
  'hpa:conflict': {
    zh: '该 HPA 已被他人修改（409）。请关闭对话框重新打开，基于最新版本再编辑。',
    en: 'This HPA was modified by someone else (409). Close and reopen the editor to start from the latest version.',
  },
}
