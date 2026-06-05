import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

/** Source uses NodeNext, so siblings are imported with a `.js` suffix
 * (`./config.js`). Vite resolves that literally and misses the `.ts` on disk —
 * rewrite a relative `*.js` specifier to `*.ts` when the TS file exists. Keeps
 * the source's import style untouched (AGENTS.md: ESM `.js` suffix is required). */
function resolveJsToTs(): Plugin {
  return {
    name: "resolve-js-to-ts",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
      const tsPath = resolve(dirname(importer), source.slice(0, -3) + ".ts");
      return existsSync(tsPath) ? tsPath : null;
    },
  };
}

export default defineConfig({
  plugins: [resolveJsToTs()],
  test: {
    root,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    setupFiles: ["./src/engine/__tests__/helpers/setupEnv.ts"],
    coverage: {
      provider: "v8",
      include: ["src/engine/**", "src/cli/**"],
      exclude: ["**/__tests__/**", "src/tui/**", "**/types.ts"],
      // Floors below current actuals (≈81% stmts / 83% lines) so CI fails on a
      // real regression without being fragile to small, legitimate changes.
      thresholds: { statements: 78, lines: 80, functions: 80, branches: 56 },
    },
  },
});
