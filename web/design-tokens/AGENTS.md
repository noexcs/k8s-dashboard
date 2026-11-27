# Design Tokens — Agent 规则

改本工程任何样式之前先读本文件与 `design-tokens/README.md`。

## 取值只有一个来源

1. 改颜色、圆角、字号、字体、缓动、间距密度、投影取值:只改 `design-tokens/tokens/**` 下的 JSON 源,然后 `npm run tokens:build`(在 `web/` 下)。风格维度同规则:radius 用 radius.scale 档位、密度用 spacing.scale 档位、投影用 shadow primitive,禁止组件里写 `rounded-[2xl]`/`shadow-[...]`/任意 spacing 绕过。
2. `src/index.css` 与 `src/styles/shadcn-adapter.css` 只允许 `var()` 映射，不允许出现具体取值；禁止改组件样式「覆盖」token 绕过体系。
3. `src/**` 禁止写死色值。自查：`grep -rnE '#[0-9a-f]{6,8}' src --include='*.tsx' --include='*.ts'`；已批准例外只有 `features/pods/Terminal.tsx`（xterm JS 主题，独立渲染域）。
4. 组件里颜色只用 Tailwind 语义类（`bg-background`、`text-caution`、`border-border`…）；需要直接取 token 时用 `dist/typescript/tokens.ts` 的 `var()` 字符串。禁止 arbitrary 色值类 `bg-[#…]`。
5. 圆角/间距/字号只用 Tailwind 刻度类（`rounded-md`、`gap-3`、`text-xs`）。

## 改值必须过 parity

改任何影响 shadcn 变量的 token 取值后必须 `npm run tokens:test`。`parity.test.mjs` 比对迁移前基线（47 变量 × 明暗），「顺手调个颜色」会被拦住。确属设计变更时，与视觉确认后从运行页重生成 `tests/__fixtures__/baseline-variables.json`，并在 CHANGELOG 记 PATCH。

## 新增 Token

1. 写在正确的层：Primitive 字面量、无语义名；Semantic 引用 Primitive；Component 只引用 Semantic。
2. `$type` 必填；semantic 颜色 token 的 `$description` 必填（有测试拦截）——历史上多处标定原因（chart-2 亮度审计、green-700 AA）只活在注释里。
3. 命名 `category.subcategory.property[.variant]`，小写+数字+连字符，最深 4 层；只允许 `$type`/`$value`/`$description`/`$extensions` 字段。
4. `npm run tokens:validate && npm run tokens:test`。

## 主题

1. 主题清单唯一来源是 `tokens/themes/registry.json`（当前单主题 ink）。
2. 明暗由 `.dark` 类决定（useTheme，不跟随系统）；新增 Visual Theme 需另接 `data-theme` 机制，不要混入明暗开关。

## 产物

1. `design-tokens/dist/` 不入库、不要手改；`predev`/`prebuild` 自动重建。
2. 不要把 dist 里的取值复制进业务代码（含注释里的色值清单）。

## 提交前

```
npm run tokens:validate   # 0 错误；对比度告警只允许已记录的 1 条（dark destructive 底白字 3.91:1）
npm run tokens:test       # build / parity / validate / adapter 全绿（18 项）
npx tsc --noEmit && npx vitest run
```

动了 token 源或取值：同一次提交更新 `design-tokens/CHANGELOG.md`（SemVer 规则见 README）。
