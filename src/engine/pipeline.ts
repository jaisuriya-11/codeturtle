/** Core review loop: superseding check, lock, context bundle, LLM call, post. */

import { buildContext } from "./bundler.js";
import { limits } from "./config.js";
import { getForgeClient, getRestForgeClient } from "./forge.js";
import { compareDiffs } from "./forgeCommits.js";
import { applyExcludes, loadNorms } from "./norms.js";
import { finalize, finalizeCommit, markFailed, snapFindings } from "./poster.js";
import { review } from "./reviewer.js";
import * as state from "./state.js";
import type { FileDiff, Job, MrInfo, PushJob } from "./types.js";

export type Logger = (msg: string) => void;

function formatDiff(diffs: FileDiff[], maxChars: number): string {
  const parts: string[] = [];
  let total = 0;
  for (const d of diffs) {
    const chunk = `### FILE: ${d.newPath || d.oldPath}\n${d.diff}\n`;
    if (total + chunk.length > maxChars) {
      parts.push("### (truncated — diff too large)");
      break;
    }
    parts.push(chunk);
    total += chunk.length;
  }
  return parts.join("\n");
}

export async function runReview(job: Job, log: Logger = console.log): Promise<void> {
  const { projectId, prNumber, headSha } = job;
  if (!state.isLatest(projectId, prNumber, headSha)) {
    log(`pr=${prNumber} superseded; skipping ${headSha}`);
    return;
  }
  if (!state.acquireLock(projectId, prNumber)) {
    log(`pr=${prNumber} already locked; skipping`);
    return;
  }

  const gl = await getForgeClient(job.forge);
  let statusId: number | string | null = null;
  try {
    statusId = await gl.postStatus(projectId, prNumber, "🐢 **Code Turtle** is reviewing this MR…");
    const mr = await gl.getMr(projectId, prNumber);
    const refs = mr.diffRefs;
    const headRef = refs.head_sha || headSha;
    const diffs = await gl.getDiffs(projectId, prNumber);
    if (!diffs.length) {
      await gl.editNote(projectId, prNumber, statusId, "<!-- ct:status -->\n🐢 Nothing to review.");
      return;
    }
    const norms = await loadNorms(gl, projectId, mr);
    const filtered = applyExcludes(diffs, norms);
    if (!filtered.length) {
      await gl.editNote(projectId, prNumber, statusId,
        "<!-- ct:status -->\n🐢 All changed files are excluded by norms.");
      return;
    }
    const context = await buildContext(gl, projectId, headRef, filtered, norms, log);
    const result = await review(formatDiff(filtered, limits.maxDiffChars), context, norms, log);
    let kept = result.findings.filter((f) => f.confidence >= norms.confidenceThreshold);
    kept = kept.slice(0, norms.maxFindings);
    kept = snapFindings(filtered, kept);
    log(`pr=${prNumber} found=${result.findings.length} kept=${kept.length}`);
    await finalize(gl, projectId, prNumber, refs, result, kept, statusId, log);
  } catch (e) {
    log(`review failed pr=${prNumber}: ${e instanceof Error ? e.message : e}`);
    if (statusId != null) await markFailed(gl, projectId, prNumber, statusId).catch(() => {});
  } finally {
    await gl.close();
    state.releaseLock(projectId, prNumber);
  }
}

/** Push-review entrypoint: a branch push with no open PR. Same lock +
 * superseding discipline as runReview, keyed by `branch:<name>` (invariant 7).
 * Findings land as commit comments on the head commit. */
export async function runPushReview(job: PushJob, log: Logger = console.log): Promise<void> {
  const { forge, projectId, branch, headSha, baseSha } = job;
  const ref = `branch:${branch}`;
  if (!state.isLatest(projectId, ref, headSha)) {
    log(`branch=${branch} superseded; skipping ${headSha}`);
    return;
  }
  if (!state.acquireLock(projectId, ref)) {
    log(`branch=${branch} already locked; skipping`);
    return;
  }

  const gl = await getRestForgeClient(forge);
  try {
    const diffs = await compareDiffs(forge, projectId, baseSha, headSha);
    if (!diffs.length) {
      log(`branch=${branch} nothing to review`);
      return;
    }
    // norms loader only needs a ref to read .codeturtle.yml from
    const mrLike: MrInfo = {
      sourceBranch: branch, targetBranch: "", headSha,
      diffRefs: { head_sha: headSha, base_sha: baseSha, start_sha: baseSha },
    };
    const norms = await loadNorms(gl, projectId, mrLike);
    const filtered = applyExcludes(diffs, norms);
    if (!filtered.length) {
      log(`branch=${branch} all changed files excluded by norms`);
      return;
    }
    const context = await buildContext(gl, projectId, headSha, filtered, norms, log);
    const result = await review(formatDiff(filtered, limits.maxDiffChars), context, norms, log);
    let kept = result.findings.filter((f) => f.confidence >= norms.confidenceThreshold);
    kept = kept.slice(0, norms.maxFindings);
    kept = snapFindings(filtered, kept);
    log(`branch=${branch} found=${result.findings.length} kept=${kept.length}`);
    await finalizeCommit(forge, projectId, branch, headSha, filtered, result, kept, log);
  } catch (e) {
    log(`review failed branch=${branch}: ${e instanceof Error ? e.message : e}`);
  } finally {
    await gl.close();
    state.releaseLock(projectId, ref);
  }
}
