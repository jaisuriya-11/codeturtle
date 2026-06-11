import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compareDiffs,
  diffPosition,
  listBranches,
  listCommitCommentBodies,
  postCommitComment,
} from "../forgeCommits.js";
import { installFetch } from "./helpers/fetchMock.js";

afterEach(() => vi.unstubAllGlobals());

const PATCH = [
  "@@ -1,3 +1,4 @@",
  " line1", // new line 1 · position 1
  "+line2", // new line 2 · position 2
  " line3", // new line 3 · position 3
  " line4", // new line 4 · position 4
].join("\n");

describe("diffPosition", () => {
  it("maps a new-side line to its diff position", () => {
    expect(diffPosition(PATCH, 2)).toBe(2);
    expect(diffPosition(PATCH, 4)).toBe(4);
  });

  it("counts later hunk headers as positions", () => {
    const twoHunks = [
      "@@ -1,2 +1,2 @@",
      " a", // line 1 · pos 1
      "+b", // line 2 · pos 2
      "@@ -10,2 +10,2 @@", // pos 3
      " c", // line 10 · pos 4
      "+d", // line 11 · pos 5
    ].join("\n");
    expect(diffPosition(twoHunks, 11)).toBe(5);
  });

  it("returns null for a line outside the patch", () => {
    expect(diffPosition(PATCH, 99)).toBeNull();
    expect(diffPosition("", 1)).toBeNull();
  });
});

describe("listBranches", () => {
  it("maps GitHub branches", async () => {
    installFetch(() => ({ json: [{ name: "main", commit: { sha: "abc" } }] }));
    expect(await listBranches("github", "o/r")).toEqual([{ name: "main", sha: "abc" }]);
  });

  it("maps GitLab branches", async () => {
    installFetch(() => ({ json: [{ name: "dev", commit: { id: "def" } }] }));
    expect(await listBranches("gitlab", "g/p")).toEqual([{ name: "dev", sha: "def" }]);
  });

  it("is soft — [] on failure", async () => {
    installFetch(() => ({ status: 500 }));
    expect(await listBranches("github", "o/r")).toEqual([]);
  });
});

describe("compareDiffs", () => {
  it("maps a GitHub compare to FileDiffs", async () => {
    installFetch(() => ({
      json: { files: [{ filename: "a.ts", patch: "@@", status: "added" }] },
    }));
    expect(await compareDiffs("github", "o/r", "b", "h")).toEqual([
      { newPath: "a.ts", oldPath: "a.ts", diff: "@@", newFile: true, deletedFile: false },
    ]);
  });

  it("maps a GitLab compare to FileDiffs", async () => {
    installFetch(() => ({
      json: { diffs: [{ new_path: "a.ts", old_path: "old.ts", diff: "@@", deleted_file: true }] },
    }));
    expect(await compareDiffs("gitlab", "g/p", "b", "h")).toEqual([
      { newPath: "a.ts", oldPath: "old.ts", diff: "@@", newFile: false, deletedFile: true },
    ]);
  });

  it("throws on a non-ok response", async () => {
    installFetch(() => ({ status: 404 }));
    await expect(compareDiffs("github", "o/r", "b", "h")).rejects.toThrow("github compare 404");
  });
});

describe("listCommitCommentBodies", () => {
  it("reads GitHub bodies and GitLab notes", async () => {
    installFetch((url) =>
      new URL(String(url)).hostname === "api.github.com"
        ? { json: [{ body: "gh comment" }] }
        : { json: [{ note: "gl comment" }] },
    );
    expect(await listCommitCommentBodies("github", "o/r", "sha")).toEqual(["gh comment"]);
    expect(await listCommitCommentBodies("gitlab", "g/p", "sha")).toEqual(["gl comment"]);
  });
});

describe("postCommitComment", () => {
  it("anchors GitHub comments by diff position", async () => {
    const { calls } = installFetch(() => ({ json: {} }));
    await postCommitComment("github", "o/r", "sha", "body", {
      path: "a.ts",
      line: 2,
      patch: PATCH,
    });
    const payload = JSON.parse(String(calls[0].init?.body));
    expect(payload).toEqual({ body: "body", path: "a.ts", position: 2 });
  });

  it("falls back to a commit-level comment when the line isn't in the patch", async () => {
    const { calls } = installFetch(() => ({ json: {} }));
    await postCommitComment("github", "o/r", "sha", "body", {
      path: "a.ts",
      line: 99,
      patch: PATCH,
    });
    const payload = JSON.parse(String(calls[0].init?.body));
    expect(payload).toEqual({ body: "body" });
  });

  it("anchors GitLab comments by real line number", async () => {
    const { calls } = installFetch(() => ({ json: {} }));
    await postCommitComment("gitlab", "g/p", "sha", "body", { path: "a.ts", line: 7, patch: "" });
    const payload = JSON.parse(String(calls[0].init?.body));
    expect(payload).toEqual({ note: "body", path: "a.ts", line: 7, line_type: "new" });
  });
});
