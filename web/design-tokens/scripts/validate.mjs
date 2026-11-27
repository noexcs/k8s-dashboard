#!/usr/bin/env node
/**
 * Token 校验：Schema、引用（悬空/循环）、命名、设计约束、对比度。
 * 作为模块导出 validate()，CLI 与 node:test 共用同一套规则。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REGISTRY, TOKENS } from "../build/config.mjs";
import { loadSources } from "../build/sources.mjs";

const TYPES = new Set([
  "color", "dimension", "duration", "number", "fontWeight", "fontFamily", "fontFamilies",
  "cubicBezier", "other", "typography", "shadow", "link", "strokeStyle", "transition",
]);
const SEGMENT = /^[a-z0-9]+([-.][a-z0-9]+)*$/; // 英文小写，数字/连字符，点分隔层级
const MAX_DEPTH = 4;
const MAX_DURATION_MS = 500;
const MAX_Z_INDEX = 100;
// 这些类型的 Semantic token 允许直接写字面量（none、字体栈等无法分解为档位的值）
const LITERAL_OK = new Set(["other", "number", "dimension", "color", "fontFamilies", "fontFamily"]);

// —— 颜色与对比度 ——————————————————————————————————————————————
const parseColor = (value) => {
  if (typeof value !== "string") return null;
  const oklch = value.match(/^oklch\(\s*([\d.]+)(?:%?)\s+([-\d.]+)\s+([-\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/);
  if (oklch) {
    const [, l, c, h, alpha] = oklch;
    return { l: Number(l), c: Number(c), h: Number(h), alpha: alpha === undefined ? 1 : Number(alpha) };
  }
  const hex = value.match(/^#([\da-f]{6})$/i);
  if (hex) {
    const n = Number(`0x${hex[1]}`);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  return null; // calc()、none、var() 等不参与对比度计算
};

const toRgb255 = ({ l, c, h }) => {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const [L, M, S] = [l_, m_, s_].map((x) => x ** 3);
  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  return lin.map((x) => {
    const g = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, g)) * 255);
  });
};

const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const contrastRatio = (a, b) => {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb || ca.alpha !== 1 || cb.alpha !== 1) return null;
  const la = luminance(ca.rgb ?? toRgb255(ca));
  const lb = luminance(cb.rgb ?? toRgb255(cb));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

// —— 校验 ————————————————————————————————————————————————
export const validate = ({ resolved, failOnContrast = false } = {}) => {
  const { byPath, refs, files, layers } = loadSources();
  const errors = [];
  const warnings = [];

  // 1) Schema + 命名
  for (const file of files) {
    if (file.endsWith("registry.json")) continue;
    const data = JSON.parse(readFileSync(file, "utf8"));
    const walk = (node, segs) => {
      if (node === null || typeof node !== "object") return;
      const rel = `${file.replace(`${process.cwd()}/`, "")}`;
      for (const key of Object.keys(node)) {
        if (!key.startsWith("$") && !SEGMENT.test(key)) {
          errors.push(`命名不合规：${rel} 片段 "${key}"（要求英文小写 + 数字/连字符，点分隔）`);
        }
      }
      if (node.$value !== undefined) {
        const path = segs.join(".");
        if (!node.$type) errors.push(`缺少 $type：${path}（${rel}）`);
        else if (!TYPES.has(node.$type)) errors.push(`未知 $type "${node.$type}"：${path}（${rel}）`);
        if (segs.length > MAX_DEPTH) errors.push(`超过 ${MAX_DEPTH} 层：${path}（${rel}）`);
        for (const extra of Object.keys(node)) {
          if (!["$type", "$value", "$description", "$extensions"].includes(extra)) {
            errors.push(`Token 内含非 DTCG 字段 "${extra}"：${path}（${rel}）`);
          }
        }
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        if (key.startsWith("$")) continue;
        walk(child, [...segs, key]);
      }
    };
    walk(data, []);
  }

  // 2) 引用：悬空 + 循环
  for (const [ref, users] of refs) {
    if (!byPath.has(ref)) errors.push(`悬空引用：${users.join(", ")} -> {${ref}}`);
  }
  const visit = (path, stack) => {
    if (stack.includes(path)) {
      errors.push(`循环引用：${[...stack, path].join(" -> ")}`);
      return;
    }
    const raw = byPath.get(path)?.rawValue;
    if (typeof raw !== "string") return;
    for (const [, ref] of raw.matchAll(/\{([^{}]+)\}/g)) {
      if (byPath.has(ref)) visit(ref, [...stack, path]);
    }
  };
  for (const path of byPath.keys()) visit(path, []);

  // 3) 分层约束：Semantic -> Primitive，Component -> Semantic（允许中间再引用同层）
  const firstRef = (path) => {
    const raw = byPath.get(path)?.rawValue;
    if (typeof raw !== "string") return [];
    return [...raw.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]).filter((r) => byPath.has(r));
  };
  const reaches = (path, want, seen = new Set()) => {
    for (const target of firstRef(path)) {
      if (seen.has(target)) continue;
      seen.add(target);
      if (layers[want].has(target)) return true;
      if (reaches(target, want, seen)) return true;
    }
    return false;
  };
  for (const path of layers.semantic) {
    const info = byPath.get(path);
    if (!firstRef(path).length) {
      if (!LITERAL_OK.has(info?.type ?? "")) warnings.push(`Semantic 使用字面量：${path}`);
      continue;
    }
    if (!reaches(path, "primitive")) warnings.push(`Semantic 未（直接或经中间层）引用 Primitive：${path} -> ${firstRef(path).join(", ")}`);
  }
  for (const path of layers.component) {
    if (!firstRef(path).length) continue;
    if (!reaches(path, "semantic")) warnings.push(`Component 未引用 Semantic：${path} -> ${firstRef(path).join(", ")}`);
  }

  // 4) 设计约束
  for (const [path, info] of byPath) {
    if (path.startsWith("duration.") || path.startsWith("motion.")) {
      const ms = Number(String(info.rawValue).match(/^(\d+(?:\.\d+)?)ms$/)?.[1]);
      if (Number.isFinite(ms) && ms > MAX_DURATION_MS) errors.push(`动效时长超过 ${MAX_DURATION_MS}ms：${path}`);
    }
    if (path.startsWith("z-index.") || path.startsWith("layer.")) {
      const z = Number(info.rawValue);
      if (Number.isFinite(z) && z > MAX_Z_INDEX) errors.push(`层级超过 ${MAX_Z_INDEX}：${path}`);
    }
    if (info.type === "color" || (layers.primitive.has(path) && String(info.rawValue).startsWith("oklch"))) {
      const value = String(info.rawValue);
      if (value.startsWith("#") && !/^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) errors.push(`颜色格式应为 6 位或 8 位（含 alpha）hex：${path}`);
      if (value.includes("rgb(") || value.includes("hsl(")) warnings.push(`建议统一用 oklch：${path}`);
    }
  }

  // 5) 主题注册表一致性
  const radiusSteps = [...byPath.entries()]
    .filter(([p]) => p.startsWith("radius.scale."))
    .map(([, info]) => String(info.rawValue));
  for (const theme of REGISTRY.themes) {
    if (!theme.layers?.light || !theme.layers.dark) errors.push(`主题 ${theme.id} 未声明 layers.light / layers.dark`);
    for (const mode of ["light", "dark"]) {
      if (theme.layers?.[mode] && !files.includes(join(TOKENS, "themes", `${theme.layers[mode]}.json`))) {
        errors.push(`主题 ${theme.id} 缺少 ${mode} 层文件：tokens/themes/${theme.layers[mode]}.json`);
      }
    }
    if (!radiusSteps.includes(theme.radius)) {
      errors.push(`主题 ${theme.id} 的 radius "${theme.radius}" 不在 radius.scale 档位值内`);
    }
  }

  // 6) 对比度（WCAG AA 4.5:1，默认告警不阻断）
  if (resolved) {
    const pairs = [
      ["color.foreground.default", "color.background.default"],
      ["color.muted.foreground", "color.background.default"],
      ["color.primary.foreground", "color.primary.default"],
      ["color.secondary.foreground", "color.secondary.default"],
      ["color.accent.foreground", "color.accent.default"],
      ["color.surface.card-foreground", "color.surface.card"],
      ["color.feedback.destructive-foreground", "color.feedback.destructive"],
      ["color.selection.foreground", "color.selection.default"],
      ["color.navigation.sidebar-foreground", "color.navigation.sidebar"],
    ];
    const defaultBlocks = ["base", `${REGISTRY.default}.dark`];
    for (const block of defaultBlocks) {
      const map = resolved.get(block);
      if (!map) continue;
      for (const [fg, bg] of pairs) {
        const ratio = contrastRatio(map.get(fg), map.get(bg));
        if (ratio !== null && ratio < 4.5) {
          const message = `对比度不足 AA：${block} ${fg} on ${bg} = ${ratio.toFixed(2)}:1`;
          (failOnContrast ? errors : warnings).push(message);
        }
      }
    }
  }

  return { errors, warnings, counts: { tokens: byPath.size, primitives: layers.primitive.size, semantic: layers.semantic.size, components: layers.component.size } };
};

const isCli = process.argv[1] && process.argv[1].endsWith("validate.mjs");
if (isCli) {
  const { build } = await import("../build/index.mjs");
  const { resolved } = await build({ quiet: true });
  const { errors, warnings, counts } = validate({ resolved, failOnContrast: process.env.DT_STRICT_CONTRAST === "1" });
  console.log(`design-tokens: ${counts.tokens} 个 token（primitive ${counts.primitives} / semantic ${counts.semantic} / component ${counts.components}）`);
  for (const w of warnings) console.warn(`  ! ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`  x ${e}`);
    console.error(`校验失败：${errors.length} 个错误，${warnings.length} 个警告`);
    process.exit(1);
  }
  console.log(`校验通过：0 个错误，${warnings.length} 个警告`);
}
