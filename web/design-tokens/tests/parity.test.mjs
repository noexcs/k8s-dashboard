import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "../build/index.mjs";

/**
 * 迁移零回归：Token 链路解析出的 47 个 shadcn 变量（明暗两态）必须与迁移前
 * 运行页 getComputedStyle 快照逐项相同——「重构不改视觉」的机器证明。
 * 基线 = tests/__fixtures__/baseline-variables.json（迁移前从线上页面抓取）。
 * 确属设计变更时重新生成基线并在 CHANGELOG 记 PATCH。
 */
const here = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(readFileSync(join(here, "__fixtures__", "baseline-variables.json"), "utf8"));

// shadcn CSS 变量 -> Semantic Token 路径（与 src/styles/shadcn-adapter.css 一致）
const MAP = {
  "--background": "color.background.default",
  "--foreground": "color.foreground.default",
  "--card": "color.surface.card",
  "--card-foreground": "color.surface.card-foreground",
  "--popover": "color.surface.popover",
  "--popover-foreground": "color.surface.popover-foreground",
  "--primary": "color.primary.default",
  "--primary-foreground": "color.primary.foreground",
  "--secondary": "color.secondary.default",
  "--secondary-foreground": "color.secondary.foreground",
  "--muted": "color.muted.default",
  "--muted-foreground": "color.muted.foreground",
  "--accent": "color.accent.default",
  "--accent-foreground": "color.accent.foreground",
  "--positive": "color.feedback.positive",
  "--negative": "color.feedback.negative",
  "--caution": "color.feedback.caution",
  "--caution-on-primary": "color.feedback.caution-on-primary",
  "--ink-on-muted": "color.feedback.on-muted",
  "--destructive": "color.feedback.destructive",
  "--destructive-on-primary": "color.feedback.destructive-on-primary",
  "--destructive-foreground": "color.feedback.destructive-foreground",
  "--border": "color.border.default",
  "--input": "color.border.input",
  "--ring": "color.border.ring",
  "--chart-1": "color.chart.1",
  "--chart-2": "color.chart.2",
  "--chart-3": "color.chart.3",
  "--chart-4": "color.chart.4",
  "--chart-5": "color.chart.5",
  "--sidebar": "color.navigation.sidebar",
  "--sidebar-foreground": "color.navigation.sidebar-foreground",
  "--sidebar-primary": "color.navigation.sidebar-primary",
  "--sidebar-primary-foreground": "color.navigation.sidebar-primary-foreground",
  "--sidebar-accent": "color.navigation.sidebar-accent",
  "--sidebar-accent-foreground": "color.navigation.sidebar-accent-foreground",
  "--sidebar-border": "color.navigation.sidebar-border",
  "--sidebar-ring": "color.navigation.sidebar-ring",
  "--surface": "color.panel.default",
  "--surface-foreground": "color.panel.foreground",
  "--code": "color.code.default",
  "--code-foreground": "color.code.foreground",
  "--code-highlight": "color.code.highlight",
  "--code-number": "color.code.number",
  "--selection": "color.selection.default",
  "--selection-foreground": "color.selection.foreground",
};

/** computed 值归一：.625rem == 0.625rem、#fff == #ffffff（computed/源码写法差异不算视觉差异） */
const norm = (v) => {
  let s = String(v).trim().toLowerCase();
  if (s.startsWith(".")) s = `0${s}`;
  const hex = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (hex) s = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  return s;
};

const { resolved } = await build({ quiet: true });

describe("迁移零回归（与迁移前运行页取值一致）", () => {
  for (const [mode, blockId] of [["light", "base"], ["dark", "base.dark"]]) {
    it(`${mode}：${Object.keys(MAP).length} 个 shadcn 变量 + radius 逐项相同`, () => {
      const map = resolved.get(blockId);
      assert.ok(map, `缺少解析块 ${blockId}`);
      const expected = baseline[mode];
      const diffs = [];
      for (const [cssVar, path] of Object.entries(MAP)) {
        const got = map.get(path);
        if (norm(got) !== norm(expected[cssVar])) diffs.push(`${cssVar}: 基线 ${expected[cssVar]} 实得 ${got}`);
      }
      if (norm(map.get("radius.base")) !== norm(expected["--radius"])) diffs.push(`--radius: 基线 ${expected["--radius"]} 实得 ${map.get("radius.base")}`);
      assert.deepEqual(diffs, [], `${mode} 与基线不一致：\n${diffs.join("\n")}`);
    });
  }
});
