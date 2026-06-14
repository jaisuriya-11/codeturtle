import { loadCredentials, resolveToken } from "./config.js";
import { getForgeClient } from "./forge.js";
import type { Forge } from "./types.js";

export interface ParsedFinding {
  file: string;
  line: number;
  severity: "critical" | "warning" | "info";
  category: string;
  confidence: number;
  title: string;
  comment: string;
  suggestedCode?: string;
  suggestion?: string;
}

export interface PRReviewData {
  summary: string;
  findings: ParsedFinding[];
}

export function parseCommentToFinding(body: string): ParsedFinding | null {
  const markerMatch = body.match(/<!-- ct:f:(.+?):(\d+) -->/);
  if (!markerMatch) return null;

  const file = markerMatch[1];
  const line = parseInt(markerMatch[2], 10);

  // Try to parse severity
  let severity: "critical" | "warning" | "info" = "info";
  if (body.includes("🛑") || body.toLowerCase().includes("critical")) {
    severity = "critical";
  } else if (body.includes("⚠️") || body.toLowerCase().includes("warning")) {
    severity = "warning";
  }

  // Parse title
  let title = "Finding";
  const titleMatch = body.match(/\*\*([^*]+)\*\*/);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  // Parse category
  let category = "style";
  const categoryMatch = body.match(/`([^`]+)`/);
  if (categoryMatch) {
    category = categoryMatch[1].trim();
  }

  // Parse confidence
  let confidence = 1.0;
  const confMatch = body.match(/confidence\s+(\d+\.\d+)/);
  if (confMatch) {
    confidence = parseFloat(confMatch[1]);
  }

  // Extract clean comment by removing the header and suggestions/footer
  let comment = body;
  comment = comment.replace(/<!-- ct:f:.+? -->/, "");

  const lines = comment.split("\n");
  const headerIdx = lines.findIndex(
    (l) => l.includes("**") && (l.includes("·") || l.includes("confidence")),
  );
  if (headerIdx !== -1) {
    lines.splice(0, headerIdx + 1);
  }
  comment = lines.join("\n").trim();

  // Extract suggestion block (if exists)
  let suggestedCode: string | undefined;
  let suggestion: string | undefined;

  const sugCodeMatch = comment.match(/```suggestion\n([\s\S]*?)\n```/);
  if (sugCodeMatch) {
    suggestedCode = sugCodeMatch[1];
    comment = comment.replace(/```suggestion\n[\s\S]*?\n```/, "").trim();
  }

  const sugTextMatch = comment.match(/\*\*Suggestion\*\*\n\n([\s\S]*?)$/);
  if (sugTextMatch) {
    suggestion = sugTextMatch[1].split("\n\n---")[0].trim();
    comment = comment.replace(/\*\*Suggestion\*\*\n\n[\s\S]*?$/, "").trim();
  }

  // Remove the footer
  const footerIdx = comment.lastIndexOf("\n\n---");
  if (footerIdx !== -1) {
    comment = comment.substring(0, footerIdx).trim();
  } else if (comment.includes("---")) {
    comment = comment.split("---")[0].trim();
  }

  return {
    file,
    line,
    severity,
    category,
    confidence,
    title,
    comment,
    suggestedCode,
    suggestion,
  };
}

export async function fetchPRReview(
  forge: Forge,
  projectId: string,
  prNumber: number,
): Promise<PRReviewData> {
  const gl = await getForgeClient(forge);
  try {
    const notes = await gl.listNotes(projectId, prNumber);
    const findings: ParsedFinding[] = [];
    let summary = "";

    for (const note of notes) {
      if (note.body.includes("<!-- ct:f:")) {
        const f = parseCommentToFinding(note.body);
        if (f) findings.push(f);
      } else if (note.body.includes("<!-- ct:review -->")) {
        summary = note.body.replace("<!-- ct:review -->", "").trim();
      } else if (note.body.includes("<!-- ct:status -->") && !summary) {
        const clean = note.body.replace("<!-- ct:status -->", "").trim();
        if (!clean.includes("is reviewing") && !clean.includes("Review complete")) {
          summary = clean;
        }
      }
    }

    return { summary, findings };
  } finally {
    await gl.close();
  }
}

export async function fetchCodeSnippet(
  forge: Forge,
  projectId: string,
  prNumber: number,
  filePath: string,
  line: number,
): Promise<{ lines: string[]; startLine: number } | null> {
  const gl = await getForgeClient(forge);
  try {
    const mr = await gl.getMr(projectId, prNumber);
    const headSha = mr.headSha;
    const content = await gl.getFile(projectId, filePath, headSha);
    if (!content) return null;

    const allLines = content.split("\n");
    const totalLines = allLines.length;

    const range = 5;
    const startLine = Math.max(1, line - range);
    const endLine = Math.min(totalLines, line + range);

    const lines = allLines.slice(startLine - 1, endLine);
    return { lines, startLine };
  } finally {
    await gl.close();
  }
}

export async function fetchOpenPrs(
  forge: Forge,
  projectId: string,
): Promise<{ iid: number; title?: string }[]> {
  const gl = await getForgeClient(forge);
  try {
    const prs = await gl.listOpenPrs(projectId);
    // Return them. We don't fetch all MR details here to avoid massive network calls,
    // but just getting the list is perfect.
    return prs.map((p) => ({ iid: p.iid }));
  } finally {
    await gl.close();
  }
}

// ---- dashboard listings (REST — MCP has no PR-list tool we rely on) -------------

export interface PrSummary {
  iid: number;
  title: string;
  state: "open" | "closed";
  author: string;
  updatedAt: string;
}

export function mapGithubPr(raw: any): PrSummary {
  return {
    iid: raw.number,
    title: raw.title ?? "",
    state: raw.state === "open" ? "open" : "closed",
    author: raw.user?.login ?? "",
    updatedAt: raw.updated_at ?? "",
  };
}

export function mapGitlabMr(raw: any): PrSummary {
  return {
    iid: raw.iid,
    title: raw.title ?? "",
    state: raw.state === "opened" ? "open" : "closed",
    author: raw.author?.username ?? "",
    updatedAt: raw.updated_at ?? "",
  };
}

const githubBase = () => process.env.GITHUB_URL ?? "https://api.github.com";
const gitlabBase = () =>
  loadCredentials().gitlab?.url ?? process.env.GITLAB_URL ?? "https://gitlab.com";

const githubHeaders = () => ({
  Authorization: `Bearer ${resolveToken("github") ?? ""}`,
  Accept: "application/vnd.github+json",
});
const gitlabHeaders = () => ({ "PRIVATE-TOKEN": resolveToken("gitlab") ?? "" });

/** PRs/MRs of a repo by state. GitLab "closed" covers both closed and merged. */
export async function fetchPrList(
  forge: Forge,
  projectId: string,
  state: "open" | "closed",
): Promise<PrSummary[]> {
  if (forge === "github") {
    const { ensureFreshGithubToken } = await import("./githubAuth.js");
    await ensureFreshGithubToken();
    const r = await fetch(
      `${githubBase()}/repos/${projectId}/pulls?state=${state}&per_page=50&sort=updated&direction=desc`,
      { headers: githubHeaders(), signal: AbortSignal.timeout(15000) },
    );
    if (!r.ok) throw new Error(`github list prs ${r.status}`);
    return ((await r.json()) as any[]).map(mapGithubPr);
  }
  const states = state === "open" ? ["opened"] : ["closed", "merged"];
  const out: PrSummary[] = [];
  for (const s of states) {
    const r = await fetch(
      `${gitlabBase()}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests?state=${s}&per_page=50&order_by=updated_at`,
      { headers: gitlabHeaders(), signal: AbortSignal.timeout(15000) },
    );
    if (!r.ok) throw new Error(`gitlab list mrs ${r.status}`);
    out.push(...((await r.json()) as any[]).map(mapGitlabMr));
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The user's repos on a forge, most recently active first. Soft call: [] on failure. */
export async function listRepos(forge: Forge): Promise<string[]> {
  try {
    if (forge === "github") {
      const { ensureFreshGithubToken } = await import("./githubAuth.js");
      await ensureFreshGithubToken();
      const r = await fetch(`${githubBase()}/user/repos?per_page=50&sort=pushed`, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return [];
      return ((await r.json()) as any[]).map((x) => x.full_name);
    }
    const r = await fetch(
      `${gitlabBase()}/api/v4/projects?membership=true&per_page=50&order_by=last_activity_at`,
      { headers: gitlabHeaders(), signal: AbortSignal.timeout(15000) },
    );
    if (!r.ok) return [];
    return ((await r.json()) as any[]).map((x) => String(x.path_with_namespace ?? x.id));
  } catch {
    return [];
  }
}
