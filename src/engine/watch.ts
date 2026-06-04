/** Polling trigger — review on PR raise and on every push. Baselines
 * already-open PRs on the first cycle, then reacts to changes. */

import { getForgeClient } from "./forge.js";
import { runReview, type Logger } from "./pipeline.js";
import * as state from "./state.js";
import type { Forge, Job } from "./types.js";

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
  log?: Logger;
  signal?: AbortSignal;
  onJob?: (job: Job) => void;
}

export async function watch(targets: string[], opts: WatchOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const parsed = targets.map(parseTarget);
  const seen = new Map<string, string>();
  let firstCycle = true;

  log(`watching ${parsed.length} repo(s) every ${opts.intervalSec}s`);
  while (!opts.signal?.aborted) {
    const jobs: Job[] = [];
    for (const { forge, repo } of parsed) {
      if (opts.signal?.aborted) break;
      try {
        const client = await getForgeClient(forge);
        try {
          if (opts.signal?.aborted) break;
          for (const pr of await client.listOpenPrs(repo)) {
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
      } catch (e) {
        if (!opts.signal?.aborted) {
          log(`poll failed ${forge}:${repo}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    if (opts.signal?.aborted) break;

    for (const job of jobs) {
      if (opts.signal?.aborted) break;
      opts.onJob?.(job);
      void runReview(job, log);
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

