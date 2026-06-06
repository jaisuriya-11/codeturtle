import { afterEach, describe, expect, it, vi } from "vitest";

import { makeFakeForge } from "./helpers/fakeForge.js";
import { installFetch } from "./helpers/fetchMock.js";

// share a configurable fake forge into the (hoisted) module mock
const hf = vi.hoisted(() => ({ fake: null as any }));
vi.mock("../forge.js", async (orig) => ({
  ...(await orig()),
  getForgeClient: vi.fn(async () => hf.fake),
}));

const { parseCommentToFinding, fetchPRReview, fetchCodeSnippet, fetchOpenPrs, fetchPrList, listRepos, mapGithubPr, mapGitlabMr } =
  await import("../viewer.js");

afterEach(() => {
  hf.fake = null;
  vi.unstubAllGlobals();
});

const findingBody = [
  "<!-- ct:f:src/a.ts:5 -->",
  "🛑 **Null deref** · `bug` · confidence 0.90",
  "",
  "This can throw when x is null.",
  "",
  "```suggestion",
  "if (x) return x.y;",
  "```",
  "",
  "---",
  "_🐢 Gemini review_",
].join("\n");

describe("parseCommentToFinding", () => {
  it("parses a posted inline finding back into structured data", () => {
    const f = parseCommentToFinding(findingBody);
    expect(f).toMatchObject({
      file: "src/a.ts",
      line: 5,
      severity: "critical",
      category: "bug",
      confidence: 0.9,
      title: "Null deref",
      suggestedCode: "if (x) return x.y;",
    });
    expect(f?.comment).toContain("This can throw");
    expect(f?.comment).not.toContain("```suggestion");
  });

  it("returns null when there is no finding marker", () => {
    expect(parseCommentToFinding("just a normal comment")).toBeNull();
  });
});

describe("fetchPRReview", () => {
  it("collects findings and the summary from PR notes", async () => {
    hf.fake = makeFakeForge({
      notes: [
        { id: 1, body: findingBody },
        { id: 2, body: "<!-- ct:review -->\n## Summary\nlooks good overall" },
      ],
    });
    const data = await fetchPRReview("github", "o/r", 1);
    expect(data.findings).toHaveLength(1);
    expect(data.summary).toContain("looks good overall");
  });
});

describe("fetchCodeSnippet", () => {
  it("returns a window of lines around the target line", async () => {
    const content = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n");
    hf.fake = makeFakeForge({ files: { "src/a.ts": content } });
    const snip = await fetchCodeSnippet("github", "o/r", 1, "src/a.ts", 6);
    expect(snip).not.toBeNull();
    expect(snip!.startLine).toBe(1);
    expect(snip!.lines.length).toBe(11);
  });

  it("returns null when the file cannot be fetched", async () => {
    hf.fake = makeFakeForge({ files: {} });
    expect(await fetchCodeSnippet("github", "o/r", 1, "missing.ts", 3)).toBeNull();
  });
});

describe("fetchOpenPrs", () => {
  it("maps the forge's open PRs to iids", async () => {
    hf.fake = makeFakeForge();
    hf.fake.listOpenPrs = vi.fn(async () => [{ iid: 3, headSha: "x" }, { iid: 4, headSha: "y" }]);
    expect(await fetchOpenPrs("github", "o/r")).toEqual([{ iid: 3 }, { iid: 4 }]);
  });
});

describe("PR summary mappers", () => {
  it("maps a GitHub PR", () => {
    expect(
      mapGithubPr({ number: 7, title: "fix", state: "open", user: { login: "amy" }, updated_at: "2026-01-02" }),
    ).toEqual({ iid: 7, title: "fix", state: "open", author: "amy", updatedAt: "2026-01-02" });
    expect(mapGithubPr({ number: 8, state: "closed" }).state).toBe("closed");
  });

  it("maps a GitLab MR — merged counts as closed", () => {
    expect(
      mapGitlabMr({ iid: 2, title: "feat", state: "opened", author: { username: "bo" }, updated_at: "2026-01-03" }),
    ).toEqual({ iid: 2, title: "feat", state: "open", author: "bo", updatedAt: "2026-01-03" });
    expect(mapGitlabMr({ iid: 3, state: "merged" }).state).toBe("closed");
  });
});

describe("fetchPrList", () => {
  it("fetches GitHub PRs by state", async () => {
    const { calls } = installFetch((url) =>
      url.includes("/pulls")
        ? { json: [{ number: 1, title: "a", state: "open", user: { login: "u" }, updated_at: "t" }] }
        : { json: {} },
    );
    const prs = await fetchPrList("github", "o/r", "open");
    expect(prs).toEqual([{ iid: 1, title: "a", state: "open", author: "u", updatedAt: "t" }]);
    expect(calls.some((c) => c.url.includes("/repos/o/r/pulls?state=open"))).toBe(true);
  });

  it("fetches both closed and merged GitLab MRs for the closed list", async () => {
    const { calls } = installFetch((url) => {
      if (url.includes("state=closed"))
        return { json: [{ iid: 1, title: "c", state: "closed", updated_at: "2026-01-01" }] };
      if (url.includes("state=merged"))
        return { json: [{ iid: 2, title: "m", state: "merged", updated_at: "2026-01-02" }] };
      return { json: [] };
    });
    const prs = await fetchPrList("gitlab", "g/p", "closed");
    expect(prs.map((p) => p.iid)).toEqual([2, 1]); // newest first
    expect(prs.every((p) => p.state === "closed")).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("throws on a non-ok forge response", async () => {
    installFetch(() => ({ status: 404 }));
    await expect(fetchPrList("github", "o/r", "open")).rejects.toThrow("github list prs 404");
  });
});

describe("listRepos", () => {
  it("lists GitHub repos by full name", async () => {
    installFetch((url) =>
      url.includes("/user/repos") ? { json: [{ full_name: "o/r1" }, { full_name: "o/r2" }] } : { json: [] },
    );
    expect(await listRepos("github")).toEqual(["o/r1", "o/r2"]);
  });

  it("is a soft call — returns [] on failure", async () => {
    installFetch(() => ({ status: 500 }));
    expect(await listRepos("gitlab")).toEqual([]);
  });
});
