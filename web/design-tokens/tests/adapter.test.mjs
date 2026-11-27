import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "../build/config.mjs";
import { loadSources } from "../build/sources.mjs";

/**
 * shadcn Adapter 的职责边界：只允许「shadcn 语义变量 -> var(--dt-*)」这一种声明，
 * 任何具体色值/尺寸都必须留在 Token 源里，否则 Adapter 会变成第二个取值来源。
 */
const adapter = readFileSync(join(REPO, "src/styles/shadcn-adapter.css"), "utf8");
const declarations = [...adapter.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)];

describe("shadcn Adapter", () => {
  it("每条声明都只映射到 --dt-* 变量", () => {
    const bad = declarations.filter(([, , value]) => !/^var\(--dt-[a-z0-9-]+\)$/.test(value.trim()));
    assert.deepEqual(bad.map(([, name, value]) => `${name}: ${value}`), []);
  });

  it("覆盖全部 shadcn 语义变量与 --radius（47 条）", () => {
    const names = new Set(declarations.map(([, name]) => name));
    for (const variable of ["--background", "--foreground", "--primary", "--positive", "--caution-on-primary", "--border", "--ring", "--chart-5", "--sidebar-ring", "--surface", "--selection", "--radius"]) {
      assert.ok(names.has(variable), `Adapter 缺少 ${variable}`);
    }
    assert.equal(names.size, 47, "Adapter 映射数量与 shadcn 变量集不一致");
  });

  it("映射目标都是真实存在的 token", () => {
    const { byPath } = loadSources();
    const missing = declarations
      .map(([, , value]) => value.trim().match(/^var\(--dt-([a-z0-9-]+)\)$/)?.[1])
      .filter((name) => name && ![...byPath.keys()].some((path) => path.replaceAll(".", "-") === name));
    assert.deepEqual(missing, []);
  });

  it("index.css 只保留映射与结构，不再定义 shadcn 变量取值", () => {
    const globals = readFileSync(join(REPO, "src/index.css"), "utf8");
    assert.match(globals, /@import "\.\.\/design-tokens\/dist\/css\/index\.css";/, "index.css 未引入 token 产物");
    assert.match(globals, /@import "\.\/styles\/shadcn-adapter\.css";/, "index.css 未引入 adapter");
    assert.doesNotMatch(globals, /^\s*--(background|foreground|primary|border|positive):\s*(?!var)/m, "index.css 里出现了 shadcn 变量的具体取值");
    assert.doesNotMatch(globals, /^\s*--font-(sans|mono):\s*"/m, "index.css 里字体栈应引用 token 而非字面量");
  });

  it("src 组件代码不引入颜色字面量（第二取值来源）", () => {
    // 已知例外：Terminal.tsx——xterm 渲染面不走 CSS 变量，主题只能是 JS 常量（独立渲染域）
    // SettingsPage/useTheme——色板选项与 accent 前景黑白判定是「用户选色的数据源」，
    // 运行时写进 CSS 变量而非组件样式（swatch/preset 本质是数据表，2026-11 评审登记）
    const EXEMPT = ["features/pods/Terminal.tsx", "features/settings/SettingsPage.tsx", "hooks/useTheme.ts"];
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (entry === "styles" || entry === "design-tokens") continue;
        const st = statSync(path);
        if (st.isDirectory()) walk(path);
        else if (/\.(tsx|ts)$/.test(entry) && !EXEMPT.some((e) => path.endsWith(e))) {
          const text = readFileSync(path, "utf8");
          const hits = [...text.matchAll(/#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/g)].filter((m) => {
            const line = text.slice(text.lastIndexOf("\n", m.index) + 1, m.index);
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false; // 注释里的标定记录不是取值来源
            const ctx = text.slice(Math.max(0, m.index - 60), m.index);
            return !/className|title|id=|path|route|url|anchor|href|fragment/i.test(ctx); // 路由 hash / 文档锚点不算
          });
          if (hits.length) offenders.push(`${path.replace(REPO, "")}: ${hits.map((h) => h[0]).slice(0, 3).join(" ")}`);
        }
      }
    };
    walk(join(REPO, "src"));
    assert.deepEqual(offenders, [], "组件里出现疑似颜色字面量，请改用 token 类：\n" + offenders.join("\n"));
  });
});
