import { describe, expect, it } from "vitest";

import { snapFindings } from "../poster.js";
import type { FileDiff, Finding } from "../types.js";

// hunk +1,4: line1 ctx, line2 added, line3 ctx, line4 added
const patch = ["@@ -1,3 +1,4 @@", " context1", "+added2", " context3", "+added4"].join("\n");
const diffs: FileDiff[] = [
  { newPath: "a.ts", oldPath: "a.ts", diff: patch, newFile: false, deletedFile: false },
];

const finding = (line: number): Finding => ({
  file: "a.ts",
  line,
  severity: "warning",
  category: "bug",
  confidence: 0.8,
  title: "t",
  comment: "c",
  suggestedCode: "fixed();",
});

describe("snapFindings", () => {
  it("keeps a finding already on an added line (with its suggestedCode)", () => {
    const [f] = snapFindings(diffs, [finding(2)]);
    expect(f.line).toBe(2);
    expect(f.suggestedCode).toBe("fixed();");
  });

  it("snaps a drifted line onto the nearest visible line and drops suggestedCode", () => {
    const [f] = snapFindings(diffs, [finding(7)]); // nearest visible is 4 (dist 3 ≤ 10)
    expect(f.line).toBe(4);
    expect(f.suggestedCode).toBeUndefined();
  });

  it("drops suggestedCode when snapping onto a context (non-added) line", () => {
    const [f] = snapFindings(diffs, [finding(3)]); // line 3 is visible context, not added
    expect(f.line).toBe(3);
    expect(f.suggestedCode).toBeUndefined();
  });

  it("leaves a finding untouched when nothing is within SNAP_TOLERANCE", () => {
    const [f] = snapFindings(diffs, [finding(50)]);
    expect(f.line).toBe(50);
    expect(f.suggestedCode).toBe("fixed();");
  });

  it("leaves a finding for a file with no diff untouched", () => {
    const f = finding(2);
    const [out] = snapFindings(diffs, [{ ...f, file: "other.ts" }]);
    expect(out.line).toBe(2);
    expect(out.suggestedCode).toBe("fixed();");
  });
});
