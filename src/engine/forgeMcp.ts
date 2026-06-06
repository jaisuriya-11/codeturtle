/** GitHub via the official remote MCP server. Inline findings accumulate on a
 * pending review; submitReview publishes them with the summary as ONE native
 * GitHub review. No comment-edit tool exists on this server, so the sticky
 * status note ("reviewing… " → "complete") goes through a REST companion
 * client with the same token — notes/status are REST, the review flow is MCP. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { resolveToken } from "./config.js";
import {
  GitHubRestClient, REVIEW_MARKER, type ForgeClient, type Note,
} from "./forge.js";
import type { DiffRefs, FileDiff, MrInfo } from "./types.js";

const MCP_URL = "https://api.githubcopilot.com/mcp/";

export class GitHubMcpClient implements ForgeClient {
  private client: Client | null = null;
  private hasPending = new Set<string>();
  private restCompanion: GitHubRestClient | null = null;

  /** REST with the same token — covers what the MCP server can't (comment edits)
   * and unifies note listing (issue + review comments) for marker dedup. */
  private rest(): GitHubRestClient {
    return (this.restCompanion ??= new GitHubRestClient());
  }

  private async ensure(): Promise<Client> {
    if (this.client) return this.client;
    const token = resolveToken("github");
    if (!token) throw new Error("GitHub not connected. Run: codeturtle (setup) or set GITHUB_TOKEN");
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "code-turtle", version: "2.0.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async close() {
    await this.client?.close().catch(() => {});
    this.client = null;
  }

  private split(projectId: string): { owner: string; repo: string } {
    const [owner, repo] = projectId.split("/");
    if (!owner || !repo) throw new Error(`GitHub projectId must be owner/repo, got ${projectId}`);
    return { owner, repo };
  }

  private async call(tool: string, args: Record<string, unknown>, opts?: { soft?: boolean }): Promise<any> {
    const client = await this.ensure();
    const res = await client.callTool({ name: tool, arguments: args });
    const text = (res.content as any[] ?? [])
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join("");
    if (res.isError) {
      if (opts?.soft) return null;
      throw new Error(`MCP ${tool} failed: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async getMr(projectId: string, prNumber: number): Promise<MrInfo> {
    const { owner, repo } = this.split(projectId);
    const d = await this.call("pull_request_read", { method: "get", owner, repo, pullNumber: prNumber });
    return {
      sourceBranch: d.head.ref,
      targetBranch: d.base.ref,
      headSha: d.head.sha,
      diffRefs: { head_sha: d.head.sha, base_sha: d.base.sha, start_sha: d.base.sha },
    };
  }

  async getDiffs(projectId: string, prNumber: number): Promise<FileDiff[]> {
    const { owner, repo } = this.split(projectId);
    const d = await this.call("pull_request_read", {
      method: "get_files", owner, repo, pullNumber: prNumber, perPage: 100,
    });
    // strict shape check: a malformed/unparsed response must fail the run, not
    // silently read as "empty diff" (which posts a wrong "Nothing to review")
    const files: any[] | undefined = Array.isArray(d) ? d : d?.files;
    if (!Array.isArray(files)) {
      throw new Error(`MCP get_files returned an unexpected shape: ${String(d).slice(0, 120)}`);
    }
    return files.map((f) => ({
      newPath: f.filename ?? "", oldPath: f.previous_filename ?? f.filename ?? "",
      diff: f.patch ?? "", newFile: f.status === "added", deletedFile: f.status === "removed",
    }));
  }

  async getFile(projectId: string, path: string, ref: string): Promise<string | null> {
    const { owner, repo } = this.split(projectId);
    const client = await this.ensure();
    const res = await client.callTool({
      name: "get_file_contents",
      arguments: { owner, repo, path, sha: ref },
    });
    if (res.isError) return null;
    // File body arrives as an EmbeddedResource; TextContent is just a status line.
    for (const item of (res.content as any[]) ?? []) {
      const text = item?.resource?.text;
      if (typeof text === "string") return text;
    }
    return null;
  }

  async searchBlobs(projectId: string, query: string): Promise<{ path: string }[]> {
    const d = await this.call("search_code", { query: `${query} repo:${projectId}`, perPage: 20 }, { soft: true });
    return (d?.items ?? []).filter((i: any) => i?.path).map((i: any) => ({ path: i.path }));
  }

  async listNotes(projectId: string, prNumber: number): Promise<Note[]> {
    // REST sees both issue comments and submitted review comments — the MCP
    // tools miss some, which let already-posted findings repost (broken dedup).
    return this.rest().listNotes(projectId, prNumber);
  }

  async createNote(projectId: string, prNumber: number, body: string) {
    const { owner, repo } = this.split(projectId);
    const d = await this.call("add_issue_comment", { owner, repo, issue_number: prNumber, body });
    return d?.id ?? 0;
  }

  async editNote(projectId: string, prNumber: number, noteId: number | string, body: string) {
    return this.rest().editNote(projectId, prNumber, noteId, body);
  }

  async postStatus(projectId: string, prNumber: number, body: string) {
    // visible progress in the PR conversation; finalize edits it on completion
    return this.rest().postStatus(projectId, prNumber, body);
  }

  async postInlineNote(
    projectId: string, prNumber: number, filePath: string, newLine: number,
    body: string, _refs: DiffRefs,
  ): Promise<boolean> {
    const { owner, repo } = this.split(projectId);
    const key = `${owner}/${repo}#${prNumber}`;
    if (!this.hasPending.has(key)) {
      const created = await this.call("pull_request_review_write", {
        method: "create", owner, repo, pullNumber: prNumber,
      }, { soft: true });
      if (created == null) {
        // a crashed run may have left a pending review (create fails while one
        // exists) — reuse it so its comments finally publish on submit
        const reviews = await this.call("pull_request_read", {
          method: "get_reviews", owner, repo, pullNumber: prNumber, perPage: 100,
        }, { soft: true });
        const blob = reviews == null ? "" : typeof reviews === "string" ? reviews : JSON.stringify(reviews);
        if (!blob.includes("PENDING")) return false;
      }
      this.hasPending.add(key);
    }
    const added = await this.call("add_comment_to_pending_review", {
      owner, repo, pullNumber: prNumber, path: filePath, line: newLine,
      side: "RIGHT", subjectType: "LINE", body,
    }, { soft: true });
    return added != null;
  }

  async submitReview(projectId: string, prNumber: number, body: string): Promise<boolean> {
    const { owner, repo } = this.split(projectId);
    const key = `${owner}/${repo}#${prNumber}`;
    const full = `${REVIEW_MARKER}\n${body}`;

    if (this.hasPending.has(key)) {
      const submitted = await this.call("pull_request_review_write", {
        method: "submit_pending", owner, repo, pullNumber: prNumber, event: "COMMENT", body: full,
      }, { soft: true });
      this.hasPending.delete(key);
      return submitted != null;
    }
    // No new inline findings this run.
    const reviews = await this.call("pull_request_read", {
      method: "get_reviews", owner, repo, pullNumber: prNumber, perPage: 100,
    }, { soft: true });
    const blob = reviews == null ? "" : typeof reviews === "string" ? reviews : JSON.stringify(reviews);
    // a leftover pending review from a crashed run blocks future ones — publish it
    if (blob.includes("PENDING")) {
      const submitted = await this.call("pull_request_review_write", {
        method: "submit_pending", owner, repo, pullNumber: prNumber, event: "COMMENT", body: full,
      }, { soft: true });
      if (submitted != null) return true;
    }
    // only post a summary review if none of ours exists
    if (blob.includes(REVIEW_MARKER)) return true;
    const created = await this.call("pull_request_review_write", {
      method: "create", owner, repo, pullNumber: prNumber, event: "COMMENT", body: full,
    }, { soft: true });
    return created != null;
  }

  async addLabels(projectId: string, prNumber: number, labels: string[]) {
    const { owner, repo } = this.split(projectId);
    // issue_write update replaces the set — merge with existing first.
    const cur = await this.call("issue_read", {
      method: "get", owner, repo, issue_number: prNumber,
    }, { soft: true });
    const existing = new Set<string>(
      (cur?.labels ?? []).map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean),
    );
    for (const l of labels) existing.add(l);
    await this.call("issue_write", {
      method: "update", owner, repo, issue_number: prNumber, labels: [...existing].sort(),
    }, { soft: true });
  }

  async listOpenPrs(projectId: string) {
    const { owner, repo } = this.split(projectId);
    const d = await this.call("list_pull_requests", {
      owner, repo, state: "open", perPage: 100,
    }, { soft: true });
    const items: any[] = Array.isArray(d) ? d : d?.pull_requests ?? [];
    return items
      .filter((pr) => pr?.number && (pr?.state === "open" || !pr?.state))
      .map((pr) => ({ iid: pr.number, headSha: pr.head?.sha ?? "" }));
  }
}
