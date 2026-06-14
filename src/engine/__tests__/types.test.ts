import { describe, expect, it } from "vitest";

import { renderContext } from "../types.js";

describe("renderContext", () => {
  it("renders notes then files with reason headers", () => {
    const out = renderContext({
      notes: ["no test for a.ts"],
      files: [{ path: "src/a.ts", reason: "changed", content: "const a = 1;" }],
    });
    expect(out).toContain("### Context Notes:");
    expect(out).toContain("- no test for a.ts");
    expect(out).toContain("### FILE: src/a.ts (reason: changed)");
    expect(out).toContain("const a = 1;");
  });

  it("omits the notes section when there are none", () => {
    const out = renderContext({ notes: [], files: [] });
    expect(out).not.toContain("### Context Notes:");
  });
});
