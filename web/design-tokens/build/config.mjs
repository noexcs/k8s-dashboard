import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // design-tokens/
export const REPO = dirname(ROOT);
export const TOKENS = join(ROOT, "tokens");
export const DIST = join(ROOT, "dist");

// CSS 变量前缀：避开 Tailwind v4 的 --color-* / --radius-* / --shadow-* 主题命名空间，
// 生成的 Token 变量与 @theme inline 的映射目标不会互相覆盖。
export const PREFIX = "dt";

const list = (dir) =>
  readdirSync(join(TOKENS, dir), { recursive: true })
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(TOKENS, dir, String(f)));

export const PRIMITIVES = list("primitives");
export const SEMANTIC = list("semantic");
export const COMPONENTS = list("components");
export const REGISTRY = JSON.parse(readFileSync(join(TOKENS, "themes/registry.json"), "utf8"));

/** 产物版本号：沿用根 package.json，测试与构建脚本都必须用同一个值，避免产物里出现 "test" 之类假版本 */
export const PKG_VERSION = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

export const layerFile = (name) => join(TOKENS, "themes", `${name}.json`);

/**
 * 每个「输出块」= 一条解析链（前一层的值作为 include 参与引用解析，最后一层提供覆盖）。
 * 每块都展开全部 semantic + component token，块内自洽，不依赖跨块 CSS 继承顺序。
 */
export const blocks = () => {
  const structural = [...PRIMITIVES, ...SEMANTIC, ...COMPONENTS];
  const out = [
    {
      id: "base",
      file: "base.css",
      selector: ":root",
      themeId: REGISTRY.default,
      mode: "light",
      chain: [...structural, layerFile("light")],
    },
    {
      id: "base.dark",
      file: "base.css",
      selector: ":root.dark, .dark",
      themeId: REGISTRY.default,
      mode: "dark",
      chain: [...structural, layerFile("light"), layerFile("dark")],
    },
  ];
  for (const theme of REGISTRY.themes) {
    if (theme.id === REGISTRY.default) continue;
    for (const mode of ["light", "dark"]) {
      out.push({
        id: `${theme.id}.${mode}`,
        file: `themes/${theme.id}.css`,
        selector:
          mode === "light"
            ? `:root[data-theme="${theme.id}"]`
            : `:root[data-theme="${theme.id}"].dark, [data-theme="${theme.id}"].dark`,
        themeId: theme.id,
        mode,
        chain: [...structural, layerFile(mode), layerFile(theme.layers[mode])],
      });
    }
  }
  return out;
};

export const tokenPath = (token) => token.path.join(".");
export const cssVar = (token) => `--${PREFIX}-${token.path.join("-")}`;
let layerIndex = null;
/** 注入 build/sources.mjs 的分层索引；主题层覆盖继承被覆盖 token 的层 */
export const setLayerIndex = (layers) => {
  layerIndex = layers;
};

export const layerOf = (token) => {
  const path = tokenPath(token);
  if (layerIndex) {
    if (layerIndex.primitive.has(path)) return "primitive";
    if (layerIndex.component.has(path)) return "component";
    if (layerIndex.semantic.has(path)) return "semantic";
    return "theme";
  }
  const file = token.filePath ?? "";
  if (file.includes("/primitives/")) return "primitive";
  if (file.includes("/components/")) return "component";
  return "semantic";
};
