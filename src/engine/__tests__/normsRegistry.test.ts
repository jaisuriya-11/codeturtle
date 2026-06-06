/** The norms plugin registry: pack loading, name-safety, merge semantics, and
 * code-transform loading from the trusted ~/.codeturtle/norms dir. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { normsDir } from "../config.js";
import { closeShape, loadPacks, loadTransforms, mergeNorms, safePackName } from "../normsRegistry.js";
import type { Norms, RawNorms } from "../types.js";

const DIR = normsDir();

function writeFile(name: string, body: string): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, name), body);
}

const base: Norms = {
  confidenceThreshold: 0.7,
  maxFindings: 25,
  exclude: ["**/dist/**"],
  categories: { security: true, bug: true },
  guidelines: "baseline guideline",
  examples: [{ bad: "x", why: "y" }],
};

beforeEach(() => rmSync(DIR, { recursive: true, force: true }));

describe("safePackName", () => {
  it("accepts bare identifiers, rejects path-ish / traversal names", () => {
    expect(safePackName("security-strict")).toBe(true);
    expect(safePackName("react_team")).toBe(true);
    expect(safePackName("../evil")).toBe(false);
    expect(safePackName("a/b")).toBe(false);
    expect(safePackName("a\\b")).toBe(false);
    expect(safePackName("..")).toBe(false);
    expect(safePackName("with.dot")).toBe(false);
    expect(safePackName("")).toBe(false);
    expect(safePackName(42)).toBe(false);
  });
});

describe("loadPacks", () => {
  it("returns empty when the norms dir does not exist", () => {
    expect(loadPacks().size).toBe(0);
  });

  it("keys a pack by its `name` field, falling back to the filename", () => {
    writeFile("alpha.yml", "name: custom-name\nmax_findings: 9");
    writeFile("beta.yaml", "max_findings: 3");
    const packs = loadPacks();
    expect(packs.get("custom-name")?.max_findings).toBe(9);
    expect(packs.get("beta")?.max_findings).toBe(3);
    expect(packs.has("alpha")).toBe(false); // overridden by its name field
  });

  it("strips agent/key_ref and skips malformed packs", () => {
    writeFile("p.yml", "name: p\nagent: https://evil\nkey_ref: STEAL\nmax_findings: 4");
    writeFile("broken.yml", ":\n  - : not valid : yaml :");
    const packs = loadPacks();
    expect(packs.get("p")).toMatchObject({ max_findings: 4 });
    expect("agent" in (packs.get("p") as object)).toBe(false);
    expect("key_ref" in (packs.get("p") as object)).toBe(false);
  });

  it("ignores non-yaml files", () => {
    writeFile("readme.txt", "not a pack");
    writeFile("plugin.mjs", "export default {}");
    expect(loadPacks().size).toBe(0);
  });
});

describe("mergeNorms", () => {
  it("last-writer-wins for scalars, shallow-merges categories", () => {
    const layer: RawNorms = { confidence_threshold: 0.5, max_findings: 10, categories: { perf: true } };
    const out = mergeNorms(base, layer);
    expect(out.confidenceThreshold).toBe(0.5);
    expect(out.maxFindings).toBe(10);
    expect(out.categories).toEqual({ security: true, bug: true, perf: true });
  });

  it("keeps base scalars when the layer omits them", () => {
    const out = mergeNorms(base, { max_findings: 1 });
    expect(out.confidenceThreshold).toBe(0.7); // untouched
    expect(out.maxFindings).toBe(1);
  });

  it("unions excludes and concatenates examples", () => {
    const out = mergeNorms(base, { exclude: ["**/dist/**", "**/*.snap"], examples: [{ bad: "z" }] });
    expect(out.exclude).toEqual(["**/dist/**", "**/*.snap"]); // dedup keeps dist once
    expect(out.examples).toEqual([{ bad: "x", why: "y" }, { bad: "z" }]);
  });

  it("appends guidelines with a source label instead of clobbering", () => {
    const out = mergeNorms(base, { guidelines: "no console.log" }, "team-pack");
    expect(out.guidelines).toContain("baseline guideline");
    expect(out.guidelines).toContain("# team-pack");
    expect(out.guidelines).toContain("no console.log");
  });
});

describe("closeShape", () => {
  it("strips stray keys, keeping exactly the six Norms fields", () => {
    const dirty = { ...base, evil: "pwned" } as unknown as Norms;
    const out = closeShape(dirty);
    expect(Object.keys(out).sort()).toEqual(
      ["categories", "confidenceThreshold", "examples", "exclude", "guidelines", "maxFindings"].sort(),
    );
    expect("evil" in out).toBe(false);
  });
});

describe("loadTransforms", () => {
  it("loads a valid default-exported transform, skips missing/invalid/unsafe names", async () => {
    writeFile("scale.mjs", "export default { name: 'scale', transform: (n) => { n.maxFindings = 99; return n; } }");
    writeFile("nofn.mjs", "export default { name: 'nofn' }"); // no transform fn
    const got = await loadTransforms(["scale", "nofn", "missing", "../evil"]);
    expect(got.map((t) => t.name)).toEqual(["scale"]);
    const n = { maxFindings: 1 } as Norms;
    got[0].transform(n, { forge: "github", projectId: "o/r", mr: {} as never });
    expect(n.maxFindings).toBe(99);
  });

  it("returns empty when the dir is absent", async () => {
    expect(await loadTransforms(["anything"])).toEqual([]);
  });
});
