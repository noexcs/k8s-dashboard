// ing 字典：Ingress 表单编辑器（class/域名+路径规则/TLS/兜底后端/YAML 预览/保存确认）。ns = ing
import type { Entry } from './strings'

export const STRINGS_INGRESS: Record<string, Entry> = {
  // ---- 入口与标题 ----
  'ing:edit': { zh: '编辑 Ingress', en: 'Edit Ingress' },
  'ing:create': { zh: '新建 Ingress', en: 'New Ingress' },
  'ing:titleEdit': { zh: '编辑 Ingress：{name}', en: 'Edit Ingress: {name}' },
  'ing:titleCreate': { zh: '新建 Ingress', en: 'Create Ingress' },
  'ing:desc': {
    zh: '表单只覆盖常用字段；未识别的字段会在打开时列出并告警，需要保留请改用 YAML 页编辑。',
    en: 'The form covers common fields only; unrecognized fields are listed as warnings when opened — use the YAML tab to keep them.',
  },
  'ing:namespaceLabel': { zh: '命名空间 {ns}', en: 'Namespace {ns}' },

  // ---- 名称 ----
  'ing:name': { zh: '名称', en: 'Name' },
  'ing:namePlaceholder': { zh: 'ingress 名称', en: 'ingress name' },
  'ing:invalidName': {
    zh: '名称必填：小写字母/数字/-/.，且以字母或数字开头结尾',
    en: 'Name is required: lowercase alphanumerics, "-" and ".", must start and end alphanumeric',
  },

  // ---- ingressClassName ----
  'ing:class': { zh: '路由类（ingressClassName）', en: 'Class (ingressClassName)' },
  'ing:classUnset': { zh: '不指定', en: 'Not set' },
  'ing:classPlaceholder': { zh: '如 nginx', en: 'e.g. nginx' },
  'ing:classLoadFailed': {
    zh: 'ingressclass 列表加载失败，已退化为手输名称',
    en: 'Failed to load ingressclasses; falling back to free-text class name',
  },
  'ing:loading': { zh: '加载中…', en: 'Loading…' },

  // ---- 转发规则 ----
  'ing:rules': { zh: '转发规则（rules）', en: 'Rules' },
  'ing:addRule': { zh: '添加域名规则', en: 'Add rule' },
  'ing:ruleN': { zh: '规则 {n}', en: 'Rule {n}' },
  'ing:deleteRule': { zh: '删除规则', en: 'Delete rule' },
  'ing:hostPlaceholder': { zh: '如 example.com', en: 'e.g. example.com' },
  'ing:hostHint': { zh: '留空 = 匹配所有 host（仅按路径转发）', en: 'Empty = match all hosts (path-based routing only)' },
  'ing:addPath': { zh: '添加路径', en: 'Add path' },
  'ing:pathPlaceholder': { zh: '如 /api', en: 'e.g. /api' },
  'ing:servicePlaceholder': { zh: '选择 Service', en: 'Select service' },
  'ing:serviceManualPlaceholder': { zh: '输入 Service 名称', en: 'Service name' },
  'ing:serviceLoadFailed': {
    zh: 'Service 列表加载失败，已退化为手输服务名与端口',
    en: 'Failed to load services; falling back to manual service name and port',
  },
  'ing:portPlaceholder': { zh: '选择端口', en: 'Select port' },
  'ing:portManualPlaceholder': { zh: '端口号（如 80）或端口名', en: 'Port number (e.g. 80) or name' },
  'ing:portOptionNamed': { zh: '{port}（命名端口）', en: '{port} (named port)' },
  'ing:portStale': { zh: '保留原值：{port}', en: 'Kept: {port}' },
  'ing:removeRow': { zh: '删除该行', en: 'Remove row' },

  // ---- 校验 ----
  'ing:invalidPath': { zh: '路径无效：{value}（需以 / 开头）', en: 'Invalid path: {value} (must start with /)' },
  'ing:invalidPort': {
    zh: '端口无效：{value}（1-65535 数字或小写端口名）',
    en: 'Invalid port: {value} (1-65535 number or lowercase port name)',
  },
  'ing:backendRequired': { zh: '规则 {n} 第 {m} 条路径未选择后端服务', en: 'Rule {n} path {m} has no backend service' },
  'ing:portRequired': { zh: '规则 {n} 第 {m} 条路径未选择后端端口', en: 'Rule {n} path {m} has no backend port' },
  'ing:pathsRequired': { zh: '规则 {n} 至少需要一条路径', en: 'Rule {n} needs at least one path' },

  // ---- TLS ----
  'ing:tls': { zh: 'TLS 证书', en: 'TLS' },
  'ing:addTls': { zh: '添加 TLS 条目', en: 'Add TLS entry' },
  'ing:tlsN': { zh: 'TLS {n}', en: 'TLS {n}' },
  'ing:secretName': { zh: 'Secret 名称', en: 'Secret name' },
  'ing:secretNamePlaceholder': { zh: 'tls 类型 Secret，如 example-com-tls', en: 'kubernetes.io/tls secret, e.g. example-com-tls' },
  'ing:tlsHosts': { zh: '覆盖域名（逗号分隔）', en: 'Hosts (comma-separated)' },
  'ing:tlsHostsPlaceholder': { zh: '如 example.com, www.example.com', en: 'e.g. example.com, www.example.com' },
  'ing:tlsHostCandidates': { zh: '从规则域名添加：', en: 'Add from rule hosts:' },
  'ing:secretRequired': { zh: 'TLS {n} 未填 Secret 名称', en: 'TLS entry {n} has no secret name' },

  // ---- defaultBackend ----
  'ing:defaultBackend': { zh: '兜底后端（defaultBackend）', en: 'Default backend' },
  'ing:defaultBackendEnable': { zh: '设置 defaultBackend', en: 'Set defaultBackend' },
  'ing:defaultBackendHint': {
    zh: '未命中任何规则的请求交给该服务；与转发规则可以共存。',
    en: 'Requests matching no rule go to this service; it can coexist with rules.',
  },
  'ing:defaultBackendMissing': {
    zh: '已勾选 defaultBackend，但后端服务/端口未填完整',
    en: 'defaultBackend is enabled but its service/port is incomplete',
  },

  // ---- 整体提示 ----
  'ing:noRoutingHint': {
    zh: '既没有转发规则也没有 defaultBackend：该 Ingress 不会路由任何请求。',
    en: 'No rules and no defaultBackend: this Ingress will route nothing.',
  },
  'ing:preview': { zh: 'YAML 预览', en: 'YAML preview' },

  // ---- 有损解析告警 ----
  'ing:lossyWarning': {
    zh: '检测到表单不支持的字段：{fields}。保存会用表单内容重新生成这些结构，这些字段将丢失；需要保留请改用 YAML 页编辑（labels/annotations 与表单未涉及的 spec 键会原样保留）。',
    en: 'Fields unsupported by this form detected: {fields}. Saving regenerates these structures from the form and these fields will be lost; use the YAML tab to keep them. Labels/annotations and spec keys outside this form are carried over untouched.',
  },
  'ing:lossNamedPort': { zh: 'service.port.namedPort', en: 'service.port.namedPort' },
  'ing:lossBackendResource': { zh: '自定义后端（backend.resource）', en: 'custom backend (backend.resource)' },
  'ing:lossCertKeyRef': {
    zh: 'certificateKeySecretRef / caCertificateSecretRef',
    en: 'certificateKeySecretRef / caCertificateSecretRef',
  },
  'ing:lossExternalName': { zh: 'defaultBackend.service.externalName', en: 'defaultBackend.service.externalName' },
  'ing:lossUnknown': { zh: '无法识别的规则/路径/TLS 条目', en: 'unrecognized rule/path/TLS entries' },

  // ---- 保存 ----
  'ing:save': { zh: '保存', en: 'Save' },
  'ing:confirmTitle': { zh: '确认保存该 Ingress？', en: 'Save this Ingress?' },
  'ing:confirmDesc': {
    zh: 'Ingress 是线上流量的入口：改错 host/path 会直接切换线上流量入口——域名或路径的请求会立刻改道到新的后端 Service（或因不再匹配而落入 defaultBackend / 返回 404）。请对照下方 YAML 逐条确认 host、path 与后端服务无误。',
    en: 'An Ingress is the front door of production traffic: a wrong host/path immediately switches where live traffic goes — requests for that host/path are rerouted to the new backend Service (or fall through to the defaultBackend / 404 when nothing matches anymore). Check every host, path and backend against the YAML above before saving.',
  },
  'ing:confirmSave': { zh: '我已确认，保存', en: 'I understand, save' },
  'ing:savedCreate': { zh: '已创建 Ingress {name}', en: 'Created Ingress {name}' },
  'ing:savedUpdate': { zh: '已更新 Ingress {name}', en: 'Updated Ingress {name}' },
  'ing:saveFailed': { zh: '保存失败：{error}', en: 'Save failed: {error}' },
  'ing:conflict': {
    zh: '该 Ingress 已被他人修改（409）。请关闭对话框重新打开，基于最新版本再编辑。',
    en: 'This Ingress was modified by someone else (409). Close and reopen the editor to start from the latest version.',
  },
}
