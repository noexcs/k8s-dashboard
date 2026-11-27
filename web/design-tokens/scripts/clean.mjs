#!/usr/bin/env node
import { rmSync } from "node:fs";

import { DIST } from "../build/config.mjs";

rmSync(DIST, { recursive: true, force: true });
console.log("已清理", DIST.replace(`${process.cwd()}/`, ""));
