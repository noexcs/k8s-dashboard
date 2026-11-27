// pvc 字典：PVC 扩容动作（容量对话框、StorageClass 扩容能力提示、resize 进度）。ns = pvc
import type { Entry } from '@/i18n/strings'

export const STRINGS_PVC: Record<string, Entry> = {
  'pvc:expand': { zh: '扩容', en: 'Expand' },
  'pvc:expanding': { zh: '扩容中', en: 'Resizing' },
  'pvc:resizePending': { zh: '等待控制器/文件系统处理扩容', en: 'Waiting for controller / filesystem resize' },
  'pvc:title': { zh: '扩容 PVC {name}', en: 'Expand PVC {name}' },
  'pvc:desc': {
    zh: '当前容量 {current}，卷 {pv}，StorageClass {sc}。只允许增大，提交后 resize 由控制器与文件系统异步执行。',
    en: 'Current size {current}, volume {pv}, StorageClass {sc}. Only growth is allowed; the resize runs asynchronously.',
  },
  'pvc:newSize': { zh: '新容量', en: 'New size' },
  'pvc:notSet': { zh: '未设置', en: 'not set' },
  'pvc:invalidSize': {
    zh: '不是合法的容量写法（例如 2Gi、500Mi、1024）',
    en: 'Not a valid quantity (e.g. 2Gi, 500Mi, 1024)',
  },
  'pvc:mustGrow': {
    zh: '新容量必须大于当前 {current}（k8s 不允许缩容）',
    en: 'New size must be larger than {current} (shrinking is not allowed)',
  },
  'pvc:notExpandable': {
    zh: 'StorageClass {sc} 未开启 allowVolumeExpansion，无法扩容',
    en: 'StorageClass {sc} does not allow volume expansion',
  },
  'pvc:checkingSc': { zh: '正在检查 StorageClass 是否支持扩容…', en: 'Checking StorageClass expansion support…' },
  'pvc:scFailed': {
    zh: '读取 StorageClass {sc} 失败：{msg}（点击重试）',
    en: 'Failed to read StorageClass {sc}: {msg} (click to retry)',
  },
  'pvc:submitted': {
    zh: '扩容已提交（需控制器/文件系统 resize 异步完成）',
    en: 'Expansion submitted (controller / filesystem resize completes asynchronously)',
  },
  'pvc:cancel': { zh: '取消', en: 'Cancel' },
  'pvc:submit': { zh: '提交扩容', en: 'Submit expansion' },
}
