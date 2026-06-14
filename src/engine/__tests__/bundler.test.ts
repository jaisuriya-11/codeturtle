import { describe, expect, it } from "vitest";

import { buildContext } from "../bundler.js";
import type { FileDiff, Norms } from "../types.js";
import { makeFakeForge } from "./helpers/fakeForge.js";

const norms: Norms = {
  confidenceThreshold: 0.7,
  maxFindings: 25,
  exclude: [],
  categories: { security: true, bug: true, perf: true, style: true, maintainability: true },
  guidelines: "",
  examples: [],
};

const changed = `import { helper } from "./util";
export function doThing() { return helper(); }
`;

const diffs: FileDiff[] = [
  {
    newPath: "src/a.ts",
    oldPath: "src/a.ts",
    diff: "@@ -1,1 +1,2 @@",
    newFile: false,
    deletedFile: false,
  },
];

describe("buildContext", () => {
  it("gathers changed file + import + caller + test, tagged by reason", async () => {
    const gl = makeFakeForge({
      files: {
        "src/a.ts": changed,
        "src/util.ts": "export const helper = () => 1;", // resolved import of "./util"
        "src/caller.ts": "import { doThing } from './a';", // found via searchBlobs
        "src/a.test.ts": "// tests", // test candidate
      },
      blobs: { doThing: [{ path: "src/caller.ts" }] },
    });

    const bundle = await buildContext(gl, "o/r", "head", diffs, norms);
    const byPath = Object.fromEntries(bundle.files.map((f) => [f.path, f.reason]));
    expect(byPath["src/a.ts"]).toBe("changed");
    expect(byPath["src/util.ts"]).toBe("import");
    expect(byPath["src/caller.ts"]).toBe("caller");
    expect(byPath["src/a.test.ts"]).toBe("test");
    // changed ranks first
    expect(bundle.files[0].reason).toBe("changed");
  });

  it("notes a missing test file for source without one", async () => {
    const gl = makeFakeForge({ files: { "src/b.ts": "export const x = 1;" } });
    const d: FileDiff[] = [
      { newPath: "src/b.ts", oldPath: "src/b.ts", diff: "", newFile: true, deletedFile: false },
    ];
    const bundle = await buildContext(gl, "o/r", "head", d, norms);
    expect(bundle.notes.some((n) => n.includes("src/b.ts"))).toBe(true);
  });

  it("skips deleted files and files it cannot fetch", async () => {
    const gl = makeFakeForge({ files: {} }); // getFile returns null for everything
    const d: FileDiff[] = [
      { newPath: "gone.ts", oldPath: "gone.ts", diff: "", newFile: false, deletedFile: true },
      {
        newPath: "missing.ts",
        oldPath: "missing.ts",
        diff: "",
        newFile: false,
        deletedFile: false,
      },
    ];
    const bundle = await buildContext(gl, "o/r", "head", d, norms);
    expect(bundle.files).toHaveLength(0);
  });
});
