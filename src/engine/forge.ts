/** Forge clients. GitHub default backend is MCP (see forgeMcp.ts); REST
 * clients here cover GitLab and the GITHUB_BACKEND=rest escape hatch. */

import { resolveToken, loadCredentials } from "./config.js";
import type { DiffRefs, FileDiff, MrInfo } from "./types.js";

export const STATUS_MARKER = "<!-- ct:status -->";
export const REVIEW_MARKER = "<!-- ct:review -->";

export const findingMarker = (file: string, line: number) => `<!-- ct:f:${file}:${line} -->`;

export interface Note {
  id: number | string | null;
  body: string;
}

export interface ForgeClient {
  close(): Promise<void>;
  getMr(projectId: string, prNumber: number): Promise<MrInfo>;
  getDiffs(projectId: string, prNumber: number): Promise<FileDiff[]>;
  getFile(projectId: string, path: string, ref: string): Promise<string | null>;
  searchBlobs(projectId: string, query: string, ref: string): Promise<{ path: string }[]>;
  createNote(projectId: string, prNumber: number, body: string): Promise<number | string>;
  editNote(projectId: string, prNumber: number, noteId: number | string, body: string): Promise<void>;
  listNotes(projectId: string, prNumber: number): Promise<Note[]>;
  postStatus(projectId: string, prNumber: number, body: string): Promise<number | string>;
  postInlineNote(
    projectId: string, prNumber: number, filePath: string, newLine: number,
    body: string, refs: DiffRefs,
  ): Promise<boolean>;
  addLabels(projectId: string, prNumber: number, labels: string[]): Promise<void>;
  submitReview(projectId: string, prNumber: number, body: string): Promise<boolean>;
  listOpenPrs(projectId: string): Promise<{ iid: number; headSha: string }[]>;
}

async function http(
  url: string, init: RequestInit & { headers: Record<string, string> },
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
}

// ---- GitLab (REST) -------------------------------------------------------------

export class GitLabClient implements ForgeClient {
  private base: string;
  private headers: Record<string, string>;

  constructor() {
    const cred = loadCredentials().gitlab ?? {};
    const url = cred.url ?? process.env.GITLAB_URL ?? "https://gitlab.com";
    this.base = `${url}/api/v4`;
    this.headers = { "PRIVATE-TOKEN": resolveToken("gitlab") ?? "" };
  }

  async close() {}

  private enc(projectId: string): string {
    return encodeURIComponent(projectId);
  }

  async getMr(projectId: string, prNumber: number): Promise<MrInfo> {
    const r = await http(`${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}`, { headers: this.headers });
    if (!r.ok) throw new Error(`gitlab get_mr ${r.status}`);
    const d = (await r.json()) as any;
    return {
      sourceBranch: d.source_branch,
      targetBranch: d.target_branch,
      headSha: d.sha ?? d.diff_refs?.head_sha ?? "",
      diffRefs: d.diff_refs,
    };
  }

  async getDiffs(projectId: string, prNumber: number): Promise<FileDiff[]> {
    const r = await http(`${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}/diffs`, { headers: this.headers });
    if (!r.ok) throw new Error(`gitlab get_diffs ${r.status}`);
    const items = (await r.json()) as any[];
    return items.map((d) => ({
      newPath: d.new_path, oldPath: d.old_path, diff: d.diff ?? "",
      newFile: !!d.new_file, deletedFile: !!d.deleted_file,
    }));
  }

  async getFile(projectId: string, path: string, ref: string): Promise<string | null> {
    const r = await http(
      `${this.base}/projects/${this.enc(projectId)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      { headers: this.headers },
    );
    return r.ok ? r.text() : null;
  }

  async searchBlobs(projectId: string, query: string, ref: string) {
    const r = await http(
      `${this.base}/projects/${this.enc(projectId)}/search?scope=blobs&search=${encodeURIComponent(query)}&ref=${encodeURIComponent(ref)}&per_page=20`,
      { headers: this.headers },
    );
    if (!r.ok) return [];
    return ((await r.json()) as any[]).map((h) => ({ path: h.path }));
  }

  async createNote(projectId: string, prNumber: number, body: string) {
    const r = await http(`${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}/notes`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!r.ok) throw new Error(`gitlab create_note ${r.status}`);
    return ((await r.json()) as any).id as number;
  }

  async editNote(projectId: string, prNumber: number, noteId: number | string, body: string) {
    const r = await http(`${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}/notes/${noteId}`, {
      method: "PUT",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!r.ok) throw new Error(`gitlab edit_note ${r.status}`);
  }

  async listNotes(projectId: string, prNumber: number): Promise<Note[]> {
    const r = await http(`${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}/notes?per_page=100`, { headers: this.headers });
    if (!r.ok) return [];
    return ((await r.json()) as any[]).map((n) => ({ id: n.id, body: n.body ?? "" }));
  }

  async postStatus(projectId: string, prNumber: number, body: string) {
    const full = `${STATUS_MARKER}\n${body}`;
    for (const note of await this.listNotes(projectId, prNumber)) {
      if (note.body.includes(STATUS_MARKER) && note.id != null) {
        await this.editNote(projectId, prNumber, note.id, full);
        return note.id;
      }
    }
    return this.createNote(projectId, prNumber, full);
  }

  async postInlineNote(
    projectId: string, prNumber: number, filePath: string, newLine: number,
    body: string, refs: DiffRefs,
  ): Promise<boolean> {
    const params = new URLSearchParams({
      body,
      "position[position_type]": "text",
      "position[base_sha]": refs.base_sha,
      "position[start_sha]": refs.start_sha,
      "position[head_sha]": refs.head_sha,
      "position[new_path]": filePath,
      "position[old_path]": filePath,
      "position[new_line]": String(newLine),
    });
    const r = await http(`${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}/discussions`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    return r.ok;
  }

  async addLabels(projectId: string, prNumber: number, labels: string[]) {
    await http(`${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}`, {
      method: "PUT",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ add_labels: labels.join(",") }),
    });
  }

  async submitReview() {
    return false; // GitLab has no formal review object; poster falls back to sticky note
  }

  async listOpenPrs(projectId: string) {
    const r = await http(`${this.base}/projects/${this.enc(projectId)}/merge_requests?state=opened&per_page=100`, { headers: this.headers });
    if (!r.ok) return [];
    return ((await r.json()) as any[])
      .filter((mr) => mr && (mr.state === "opened" || !mr.state))
      .map((mr) => ({ iid: mr.iid, headSha: mr.sha ?? "" }));
  }
}

// ---- GitHub (REST fallback) ------------------------------------------------------

export class GitHubRestClient implements ForgeClient {
  private base = process.env.GITHUB_URL ?? "https://api.github.com";
  private headers: Record<string, string>;

  constructor() {
    this.headers = {
      Authorization: `Bearer ${resolveToken("github") ?? ""}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async close() {}

  async getMr(projectId: string, prNumber: number): Promise<MrInfo> {
    const r = await http(`${this.base}/repos/${projectId}/pulls/${prNumber}`, { headers: this.headers });
    if (!r.ok) throw new Error(`github get_mr ${r.status}`);
    const d = (await r.json()) as any;
    return {
      sourceBranch: d.head.ref,
      targetBranch: d.base.ref,
      headSha: d.head.sha,
      diffRefs: { head_sha: d.head.sha, base_sha: d.base.sha, start_sha: d.base.sha },
    };
  }

  async getDiffs(projectId: string, prNumber: number): Promise<FileDiff[]> {
    const r = await http(`${this.base}/repos/${projectId}/pulls/${prNumber}/files?per_page=100`, { headers: this.headers });
    if (!r.ok) throw new Error(`github get_diffs ${r.status}`);
    return ((await r.json()) as any[]).map((f) => ({
      newPath: f.filename, oldPath: f.previous_filename ?? f.filename,
      diff: f.patch ?? "", newFile: f.status === "added", deletedFile: f.status === "removed",
    }));
  }

  async getFile(projectId: string, path: string, ref: string): Promise<string | null> {
    const r = await http(
      `${this.base}/repos/${projectId}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      { headers: { ...this.headers, Accept: "application/vnd.github.raw" } },
    );
    return r.ok ? r.text() : null;
  }

  async searchBlobs(projectId: string, query: string) {
    const r = await http(
      `${this.base}/search/code?q=${encodeURIComponent(`${query} repo:${projectId}`)}`,
      { headers: this.headers },
    );
    if (!r.ok) return [];
    const data = (await r.json()) as any;
    return (data.items ?? []).map((i: any) => ({ path: i.path }));
  }

  async createNote(projectId: string, prNumber: number, body: string) {
    const r = await http(`${this.base}/repos/${projectId}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!r.ok) throw new Error(`github create_note ${r.status}`);
    return ((await r.json()) as any).id as number;
  }

  async editNote(projectId: string, prNumber: number, noteId: number | string, body: string) {
    const r = await http(`${this.base}/repos/${projectId}/issues/comments/${noteId}`, {
      method: "PATCH",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!r.ok) throw new Error(`github edit_note ${r.status}`);
  }

  async listNotes(projectId: string, prNumber: number): Promise<Note[]> {
    const out: Note[] = [];
    for (const url of [
      `${this.base}/repos/${projectId}/issues/${prNumber}/comments?per_page=100`,
      `${this.base}/repos/${projectId}/pulls/${prNumber}/comments?per_page=100`,
    ]) {
      const r = await http(url, { headers: this.headers });
      if (r.ok) for (const c of (await r.json()) as any[]) out.push({ id: c.id, body: c.body ?? "" });
    }
    return out;
  }

  async postStatus(projectId: string, prNumber: number, body: string) {
    const full = `${STATUS_MARKER}\n${body}`;
    for (const note of await this.listNotes(projectId, prNumber)) {
      if (note.body.includes(STATUS_MARKER) && note.id != null) {
        await this.editNote(projectId, prNumber, note.id, full);
        return note.id;
      }
    }
    return this.createNote(projectId, prNumber, full);
  }

  async postInlineNote(
    projectId: string, prNumber: number, filePath: string, newLine: number,
    body: string, refs: DiffRefs,
  ): Promise<boolean> {
    const r = await http(`${this.base}/repos/${projectId}/pulls/${prNumber}/comments`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        body, commit_id: refs.head_sha, path: filePath, line: newLine, side: "RIGHT",
      }),
    });
    return r.ok;
  }

  async addLabels(projectId: string, prNumber: number, labels: string[]) {
    await http(`${this.base}/repos/${projectId}/issues/${prNumber}/labels`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ labels }),
    });
  }

  async submitReview(projectId: string, prNumber: number, body: string): Promise<boolean> {
    const full = `${REVIEW_MARKER}\n${body}`;
    const list = await http(`${this.base}/repos/${projectId}/pulls/${prNumber}/reviews?per_page=100`, { headers: this.headers });
    if (list.ok) {
      for (const rv of (await list.json()) as any[]) {
        if ((rv.body ?? "").includes(REVIEW_MARKER)) {
          const upd = await http(`${this.base}/repos/${projectId}/pulls/${prNumber}/reviews/${rv.id}`, {
            method: "PUT",
            headers: { ...this.headers, "Content-Type": "application/json" },
            body: JSON.stringify({ body: full }),
          });
          if (upd.ok) return true;
        }
      }
    }
    const r = await http(`${this.base}/repos/${projectId}/pulls/${prNumber}/reviews`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body: full, event: "COMMENT" }),
    });
    return r.ok;
  }

  async listOpenPrs(projectId: string) {
    const r = await http(`${this.base}/repos/${projectId}/pulls?state=open&per_page=100`, { headers: this.headers });
    if (!r.ok) return [];
    return ((await r.json()) as any[])
      .filter((pr) => pr && (pr.state === "open" || !pr.state))
      .map((pr) => ({ iid: pr.number, headSha: pr.head?.sha ?? "" }));
  }
}

// ---- factory ---------------------------------------------------------------------

export async function getForgeClient(forge: string): Promise<ForgeClient> {
  if (forge === "github") {
    if ((process.env.GITHUB_BACKEND ?? "mcp").toLowerCase() !== "rest") {
      const { GitHubMcpClient } = await import("./forgeMcp.js");
      return new GitHubMcpClient();
    }
    return new GitHubRestClient();
  }
  if (forge === "gitlab") return new GitLabClient();
  throw new Error(`Unknown or unsupported forge: ${forge} (bitbucket lands in v2.1)`);
}
