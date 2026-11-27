import { cssVar, layerOf } from "../config.mjs";

const render = (value) =>
  Array.isArray(value) ? value.join(", ") : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);

const group = (token) => token.path[0];

/**
 * 输出一个 CSS 作用域块：`selector { --dt-xxx: value; }`
 * options.block = { id, selector, layers }，layers 限定输出的 Token 层。
 */
export const cssBlockFormat = ({ dictionary, options }) => {
  const { selector, layers = ["primitive", "semantic", "component"] } = options.block;
  const tokens = dictionary.allTokens.filter((t) => layers.includes(layerOf(t)));
  const valueOf = (token) => token.$value ?? token.value;
  const lines = [`/* 生成文件，请勿直接修改：由 design-tokens/scripts/build.mjs 产出（块：${options.block.id}） */`, `${selector} {`];
  let current;
  for (const token of tokens) {
    if (group(token) !== current) {
      if (current) lines.push("");
      lines.push(`  /* ${group(token)} */`);
      current = group(token);
    }
    lines.push(`  ${cssVar(token)}: ${render(valueOf(token))};`);
  }
  return `${lines.join("\n")}\n}\n`;
};

export const registerCssFormat = (StyleDictionary) => {
  StyleDictionary.registerFormat({ name: "dt/css-block", format: cssBlockFormat });
};
