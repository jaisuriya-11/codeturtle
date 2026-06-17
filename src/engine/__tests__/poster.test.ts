import { afterEach, describe, expect, it, vi } from "vitest";

import { finalize, finalizeCommit, snapFindings } from "../poster.js";
import type { DiffRefs, FileDiff, Finding, ReviewResult } from "../types.js";
import { makeFakeForge } from "./helpers/fakeForge.js";
import { installFetch } from "./helpers/fetchMock.js";

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

describe("finalize — recheck note", () => {
  const refs: DiffRefs = { head_sha: "sha2", base_sha: "b", start_sha: "b" };
  const clean: ReviewResult = { findings: [], summary: "all good" };
  const oldMarkerNote = { id: 1, body: "<!-- ct:f:a.ts:2 -->\nold finding" };

  it("posts 'no issues found' on a clean re-review", async () => {
    const gl = makeFakeForge({ notes: [oldMarkerNote] });
    const statusId = await gl.postStatus("o/r", 1, "reviewing");
    await finalize(gl, "o/r", 1, refs, clean, [], statusId);
    const note = gl.created.find((b) => b.includes("<!-- ct:recheck:sha2 -->"));
    expect(note).toContain("no issues found");
  });

  it("says earlier findings still apply when everything deduped", async () => {
    const gl = makeFakeForge({ notes: [oldMarkerNote] });
    const statusId = await gl.postStatus("o/r", 1, "reviewing");
    // kept finding sits on the already-posted marker → posted=0
    await finalize(gl, "o/r", 1, refs, clean, [finding(2)], statusId);
    const note = gl.created.find((b) => b.includes("<!-- ct:recheck:sha2 -->"));
    expect(note).toContain("1 earlier finding(s) still apply");
  });

  it("posts the recheck note only once per head commit", async () => {
    const gl = makeFakeForge({
      notes: [oldMarkerNote, { id: 2, body: "<!-- ct:recheck:sha2 -->\nalready said" }],
    });
    const statusId = await gl.postStatus("o/r", 1, "reviewing");
    await finalize(gl, "o/r", 1, refs, clean, [], statusId);
    expect(gl.created.filter((b) => b.includes("ct:recheck"))).toHaveLength(0);
  });

  it("stays quiet on a first review — the summary already covers it", async () => {
    const gl = makeFakeForge();
    const statusId = await gl.postStatus("o/r", 1, "reviewing");
    await finalize(gl, "o/r", 1, refs, clean, [], statusId);
    expect(gl.created.filter((b) => b.includes("ct:recheck"))).toHaveLength(0);
  });
});

describe("finalize — no duplicate summary, exclusive labels", () => {
  const refs: DiffRefs = { head_sha: "sha2", base_sha: "b", start_sha: "b" };
  const result: ReviewResult = { findings: [], summary: "issues found" };
  const oldMarkerNote = { id: 1, body: "<!-- ct:f:a.ts:2 -->\nold finding" };

  it("submits the summary review on a first review", async () => {
    const gl = makeFakeForge();
    const statusId = await gl.postStatus("o/r", 1, "reviewing");
    await finalize(gl, "o/r", 1, refs, result, [finding(2)], statusId);
    expect(gl.submitted).toHaveLength(1);
  });

  it("skips the summary review when a re-review adds nothing new", async () => {
    const gl = makeFakeForge({ notes: [oldMarkerNote] });
    const statusId = await gl.postStatus("o/r", 1, "reviewing");
    // kept finding dedups against the existing marker → posted=0
    await finalize(gl, "o/r", 1, refs, result, [finding(2)], statusId);
    expect(gl.submitted).toHaveLength(0);
    const status = gl.edited.find((e) => e.body.includes("ct:status"));
    expect(status?.body).toContain("earlier review summary still applies");
  });

  it("still submits a summary when a re-review finds something new", async () => {
    const gl = makeFakeForge({ notes: [oldMarkerNote] });
    const statusId = await gl.postStatus("o/r", 1, "reviewing");
    await finalize(gl, "o/r", 1, refs, result, [{ ...finding(2), file: "b.ts" }], statusId);
    expect(gl.submitted).toHaveLength(1);
  });

  it("swaps clean → severity label when findings appear", async () => {
    const gl = makeFakeForge();
    const statusId = await gl.postStatus("o/r", 1, "reviewing");
    await finalize(gl, "o/r", 1, refs, result, [finding(2)], statusId);
    expect(gl.labels).toContain("code-turtle/warning");
    expect(gl.removedLabels).toContain("code-turtle/clean");
    expect(gl.removedLabels).not.toContain("code-turtle/warning");
  });

  it("swaps severity → clean label on a clean review", async () => {
    const gl = makeFakeForge();
    const statusId = await gl.postStatus("o/r", 1, "reviewing");
    await finalize(gl, "o/r", 1, refs, { findings: [], summary: "ok" }, [], statusId);
    expect(gl.labels).toContain("code-turtle/clean");
    expect(gl.removedLabels).toEqual(
      expect.arrayContaining(["code-turtle/critical", "code-turtle/warning", "code-turtle/info"]),
    );
  });

  it("labels by the severity of all kept findings, not just newly posted ones", async () => {
    // existing marker covers the critical finding; only a new warning posts —
    // the label must still say critical
    const gl = makeFakeForge({ notes: [oldMarkerNote] });
    const statusId = await gl.postStatus("o/r", 1, "reviewing");
    const critical: Finding = { ...finding(2), severity: "critical" };
    const newWarning: Finding = { ...finding(2), file: "b.ts" };
    await finalize(gl, "o/r", 1, refs, result, [critical, newWarning], statusId);
    expect(gl.labels).toContain("code-turtle/critical");
  });

  it("does not fail the review when label perms are missing (403)", async () => {
    const gl = makeFakeForge();
    const statusId = await gl.postStatus("o/r", 1, "reviewing");
    // GitHub App without Issues access: addLabels hits issue_read/write → 403
    gl.addLabels = vi.fn(async () => {
      throw new Error("403 Resource not accessible by integration");
    });
    await expect(
      finalize(gl, "o/r", 1, refs, { findings: [], summary: "ok" }, [], statusId),
    ).resolves.toBeUndefined();
    // the summary review still went out despite the label failure
    expect(gl.submitted).toHaveLength(1);
  });
});

describe("finalizeCommit", () => {
  afterEach(() => vi.unstubAllGlobals());
  const result: ReviewResult = { findings: [], summary: "overall fine" };

  it("dedups against existing commit markers (±3) and posts one summary", async () => {
    const { calls } = installFetch((url, init) => {
      if (!init?.method) {
        // existing comments on the commit: a finding near a.ts:2 (within ±3)
        return { json: [{ body: "<!-- ct:f:a.ts:4 -->\nold finding" }] };
      }
      return { json: {} };
    });

    await finalizeCommit("github", "o/r", "feat", "sha1", diffs, result, [
      finding(2),
      { ...finding(2), file: "b.ts" },
    ]);

    const posts = calls.filter((c) => c.init?.method === "POST");
    const bodies = posts.map((p) => JSON.parse(String(p.init?.body)));
    // a.ts:2 deduped (marker a.ts:4 within tolerance) → only b.ts + summary
    expect(posts).toHaveLength(2);
    expect(bodies[0].body).toContain("<!-- ct:f:b.ts:2 -->");
    expect(bodies[1].body).toContain("<!-- ct:review -->");
    expect(bodies[1].body).toContain("push to `feat`");
  });

  it("doesn't repost the summary when the commit already has one", async () => {
    const { calls } = installFetch((url, init) =>
      !init?.method ? { json: [{ body: "<!-- ct:review -->\nseen" }] } : { json: {} },
    );
    await finalizeCommit("github", "o/r", "feat", "sha1", diffs, result, []);
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(0);
  });
});
