import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// shared handles for the mocked forge client + pipeline entrypoints + branches
const wh = vi.hoisted(() => ({
  client: null as any,
  runReview: null as any,
  runPushReview: null as any,
  branches: [] as { name: string; sha: string }[],
}));
vi.mock("../forge.js", async (orig) => ({
  ...(await orig()),
  getForgeClient: vi.fn(async () => wh.client),
}));
vi.mock("../pipeline.js", () => ({
  runReview: (...a: any[]) => wh.runReview(...a),
  runPushReview: (...a: any[]) => wh.runPushReview(...a),
}));
vi.mock("../forgeCommits.js", async (orig) => ({
  ...(await orig()),
  listBranches: vi.fn(async () => wh.branches),
}));

const { watch } = await import("../watch.js");

beforeEach(() => {
  wh.runReview = vi.fn(async () => {});
  wh.runPushReview = vi.fn(async () => {});
  wh.branches = [];
  wh.client = {
    listOpenPrs: vi.fn(async () => [{ iid: 1, headSha: "a" }]),
    close: vi.fn(async () => {}),
  };
});
afterEach(() => vi.clearAllMocks());

describe("watch loop", () => {
  it("baselines existing PRs on the first cycle without reviewing", async () => {
    const ctrl = new AbortController();
    await watch(["github:o/r"], {
      intervalSec: 300,
      signal: ctrl.signal,
      log: (m) => {
        if (m.includes("baseline")) ctrl.abort();
      },
    });
    expect(wh.runReview).not.toHaveBeenCalled();
    expect(wh.client.close).toHaveBeenCalled();
  });

  it("queues a review for a new PR when reviewExisting is set", async () => {
    const ctrl = new AbortController();
    const jobs: any[] = [];
    await watch(["github:o/r"], {
      intervalSec: 300,
      reviewExisting: true,
      signal: ctrl.signal,
      log: () => {},
      onJob: (j) => {
        jobs.push(j);
        ctrl.abort();
      },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ forge: "github", projectId: "o/r", prNumber: 1, headSha: "a" });
    expect(wh.runReview).toHaveBeenCalledTimes(1);
  });

  it("reviews a push to a branch with no open PR, after baselining", async () => {
    let cycle = 0;
    wh.client.listOpenPrs = vi.fn(async () => {
      cycle++;
      return [];
    });
    wh.branches = [{ name: "feat", sha: "s1" }];
    const ctrl = new AbortController();
    const pushJobs: any[] = [];
    await watch(["github:o/r"], {
      intervalSec: 0,
      signal: ctrl.signal,
      log: () => {
        // second cycle: simulate a push to the same branch
        if (cycle === 1) wh.branches = [{ name: "feat", sha: "s2" }];
      },
      onPushJob: (j) => {
        pushJobs.push(j);
        ctrl.abort();
      },
    });
    expect(pushJobs).toHaveLength(1);
    expect(pushJobs[0]).toMatchObject({
      forge: "github", projectId: "o/r", branch: "feat", headSha: "s2", baseSha: "s1",
    });
    expect(wh.runPushReview).toHaveBeenCalledTimes(1);
  });

  it("skips branches whose head matches an open PR head", async () => {
    const ctrl = new AbortController();
    let cycle = 0;
    wh.client.listOpenPrs = vi.fn(async () => {
      cycle++;
      // cycle 2: the PR's source branch gets the PR head sha — must be skipped
      if (cycle === 2) wh.branches = [{ name: "pr-branch", sha: "prsha" }];
      if (cycle >= 4) ctrl.abort();
      return [{ iid: 1, headSha: "prsha" }];
    });
    wh.branches = [{ name: "pr-branch", sha: "old" }];
    await watch(["github:o/r"], {
      intervalSec: 0,
      signal: ctrl.signal,
      log: () => {},
      onPushJob: () => {
        throw new Error("PR-headed branch must not get a push review");
      },
    });
    expect(wh.runPushReview).not.toHaveBeenCalled();
  });

  it("survives a poll error without throwing", async () => {
    wh.client.listOpenPrs = vi.fn(async () => {
      throw new Error("network down");
    });
    const ctrl = new AbortController();
    const errors: string[] = [];
    await watch(["github:o/r"], {
      intervalSec: 300,
      signal: ctrl.signal,
      log: (m) => {
        if (m.includes("poll failed")) {
          errors.push(m);
          ctrl.abort();
        }
      },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(wh.runReview).not.toHaveBeenCalled();
  });
});
