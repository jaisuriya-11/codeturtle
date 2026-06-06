/** Commit-level forge ops for branch-push reviews: branch listing, push diffs,
 * commit comments. Always REST on both forges — the GitHub MCP server exposes
 * no commit-comment tools. */

import { loadCredentials, resolveToken } from "./config.js";
import type { FileDiff, Forge } from "./types.js";

export interface BranchInfo {
  name: string;
  sha: string;
}

/** Inline anchor for a commit comment; patch is the file's unified diff. */
export interface CommitAnchor {
  path: string;
  line: number;
  patch: string;
}

const githubBase = () => process.env.GITHUB_URL ?? "https://api.github.com";
const gitlabBase = () =>
  loadCredentials().gitlab?.url ?? process.env.GITLAB_URL ?? "https://gitlab.com";

const githubHeaders = () => ({
  Authorization: `Bearer ${resolveToken("github") ?? ""}`,
  Accept: "application/vnd.github+json",
});
const gitlabHeaders = () => ({ "PRIVATE-TOKEN": resolveToken("gitlab") ?? "" });

async function githubFetch(path: string, init?: RequestInit): Promise<Response> {
  const { ensureFreshGithubToken } = await import("./githubAuth.js");
  await ensureFreshGithubToken();
  return fetch(`${githubBase()}${path}`, {
    ...init,
    headers: { ...githubHeaders(), ...(init?.headers as Record<string, string>) },
    signal: AbortSignal.timeout(30000),
  });
}

async function gitlabFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${gitlabBase()}/api/v4${path}`, {
    ...init,
    headers: { ...gitlabHeaders(), ...(init?.headers as Record<string, string>) },
    signal: AbortSignal.timeout(30000),
  });
}

/** Branches with their head SHAs. Soft call: [] on failure (watcher resilience). */
export async function listBranches(forge: Forge, projectId: string): Promise<BranchInfo[]> {
  try {
    if (forge === "github") {
      const r = await githubFetch(`/repos/${projectId}/branches?per_page=100`);
      if (!r.ok) return [];
      return ((await r.json()) as any[]).map((b) => ({
        name: b.name,
        sha: b.commit?.sha ?? "",
      }));
    }
    const r = await gitlabFetch(
      `/projects/${encodeURIComponent(projectId)}/repository/branches?per_page=100`,
    );
    if (!r.ok) return [];
    return ((await r.json()) as any[]).map((b) => ({
      name: b.name,
      sha: b.commit?.id ?? "",
    }));
  } catch {
    return [];
  }
}

/** The diff of a push: base (last seen SHA) … head. */
export async function compareDiffs(
  forge: Forge,
  projectId: string,
  base: string,
  head: string,
): Promise<FileDiff[]> {
  if (forge === "github") {
    const r = await githubFetch(
      `/repos/${projectId}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    if (!r.ok) throw new Error(`github compare ${r.status}`);
    const data = (await r.json()) as any;
    return ((data.files ?? []) as any[]).map((f) => ({
      newPath: f.filename,
      oldPath: f.previous_filename ?? f.filename,
      diff: f.patch ?? "",
      newFile: f.status === "added",
      deletedFile: f.status === "removed",
    }));
  }
  const r = await gitlabFetch(
    `/projects/${encodeURIComponent(projectId)}/repository/compare?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`,
  );
  if (!r.ok) throw new Error(`gitlab compare ${r.status}`);
  const data = (await r.json()) as any;
  return ((data.diffs ?? []) as any[]).map((d) => ({
    newPath: d.new_path,
    oldPath: d.old_path,
    diff: d.diff ?? "",
    newFile: !!d.new_file,
    deletedFile: !!d.deleted_file,
  }));
}

/** Bodies of existing comments on a commit — the dedup source for push reviews. */
export async function listCommitCommentBodies(
  forge: Forge,
  projectId: string,
  sha: string,
): Promise<string[]> {
  try {
    if (forge === "github") {
      const r = await githubFetch(`/repos/${projectId}/commits/${sha}/comments?per_page=100`);
      if (!r.ok) return [];
      return ((await r.json()) as any[]).map((c) => c.body ?? "");
    }
    const r = await gitlabFetch(
      `/projects/${encodeURIComponent(projectId)}/repository/commits/${sha}/comments?per_page=100`,
    );
    if (!r.ok) return [];
    return ((await r.json()) as any[]).map((c) => c.note ?? "");
  } catch {
    return [];
  }
}

/** GitHub anchors commit comments by diff position, not file line: lines are
 * counted down from the file's first @@ header (the line below it is 1, later
 * @@ headers count too). Returns null when the line isn't visible in the patch. */
export function diffPosition(patch: string, line: number): number | null {
  const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let pos = 0;
  let newLine = 0;
  let seenHunk = false;
  for (const l of patch.split("\n")) {
    const hunk = l.match(HUNK_RE);
    if (hunk) {
      if (seenHunk) pos++;
      seenHunk = true;
      newLine = Number(hunk[1]);
      continue;
    }
    if (!seenHunk) continue;
    pos++;
    if (l.startsWith("-") || l.startsWith("\\")) continue;
    if (newLine === line) return pos;
    newLine++;
  }
  return null;
}

/** Post a comment on a commit; inline when the anchor maps into the patch,
 * commit-level otherwise. Returns false on failure (caller falls back). */
export async function postCommitComment(
  forge: Forge,
  projectId: string,
  sha: string,
  body: string,
  anchor?: CommitAnchor,
): Promise<boolean> {
  if (forge === "github") {
    const position = anchor ? diffPosition(anchor.patch, anchor.line) : null;
    const payload: Record<string, unknown> = { body };
    if (anchor && position != null) {
      payload.path = anchor.path;
      payload.position = position;
    }
    const r = await githubFetch(`/repos/${projectId}/commits/${sha}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return r.ok;
  }
  const payload: Record<string, unknown> = { note: body };
  if (anchor) {
    payload.path = anchor.path;
    payload.line = anchor.line;
    payload.line_type = "new";
  }
  const r = await gitlabFetch(
    `/projects/${encodeURIComponent(projectId)}/repository/commits/${sha}/comments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return r.ok;
}
