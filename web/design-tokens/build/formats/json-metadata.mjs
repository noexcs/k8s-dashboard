import { PREFIX, REGISTRY, layerOf } from "../config.mjs";

const themeIds = REGISTRY.themes.map((t) => t.id);

/**
 * dist/json/tokens.json —— Playground / 文档 / 校验器的唯一数据源；
 * dist/json/themes.json —— 主题清单 + 预览色（从解析结果取，不在别处重复登记色值）。
 * resolved: Map<blockId, Map<path, value>>
 */
export const buildJson = ({ sources, resolved }) => {
  const paths = [...resolved.get("base").keys()].sort();

  const tokens = paths.map((path) => {
    const info = sources.byPath.get(path) ?? {};
    const themes = {};
    for (const themeId of themeIds) {
      for (const mode of ["light", "dark"]) {
        const block = resolved.get(`${themeId}.${mode}`) ?? resolved.get(mode === "dark" ? "base.dark" : "base");
        if (!block?.has(path)) continue;
        (themes[themeId] ??= {})[mode] = block.get(path);
      }
    }
    return {
      path,
      cssVar: `var(--${PREFIX}-${path.replaceAll(".", "-")})`,
      type: info.type ?? null,
      layer: layerOf({ path: path.split(".") }),
      value: info.rawValue ?? null, // 原始定义，保留 {引用}
      resolvedValue: resolved.get("base").get(path),
      description: info.description ?? null,
      usedBy: sources.refs.get(path) ?? [],
      themes,
    };
  });

  // version 由调用方注入（build({version}) 取自根 package.json），这里只出结构
  return {
    "json/tokens.json": { count: tokens.length, tokens },
    "json/themes.json": {
      default: REGISTRY.default,
      themes: REGISTRY.themes.map((theme) => {
        const light = resolved.get(`${theme.id}.light`) ?? resolved.get("base");
        return {
          ...theme,
          swatch: {
            background: light.get("color.background.default"),
            foreground: light.get("color.foreground.default"),
            primary: light.get("color.primary.default"),
            accent: light.get("color.feedback.warning"),
          },
        };
      }),
    },
  };
};

const identifier = (key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key));

/** dist/typescript/tokens.ts —— 类型安全的 var() 引用表 */
export const buildTypeScript = ({ sources }) => {
  const tree = {};
  for (const path of [...sources.byPath.keys()].sort()) {
    const segs = path.split(".");
    let node = tree;
    for (const seg of segs.slice(0, -1)) node = node[seg] ??= {};
    node[segs.at(-1)] = `var(--${PREFIX}-${path.replaceAll(".", "-")})`;
  }
  const paths = [...sources.byPath.keys()].sort();
  const emit = (node, indent) =>
    `{\n${Object.entries(node)
      .map(([key, value]) => {
        const name = identifier(key);
        return typeof value === "string"
          ? `${indent}  ${name}: ${JSON.stringify(value)},`
          : `${indent}  ${name}: ${emit(value, `${indent}  `)},`;
      })
      .join("\n")}\n${indent}}`;

  return `// 生成文件，请勿直接修改：由 design-tokens/scripts/build.mjs 产出。
export const tokens = ${emit(tree, "")} as const;

export type TokenName =
${paths.map((p) => `  | ${JSON.stringify(p)}`).join("\n")};

export type ThemeId = ${themeIds.map((id) => JSON.stringify(id)).join(" | ")};

export const themeIds = [${themeIds.map((id) => JSON.stringify(id)).join(", ")}] as const satisfies readonly ThemeId[];

export const defaultThemeId = ${JSON.stringify(REGISTRY.default)} satisfies ThemeId;

export const tokenNames: readonly TokenName[] = [${paths.map((p) => JSON.stringify(p)).join(", ")}];

export function tokenCssVar(name: TokenName): \`var(--${PREFIX}-\${string})\` {
  const flat = tokens as unknown as Record<TokenName, \`var(--${PREFIX}-\${string})\`>;
  return flat[name];
}
`;
};
