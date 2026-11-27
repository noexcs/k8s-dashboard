import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, REGISTRY } from "../build/config.mjs";
import { build } from "../build/index.mjs";

const read = (...parts) => readFileSync(join(DIST, ...parts), "utf8");
const cssPath = "css/index.css";

await build({ quiet: true });

describe("构建产物", () => {
  it("生成 CSS / JSON / TypeScript 三类产物", () => {
    for (const file of ["css/index.css", "css/base.css", "json/tokens.json", "json/themes.json", "typescript/tokens.ts"]) {
      assert.ok(read(file).length > 0, `缺少产物 ${file}`);
    }
  });

  it("每个主题都有 light 与 dark 选择器块", () => {
    const css = read(cssPath);
    assert.match(css, /:root\s*\{/);
    assert.match(css, /\.dark\s*\{/);
    for (const theme of REGISTRY.themes) {
      if (theme.id === REGISTRY.default) continue;
      assert.match(css, new RegExp(`:root\\[data-theme="${theme.id}"\\]`), `缺少 ${theme.id} 亮色块`);
      assert.match(css, new RegExp(`:root\\[data-theme="${theme.id}"\\]\\.dark`), `缺少 ${theme.id} 暗色块`);
    }
  });

  it("同一份源重复构建结果一致（可复现）", async () => {
    const first = read(cssPath);
    const json = read("json/tokens.json");
    await build({ quiet: true });
    assert.equal(read(cssPath), first);
    assert.equal(read("json/tokens.json"), json);
  });

  it("产物不含时间戳等不可复现字段", () => {
    for (const file of ["css/index.css", "json/tokens.json"]) {
      assert.doesNotMatch(read(file), /generatedAt|"date"|timestamp/i, `${file} 含时间戳`);
    }
  });

  it("每个 token 都有解析值与主题取值", () => {
    const { tokens } = JSON.parse(read("json/tokens.json"));
    for (const token of tokens) {
      assert.ok(token.resolvedValue !== undefined, `${token.path} 无解析值`);
      for (const theme of REGISTRY.themes) {
        assert.ok(token.themes?.[theme.id], `${token.path} 缺主题 ${theme.id} 取值`);
      }
    }
    assert.ok(tokens.length >= 85, `token 数量异常：${tokens.length}`);
  });

  it("主题清单与注册表同源", () => {
    const { themes } = JSON.parse(read("json/themes.json"));
    assert.deepEqual(themes.map((t) => t.id), REGISTRY.themes.map((t) => t.id));
    for (const theme of themes) {
      assert.ok(theme.swatch?.primary, `${theme.id} 预览色未从产物取值`);
    }
  });
});
