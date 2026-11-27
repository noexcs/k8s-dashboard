# Design Tokens 规范

单包工程内的 Design Token 体系：DTCG JSON 源 → Style Dictionary 5 构建 → CSS / JSON / TypeScript 产物 → shadcn/ui 组件。业务代码零色值。

组织方式对齐 kcts-0 `design-tokens/`（同一套三层模型、构建链与 parity 机制），token 集合为 K8S Dashboard 现状（ink「夜班控制室」主题，47 个 shadcn 颜色变量 + radius 形态 + 字体栈 + 缓动对 + 间距密度 + 投影档位；123 token = primitive 68 / semantic 55）。

## 目录结构

```
design-tokens/
├── tokens/                 Token 源（唯一事实来源，入库）
│   ├── primitives/         color（paper/night/graphite/绿红琥珀蓝档）/ radius / typography / motion
│   ├── semantic/           color / radius
│   ├── components/         index.json（组件槽位层，当前留空）
│   └── themes/             registry.json（主题注册表，当前单主题 ink）
│                           light.json（默认主题 light 层=空，基准值在 semantic）
│                           dark.json（dark 模式增量覆盖）
├── build/                  构建实现（config 分层与输出块 / sources 索引 / SD5 编排 / 自定义 format）
├── scripts/                build.mjs / validate.mjs / clean.mjs
├── tests/                  node --test：build / parity / validate / adapter
│   └── __fixtures__/baseline-variables.json（迁移前线上页 getComputedStyle 快照，47 变量 × 明暗）
└── dist/                   产物（.gitignore，predev/prebuild 自动生成）
```

版本号沿用 `web/package.json`（`design-tokens/` 内没有 package.json）。

## 三层模型

| 层 | 位置 | 职责 | 约束（validate 强制） |
| --- | --- | --- | --- |
| Primitive | `tokens/primitives/` | 原始取值：ink ramp 色档、radius 基准、字体栈、缓动曲线 | 不含语义命名；只写字面量 |
| Semantic | `tokens/semantic/` | 意图命名：`color.primary.default`、`color.chart.2` | 必须（直接或经中间层）引用 Primitive |
| Component | `tokens/components/` | 组件槽位 | 只引用 Semantic，不出现原始值 |

主题层（`tokens/themes/`）不是第四层：它是 semantic 的**增量覆盖**；`dark.json` 只写与 light 不同的 38 项，引用链 token（chart-1/3/4、code.*）随被引用者自动换档。

## 命名与 CSS 变量

- 路径 `category.subcategory.property[.variant]`，小写+数字+连字符，点分隔，最深 4 层。
- CSS 变量 = 点换连字符加前缀：`color.background.default` → `--dt-color-background-default`。`--dt-` 前缀避开 Tailwind v4 的 `--color-*`/`--ease-*` 主题命名空间，不与 `@theme inline` 映射目标同名。

## DTCG 约定

每个 token 是含 `$value` 的对象，允许字段仅 `$type` / `$value` / `$description` / `$extensions`。`$type` 必填；semantic 颜色 token 的 `$description` 有测试硬性拦截（历史上多处标定原因只存在于注释里，丢了注释就丢原因）。`{a.b.c}` 引用悬空与循环都是错误。构建保持原值（hex alpha、cubic-bezier 不做转换）。

## 构建链路与产物

`npm run tokens:build`（先清旧产物；无时间戳，同输入同字节）：

| 产物 | 内容 |
| --- | --- |
| `dist/css/base.css` | `:root`（primitive+semantic 全展开）与 `:root.dark, .dark` 块 |
| `dist/css/index.css` | base（+未来主题），`src/index.css` 实际引入它 |
| `dist/json/tokens.json` | 每 token：path/cssVar/type/layer/value/resolvedValue/description/usedBy/themes |
| `dist/json/themes.json` | 主题清单 + swatch（registry 驱动） |
| `dist/typescript/tokens.ts` | `var()` 引用表 + `TokenName` / `tokenCssVar()` |

引入链路：

```
tokens/**.json → dist/css（--dt-* 取值，:root 与 .dark 两块全展开）
  → src/styles/shadcn-adapter.css（shadcn 变量 = var(--dt-*)，只映射，47 条）
  → src/index.css @theme inline（--color-*/--font-*/--ease-* = var(--…) 映射）
  → 组件语义类（bg-background / text-caution / ease-strong…）
```

铁律：**adapter 与 @theme 只映射，不定义值**；明暗切换由 dist 的 `.dark` 块换值完成，adapter 两模式共用一份。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run tokens:build` | 全量重建 dist |
| `npm run tokens:validate` | Schema/命名/悬空与循环引用/分层约束/时长/z-index/注册表一致性/对比度（9 对 AA，默认告警；`DT_STRICT_CONTRAST=1` 阻断） |
| `npm run tokens:clean` | 删 dist |
| `npm run tokens:test` | `node --test design-tokens/tests`（18 项） |

`predev`/`prebuild` 自动跑 validate+build，vite 不会引入缺失 dist。

### 测试职责

| 文件 | 证明的事 |
| --- | --- |
| `build.test.mjs` | 产物齐全、`:root`/`.dark` 块在场、重复构建字节一致、无时间戳 |
| `parity.test.mjs` | 明暗两态 47 个 shadcn 变量 + radius 与 `baseline-variables.json`（迁移前线上页快照）逐项一致——「重构不改视觉」的机器证明；抓出过 dark `chart-5` 独立档被并错 ramp 档的抄写错误 |
| `validate.test.mjs` | 校验 0 错误、警告只允许已记录对比度项、semantic 颜色必带 `$description` |
| `adapter.test.mjs` | adapter 47 条全为 `var(--dt-*)`、目标 token 存在、index.css 不再定义取值、src 无第二处色值来源（例外：`Terminal.tsx` xterm JS 主题，独立渲染域） |

## 流程

### 改值
1. 只改源文件；primitive 改动沿引用链传导。
2. `npm run tokens:test`——影响 47 个 shadcn 变量的改动会被 parity 拦下。
3. 确属设计变更：视觉确认后重生成 `__fixtures__/baseline-variables.json`（从运行页 `getComputedStyle` 抓 47 变量 × 明暗），CHANGELOG 记 PATCH。

### 新增 token
写对层（primitive 字面量 / semantic 引用 / component 引 semantic），`$type`+`$description` 必填，`tokens:validate && tokens:test`。

### 新增主题
加 `<id>.light.json` + `<id>.dark.json` 增量层 + registry 登记 + `tokens:build`；构建产物（`data-theme` CSS 块、`ThemeId`、`themes.json` 含 swatch）自动扩，设置-外观「配色主题」组读 `themes.json` 渲染——UI 零改动。前端 `<html data-theme=id>` 由 useTheme 应用（默认主题删属性走 `:root` 基础块）。

现有 7 个预设主题（accent 类 blue/teal/amber/violet = zinc base + accent 合成；tinted-neutral 类 stone/mauve/mist = 整体中性色调基底）均为 shadcn/create 官方 palette 照抄（源 `shadcn-ui/ui apps/v4/registry/themes.ts`），theme 层写 oklch 字面值（外来登记 palette，不塞 primitives）。accent 类只染强调色，light 下差异小；tinted-neutral 类给背景/边框/侧栏整体上色，dark 下换气质最明显。**chart-\* 与状态色（positive/negative/caution）不随主题覆盖**——面板图表颜色即状态语义。主题与明暗档位正交（档位切 `.dark`，主题切 `data-theme`）。

### 风格维度（颜色之外）

token 覆盖的样式维度：`radius.base`（形态，档位白名单 sharp/base/refined/soft）、`spacing.scale.default`（Tailwind `--spacing` 密度乘子）、`shadow.{xs,sm,md,lg,xl}`（utility 名不动、主题换档位内容）、`font.{ui,code}`（整页字体栈）。默认主题全部钉在 Tailwind v4 内置值（零漂移，线上实测 computed 一致）。

| 主题 | 色 | 圆角 | 密度 | 投影 | 界面字 |
| --- | --- | --- | --- | --- | --- |
| ink | 蓝墨中性 | .625 | 标准 | TW 内置 | sans |
| blue/teal/amber/violet | 换强调色 | .625 | 标准 | TW 内置 | sans |
| stone | 暖米底 | **1rem** | 宽松 .265 | **暖褐染色** | sans |
| mauve | 紫灰底 | .75 | 标准 | **紫灰染色** | sans |
| mist | 蓝灰底 | **.375 锐角** | **密排 .23** | **平涂 none** | **等宽 console** |
| cobalt | Radix indigo 彩色底 + **靛蓝深色导航** | .625 | 标准 | TW 内置 | sans |
| jade | Radix jade 翡翠底 + **深绿导航** | **.375 锐角** | **密排 .23** | TW 内置 | sans |
| cream | Radix amber 沙色底 + **深棕导航** | **1rem** | 宽松 .265 | **暖褐染色** | sans |

cobalt/jade/cream 是**强差异档**：Radix Colors v3 全色阶照抄（`@radix-ui/colors`，彩色纸底 + 深色导航 light / 彩色暗底 dark），自带 AA 对比设计（validate 0 新警告）。侧栏 footer 控件（集群选择/设置/主题）用 `sidebar-*` 语义色适配深色导航。

## 版本与 CHANGELOG

SemVer 作用于 token 集合：MAJOR=删 token/改类型/改名；MINOR=新增 token/主题；PATCH=改值。改 token 源的同一次提交内更新 `CHANGELOG.md`。

## 已知债务

| 块 | 组合 | 实测 | 处置 |
| --- | --- | --- | --- |
| ink.dark | `color.feedback.destructive-foreground` on `color.feedback.destructive` | 3.91:1 | 迁移前既有视觉（`#e5484d` 底白字），「不改视觉」原则保留；修复需先与视觉确认新值 |
