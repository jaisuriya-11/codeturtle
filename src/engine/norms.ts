/** Review norms: built-in defaults <- repo .codeturtle.yml (last wins).
 * `agent`/`key_ref` are stripped from repo config — a fork must not be able to
 * redirect the reviewer or leak keys. */

import { parse } from "yaml";

import type { ForgeClient } from "./forge.js";
import type { FileDiff, MrInfo, Norms } from "./types.js";

const DEFAULTS: Norms = {
  confidenceThreshold: 0.7,
  maxFindings: 25,
  exclude: ["**/*.lock", "**/*.min.js", "**/__generated__/**", "**/node_modules/**", "**/dist/**", "**/build/**"],
  categories: { security: true, bug: true, perf: true, style: true, maintainability: true },
  guidelines: `Review like a careful senior engineer. Prioritise, in order:
1. Security — injection, secrets in code, broken authn/authz, unsafe deserialization.
2. Correctness — null/undefined derefs, off-by-one, race conditions, wrong API usage.
3. Performance — N+1 queries, accidental quadratic loops, sync I/O on a hot path.
4. Maintainability — dead code, misleading names, missing error handling.
Be concrete and kind. Prefer one strong finding over many weak ones.`,
  examples: [],
};

export async function loadNorms(gl: ForgeClient, projectId: string, mr: MrInfo): Promise<Norms> {
  let repoCfg: Record<string, unknown> = {};
  const ref = mr.diffRefs?.head_sha || mr.sourceBranch;
  if (ref) {
    const raw = await gl.getFile(projectId, ".codeturtle.yml", ref).catch(() => null);
    if (raw) {
      try {
        repoCfg = (parse(raw) as Record<string, unknown>) ?? {};
        delete repoCfg.agent; // security: never from repo
        delete repoCfg.key_ref;
      } catch {
        repoCfg = {};
      }
    }
  }
  return {
    confidenceThreshold: Number(repoCfg.confidence_threshold ?? DEFAULTS.confidenceThreshold),
    maxFindings: Number(repoCfg.max_findings ?? DEFAULTS.maxFindings),
    exclude: (repoCfg.exclude as string[]) ?? DEFAULTS.exclude,
    categories: { ...DEFAULTS.categories, ...((repoCfg.categories as Record<string, boolean>) ?? {}) },
    guidelines: String(repoCfg.guidelines ?? DEFAULTS.guidelines),
    examples: (repoCfg.examples as Norms["examples"]) ?? [],
  };
}

function globToRegex(pat: string): RegExp {
  const esc = pat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${esc}$`);
}

export function isExcluded(path: string, norms: Norms): boolean {
  const basename = path.split("/").pop() ?? path;
  for (const pat of norms.exclude) {
    const stripped = pat.startsWith("**/") ? pat.slice(3) : pat;
    if (globToRegex(pat).test(path) || globToRegex(stripped).test(path) || globToRegex(stripped).test(basename)) {
      return true;
    }
  }
  return false;
}

export function applyExcludes(diffs: FileDiff[], norms: Norms): FileDiff[] {
  return diffs.filter((d) => !isExcluded(d.newPath || d.oldPath || "", norms));
}
