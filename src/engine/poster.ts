/** Posting: inline findings (deduped vs existing markers, ±3 line tolerance for
 * LLM line jitter), final summary as a formal review where supported. */

import { reviewerSettings } from "./config.js";
import {
  findingMarker,
  recheckMarker,
  REVIEW_MARKER,
  STATUS_MARKER,
  type ForgeClient,
} from "./forge.js";
import { listCommitCommentBodies, postCommitComment } from "./forgeCommits.js";
import type { DiffRefs, FileDiff, Finding, Forge, ReviewResult, Severity } from "./types.js";

const LABEL: Record<Severity, string> = {
  critical: "code-turtle/critical",
  warning: "code-turtle/warning",
  info: "code-turtle/info",
};
const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
const EMOJI: Record<Severity, string> = { critical: "🛑", warning: "⚠️", info: "💡" };

const MARKER_RE = /<!-- ct:f:(.+?):(\d+) -->/g;
const LINE_TOLERANCE = 3;
const SNAP_TOLERANCE = 10;
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** New-side line numbers visible in a unified diff: added lines (commentable +
 * suggestable) and context lines (commentable). */
function diffLines(patch: string): { added: Set<number>; visible: Set<number> } {
  const added = new Set<number>();
  const visible = new Set<number>();
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = line.match(HUNK_RE);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("-") || line.startsWith("\\")) continue;
    if (line.startsWith("+")) added.add(newLine);
    visible.add(newLine);
    newLine++;
  }
  return { added, visible };
}

/** Snap finding lines onto the diff so inline anchoring succeeds. LLMs drift a
 * few lines off the hunk; the forge rejects lines outside it. A snapped line
 * loses its suggestedCode — the replacement was written for the original line. */
export function snapFindings(diffs: FileDiff[], findings: Finding[]): Finding[] {
  const byFile = new Map<string, { added: Set<number>; visible: Set<number> }>();
  for (const d of diffs) {
    if (d.diff && !d.deletedFile) byFile.set(d.newPath, diffLines(d.diff));
  }
  return findings.map((f) => {
    const lines = byFile.get(f.file);
    if (!lines || lines.added.has(f.line)) return f;
    let best: number | null = null;
    for (const cand of lines.visible) {
      const dist = Math.abs(cand - f.line);
      if (dist <= SNAP_TOLERANCE && (best === null || dist < Math.abs(best - f.line))) best = cand;
    }
    if (best === null) return f; // nothing nearby — finalize falls back to a plain note
    return { ...f, line: best, suggestedCode: undefined };
  });
}

function commentBody(f: Finding, botName: string): string {
  const emoji = botName.toLowerCase().includes("turtle") ? "🐢" : "🤖";
  let body =
    `${findingMarker(f.file, f.line)}\n` +
    `${EMOJI[f.severity]} **${f.title}** · \`${f.category}\` · confidence ${f.confidence.toFixed(2)}\n\n${f.comment}`;
  if (f.suggestedCode) {
    body += "\n\n```suggestion\n" + f.suggestedCode + "\n```";
  } else if (f.suggestion) {
    body += `\n\n**Suggestion**\n\n${f.suggestion}`;
  }
  return body + `\n\n---\n_${emoji} ${botName}_`;
}

export async function finalize(
  gl: ForgeClient,
  projectId: string,
  prNumber: number,
  refs: DiffRefs,
  result: ReviewResult,
  kept: Finding[],
  statusId: number | string,
  log: (msg: string) => void = () => {},
): Promise<void> {
  const botName = reviewerSettings().botName;
  const botEmoji = botName.toLowerCase().includes("turtle") ? "🐢" : "🤖";
  const existing = (await gl.listNotes(projectId, prNumber)).map((n) => n.body).join("\n");
  const existingMarkers = [...existing.matchAll(MARKER_RE)].map(
    (m) => [m[1], Number(m[2])] as const,
  );
  const alreadyPosted = (file: string, line: number) =>
    existingMarkers.some(([f, l]) => f === file && Math.abs(l - line) <= LINE_TOLERANCE);

  let maxSev: Severity | null = null;
  let posted = 0;
  for (const f of kept) {
    if (alreadyPosted(f.file, f.line)) continue;
    posted++;
    const ok = await gl.postInlineNote(
      projectId,
      prNumber,
      f.file,
      f.line,
      commentBody(f, botName),
      refs,
    );
    if (!ok) {
      await gl.createNote(
        projectId,
        prNumber,
        `_(couldn't anchor inline — ${f.file}:${f.line})_\n\n${commentBody(f, botName)}`,
      );
    }
    if (maxSev === null || RANK[f.severity] > RANK[maxSev]) maxSev = f.severity;
  }

  let summary: string;
  if (kept.length) {
    const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
    for (const f of kept) counts[f.severity]++;
    const rows = [...kept]
      .sort(
        (a, b) =>
          RANK[b.severity] - RANK[a.severity] || a.file.localeCompare(b.file) || a.line - b.line,
      )
      .map((f) => `| ${EMOJI[f.severity]} ${f.severity} | \`${f.file}:${f.line}\` | ${f.title} |`)
      .join("\n");
    summary =
      `## ${botEmoji} ${botName}\n\n${result.summary}\n\n` +
      `### Findings\n\n` +
      `| severity | location | finding |\n|---|---|---|\n${rows}\n\n` +
      `**${counts.critical} critical · ${counts.warning} warning · ${counts.info} info**`;
  } else {
    summary = `## ${botEmoji} ${botName}\n\n✅ No issues found above the confidence threshold.`;
  }

  if (await gl.submitReview(projectId, prNumber, summary)) {
    await gl.editNote(
      projectId,
      prNumber,
      statusId,
      `${STATUS_MARKER}\n${botEmoji} Review complete — see the review summary below.`,
    );
  } else {
    await gl.editNote(projectId, prNumber, statusId, `${STATUS_MARKER}\n${summary}`);
  }

  if (kept.length && maxSev) {
    await gl.addLabels(projectId, prNumber, [LABEL[maxSev]]);
  } else if (!kept.length) {
    await gl.addLabels(projectId, prNumber, ["code-turtle/clean"]);
  }

  // A re-review that produced nothing new is otherwise silent (MCP can't edit;
  // REST edits the old review in place) — say so in the conversation, once per
  // head commit. "Re-review" = earlier finding markers exist on the PR.
  const isReReview = existingMarkers.length > 0;
  if (
    isReReview &&
    posted === 0 &&
    refs.head_sha &&
    !existing.includes(recheckMarker(refs.head_sha))
  ) {
    const short = refs.head_sha.slice(0, 8);
    const msg = kept.length
      ? `${botEmoji} ${botName} re-checked \`${short}\` — no new issues; ${kept.length} earlier finding(s) still apply.`
      : `${botEmoji} ${botName} re-checked \`${short}\` — ✅ no issues found.`;
    await gl.createNote(projectId, prNumber, `${recheckMarker(refs.head_sha)}\n${msg}`);
    log(`recheck note posted for ${short}`);
  }

  log(`posted: ${posted} new, ${kept.length - posted} already on PR`);
}

/** Push-review posting: findings as commit comments on the head commit. Same
 * marker format and ±3 dedup as the PR path — never change either (invariant 1).
 * No status note / labels: those are PR concepts. One summary per commit. */
export async function finalizeCommit(
  forge: Forge,
  projectId: string,
  branch: string,
  headSha: string,
  diffs: FileDiff[],
  result: ReviewResult,
  kept: Finding[],
  log: (msg: string) => void = () => {},
): Promise<void> {
  const botName = reviewerSettings().botName;
  const botEmoji = botName.toLowerCase().includes("turtle") ? "🐢" : "🤖";
  const existing = (await listCommitCommentBodies(forge, projectId, headSha)).join("\n");
  const existingMarkers = [...existing.matchAll(MARKER_RE)].map(
    (m) => [m[1], Number(m[2])] as const,
  );
  const alreadyPosted = (file: string, line: number) =>
    existingMarkers.some(([f, l]) => f === file && Math.abs(l - line) <= LINE_TOLERANCE);
  const patchByFile = new Map(diffs.map((d) => [d.newPath, d.diff]));

  let posted = 0;
  for (const f of kept) {
    if (alreadyPosted(f.file, f.line)) continue;
    posted++;
    const ok = await postCommitComment(forge, projectId, headSha, commentBody(f, botName), {
      path: f.file,
      line: f.line,
      patch: patchByFile.get(f.file) ?? "",
    });
    if (!ok) {
      await postCommitComment(
        forge,
        projectId,
        headSha,
        `_(couldn't anchor inline — ${f.file}:${f.line})_\n\n${commentBody(f, botName)}`,
      );
    }
  }

  if (!existing.includes(REVIEW_MARKER)) {
    let summary: string;
    if (kept.length) {
      const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
      for (const f of kept) counts[f.severity]++;
      const rows = [...kept]
        .sort(
          (a, b) =>
            RANK[b.severity] - RANK[a.severity] || a.file.localeCompare(b.file) || a.line - b.line,
        )
        .map((f) => `| ${EMOJI[f.severity]} ${f.severity} | \`${f.file}:${f.line}\` | ${f.title} |`)
        .join("\n");
      summary =
        `## ${botEmoji} ${botName} — push to \`${branch}\`\n\n${result.summary}\n\n` +
        `### Findings\n\n` +
        `| severity | location | finding |\n|---|---|---|\n${rows}\n\n` +
        `**${counts.critical} critical · ${counts.warning} warning · ${counts.info} info**`;
    } else {
      summary =
        `## ${botEmoji} ${botName} — push to \`${branch}\`\n\n` +
        `✅ No issues found above the confidence threshold.`;
    }
    await postCommitComment(forge, projectId, headSha, `${REVIEW_MARKER}\n${summary}`);
  }

  log(`posted: ${posted} new, ${kept.length - posted} already on commit`);
}

export async function markFailed(
  gl: ForgeClient,
  projectId: string,
  prNumber: number,
  statusId: number | string,
): Promise<void> {
  const botName = reviewerSettings().botName;
  await gl.editNote(
    projectId,
    prNumber,
    statusId,
    `${STATUS_MARKER}\n⚠️ ${botName} hit an error reviewing this MR.`,
  );
}

export { REVIEW_MARKER };
