// tmpl 字典：创建对话框模板库（内置 kind 模板下拉 / 自定义模板存取删）。ns = tmpl
import type { Entry } from './strings'

export const STRINGS_TMPL: Record<string, Entry> = {
  'tmpl:templates': { zh: '模板', en: 'Templates' },
  'tmpl:builtIn': { zh: '内置 kind', en: 'Built-in kinds' },
  'tmpl:append': { zh: '追加', en: 'Append' },
  'tmpl:custom': { zh: '自定义', en: 'Custom' },
  'tmpl:saveAs': { zh: '存为模板', en: 'Save as template' },
  'tmpl:saveTitle': { zh: '存为模板', en: 'Save as template' },
  'tmpl:saveDesc': {
    zh: '将当前编辑器 YAML 存为 {kind} 的自定义模板（本机保存，同名覆盖）。',
    en: 'Save the current editor YAML as a custom {kind} template (stored locally, same name overwrites).',
  },
  'tmpl:saveNoKind': {
    zh: '无法从编辑器内容解析出 kind，请先填写 kind/apiVersion。',
    en: 'No kind found in the editor content. Fill in kind/apiVersion first.',
  },
  'tmpl:saveName': { zh: '模板名称', en: 'Template name' },
  'tmpl:saveConfirm': { zh: '保存', en: 'Save' },
  'tmpl:saved': { zh: '已保存模板「{name}」', en: 'Saved template "{name}"' },
  'tmpl:overwritten': { zh: '已覆盖同名模板「{name}」', en: 'Overwrote template "{name}"' },
  'tmpl:deleteTitle': { zh: '删除模板', en: 'Delete template' },
  'tmpl:deleteDesc': {
    zh: '删除自定义模板「{name}」（{kind}）？此操作不可恢复。',
    en: 'Delete custom template "{name}" ({kind})? This cannot be undone.',
  },
  'tmpl:delete': { zh: '删除', en: 'Delete' },
  'tmpl:deleted': { zh: '已删除模板「{name}」', en: 'Deleted template "{name}"' },
  'tmpl:cancel': { zh: '取消', en: 'Cancel' },
}
