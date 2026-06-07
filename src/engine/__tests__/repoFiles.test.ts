import { describe, expect, it } from "vitest";

import {
  exportedSymbols,
  langOf,
  parseImports,
  resolveImport,
  testCandidates,
} from "../repoFiles.js";

describe("langOf", () => {
  it("classifies TS/JS family as ts", () => {
    for (const p of ["a.ts", "a.tsx", "a.js", "a.jsx", "a.mjs", "a.cjs"]) {
      expect(langOf(p)).toBe("ts");
    }
  });
  it("classifies .py as py and everything else as other", () => {
    expect(langOf("x.py")).toBe("py");
    expect(langOf("README.md")).toBe("other");
    expect(langOf("noext")).toBe("other");
  });
});

describe("parseImports", () => {
  it("extracts TS import/require specifiers", () => {
    const src = [
      `import { a } from "./a.js";`,
      `import "./side-effect.js";`,
      `const x = require("./legacy.js");`,
      `import type { T } from "../types.js";`,
    ].join("\n");
    expect(parseImports(src, "ts")).toEqual(
      expect.arrayContaining(["./a.js", "./side-effect.js", "./legacy.js", "../types.js"]),
    );
  });
  it("extracts Python import specifiers", () => {
    const src = "from .mod import thing\nimport os\nfrom ..pkg import y";
    expect(parseImports(src, "py")).toEqual(expect.arrayContaining([".mod", "os", "..pkg"]));
  });
});

describe("resolveImport", () => {
  it("resolves relative TS specifiers to candidate paths", () => {
    const cands = resolveImport("./util.js", "src/engine/forge.ts", "ts");
    // path joins relative to the importer's dir and tries ts/tsx/js/jsx + index.*
    expect(cands).toContain("src/engine/util.js.ts");
    expect(cands.some((c) => c.endsWith("/index.ts"))).toBe(true);
  });
  it("ignores bare/package imports", () => {
    expect(resolveImport("react", "src/x.ts", "ts")).toEqual([]);
    expect(resolveImport("os", "a.py", "py")).toEqual([]);
  });
});

describe("exportedSymbols", () => {
  it("collects exported names and drops underscored ones", () => {
    const src = [
      "export function alpha() {}",
      "export const beta = 1;",
      "export class Gamma {}",
      "export function _private() {}",
    ].join("\n");
    const syms = exportedSymbols(src, "ts");
    expect(syms).toEqual(expect.arrayContaining(["alpha", "beta", "Gamma"]));
    expect(syms).not.toContain("_private");
  });

  it("caps the result at 6 symbols", () => {
    const src = Array.from({ length: 10 }, (_, i) => `export function fn${i}() {}`).join("\n");
    expect(exportedSymbols(src, "ts").length).toBe(6);
  });
});

describe("testCandidates", () => {
  it("suggests conventional TS test paths", () => {
    const c = testCandidates("src/engine/forge.ts", "ts");
    expect(c).toContain("src/engine/forge.test.ts");
    expect(c).toContain("src/engine/forge.spec.ts");
    expect(c.some((p) => p.includes("__tests__"))).toBe(true);
  });
  it("suggests conventional Python test paths", () => {
    const c = testCandidates("pkg/mod.py", "py");
    expect(c).toContain("pkg/mod_test.py");
    expect(c.some((p) => p.includes("test_mod.py"))).toBe(true);
  });
});
