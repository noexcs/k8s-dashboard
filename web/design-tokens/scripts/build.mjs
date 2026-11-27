import { build } from "../build/index.mjs";

// 单包工程：产物版本号沿用根 package.json（见 design-tokens/README.md 的版本策略）
try {
  const { written } = await build();
  for (const path of written) console.log("  ", path.replace(`${process.cwd()}/`, ""));
} catch (error) {
  console.error("[design-tokens] 构建失败：");
  console.error(error.message);
  process.exit(1);
}
