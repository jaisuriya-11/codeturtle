import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireLock, recordLatest, releaseLock } from "../state.js";
import type { FileDiff } from "../types.js";
import { makeFakeForge, type FakeForge } from "./helpers/fakeForge.js";

// shared fake forge + mocked engine deps
const ph = vi.hoisted(() => ({ fake: null as any }));
vi.mock("../forge.js", async (orig) => ({
  ...(await orig()),
  getForgeClient: vi.fn(async () => ph.fake),
}));
vi.mock("../bundler.js", () => ({ buildContext: vi.fn(async () => ({ files: [], notes: [] })) }));
vi.mock("../reviewer.js", () => ({ review: vi.fn() }));

const { runReview } = await import("../pipeline.js");
const { getForgeClient } = await import("../forge.js");
const { review } = await import("../reviewer.js");

const diff: FileDiff = {
  newPath: "a.ts",
  oldPath: "a.ts",
  diff: "@@ -1,1 +1,2 @@\n ctx\n+added\n",
  newFile: false,
  deletedFile: false,
};

let pid = 0;
const job = (over: Partial<{ projectId: string; headSha: string }> = {}) => ({
  forge: "github" as const,
  projectId: over.projectId ?? `o/r-${pid}`,
  prNumber: 1,
  headSha: over.headSha ?? "h",
});

beforeEach(() => {
  pid++;
  vi.mocked(getForgeClient).mockClear();
  vi.mocked(review).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("runReview", () => {
  it("runs end-to-end and posts findings + a summary review", async () => {
    const fake: FakeForge = makeFakeForge({ diffs: [diff] });
    ph.fake = fake;
    vi.mocked(review).mockResolvedValue({
      findings: [
        {
          file: "a.ts",
          line: 2,
          severity: "warning",
          category: "bug",
          confidence: 0.9,
          title: "t",
          comment: "c",
        },
      ],
      summary: "looks risky",
    });

    await runReview(job());
    expect(fake.inline).toHaveLength(1);
    expect(fake.inline[0]).toMatchObject({ filePath: "a.ts", newLine: 2 });
    expect(fake.submitted).toHaveLength(1);
    expect(fake.labels.length).toBeGreaterThan(0);
  });

  it("skips a superseded head sha before opening a forge client", async () => {
    const j = job();
    recordLatest(j.projectId, j.prNumber, "newer-sha"); // newer than j.headSha
    await runReview(j);
    expect(getForgeClient).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it("force re-reviews past a held lock and a superseded head sha", async () => {
    const j = job();
    ph.fake = makeFakeForge({ diffs: [diff] });
    vi.mocked(review).mockResolvedValue({ findings: [], summary: "ok" });
    recordLatest(j.projectId, j.prNumber, "newer-sha"); // j.headSha is now superseded
    expect(acquireLock(j.projectId, j.prNumber)).toBe(true); // lock is held

    // without force: both guards skip it before the forge client opens
    await runReview(j);
    expect(review).not.toHaveBeenCalled();

    // with force: ignores supersede + steals the lock, runs end-to-end
    const logs: string[] = [];
    await runReview(j, (m) => logs.push(m), { force: true });
    expect(review).toHaveBeenCalledTimes(1);
    expect(logs.some((m) => m.includes("forcing re-review"))).toBe(true);
    releaseLock(j.projectId, j.prNumber);
  });

  it("reports nothing to review when there are no diffs", async () => {
    ph.fake = makeFakeForge({ diffs: [] });
    const logs: string[] = [];
    await runReview(job(), (m) => logs.push(m));
    expect(review).not.toHaveBeenCalled();
    // terminal log line — the TUI uses it to clear the "reviewing…" status
    expect(logs.some((m) => /pr=1 nothing to review/.test(m))).toBe(true);
  });

  it("releases the lock when the forge client can't even be constructed", async () => {
    const j = job();
    vi.mocked(getForgeClient).mockRejectedValueOnce(new Error("token refresh failed"));
    const logs: string[] = [];
    await runReview(j, (m) => logs.push(m));
    expect(
      logs.some((m) => m.includes("review failed") && m.includes("token refresh failed")),
    ).toBe(true);
    // lock must be free again — a second run reaches the forge stage
    ph.fake = makeFakeForge({ diffs: [] });
    const logs2: string[] = [];
    await runReview(j, (m) => logs2.push(m));
    expect(logs2.some((m) => m.includes("nothing to review"))).toBe(true);
    expect(logs2.some((m) => m.includes("already locked"))).toBe(false);
  });

  it("drops findings below the confidence threshold", async () => {
    const fake = makeFakeForge({ diffs: [diff] });
    ph.fake = fake;
    vi.mocked(review).mockResolvedValue({
      findings: [
        {
          file: "a.ts",
          line: 2,
          severity: "info",
          category: "style",
          confidence: 0.1,
          title: "t",
          comment: "c",
        },
      ],
      summary: "ok",
    });
    await runReview(job());
    expect(fake.inline).toHaveLength(0); // below default threshold 0.7
    expect(fake.labels).toContain("code-turtle/clean");
  });
});
