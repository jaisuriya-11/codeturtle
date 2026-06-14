import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAll, setForge } from "../config.js";
import type { DiffRefs } from "../types.js";
import { installFetch } from "./helpers/fetchMock.js";

const refs: DiffRefs = { head_sha: "h", base_sha: "b", start_sha: "b" };

// configurable MCP tool handler + a record of calls
const mh = vi.hoisted(() => ({
  handler: (_name: string, _args: any) => ({ text: "{}", content: null as any, isError: false }),
  calls: [] as { name: string; args: any }[],
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}
    async close() {}
    async callTool(req: any) {
      mh.calls.push({ name: req.name, args: req.arguments });
      const r = mh.handler(req.name, req.arguments);
      return { content: r.content ?? [{ text: r.text ?? "{}" }], isError: !!r.isError };
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));

const { GitHubMcpClient } = await import("../forgeMcp.js");

beforeEach(() => {
  resetAll();
  setForge("github", { token: "ghp_x" });
  mh.calls.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetAll();
});

describe("GitHubMcpClient", () => {
  it("getMr maps the pull_request_read response", async () => {
    mh.handler = (name, args) =>
      name === "pull_request_read" && args.method === "get"
        ? {
            text: JSON.stringify({
              head: { ref: "f", sha: "hs" },
              base: { ref: "main", sha: "bs" },
            }),
            content: null,
            isError: false,
          }
        : { text: "{}", content: null, isError: false };
    expect(await new GitHubMcpClient().getMr("o/r", 1)).toEqual({
      sourceBranch: "f",
      targetBranch: "main",
      headSha: "hs",
      diffRefs: { head_sha: "hs", base_sha: "bs", start_sha: "bs" },
    });
  });

  it("getDiffs maps the files array", async () => {
    mh.handler = () => ({
      text: JSON.stringify([{ filename: "a.ts", patch: "@@", status: "added" }]),
      content: null,
      isError: false,
    });
    const d = await new GitHubMcpClient().getDiffs("o/r", 1);
    expect(d[0]).toMatchObject({ newPath: "a.ts", newFile: true });
  });

  it("getDiffs accepts a legit empty files list", async () => {
    mh.handler = () => ({ text: JSON.stringify({ files: [] }), content: null, isError: false });
    expect(await new GitHubMcpClient().getDiffs("o/r", 1)).toEqual([]);
  });

  it("getDiffs throws on an unexpected response shape instead of reading it as empty", async () => {
    mh.handler = () => ({ text: "rate limit exceeded", content: null, isError: false });
    await expect(new GitHubMcpClient().getDiffs("o/r", 1)).rejects.toThrow("unexpected shape");
  });

  it("getFile reads the embedded resource text", async () => {
    mh.handler = () => ({
      text: "",
      content: [{ resource: { text: "file body" } }],
      isError: false,
    });
    expect(await new GitHubMcpClient().getFile("o/r", "a.ts", "sha")).toBe("file body");
  });

  it("getFile returns null on error", async () => {
    mh.handler = () => ({ text: "nope", content: null, isError: true });
    expect(await new GitHubMcpClient().getFile("o/r", "a.ts", "sha")).toBeNull();
  });

  it("searchBlobs maps items (soft)", async () => {
    mh.handler = () => ({
      text: JSON.stringify({ items: [{ path: "a.ts" }] }),
      content: null,
      isError: false,
    });
    expect(await new GitHubMcpClient().searchBlobs("o/r", "sym")).toEqual([{ path: "a.ts" }]);
  });

  it("listNotes goes through REST and merges issue + review comments", async () => {
    installFetch((url) =>
      url.includes("/issues/")
        ? { json: [{ id: 1, body: "c1" }] }
        : { json: [{ id: 2, body: "c2" }] },
    );
    const notes = await new GitHubMcpClient().listNotes("o/r", 1);
    expect(notes.map((n) => n.body)).toEqual(expect.arrayContaining(["c1", "c2"]));
    expect(mh.calls).toHaveLength(0); // no MCP tool involved
  });

  it("postStatus posts a sticky comment via REST, editable on completion", async () => {
    const { calls } = installFetch((url, init) =>
      init?.method === "POST" ? { json: { id: 42 } } : { json: [] },
    );
    const c = new GitHubMcpClient();
    const id = await c.postStatus("o/r", 1, "reviewing…");
    expect(id).toBe(42);
    await c.editNote("o/r", 1, id, "done");
    const patch = calls.find((x) => x.init?.method === "PATCH");
    expect(patch?.url).toContain("/issues/comments/42");
    expect(mh.calls).toHaveLength(0);
  });

  it("reuses a leftover pending review instead of dropping inline comments", async () => {
    mh.handler = (name, args) => {
      if (name === "pull_request_review_write" && args.method === "create") {
        return { text: "a pending review already exists", content: null, isError: true };
      }
      if (name === "pull_request_read" && args.method === "get_reviews") {
        return {
          text: JSON.stringify([{ id: 9, state: "PENDING" }]),
          content: null,
          isError: false,
        };
      }
      return { text: "{}", content: null, isError: false };
    };
    const ok = await new GitHubMcpClient().postInlineNote("o/r", 1, "a.ts", 5, "b", refs);
    expect(ok).toBe(true);
    expect(mh.calls.some((x) => x.name === "add_comment_to_pending_review")).toBe(true);
  });

  it("addLabels merges with existing labels", async () => {
    mh.handler = (name) =>
      name === "issue_read"
        ? {
            text: JSON.stringify({ labels: [{ name: "existing" }] }),
            content: null,
            isError: false,
          }
        : { text: "{}", content: null, isError: false };
    await new GitHubMcpClient().addLabels("o/r", 1, ["code-turtle/critical"]);
    const write = mh.calls.find((c) => c.name === "issue_write");
    expect(write?.args.labels).toEqual(
      expect.arrayContaining(["existing", "code-turtle/critical"]),
    );
  });

  it("submitReview with no pending review creates one when none has the marker", async () => {
    mh.handler = (name, args) => {
      if (name === "pull_request_read" && args.method === "get_reviews") {
        return { text: "[]", content: null, isError: false };
      }
      return { text: "{}", content: null, isError: false }; // create
    };
    expect(await new GitHubMcpClient().submitReview("o/r", 1, "summary")).toBe(true);
    expect(
      mh.calls.some((c) => c.name === "pull_request_review_write" && c.args.method === "create"),
    ).toBe(true);
  });

  it("listOpenPrs maps open pull requests", async () => {
    mh.handler = () => ({
      text: JSON.stringify([{ number: 5, head: { sha: "s5" }, state: "open" }]),
      content: null,
      isError: false,
    });
    expect(await new GitHubMcpClient().listOpenPrs("o/r")).toEqual([{ iid: 5, headSha: "s5" }]);
  });
});
