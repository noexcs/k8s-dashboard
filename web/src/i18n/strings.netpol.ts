// np 字典：NetworkPolicy 表单编辑器（预设/podSelector/规则/端口/YAML 预览/保存确认）。ns = np
import type { Entry } from './strings'

export const STRINGS_NETPOL: Record<string, Entry> = {
  // ---- 入口与标题 ----
  'np:edit': { zh: '编辑策略', en: 'Edit policy' },
  'np:create': { zh: '新建网络策略', en: 'New NetworkPolicy' },
  'np:titleEdit': { zh: '编辑 NetworkPolicy：{name}', en: 'Edit NetworkPolicy: {name}' },
  'np:titleCreate': { zh: '新建 NetworkPolicy', en: 'Create NetworkPolicy' },
  'np:desc': {
    zh: '表单只覆盖常用字段；复杂字段（matchExpressions、endPort 等）请用 YAML 页编辑。',
    en: 'The form covers common fields only. Use the YAML tab for advanced fields (matchExpressions, endPort, ...).',
  },
  'np:namespaceLabel': { zh: '命名空间 {ns}', en: 'Namespace {ns}' },

  // ---- 名称 ----
  'np:name': { zh: '名称', en: 'Name' },
  'np:namePlaceholder': { zh: 'network-policy 名称', en: 'network policy name' },
  'np:invalidName': {
    zh: '名称必填：小写字母/数字/-/.，且以字母或数字开头结尾',
    en: 'Name is required: lowercase alphanumerics, "-" and ".", must start and end alphanumeric',
  },

  // ---- 预设 ----
  'np:presets': { zh: '预设', en: 'Presets' },
  'np:presetDeny': { zh: '默认拒绝全部 Ingress', en: 'Deny all ingress' },
  'np:presetSameNs': { zh: '放行同 ns', en: 'Allow same namespace' },
  'np:presetIngressNs': { zh: '放行来自 ingress-controller ns', en: 'Allow from ingress-controller namespace' },
  'np:presetApplied': { zh: '已应用预设「{name}」', en: 'Preset applied: {name}' },

  // ---- podSelector ----
  'np:podSelector': { zh: '作用的 Pod（podSelector）', en: 'Applies to pods (podSelector)' },
  'np:selAll': { zh: '全部 Pod', en: 'All pods' },
  'np:selLabels': { zh: '按标签', en: 'By labels' },
  'np:labelsHint': { zh: '标签行留空 = 匹配全部', en: 'No label rows = match everything' },
  'np:labelKey': { zh: '标签名', en: 'Label key' },
  'np:labelValue': { zh: '标签值', en: 'Label value' },
  'np:addLabel': { zh: '添加标签', en: 'Add label' },
  'np:removeRow': { zh: '删除该行', en: 'Remove row' },

  // ---- policyTypes ----
  'np:policyTypes': { zh: '策略类型（policyTypes）', en: 'Policy types' },
  'np:typesHint': {
    zh: '未勾选的方向不受本策略限制（流量照常放行）；两个都不勾 = 本策略不限制任何流量。',
    en: 'Unchecked directions are not restricted by this policy (traffic flows as usual); checking neither restricts nothing.',
  },

  // ---- 规则 ----
  'np:ingressRules': { zh: 'Ingress 规则（放行的入站流量）', en: 'Ingress rules (allowed inbound traffic)' },
  'np:egressRules': { zh: 'Egress 规则（放行的出站流量）', en: 'Egress rules (allowed outbound traffic)' },
  'np:addRule': { zh: '添加规则', en: 'Add rule' },
  'np:ruleN': { zh: '规则 {n}', en: 'Rule {n}' },
  'np:deleteRule': { zh: '删除规则', en: 'Delete rule' },
  'np:rulesEmptyDeny': {
    zh: '没有任何规则：被本策略选中的 Pod 的{dir}流量将全部被拒绝。',
    en: 'No rules: all {dir} traffic to the selected pods will be denied.',
  },
  'np:dirIngress': { zh: '入站（Ingress）', en: ' inbound (Ingress)' },
  'np:dirEgress': { zh: '出站（Egress）', en: ' outbound (Egress)' },

  // ---- 来源/目标 ----
  'np:sourcesFrom': { zh: '来源（from）', en: 'Sources (from)' },
  'np:sourcesTo': { zh: '目标（to）', en: 'Targets (to)' },
  'np:noSourceHint': {
    zh: '未添加任何来源 = 放行全部来源（注意：与「一条规则都没有」的全拒语义不同）。',
    en: 'No source added = allow all sources (different from an empty rule list, which denies everything).',
  },
  'np:srcAll': { zh: '全部', en: 'All' },
  'np:srcPods': { zh: '同 ns · Pod 标签', en: 'Same ns · pod labels' },
  'np:srcNamespaces': { zh: '按命名空间标签', en: 'By namespace labels' },
  'np:srcNsPods': { zh: '跨 ns · ns+Pod 标签', en: 'Cross-ns · ns + pod labels' },
  'np:srcIpBlock': { zh: 'IP 段', en: 'IP block' },

  // ---- 来源条目 ----
  'np:peerAll': { zh: '全部来源（不限）', en: 'All sources (unrestricted)' },
  'np:peerAllDesc': { zh: '任何来源都被放行', en: 'Traffic from anywhere is allowed' },
  'np:peerPods': { zh: '本命名空间 · 按 Pod 标签', en: 'This namespace · by pod labels' },
  'np:peerNamespaces': { zh: '按命名空间标签', en: 'By namespace labels' },
  'np:peerNsPods': { zh: '跨命名空间（ns 标签 + Pod 标签）', en: 'Cross-namespace (namespace + pod labels)' },
  'np:peerIpBlock': { zh: 'IP 段（ipBlock）', en: 'IP block' },
  'np:nsLabelKey': { zh: '命名空间标签名', en: 'Namespace label key' },
  'np:cidr': { zh: 'CIDR', en: 'CIDR' },
  'np:cidrPlaceholder': { zh: '如 10.0.0.0/8', en: 'e.g. 10.0.0.0/8' },
  'np:except': { zh: '排除（except）', en: 'Excluded (except)' },
  'np:addExcept': { zh: '添加排除段', en: 'Add exclusion' },
  'np:exceptPlaceholder': { zh: '如 10.0.9.0/24', en: 'e.g. 10.0.9.0/24' },

  // ---- 端口 ----
  'np:ports': { zh: '端口', en: 'Ports' },
  'np:portAllHint': { zh: '端口留空 = 该规则放行全部端口', en: 'Empty port = rule allows all ports' },
  'np:addPort': { zh: '添加端口', en: 'Add port' },
  'np:portPlaceholder': { zh: '端口号或名称，如 80 / http', en: 'Port number or name, e.g. 80 / http' },
  'np:invalidPort': { zh: '端口无效：{value}（需 1-65535 数字或小写命名端口）', en: 'Invalid port: {value} (1-65535 number or lowercase named port)' },

  // ---- YAML 预览 ----
  'np:preview': { zh: 'YAML 预览', en: 'YAML preview' },

  // ---- 有损解析告警 ----
  'np:lossyWarning': {
    zh: '检测到表单不支持的字段：{fields}。保存会用表单内容整体覆盖，这些字段将丢失；需要保留请改用 YAML 页编辑。',
    en: 'Fields unsupported by this form detected: {fields}. Saving overwrites the whole object and these fields will be lost; use the YAML tab to keep them.',
  },
  'np:lossMatchExpressions': { zh: 'matchExpressions', en: 'matchExpressions' },
  'np:lossEndPort': { zh: 'endPort', en: 'endPort' },
  'np:lossUnknownPeer': { zh: '无法识别的来源条目', en: 'unrecognized source/target entries' },
  'np:lossUnknownRule': { zh: '无法识别的规则字段', en: 'unrecognized rule fields' },
  'np:lossPorts': { zh: '无法识别的端口定义', en: 'unrecognized port definitions' },

  // ---- 保存 ----
  'np:save': { zh: '保存', en: 'Save' },
  'np:confirmTitle': { zh: '确认保存该网络策略？', en: 'Save this network policy?' },
  'np:confirmDesc': {
    zh: 'NetworkPolicy 是「白名单叠加」：集群里一旦有任何策略选中某个 Pod，该 Pod 未被任何策略显式放行的流量就会被全部拒绝（不是合并放行）。请对照下方 YAML 确认没有切断现有依赖的流量，尤其是选中全部 Pod 且无放行规则时，整个命名空间会被锁死。',
    en: 'NetworkPolicies are additive allow-lists: as soon as any policy selects a pod, ALL traffic not explicitly allowed by some policy is DENIED (not merged with existing allowances). Check the YAML above so you do not cut traffic you depend on — selecting all pods with no allow rules locks down the whole namespace.',
  },
  'np:confirmSave': { zh: '我已确认，保存', en: 'I understand, save' },
  'np:savedCreate': { zh: '已创建 NetworkPolicy {name}', en: 'Created NetworkPolicy {name}' },
  'np:savedUpdate': { zh: '已更新 NetworkPolicy {name}', en: 'Updated NetworkPolicy {name}' },
  'np:saveFailed': { zh: '保存失败：{error}', en: 'Save failed: {error}' },
  'np:conflict': {
    zh: '该策略已被他人修改（409）。请关闭对话框重新打开，基于最新版本再编辑。',
    en: 'This policy was modified by someone else (409). Close and reopen the editor to start from the latest version.',
  },
}
