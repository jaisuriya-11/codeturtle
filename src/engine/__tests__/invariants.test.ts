/** Locks the seven HARD INVARIANTS from AGENTS.md. Each test imports the REAL
 * engine code so a future change that violates a principle fails here, loudly.
 * If you change one of these on purpose, update the matching invariant in
 * AGENTS.md and this test together. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadCredentials,
  normsDir,
  resetAll,
  resolveToken,
  setForge,
  updateConfig,
} from "../config.js";
import { loadNorms } from "../norms.js";
import { finalize } from "../poster.js";
import { acquireLock, isLatest, recordLatest, releaseLock } from "../state.js";
import type { DiffRefs, Finding, MrInfo, ReviewResult } from "../types.js";
import { makeFakeForge } from "./helpers/fakeForge.js";

const HOME = process.env.CODETURTLE_HOME as string;

// ── mocks for the two I/O-bound invariants (#5 MCP, #6 reviewer) ──────────────
const mcp = vi.hoisted(() => ({ calls: [] as { name: string; args: any }[] }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}
    async close() {}
    async callTool(req: any) {
      mcp.calls.push({ name: req.name, args: req.arguments });
      return { content: [{ text: "{}" }], isError: false };
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));
const rev = vi.hoisted(() => ({ content: "{}" }));
vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: { create: async () => ({ choices: [{ message: { content: rev.content } }] }) },
    };
  },
}));

beforeEach(() => resetAll());
afterEach(() => {
  for (const k of ["GITHUB_TOKEN", "REVIEWER_API_KEY"]) delete process.env[k];
  mcp.calls.length = 0;
  vi.unstubAllGlobals();
  rmSync(normsDir(), { recursive: true, force: true });
  resetAll();
});

const refs: DiffRefs = { head_sha: "h", base_sha: "b", start_sha: "s" };
const mr: MrInfo = { sourceBranch: "f", targetBranch: "main", headSha: "h", diffRefs: refs };
const finding = (file: string, line: number): Finding => ({
  file,
  line,
  severity: "warning",
  category: "bug",
  confidence: 0.9,
  title: "t",
  comment: "c",
});

describe("Invariant 1 — markers are the idempotency system (±3 line tolerance)", () => {
  it("does not re-post a finding already present within 3 lines, posts genuinely new ones", async () => {
    const gl = makeFakeForge({ notes: [{ id: 1, body: "<!-- ct:f:a.ts:5 -->\nold comment" }] });
    const kept = [finding("a.ts", 7), finding("a.ts", 20)]; // 7≈5 (dup), 20 is new
    const result: ReviewResult = { findings: kept, summary: "s" };
    await finalize(gl, "o/r", 1, refs, result, kept, 99);
    expect(gl.inline).toHaveLength(1);
    expect(gl.inline[0]).toMatchObject({ filePath: "a.ts", newLine: 20 });
  });
});

describe("Invariant 2 — repo config is untrusted (strip agent/key_ref)", () => {
  it("never lets .codeturtle.yml inject agent, key_ref, or any arbitrary key", async () => {
    const gl = makeFakeForge({
      files: {
        ".codeturtle.yml":
          "confidence_threshold: 0.8\nagent: https://evil\nkey_ref: STEAL_ME\nevil_key: pwned",
      },
    });
    const norms = await loadNorms(gl, "o/r", mr);
    expect(norms.confidenceThreshold).toBe(0.8); // legit field still applied
    // loadNorms must return a CLOSED shape — no repo-controlled key may leak in,
    // which guards against a future `return {...repoCfg}` style refactor too.
    expect("agent" in norms).toBe(false);
    expect("key_ref" in norms).toBe(false);
    expect("evil_key" in norms).toBe(false);
  });

  it("a repo `extends` can reference packs by name only — never path-escape the norms dir", async () => {
    // a real, installed pack proves extends works; the traversal entry must be ignored.
    mkdirSync(normsDir(), { recursive: true });
    writeFileSync(join(normsDir(), "ok.yml"), "name: ok\nmax_findings: 3");
    const gl = makeFakeForge({
      files: { ".codeturtle.yml": "extends: ['ok', '../../etc/evil', 'a/b']" },
    });
    const norms = await loadNorms(gl, "o/r", mr);
    expect(norms.maxFindings).toBe(3); // the safe-named pack applied; traversal entries no-op'd
  });

  it("a repo can NEVER trigger a code transform — only the global config can", async () => {
    // drop a transform that would mutate norms if it ran, and have the REPO try to use it.
    mkdirSync(normsDir(), { recursive: true });
    writeFileSync(
      join(normsDir(), "evil.mjs"),
      "export default { name: 'evil', transform: (n) => { n.maxFindings = 9999; return n; } }",
    );
    const repoTriggers = makeFakeForge({ files: { ".codeturtle.yml": "extends: [evil]" } });
    expect((await loadNorms(repoTriggers, "o/r", mr)).maxFindings).not.toBe(9999);

    // sanity: the SAME transform DOES run when the global config activates it — proving the
    // guard is what blocks the repo path, not a broken/ignored transform.
    updateConfig("norms", { use: ["evil"] });
    const glGlobal = makeFakeForge({ files: {} });
    expect((await loadNorms(glGlobal, "o/r", mr)).maxFindings).toBe(9999);
  });
});

describe("Invariant 3 — secrets stay in ~/.codeturtle, env tokens never written", () => {
  it("persists tokens only under CODETURTLE_HOME", () => {
    setForge("github", { token: "secret" });
    expect(existsSync(join(HOME, "credentials.json"))).toBe(true);
  });
  it("does not write an env-provided token to disk", () => {
    process.env.GITHUB_TOKEN = "env-only";
    expect(resolveToken("github")).toBe("env-only");
    expect(loadCredentials().github).toBeUndefined(); // not persisted
  });
});

describe("Invariant 4 — credentials.json shape is an additive contract", () => {
  it("merge-writes preserve unknown/extra fields", () => {
    // simulate a future field written by a newer version
    writeFileSync(
      join(HOME, "credentials.json"),
      JSON.stringify({ github: { token: "t", future_field: "keep" } }),
    );
    setForge("github", { user: "u" });
    const raw = JSON.parse(readFileSync(join(HOME, "credentials.json"), "utf8"));
    expect(raw.github.future_field).toBe("keep");
    expect(raw.github).toMatchObject({ token: "t", user: "u" });
  });
});

describe("Invariant 5 — GitHub MCP posts exactly ONE review (pending-review flow)", () => {
  it("creates one pending review, adds N inline comments, submits once", async () => {
    setForge("github", { token: "ghp_x", method: "pat", backend: "mcp" });
    const { GitHubMcpClient } = await import("../forgeMcp.js");
    const c = new GitHubMcpClient();
    await c.postInlineNote("o/r", 1, "a.ts", 5, "b1", refs);
    await c.postInlineNote("o/r", 1, "a.ts", 9, "b2", refs);
    await c.submitReview("o/r", 1, "summary");

    const creates = mcp.calls.filter(
      (x) => x.name === "pull_request_review_write" && x.args.method === "create",
    );
    const adds = mcp.calls.filter((x) => x.name === "add_comment_to_pending_review");
    const submits = mcp.calls.filter(
      (x) => x.name === "pull_request_review_write" && x.args.method === "submit_pending",
    );
    expect(creates).toHaveLength(1);
    expect(adds).toHaveLength(2);
    expect(submits).toHaveLength(1);
  });
});

describe("Invariant 6 — reviewer output is hostile input (drop invalid findings)", () => {
  it("silently drops malformed findings", async () => {
    process.env.REVIEWER_API_KEY = "k";
    rev.content = JSON.stringify({
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
        { file: "b.ts", line: 1, severity: "nope", category: "bug", confidence: 0.5 }, // bad enum → dropped
      ],
      summary: "s",
    });
    const { review } = await import("../reviewer.js");
    const r = await review(
      "diff",
      { files: [], notes: [] },
      {
        confidenceThreshold: 0,
        maxFindings: 25,
        exclude: [],
        categories: { security: true, bug: true, perf: true, style: true, maintainability: true },
        guidelines: "",
        examples: [],
      },
    );
    expect(r.findings).toHaveLength(1);
  });
});

describe("Invariant 7 — one review at a time per PR (lock + supersede)", () => {
  it("a lock blocks a concurrent review and a newer head sha supersedes", () => {
    expect(acquireLock("o/r", 7)).toBe(true);
    expect(acquireLock("o/r", 7)).toBe(false); // already locked
    releaseLock("o/r", 7);

    recordLatest("o/r", 7, "sha-new");
    expect(isLatest("o/r", 7, "sha-old")).toBe(false); // superseded
    expect(isLatest("o/r", 7, "sha-new")).toBe(true);
  });
});
