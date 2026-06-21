import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextBundle, Norms } from "../types.js";

// hoisted so the (hoisted) vi.mock factory can reach it. queue serves per-call
// responses (multi-pass tests); errors throws status codes first (retry tests);
// when both are empty, every call gets `content`.
const h = vi.hoisted(() => ({
  content: "{}",
  queue: [] as string[],
  errors: [] as number[],
  calls: 0,
  noChoices: false, // emulate compat servers that return a 200 body without `choices`
}));

vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: vi.fn(async () => {
          h.calls++;
          if (h.errors.length) {
            const status = h.errors.shift()!;
            throw Object.assign(new Error(`${status} status code`), { status });
          }
          if (h.noChoices) return { error: { message: "rate-limited" } };
          const c = h.queue.length ? h.queue.shift()! : h.content;
          return { choices: [{ message: { content: c } }] };
        }),
      },
    };
  },
}));

// imported after the mock is registered
const { review, describeModelError } = await import("../reviewer.js");

const ctx: ContextBundle = { files: [], notes: [] };
const norms: Norms = {
  confidenceThreshold: 0.7,
  maxFindings: 25,
  exclude: [],
  categories: { security: true, bug: true, perf: true, style: true, maintainability: true },
  guidelines: "",
  examples: [],
};

beforeEach(() => {
  process.env.REVIEWER_API_KEY = "k"; // so review() doesn't bail on missing key
  process.env.REVIEWER_RETRY_BASE_MS = "1"; // keep retry tests instant
  h.queue = [];
  h.errors = [];
  h.calls = 0;
  h.noChoices = false;
});
afterEach(() => {
  delete process.env.REVIEWER_API_KEY;
  delete process.env.REVIEWER_PASSES;
  delete process.env.REVIEWER_RETRY_BASE_MS;
});

describe("review (hostile reviewer output)", () => {
  it("drops invalid findings and coerces word-confidence", async () => {
    h.content = JSON.stringify({
      findings: [
        {
          file: "a.ts",
          line: 5,
          severity: "critical",
          category: "bug",
          confidence: 0.8,
          title: "t",
          comment: "c",
        },
        { line: 3, severity: "warning", category: "bug", confidence: 0.5 }, // no file → dropped
        { file: "b.ts", line: 2, severity: "BOGUS", category: "bug", confidence: 0.5 }, // bad severity → dropped
        { file: "c.ts", line: 1, severity: "info", category: "style", confidence: "high" }, // word → 0.9
      ],
      summary: "ok",
    });
    const r = await review("diff", ctx, norms);
    expect(r.findings).toHaveLength(2);
    expect(r.summary).toBe("ok");
    const cFile = r.findings.find((f) => f.file === "c.ts");
    expect(cFile?.confidence).toBeCloseTo(0.9);
  });

  it("drops a finding whose evidence is not in the diff (hallucination gate)", async () => {
    const base = {
      line: 5,
      severity: "critical",
      category: "bug",
      confidence: 0.9,
      title: "t",
      comment: "c",
    };
    h.content = JSON.stringify({
      findings: [
        { ...base, file: "real.ts", evidence: "if (x.isAfter(now))" },
        { ...base, file: "fake.ts", evidence: "if (x.isBefore(now))" }, // model invented this line
        { ...base, file: "noev.ts" }, // no evidence → kept (weak models omit it)
      ],
      summary: "ok",
    });
    const diff = "@@ -1,1 +1,1 @@\n+        if (x.isAfter(now)) {\n";
    const r = await review(diff, ctx, norms);
    expect(r.findings.map((f) => f.file)).toEqual(["real.ts", "noev.ts"]);
  });

  it("matches evidence whitespace-insensitively", async () => {
    h.content = JSON.stringify({
      findings: [
        {
          file: "a.ts",
          line: 1,
          severity: "info",
          category: "style",
          confidence: 0.8,
          title: "t",
          comment: "c",
          evidence: "const  x=1;",
        },
      ],
      summary: "ok",
    });
    const r = await review("@@ -0,0 +1,1 @@\n+const x = 1;\n", ctx, norms);
    expect(r.findings).toHaveLength(1);
  });

  it("unions findings across passes and dedups repeats (passes=3)", async () => {
    process.env.REVIEWER_PASSES = "3";
    const f = (file: string, line: number, category: string, confidence: number) => ({
      file,
      line,
      category,
      confidence,
      severity: "critical",
      title: "t",
      comment: "c",
    });
    h.queue = [
      JSON.stringify({ findings: [f("a.ts", 5, "security", 0.7)], summary: "general view" }),
      // security pass re-finds a.ts:6 (±3 dup, higher confidence) + a new one
      JSON.stringify({
        findings: [f("a.ts", 6, "security", 0.95), f("b.ts", 9, "security", 0.9)],
        summary: "x",
      }),
      JSON.stringify({ findings: [f("c.ts", 1, "bug", 0.8)], summary: "y" }),
    ];
    const r = await review("diff", ctx, norms);
    expect(h.calls).toBe(3);
    expect(r.summary).toBe("general view"); // summary comes from the general pass
    expect(r.findings).toHaveLength(3);
    const aDup = r.findings.find((x) => x.file === "a.ts");
    expect(aDup?.confidence).toBeCloseTo(0.95); // higher-confidence copy wins
  });

  it("runs a single call when passes=1 (default)", async () => {
    h.content = JSON.stringify({ findings: [], summary: "ok" });
    await review("diff", ctx, norms);
    expect(h.calls).toBe(1);
  });

  it("retries rate limits (429) with backoff and succeeds", async () => {
    h.errors = [429, 429];
    h.content = JSON.stringify({ findings: [], summary: "after retries" });
    const r = await review("diff", ctx, norms);
    expect(r.summary).toBe("after retries");
    expect(h.calls).toBe(3);
  });

  it("gives up after exhausting retries on a persistent 429", async () => {
    h.errors = [429, 429, 429];
    await expect(review("diff", ctx, norms)).rejects.toThrow("429");
  });

  it("surfaces an actionable message when the model errors out", async () => {
    h.errors = [429, 429, 429];
    await expect(review("diff", ctx, norms)).rejects.toThrow(/quota|rate limit/i);
  });

  it("strips response_format only on a 400-style rejection", async () => {
    h.errors = [400]; // first call (with response_format) rejected
    h.content = JSON.stringify({ findings: [], summary: "fallback ok" });
    const r = await review("diff", ctx, norms);
    expect(r.summary).toBe("fallback ok");
    expect(h.calls).toBe(2);
  });

  it("parses JSON wrapped in markdown fences", async () => {
    h.content = "```json\n" + JSON.stringify({ findings: [], summary: "fenced" }) + "\n```";
    const r = await review("diff", ctx, norms);
    expect(r.summary).toBe("fenced");
  });

  it("returns an empty result when the response body has no choices array", async () => {
    h.noChoices = true; // OpenRouter free tier returns a 200 error body without `choices`
    const r = await review("diff", ctx, norms);
    expect(r.findings).toEqual([]);
    expect(r.summary).toBe("");
  });

  it("returns an empty result for non-JSON output", async () => {
    h.content = "I am not JSON at all";
    const r = await review("diff", ctx, norms);
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatch(/could not be parsed/i);
  });

  it("throws when no API key is configured for a non-local endpoint", async () => {
    delete process.env.REVIEWER_API_KEY; // default base url is the Gemini cloud endpoint
    await expect(review("diff", ctx, norms)).rejects.toThrow(/API key/i);
  });
});

describe("describeModelError", () => {
  it("includes model, status, provider detail, and a hint", () => {
    const e = Object.assign(new Error("429 status code (no body)"), {
      status: 429,
      error: { message: "You exceeded your current quota" },
    });
    const out = describeModelError(e, "gemini-2.5-pro");
    expect(out.message).toContain("gemini-2.5-pro");
    expect(out.message).toContain("429");
    expect(out.message).toContain("exceeded your current quota");
    expect(out.message).toMatch(/billing|quota/);
    expect((out as { status?: number }).status).toBe(429); // callers still branch on .status
  });

  it("falls back to a generic hint for 5xx and passes through non-API errors", () => {
    const e = Object.assign(new Error("500 status code (no body)"), { status: 500 });
    expect(describeModelError(e, "m").message).toMatch(/server error/);
    const plain = new Error("boom");
    expect(describeModelError(plain, "m")).toBe(plain);
  });
});
