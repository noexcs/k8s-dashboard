import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import StyleDictionary from "style-dictionary";

import { DIST, PKG_VERSION, PRIMITIVES, REGISTRY, blocks, setLayerIndex, tokenPath } from "./config.mjs";
import { buildJson, buildTypeScript } from "./formats/json-metadata.mjs";
import { cssBlockFormat, registerCssFormat } from "./formats/css-block.mjs";
import { loadSources } from "./sources.mjs";

const write = (rel, content) => {
  const path = join(DIST, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`);
  return path;
};

/**
 * 只删除本次没有产出的旧文件，不整体清空 dist：
 * next dev 正在跑时，「先删目录再写文件」会让 layout 的 CSS import 短暂找不到模块。
 */
const prune = (keep) => {
  const removed = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        if (!readdirSync(path).length) rmSync(path, { recursive: true, force: true });
      } else if (!keep.has(path)) {
        rmSync(path, { force: true });
        removed.push(path);
      }
    }
  };
  if (existsSync(DIST)) walk(DIST);
  return removed;
};

const styleDictionary = (chain) =>
  new StyleDictionary({
    include: PRIMITIVES,
    source: chain,
    // 保持取值原样（oklch / calc / cubic-bezier 等），不做颜色或单位转换
    platforms: { css: { transformGroups: [], transforms: ["attribute/cti"], files: [] } },
    log: { verbosity: "silent", warnings: "disabled" },
  });

/**
 * 构建全部产物：CSS（base + 每个 Visual Theme）、JSON 元数据、TypeScript 变量表。
 * 同一份源、同一套解析链 -> 同样字节输出（无时间戳），可复现。
 */
export async function build({ version = PKG_VERSION, quiet = false } = {}) {
  registerCssFormat(StyleDictionary);

  const sources = loadSources();
  setLayerIndex(sources.layers);
  const resolved = new Map();
  const chunks = new Map();

  for (const block of blocks()) {
    const sd = styleDictionary(block.chain);
    const { allTokens } = await sd.getPlatformTokens("css");
    resolved.set(block.id, new Map(allTokens.map((t) => [tokenPath(t), t.$value ?? t.value])));
    // 默认主题同时以 <themeId>.<mode> 记录，供按主题取值的产物复用
    resolved.set(`${block.themeId}.${block.mode}`, resolved.get(block.id));

    const layers = block.id === "base" ? ["primitive", "semantic", "component"] : ["semantic", "component"];
    const css = cssBlockFormat({ dictionary: { allTokens }, options: { block: { ...block, layers } } });
    chunks.set(block.file, [...(chunks.get(block.file) ?? []), css]);
  }

  const written = [];
  written.push(write("css/base.css", chunks.get("base.css").join("\n")));
  const themeFiles = REGISTRY.themes.filter((t) => t.id !== REGISTRY.default).map((t) => `themes/${t.id}.css`);
  for (const file of themeFiles) {
    const css = chunks.get(file);
    if (css) written.push(write(`css/${file}`, css.join("\n")));
  }
  const index = [
    `/* Design Token 产物（默认主题 = ${REGISTRY.default}）。生成文件，请勿修改。 */`,
    ...chunks.get("base.css"),
    "",
    ...themeFiles.flatMap((f) => chunks.get(f) ?? []),
  ].join("\n");
  written.push(write("css/index.css", index));

  const json = buildJson({ sources, resolved });
  for (const [rel, data] of Object.entries(json)) written.push(write(rel, JSON.stringify({ ...data, version }, null, 2)));
  written.push(write("typescript/tokens.ts", buildTypeScript({ sources })));

  const removed = prune(new Set(written));
  if (!quiet) {
    console.log(`design-tokens: ${resolved.get("base").size} tokens -> ${written.length} 个产物${removed.length ? `（清理 ${removed.length} 个过期文件）` : ""}`);
  }
  return { written, resolved, sources };
}
