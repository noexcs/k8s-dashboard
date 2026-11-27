import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { TOKENS } from "./config.mjs";

export const sourceFiles = () =>
  ["primitives", "semantic", "components", "themes"]
    .flatMap((dir) =>
      readdirSync(join(TOKENS, dir), { recursive: true })
        .filter((f) => String(f).endsWith(".json"))
        .map((f) => join(TOKENS, dir, String(f))),
    )
    .sort();

/**
 * 源文件索引：token 路径 -> 定义信息（原始值含 {引用}、$type、$description、所在文件）。
 * 构建产物与校验器共用，保证「引用来源」「使用次数」与源一致。
 */
export const loadSources = () => {
  const byPath = new Map();
  const layers = { primitive: new Set(), semantic: new Set(), component: new Set(), theme: new Set() };
  const refs = new Map(); // 被引用 token -> [引用方 token]
  const files = sourceFiles();

  for (const file of files) {
    const layer = file.includes("/primitives/") ? "primitive" : file.includes("/components/") ? "component" : file.includes("/themes/") ? "theme" : "semantic";
    const data = JSON.parse(readFileSync(file, "utf8"));
    const walk = (node, segs) => {
      if (node === null || typeof node !== "object") return;
      if (node.$value !== undefined) {
        const path = segs.join(".");
        layers[layer].add(path);
        // 主题层是覆盖，不覆盖定义信息（$description/$type 以 semantic|primitive 定义为准）
        if (!byPath.has(path)) byPath.set(path, {
          path,
          file,
          type: node.$type ?? null,
          rawValue: node.$value,
          description: node.$description ?? null,
        });
        if (typeof node.$value === "string") {
          for (const [, ref] of node.$value.matchAll(/\{([^{}]+)\}/g)) {
            const users = refs.get(ref) ?? [];
            if (!users.includes(path)) users.push(path);
            refs.set(ref, users);
          }
        }
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        if (key.startsWith("$")) continue;
        if (file.endsWith("registry.json")) continue; // 注册表是元数据，不是 token
        walk(child, [...segs, key]);
      }
    };
    walk(data, []);
  }
  return { byPath, refs, files, layers };
};
