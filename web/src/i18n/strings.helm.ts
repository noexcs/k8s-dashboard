// helm 字典：HelmPage 顶层 tabs + RepoChartsTab（Charts/Repositories）+ InstallChartDialog（安装/升级）。ns = helm
import type { Entry } from './strings'

export const STRINGS_HELM: Record<string, Entry> = {
  // ---- 顶层 tabs ----
  'helm:tabReleases': { zh: 'Releases', en: 'Releases' },
  'helm:tabCharts': { zh: '图表', en: 'Charts' },
  'helm:tabRepositories': { zh: '仓库', en: 'Repositories' },

  'helm:colAction': { zh: '操作', en: 'Actions' },
  'helm:colChart': { zh: 'Chart', en: 'Chart' },

  // ---- Charts tab ----
  'helm:chartsSearchPlaceholder': { zh: '搜索 chart 名称…', en: 'Search chart name…' },
  'helm:colRepos': { zh: '仓库', en: 'Repos' },
  'helm:expandVersions': { zh: '展开全部版本', en: 'Expand all versions' },
  'helm:collapseVersions': { zh: '收起版本', en: 'Collapse versions' },
  'helm:allVersions': { zh: '全部版本（按仓库）', en: 'All versions (by repository)' },
  'helm:emptyCharts': { zh: '没有匹配的 chart。', en: 'No matching charts.' },
  'helm:noReposTitle': { zh: '尚未添加任何 Chart 仓库', en: 'No chart repositories yet' },
  'helm:noReposDesc': {
    zh: '图表列表来自已添加仓库的索引（后端没有任何仓库时会报错）。先到「仓库」添加一个（如 bitnami → https://charts.bitnami.com/bitnami），再回来浏览安装。',
    en: 'The chart list comes from indexes of added repositories (the backend errors out when none are configured). Add one under "Repositories" first (e.g. bitnami → https://charts.bitnami.com/bitnami), then come back here.',
  },
  'helm:goToRepositories': { zh: '去添加仓库', en: 'Go to Repositories' },
  'helm:chartsLoadFailed': {
    zh: '图表列表加载失败（也可能是仓库索引尚未下载成功）：{msg}',
    en: 'Failed to load charts (the repository index may not have been downloaded yet): {msg}',
  },

  // ---- Repositories tab ----
  'helm:emptyRepos': {
    zh: '尚未添加仓库。添加后即可在「图表」浏览并安装其中的 chart。',
    en: 'No repositories yet. Once added, you can browse and install charts under "Charts".',
  },
  'helm:repoUrl': { zh: '地址', en: 'URL' },
  'helm:repoNamePlaceholder': { zh: '如 bitnami', en: 'e.g. bitnami' },
  'helm:repoUrlPlaceholder': { zh: '如 https://charts.bitnami.com/bitnami', en: 'e.g. https://charts.bitnami.com/bitnami' },
  'helm:repoInsecure': { zh: '跳过 TLS 证书校验（insecure）', en: 'Skip TLS verification (insecure)' },
  'helm:repoInsecureHint': {
    zh: '仅自签证书的内网仓库需要；凭据（用户名/密码）请仍用 helm CLI 配置，本表单不采集。',
    en: 'Only needed for self-signed internal registries; credentials (username/password) must still be configured via the helm CLI — this form does not collect them.',
  },
  'helm:addRepo': { zh: '添加仓库', en: 'Add repository' },
  'helm:repoAdding': { zh: '添加中（正在下载索引，可能需要几十秒）…', en: 'Adding (downloading index, may take tens of seconds)…' },
  'helm:repoAdded': { zh: '仓库 {name} 已添加，索引已下载', en: 'Repository {name} added, index downloaded' },
  'helm:repoAddFailed': { zh: '添加仓库失败：{msg}', en: 'Failed to add repository: {msg}' },
  'helm:removeRepoTitle': { zh: '删除仓库 {name}？', en: 'Remove repository {name}?' },
  'helm:removeRepoDesc': {
    zh: '仅从服务器的 helm 配置中移除仓库条目及其索引缓存引用，不影响任何已安装的 release。',
    en: 'Only removes the repository entry (and its index cache reference) from the server-side helm config; installed releases are unaffected.',
  },
  'helm:repoRemoved': { zh: '仓库 {name} 已删除。', en: 'Repository {name} removed.' },
  'helm:repoRemoveFailed': { zh: '删除仓库失败：{msg}', en: 'Failed to remove repository: {msg}' },
  'helm:refreshIndex': { zh: '刷新索引', en: 'Refresh index' },
  'helm:indexRefreshed': { zh: '仓库 {name} 的索引已刷新。', en: 'Index of repository {name} refreshed.' },
  'helm:indexRefreshFailed': { zh: '刷新索引失败：{msg}', en: 'Failed to refresh index: {msg}' },
  'helm:refreshIndexHint': {
    zh: '「刷新索引」= 用同名同地址重新添加（add 端点会同步重新下载索引）；后端 update 端点只改条目、不拉索引，故不用它。',
    en: '“Refresh index” = re-add with the same name and URL (the add endpoint re-downloads the index synchronously); the backend update endpoint only edits the entry without pulling the index, so it is not used here.',
  },

  // ---- 安装对话框 ----
  'helm:install': { zh: '安装', en: 'Install' },
  'helm:installTitle': { zh: '安装 {chart}', en: 'Install {chart}' },
  'helm:releaseName': { zh: 'Release 名称', en: 'Release name' },
  'helm:releaseNameInvalid': {
    zh: '仅允许小写字母、数字、“-”和“.”，且须以字母或数字开头结尾（≤253 字符）',
    en: 'Lowercase letters, digits, "-" and "." only; must start and end with a letter or digit (≤253 chars)',
  },
  'helm:chooseNamespace': { zh: '选择命名空间', en: 'Select namespace' },
  'helm:createNamespace': { zh: '新建命名空间', en: 'Create new namespace' },
  'helm:newNamespacePlaceholder': { zh: '新命名空间名称', en: 'New namespace name' },
  'helm:namespaceInvalid': {
    zh: '命名空间须为小写字母、数字或“-”（RFC 1123 label，≤63 字符）',
    en: 'Namespace must be lowercase letters, digits or "-" (RFC 1123 label, ≤63 chars)',
  },
  'helm:versionTarget': { zh: '版本', en: 'Version' },
  'helm:valuesOverride': { zh: 'Values 覆盖', en: 'Values override' },
  'helm:valuesHint': {
    zh: 'chart 默认 values 未拉取，这里只填 override（YAML），安装时与 chart 默认值合并生效。',
    en: 'The chart’s default values are not fetched; fill only overrides here (YAML), merged over the chart defaults at install time.',
  },
  'helm:valuesPlaceholder': { zh: '如：\nreplicaCount: 2\ningress:\n  enabled: true', en: 'e.g.:\nreplicaCount: 2\ningress:\n  enabled: true' },
  'helm:installSubmit': { zh: '开始安装', en: 'Install' },
  'helm:installSubmitted': { zh: '已提交，等待安装完成…', en: 'Submitted, waiting for install to finish…' },
  'helm:installSuccess': { zh: '{name} 安装成功', en: '{name} installed successfully' },
  'helm:installFailed': { zh: '{name} 安装失败：{msg}', en: 'Install of {name} failed: {msg}' },
  'helm:actionProcessing': { zh: '执行中…', en: 'Running…' },

  // ---- 升级对话框 ----
  'helm:upgrade': { zh: '升级', en: 'Upgrade' },
  'helm:upgradeTitle': { zh: '升级 {name}', en: 'Upgrade {name}' },
  'helm:currentVersion': { zh: '当前版本', en: 'Current' },
  'helm:targetVersion': { zh: '目标版本', en: 'Target version' },
  'helm:upgradeValuesHint': {
    zh: '留空 = 复用上次发布生效的 values；填写则用 chart 默认值 + 这份 YAML 重新合并并整体替换。',
    en: 'Leave empty to reuse the values from the last revision; fill in to replace them with chart defaults merged with this YAML.',
  },
  'helm:chartMissingInRepos': {
    zh: '在已添加的仓库里找不到 chart「{chart}」（可能已下架或仓库被删）。可手动填写仓库名与目标版本，坐标存在时 helm 仍能解析。',
    en: 'Chart “{chart}” was not found in the added repositories (pulled down or repo removed?). You may type the repository name and target version manually; helm can still resolve the coordinates if they exist.',
  },
  'helm:repoShort': { zh: '仓库', en: 'Repo' },
  'helm:submitUpgrade': { zh: '开始升级', en: 'Upgrade' },
  'helm:upgradeSubmitted': { zh: '已提交，等待升级完成…', en: 'Submitted, waiting for upgrade to finish…' },
  'helm:upgradeSuccess': { zh: '{name} 已升级到 {version}', en: '{name} upgraded to {version}' },
  'helm:upgradeFailed': { zh: '{name} 升级失败：{msg}', en: 'Upgrade of {name} failed: {msg}' },
}
