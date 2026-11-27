# Changelog

本目录 Design Token 集合的变更史。SemVer:MAJOR=删 token/改类型/改名,MINOR=新增 token/主题,PATCH=改值。

## [1.5.1] - 2026-11-27

### Changed
- 五主题 light 模式导航从深色(Radix step-11)改为浅色调色板同族 tint(sidebar=step3 / foreground=step11 / accent=step4 / border=step6,值取 Radix v3 官方色表):深导航与浅色纸底对比过强(用户反馈),对齐 ink 浅导航基线与 shadcn sidebar 语言;dark 模式导航本就是邻近色不变。sidebar-primary 保留 accent 彩,活动项仍有彩色高亮。

## [1.5.0] - 2026-11-27

### Changed
- 五主题从「仅 accent」升级为完整形态(用户反馈:只有强调色区别):accent 组(primary/secondary/sidebar-primary)保留 shadcn 预设值,其余形态字段照抄旧主题人格模板——indigo←cobalt(Radix indigo 靛蓝纸底+深靛导航)、emerald←jade(深绿导航+锐角+密排)、orange←cream(奶油纸底+深棕导航+柔圆+暖投影)、rose/sky 以 cobalt 为结构模板按 step 映射 Radix crimson/sky 官方色表重建;registry radius 档随层(emerald .375/orange 1rem)。

### Fixed
- useTheme 自定义层无覆盖时恒写 `--dt-radius-base:5px`,把全部主题(含旧 jade/mist/cream)的圆角人格档压死——改为仅用户显式覆盖时写入,否则交还主题层;设置面板圆角/密度滑杆回显与「拖到同值清覆盖」语义同步跟随主题生效值。

## [1.4.0] - 2026-11-27

### Added
- 常见调色板五主题 sky/emerald/orange/rose/indigo:shadcn/create 官方预设(shadcn-ui/ui registry/themes.ts,zinc base + 单色 accent)照抄,与旧 blue.* 同配方(zinc 中性底不动,仅 primary/secondary/sidebar-primary 组随 accent)。

### Removed
- 全部旧衍生主题 blue/teal/amber/violet/stone/mauve/mist/cobalt/jade/cream(用户定稿:仅保留 ink 基底,主题位让给新调色板系列);registry 仅剩 ink+5 新。存量 localStorage 旧 id 由 readStoredId 白名单校验自动回退 ink,无需迁移。

### Fixed
- adapter 色值字面量门禁登记两处「数据非样式」例外:SettingsPage 色板预设表与 useTheme 前景黑白判定常量(运行时写入 CSS 变量的用户选项数据,非组件样式取值)。

## [1.3.0] - 2026-11-27

### Added
- 强差异三主题 cobalt/jade/cream:Radix Colors v3 indigo/jade/amber 全色阶照抄(@radix-ui/colors),彩色纸底 + 深色导航(light)、彩色暗底(dark);Radix 自带 AA 对比(validate 0 新警告)。形态各配档位:jade=锐角+密排,cream=柔圆+宽松+暖投影。
- destructive/destructive-foreground 纳入主题覆盖(Radix red 色阶;此前未随主题)。

### Fixed
- 深色导航主题下侧栏 footer 三控件(集群选择/设置/主题)原用 muted 深色文字不可读:改用 sidebar-* 语义色(浅色导航主题表现不变)。

## [1.2.0] - 2026-11-27

### Added
- 风格维度入体系(颜色之外):`radius.scale` 扩 sharp/refined/soft 档(registry.radius 白名单改为按档位值匹配)、`spacing.scale.{base,dense,soft}`(Tailwind `--spacing` 密度乘子,@theme 映射)、`shadow.{xs,sm,md,lg,xl}` 语义档(TW4 内置值照抄为默认 = 零漂移,utility 名不动)、`font.{ui,code}` 语义字体。123 token(prim 68/sem 55)。
- 主题人格差异化:stone=柔圆 1rem+暖褐投影+宽松;mist=控制台(锐角 .375+密排 .23+平涂无投影+等宽界面字);mauve=0.75 圆角+紫灰投影。
- validate:registry.radius 白名单从「key 名=数字」旧机制改为遍历 radius.scale 档位值匹配。

## [1.1.0] - 2026-11-27

### Added
- 7 个 shadcn/create 预设主题:accent 类 blue/teal/amber/violet(zinc base + accent 合成)+ tinted-neutral 类 stone/mauve/mist(整体中性色调基底,dark 下换气质);官方 palette 照抄,light/dark 各 26 变量增量层;registry 登记后 `data-theme` CSS 块、`ThemeId`、`themes.json` swatch 自动扩,侧栏「主题」选择器产物驱动(加主题 UI 零改动,已实证)。
- 约定:chart-*/状态色不随主题覆盖(面板图表颜色即状态语义);预设 theme 层允许 oklch 字面值(外来登记 palette)。

## [1.0.0] - 2026-11-27

### Added
- DTCG 三层 token 体系落地（组织方式对齐 kcts-0 design-tokens）：primitives 45 / semantic 47 / themes（registry + light 空层 + dark 38 项增量）/ components 空层占位。
- Style Dictionary 5 构建链：`dist/css`（:root 与 .dark 全展开块）、`dist/json`（含 usedBy 与主题取值矩阵）、`dist/typescript`；predev/prebuild 自动构建。
- `src/styles/shadcn-adapter.css`：47 条 shadcn 变量 → `var(--dt-*)` 只映射层。
- 测试 18 项：build（可复现字节）/ parity（迁移前基线 47×明暗）/ validate（schema+分层+对比度）/ adapter（映射纯度+src 无第二色源）。

### Changed
- `src/index.css` 的 `:root`/`.dark` 字面值与 `@theme` 字体/缓动字面值全部替换为 token 映射；视觉零变化（parity + 线上 computed 47 项 × 明暗实测通过）。

### Fixed
- 迁移抄写校验抓到 dark `--chart-5`（#6f7891）是独立标定档而非 ring ramp 档，建为 `graphite.570` 专档（parity 拦截的直接收益）。

### Known issues
- `ink.dark` destructive 底白字对比度 3.91:1（迁移前既有），validate 记录为唯一允许警告。
