// kv 字典：ConfigMap/Secret 键值编辑器（表格行编辑/二进制只读行/YAML 预览/Secret 明文警告）。ns = kv
import type { Entry } from './strings'

export const STRINGS_KV: Record<string, Entry> = {
  // ---- 入口与标题 ----
  'kv:edit': { zh: '编辑键值', en: 'Edit key-value' },
  'kv:titleEdit': { zh: '编辑 {kind}：{name}', en: 'Edit {kind}: {name}' },
  'kv:desc': {
    zh: '表格直接编辑数据条目；其他字段（type、labels 等）原样保留，需要改动请走 YAML 页。',
    en: 'Rows edit the data entries directly; other fields (type, labels, ...) are preserved as-is — use the YAML tab to change them.',
  },
  'kv:immutableTitle': {
    zh: '{kind} 已设为 immutable（不可变），无法在此编辑；如需修改请删除后重建。',
    en: '{kind} is marked immutable and cannot be edited here; delete and recreate it to change it.',
  },

  // ---- 表格 ----
  'kv:keyPlaceholder': { zh: '键名', en: 'Key name' },
  'kv:valuePlaceholder': { zh: '值（支持多行）', en: 'Value (multi-line allowed)' },
  'kv:addRow': { zh: '添加条目', en: 'Add entry' },
  'kv:removeRow': { zh: '删除该条目', en: 'Remove entry' },
  'kv:noRows': { zh: '当前没有可编辑的条目', en: 'No editable entries' },

  // ---- 校验 ----
  'kv:keyInvalid': {
    zh: '键名不合法：以字母或 -._ 开头，只含字母、数字、-._',
    en: 'Invalid key: must start with a letter or -._ and contain only letters, digits, -._',
  },
  'kv:keyRequired': { zh: '键名不能为空', en: 'Key name is required' },
  'kv:keyDuplicate': { zh: '键名重复：{key}', en: 'Duplicate key: {key}' },

  // ---- 二进制只读行 ----
  'kv:binarySection': { zh: '二进制条目（只读）', en: 'Binary entries (read-only)' },
  'kv:binaryReadonly': { zh: '二进制，不可在此编辑', en: 'Binary, not editable here' },
  'kv:binaryBytes': { zh: '{n} 字节', en: '{n} bytes' },

  // ---- YAML 视图 ----
  'kv:yamlView': { zh: 'YAML 视图', en: 'YAML view' },
  'kv:yamlHint': {
    zh: '与表格实时同步的只读预览；要修改其他结构请到 YAML 页。',
    en: 'Read-only preview kept in sync with the table; edit the YAML tab to change other fields.',
  },

  // ---- Secret 明文警告 ----
  'kv:secretWarnTitle': { zh: '确认保存 Secret？', en: 'Save this Secret?' },
  'kv:secretWarnDesc': {
    zh: '明文 value 会经 TLS 传到 API server，并在服务端转为 base64 后存为集群 Secret。base64 不是加密：有该 ns 读权限的人都能看到明文，请确认这些值允许以明文形式存在于集群中。',
    en: 'Plaintext values travel over TLS to the API server and are stored as a cluster Secret (base64-encoded). base64 is not encryption: anyone with read access to this namespace can see the plaintext — make sure these values are safe to keep in the cluster.',
  },
  'kv:secretWarnConfirm': { zh: '确认保存', en: 'Save' },

  // ---- 保存 ----
  'kv:save': { zh: '保存', en: 'Save' },
  'kv:saved': { zh: '已保存 {name}', en: 'Saved {name}' },
  'kv:saveFailed': { zh: '保存失败：{error}', en: 'Save failed: {error}' },
  'kv:conflict': {
    zh: '资源已被他人修改（409 冲突），请关闭本窗口后重新打开编辑器。',
    en: 'The resource was modified by someone else (409 conflict). Close this dialog and reopen the editor.',
  },
}
