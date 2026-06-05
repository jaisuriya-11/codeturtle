import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAll, setForge } from "../config.js";
import { type ForgeClient, GitHubRestClient, GitLabClient } from "../forge.js";
import type { DiffRefs } from "../types.js";
import { installFetch, type FetchHandler } from "./helpers/fetchMock.js";

const refs: DiffRefs = { head_sha: "h", base_sha: "b", start_sha: "s" };
const m = (init?: RequestInit) => (init?.method ?? "GET").toUpperCase();

beforeEach(() => {
  resetAll();
  setForge("github", { token: "ght" });
  setForge("gitlab", { token: "glt" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetAll();
});

describe("GitLabClient (REST)", () => {
  const route: (h: FetchHandler) => void = (h) => installFetch(h);
  const c = (): ForgeClient => new GitLabClient();

  it("getMr maps merge-request fields", async () => {
    route(() => ({ json: { source_branch: "f", target_branch: "main", sha: "sha1", diff_refs: refs } }));
    expect(await c().getMr("g/p", 1)).toEqual({
      sourceBranch: "f", targetBranch: "main", headSha: "sha1", diffRefs: refs,
    });
  });

  it("getMr throws on a non-ok response", async () => {
    route(() => ({ status: 404 }));
    await expect(c().getMr("g/p", 1)).rejects.toThrow(/gitlab get_mr 404/);
  });

  it("getDiffs maps the diff list", async () => {
    route(() => ({ json: [{ new_path: "a.ts", old_path: "a.ts", diff: "@@", new_file: true, deleted_file: false }] }));
    const d = await c().getDiffs("g/p", 1);
    expect(d[0]).toMatchObject({ newPath: "a.ts", newFile: true, deletedFile: false });
  });

  it("getFile returns text when ok and null otherwise", async () => {
    route((url) => (url.includes("/raw") ? { text: "contents" } : { status: 404 }));
    expect(await c().getFile("g/p", "a.ts", "ref")).toBe("contents");
    route(() => ({ status: 404 }));
    expect(await c().getFile("g/p", "a.ts", "ref")).toBeNull();
  });

  it("searchBlobs maps hits and tolerates failure", async () => {
    route(() => ({ json: [{ path: "x.ts" }, { path: "y.ts" }] }));
    expect(await c().searchBlobs("g/p", "sym", "ref")).toEqual([{ path: "x.ts" }, { path: "y.ts" }]);
    route(() => ({ status: 500 }));
    expect(await c().searchBlobs("g/p", "sym", "ref")).toEqual([]);
  });

  it("postStatus creates a note when none carries the marker", async () => {
    route((url, init) => {
      if (url.includes("/notes") && m(init) === "GET") return { json: [] };
      return { json: { id: 7 } }; // POST create
    });
    expect(await c().postStatus("g/p", 1, "hello")).toBe(7);
  });

  it("postStatus edits the existing marker note", async () => {
    route((url, init) => {
      if (url.includes("/notes") && m(init) === "GET") {
        return { json: [{ id: 3, body: "<!-- ct:status -->\nold" }] };
      }
      return { json: {} }; // PUT edit
    });
    expect(await c().postStatus("g/p", 1, "new")).toBe(3);
  });

  it("postInlineNote posts a discussion and reports success", async () => {
    route(() => ({ json: {} }));
    expect(await c().postInlineNote("g/p", 1, "a.ts", 5, "body", refs)).toBe(true);
  });

  it("submitReview is unsupported on GitLab", async () => {
    expect(await c().submitReview("g/p", 1, "x")).toBe(false);
  });

  it("listOpenPrs returns opened MRs", async () => {
    route(() => ({ json: [{ iid: 2, sha: "z", state: "opened" }] }));
    expect(await c().listOpenPrs("g/p")).toEqual([{ iid: 2, headSha: "z" }]);
  });

  it("createNote returns the new note id", async () => {
    route(() => ({ json: { id: 12 } }));
    expect(await c().createNote("g/p", 1, "hi")).toBe(12);
  });

  it("editNote PUTs without throwing", async () => {
    route(() => ({ json: {} }));
    await expect(c().editNote("g/p", 1, 12, "edited")).resolves.toBeUndefined();
  });

  it("listNotes maps id + body", async () => {
    route(() => ({ json: [{ id: 1, body: "n1" }, { id: 2, body: "n2" }] }));
    const notes = await c().listNotes("g/p", 1);
    expect(notes).toEqual([{ id: 1, body: "n1" }, { id: 2, body: "n2" }]);
  });

  it("addLabels PUTs labels without throwing", async () => {
    route(() => ({ json: {} }));
    await expect(c().addLabels("g/p", 1, ["code-turtle/info"])).resolves.toBeUndefined();
  });
});

describe("GitHubRestClient (REST)", () => {
  const route: (h: FetchHandler) => void = (h) => installFetch(h);
  const c = (): ForgeClient => new GitHubRestClient();

  it("getMr maps pull-request fields", async () => {
    route(() => ({ json: { head: { ref: "f", sha: "hs" }, base: { ref: "main", sha: "bs" } } }));
    expect(await c().getMr("o/r", 1)).toEqual({
      sourceBranch: "f", targetBranch: "main", headSha: "hs",
      diffRefs: { head_sha: "hs", base_sha: "bs", start_sha: "bs" },
    });
  });

  it("getDiffs maps the files list", async () => {
    route(() => ({ json: [{ filename: "a.ts", patch: "@@", status: "added" }] }));
    const d = await c().getDiffs("o/r", 1);
    expect(d[0]).toMatchObject({ newPath: "a.ts", diff: "@@", newFile: true });
  });

  it("searchBlobs reads the items array", async () => {
    route(() => ({ json: { items: [{ path: "a.ts" }] } }));
    expect(await c().searchBlobs("o/r", "sym", "ref")).toEqual([{ path: "a.ts" }]);
  });

  it("listNotes merges issue and review comments", async () => {
    route((url) => {
      if (url.includes("/issues/")) return { json: [{ id: 1, body: "issue" }] };
      return { json: [{ id: 2, body: "review" }] };
    });
    const notes = await c().listNotes("o/r", 1);
    expect(notes.map((n) => n.body)).toEqual(expect.arrayContaining(["issue", "review"]));
  });

  it("postInlineNote posts a PR review comment", async () => {
    route(() => ({ json: {} }));
    expect(await c().postInlineNote("o/r", 1, "a.ts", 5, "b", refs)).toBe(true);
  });

  it("submitReview creates a new review when none has the marker", async () => {
    route((url, init) => {
      if (url.includes("/reviews") && m(init) === "GET") return { json: [] };
      return { json: {} }; // POST create
    });
    expect(await c().submitReview("o/r", 1, "summary")).toBe(true);
  });

  it("listOpenPrs returns open pulls", async () => {
    route(() => ({ json: [{ number: 9, head: { sha: "s9" }, state: "open" }] }));
    expect(await c().listOpenPrs("o/r")).toEqual([{ iid: 9, headSha: "s9" }]);
  });

  it("createNote returns the new comment id", async () => {
    route(() => ({ json: { id: 11 } }));
    expect(await c().createNote("o/r", 1, "hi")).toBe(11);
  });

  it("editNote PATCHes without throwing", async () => {
    route(() => ({ json: {} }));
    await expect(c().editNote("o/r", 1, 11, "edited")).resolves.toBeUndefined();
  });

  it("postStatus creates a fresh status comment when none exists", async () => {
    route((url, init) => {
      if (url.includes("/comments") && m(init) === "GET") return { json: [] };
      return { json: { id: 8 } }; // POST create
    });
    expect(await c().postStatus("o/r", 1, "status")).toBe(8);
  });

  it("addLabels posts labels without throwing", async () => {
    route(() => ({ json: {} }));
    await expect(c().addLabels("o/r", 1, ["code-turtle/info"])).resolves.toBeUndefined();
  });
});
