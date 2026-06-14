/** Polling trigger — review on PR raise, on every PR push, and on pushes to
 * branches with no open PR (commit-comment reviews). Baselines already-open
 * PRs and existing branches on the first cycle, then reacts to changes. */

import { describeError, getForgeClient } from "./forge.js";
import { listBranches } from "./forgeCommits.js";
import { runPushReview, runReview, type Logger } from "./pipeline.js";
import * as state from "./state.js";
import type { Forge, Job, PushJob } from "./types.js";

export function parseTarget(target: string): { forge: Forge; repo: string } {
  const idx = target.indexOf(":");
  const forge = (idx === -1 ? "" : target.slice(0, idx)).toLowerCase() as Forge;
  const repo = idx === -1 ? "" : target.slice(idx + 1);
  if (!["github", "gitlab"].includes(forge) || !repo) {
    throw new Error(`Bad target ${target}; expected forge:repo (e.g. github:owner/repo)`);
  }
  return { forge, repo };
}

export interface WatchOptions {
  intervalSec: number;
  reviewExisting?: boolean;
  /** also watch branches without an open PR (default on) */
  branches?: boolean;
  log?: Logger;
  signal?: AbortSignal;
  onJob?: (job: Job) => void;
  onPushJob?: (job: PushJob) => void;
}

export async function watch(targets: string[], opts: WatchOptions): Promise<void> {
  const log = opts.log ?? console.log;
  // one malformed target in config must not kill the whole watcher
  const parsed: { forge: Forge; repo: string }[] = [];
  for (const t of targets) {
    try {
      parsed.push(parseTarget(t));
    } catch (e) {
      log(`skipping bad watch target "${t}": ${e instanceof Error ? e.message : e}`);
    }
  }
  const seen = new Map<string, string>();
  const seenBranches = new Map<string, string>();
  let firstCycle = true;

  log(`watching ${parsed.length} repo(s) every ${opts.intervalSec}s`);
  while (!opts.signal?.aborted) {
    const jobs: Job[] = [];
    const pushJobs: PushJob[] = [];
    for (const { forge, repo } of parsed) {
      if (opts.signal?.aborted) break;
      try {
        const client = await getForgeClient(forge);
        let openPrs: { iid: number; headSha: string }[] = [];
        try {
          if (opts.signal?.aborted) break;
          openPrs = await client.listOpenPrs(repo);
          for (const pr of openPrs) {
            if (opts.signal?.aborted) break;
            const key = `${forge}:${repo}#${pr.iid}`;
            if (seen.get(key) === pr.headSha) continue;
            const isNew = !seen.has(key);
            seen.set(key, pr.headSha);
            if (firstCycle && !opts.reviewExisting) {
              log(`baseline ${key} @ ${pr.headSha.slice(0, 8)}`);
              continue;
            }
            log(`${isNew ? "new PR" : "new push"} ${key} — queueing review`);
            state.recordLatest(repo, pr.iid, pr.headSha);
            jobs.push({ forge, projectId: repo, prNumber: pr.iid, headSha: pr.headSha });
          }
        } finally {
          await client.close();
        }

        // branch pushes with no open PR → commit-comment review. A branch whose
        // head matches an open PR head is the PR's source branch — PR path owns it.
        if (opts.branches !== false && !opts.signal?.aborted) {
          const prHeads = new Set(openPrs.map((p) => p.headSha));
          for (const b of await listBranches(forge, repo)) {
            if (opts.signal?.aborted) break;
            if (!b.sha) continue;
            const bkey = `${forge}:${repo}@${b.name}`;
            const prev = seenBranches.get(bkey);
            if (prev === b.sha) continue;
            seenBranches.set(bkey, b.sha);
            if (prHeads.has(b.sha)) continue;
            if ((firstCycle && !opts.reviewExisting) || !prev) {
              // first sight of the branch — no base SHA to diff a push against
              log(`baseline ${bkey} @ ${b.sha.slice(0, 8)}`);
              continue;
            }
            log(`new push ${bkey} — queueing review`);
            state.recordLatest(repo, `branch:${b.name}`, b.sha);
            pushJobs.push({
              forge,
              projectId: repo,
              branch: b.name,
              headSha: b.sha,
              baseSha: prev,
            });
          }
        }
      } catch (e) {
        if (!opts.signal?.aborted) {
          log(`poll failed ${forge}:${repo}: ${describeError(e)}`);
        }
      }
    }

    if (opts.signal?.aborted) break;

    // runReview/runPushReview catch internally; the .catch is a last-resort
    // guard — an unhandled rejection here would take down the process
    for (const job of jobs) {
      if (opts.signal?.aborted) break;
      opts.onJob?.(job);
      runReview(job, log).catch((e) =>
        log(`review crashed pr=${job.prNumber}: ${describeError(e)}`),
      );
    }
    for (const job of pushJobs) {
      if (opts.signal?.aborted) break;
      opts.onPushJob?.(job);
      runPushReview(job, log).catch((e) =>
        log(`review crashed branch=${job.branch}: ${describeError(e)}`),
      );
    }
    firstCycle = false;

    if (opts.signal?.aborted) break;

    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        opts.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, opts.intervalSec * 1000);
      opts.signal?.addEventListener("abort", onAbort);
    });
  }
}
