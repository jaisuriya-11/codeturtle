import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { normsDir, resetAll, updateConfig } from "../config.js";
import { applyExcludes, isExcluded, loadNorms } from "../norms.js";
import type { FileDiff, MrInfo, Norms } from "../types.js";
import { makeFakeForge } from "./helpers/fakeForge.js";

function writePack(name: string, body: string): void {
  mkdirSync(normsDir(), { recursive: true });
  writeFileSync(join(normsDir(), `${name}.yml`), body);
}

const baseNorms: Norms = {
  confidenceThreshold: 0.7,
  maxFindings: 25,
  exclude: ["**/*.lock", "**/*.min.js", "**/dist/**"],
  categories: { security: true, bug: true, perf: true, style: true, maintainability: true },
  guidelines: "",
  examples: [],
};

const mr: MrInfo = {
  sourceBranch: "feature",
  targetBranch: "main",
  headSha: "head",
  diffRefs: { head_sha: "head", base_sha: "base", start_sha: "start" },
};

describe("isExcluded", () => {
  it("matches by full path and by basename", () => {
    expect(isExcluded("pkg/yarn.lock", baseNorms)).toBe(true); // basename match
    expect(isExcluded("dist/bundle.js", baseNorms)).toBe(true); // dir glob match
    expect(isExcluded("app/vendor.min.js", baseNorms)).toBe(true);
  });
  it("does not exclude normal source files", () => {
    expect(isExcluded("src/engine/forge.ts", baseNorms)).toBe(false);
  });
});

describe("applyExcludes", () => {
  it("drops excluded diffs, keeps the rest", () => {
    const diffs: FileDiff[] = [
      { newPath: "src/a.ts", oldPath: "src/a.ts", diff: "", newFile: false, deletedFile: false },
      { newPath: "package-lock.json", oldPath: "", diff: "", newFile: true, deletedFile: false },
      { newPath: "dist/x.js", oldPath: "", diff: "", newFile: true, deletedFile: false },
    ];
    const kept = applyExcludes(diffs, {
      ...baseNorms,
      exclude: ["**/dist/**", "package-lock.json"],
    });
    expect(kept.map((d) => d.newPath)).toEqual(["src/a.ts"]);
  });
});

describe("loadNorms", () => {
  it("merges repo .codeturtle.yml over defaults", async () => {
    const gl = makeFakeForge({
      files: { ".codeturtle.yml": "confidence_threshold: 0.9\nmax_findings: 5" },
    });
    const norms = await loadNorms(gl, "owner/repo", mr);
    expect(norms.confidenceThreshold).toBe(0.9);
    expect(norms.maxFindings).toBe(5);
    // untouched fields fall back to defaults
    expect(norms.categories.security).toBe(true);
  });

  it("falls back to defaults when no repo config exists", async () => {
    const gl = makeFakeForge({ files: {} });
    const norms = await loadNorms(gl, "owner/repo", mr);
    expect(norms.confidenceThreshold).toBe(0.7);
    expect(norms.maxFindings).toBe(25);
  });
});

describe("loadNorms — global + pack + repo layering", () => {
  beforeEach(() => {
    resetAll();
    rmSync(normsDir(), { recursive: true, force: true });
  });

  it("layers DEFAULTS -> global -> repo, with the repo winning on overlapping scalars", async () => {
    updateConfig("norms", { confidence_threshold: 0.5, max_findings: 50 });
    const gl = makeFakeForge({ files: { ".codeturtle.yml": "max_findings: 7" } });
    const norms = await loadNorms(gl, "o/r", mr);
    expect(norms.confidenceThreshold).toBe(0.5); // from global (repo silent)
    expect(norms.maxFindings).toBe(7); // repo overrides global
  });

  it("pulls in a global pack via config `use`", async () => {
    writePack("strict", "name: strict\nconfidence_threshold: 0.4\ncategories: { perf: false }");
    updateConfig("norms", { use: ["strict"] });
    const gl = makeFakeForge({ files: {} });
    const norms = await loadNorms(gl, "o/r", mr);
    expect(norms.confidenceThreshold).toBe(0.4);
    expect(norms.categories.perf).toBe(false);
  });

  it("lets a repo opt into an installed pack by name via `extends`, repo inline still winning", async () => {
    writePack("react", "name: react\nmax_findings: 40\nexclude: ['**/*.stories.tsx']");
    const gl = makeFakeForge({
      files: { ".codeturtle.yml": "extends: [react]\nmax_findings: 12" },
    });
    const norms = await loadNorms(gl, "o/r", mr);
    expect(norms.maxFindings).toBe(12); // repo inline beats the pack it extends
    expect(norms.exclude).toContain("**/*.stories.tsx"); // pack exclude unioned in
  });

  it("accumulates excludes and guidelines across layers", async () => {
    updateConfig("norms", { exclude: ["**/vendor/**"], guidelines: "global rule" });
    const gl = makeFakeForge({
      files: { ".codeturtle.yml": "exclude: ['**/*.snap']\nguidelines: repo rule" },
    });
    const norms = await loadNorms(gl, "o/r", mr);
    expect(norms.exclude).toEqual(expect.arrayContaining(["**/vendor/**", "**/*.snap"]));
    expect(norms.guidelines).toContain("global rule");
    expect(norms.guidelines).toContain("repo rule");
  });
});
