import { afterEach, describe, expect, it, vi } from "vitest";

import { makeFakeForge } from "./helpers/fakeForge.js";

// share a configurable fake forge into the (hoisted) module mock
const hf = vi.hoisted(() => ({ fake: null as any }));
vi.mock("../forge.js", async (orig) => ({
  ...(await orig()),
  getForgeClient: vi.fn(async () => hf.fake),
}));

const { parseCommentToFinding, fetchPRReview, fetchCodeSnippet, fetchOpenPrs } = await import("../viewer.js");

afterEach(() => {
  hf.fake = null;
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
