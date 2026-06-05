import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextBundle, Norms } from "../types.js";

// hoisted so the (hoisted) vi.mock factory can reach it
const h = vi.hoisted(() => ({ content: "{}" }));

vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: vi.fn(async () => ({ choices: [{ message: { content: h.content } }] })),
      },
    };
  },
}));

// imported after the mock is registered
const { review } = await import("../reviewer.js");

const ctx: ContextBundle = { files: [], notes: [] };
const norms: Norms = {
  confidenceThreshold: 0.7, maxFindings: 25, exclude: [],
  categories: { security: true, bug: true, perf: true, style: true, maintainability: true },
  guidelines: "", examples: [],
};

beforeEach(() => {
  process.env.REVIEWER_API_KEY = "k"; // so review() doesn't bail on missing key
});
afterEach(() => {
  delete process.env.REVIEWER_API_KEY;
});

describe("review (hostile reviewer output)", () => {
  it("drops invalid findings and coerces word-confidence", async () => {
    h.content = JSON.stringify({
      findings: [
        { file: "a.ts", line: 5, severity: "critical", category: "bug", confidence: 0.8, title: "t", comment: "c" },
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

  it("parses JSON wrapped in markdown fences", async () => {
    h.content = "```json\n" + JSON.stringify({ findings: [], summary: "fenced" }) + "\n```";
    const r = await review("diff", ctx, norms);
    expect(r.summary).toBe("fenced");
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
