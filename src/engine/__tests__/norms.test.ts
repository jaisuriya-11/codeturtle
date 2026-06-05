import { describe, expect, it } from "vitest";

import { applyExcludes, isExcluded, loadNorms } from "../norms.js";
import type { FileDiff, MrInfo, Norms } from "../types.js";
import { makeFakeForge } from "./helpers/fakeForge.js";

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
    const kept = applyExcludes(diffs, { ...baseNorms, exclude: ["**/dist/**", "package-lock.json"] });
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
