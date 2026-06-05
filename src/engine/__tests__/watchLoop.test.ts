import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// shared handles for the mocked forge client + pipeline.runReview
const wh = vi.hoisted(() => ({ client: null as any, runReview: null as any }));
vi.mock("../forge.js", async (orig) => ({
  ...(await orig()),
  getForgeClient: vi.fn(async () => wh.client),
}));
vi.mock("../pipeline.js", () => ({ runReview: (...a: any[]) => wh.runReview(...a) }));

const { watch } = await import("../watch.js");

beforeEach(() => {
  wh.runReview = vi.fn(async () => {});
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
