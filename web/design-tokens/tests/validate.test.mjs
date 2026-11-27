import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { build } from "../build/index.mjs";
import { loadSources } from "../build/sources.mjs";
import { contrastRatio, validate } from "../scripts/validate.mjs";

const { resolved } = await build({ quiet: true });
const result = validate({ resolved });

describe("Token 校验", () => {
  it("无错误：Schema、引用、命名、主题注册表全部通过", () => {
    assert.deepEqual(result.errors, []);
  });

  it("警告只允许是已记录的对比度问题", () => {
    for (const warning of result.warnings) {
      assert.match(warning, /^对比度不足 AA：/, `非预期警告：${warning}`);
    }
  });

  it("分层数量符合预期（primitive/semantic 成规模，component 暂空）", () => {
    const { primitives, semantic, components } = result.counts;
    assert.ok(primitives >= 40 && semantic >= 45 && components === 0, JSON.stringify(result.counts));
  });

  it("对比度计算与已知参考值一致", () => {
    // 纯黑/纯白 = 21:1；同色 = 1:1
    assert.equal(contrastRatio("#000000", "#ffffff").toFixed(2), "21.00");
    assert.equal(contrastRatio("#ffffff", "#ffffff").toFixed(2), "1.00");
    // 半透明值不参与计算
    assert.equal(contrastRatio("oklch(1 0 0 / 10%)", "#ffffff"), null);
  });

  it("颜色语义 token 都带说明（PRD 12.2：重要 Token 必须有描述）", () => {
    const { byPath, layers } = loadSources();
    const missing = [...layers.semantic]
      .filter((path) => path.startsWith("color."))
      .filter((path) => !byPath.get(path)?.description)
      .sort();
    assert.deepEqual(missing, [], `以下 semantic 颜色 token 缺少 $description：\n${missing.join("\n")}`);
  });
});
