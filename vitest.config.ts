import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// bun's isolated linker stores koishi's transitive deps only in per-package store
// siblings; vite cannot reproduce that resolution and the koishi entry's loader
// class chain breaks under interop. Tests only need `Schema`, which is
// @koishijs/core's re-export of schemastery — alias to the same object.
// Under yarn's node-modules linker the package sits at the usual hoisted path.
const bunKoishiCore = fileURLToPath(new URL("./node_modules/.bun/@koishijs+core@4.18.11/node_modules/@koishijs/core", import.meta.url));
const koishiCore = existsSync(bunKoishiCore) ? bunKoishiCore : fileURLToPath(new URL("./node_modules/@koishijs/core", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      koishi: koishiCore,
    },
  },
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "tools/**"],
  },
});
