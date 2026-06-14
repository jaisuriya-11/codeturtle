/** Review norms, layered low->high: built-in defaults <- global config & packs <-
 * repo .codeturtle.yml (project wins). Global code transforms run last. `agent`/`key_ref`
 * are stripped from repo config and a repo's `extends` may reference packs by NAME only —
 * a fork must never redirect the reviewer, leak keys, escape the dir, or run code. */

import { parse } from "yaml";

import { loadConfig } from "./config.js";
import type { ForgeClient } from "./forge.js";
import {
  closeShape,
  loadPacks,
  loadTransforms,
  mergeNorms,
  safePackName,
} from "./normsRegistry.js";
import type { Forge, MrInfo, NormCtx, Norms, RawNorms } from "./types.js";
import type { FileDiff } from "./types.js";

const DEFAULTS: Norms = {
  confidenceThreshold: 0.7,
  maxFindings: 25,
  exclude: [
    "**/*.lock",
    "**/*.min.js",
    "**/__generated__/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
  ],
  categories: { security: true, bug: true, perf: true, style: true, maintainability: true },
  guidelines: `Review like a careful senior engineer. Prioritise, in order:
1. Security — injection, secrets in code, broken authn/authz, unsafe deserialization.
2. Correctness — null/undefined derefs, off-by-one, race conditions, wrong API usage.
3. Performance — N+1 queries, accidental quadratic loops, sync I/O on a hot path.
4. Maintainability — dead code, misleading names, missing error handling.
Be concrete and kind. Prefer one strong finding over many weak ones.`,
  examples: [],
};

/** Facts the layered loader can pass through to code transforms. */
export interface LoadNormsCtx {
  forge?: Forge;
  diffLines?: number;
}

export async function loadNorms(
  gl: ForgeClient,
  projectId: string,
  mr: MrInfo,
  ctx: LoadNormsCtx = {},
): Promise<Norms> {
  const packs = loadPacks();
  const global = loadConfig().norms ?? {};

  // repo .codeturtle.yml — UNTRUSTED. strip redirect/key fields; `extends` is name-only.
  let repoCfg: RawNorms = {};
  const ref = mr.diffRefs?.head_sha || mr.sourceBranch;
  if (ref) {
    const raw = await gl.getFile(projectId, ".codeturtle.yml", ref).catch(() => null);
    if (raw) {
      try {
        const parsed = (parse(raw) as Record<string, unknown>) ?? {};
        delete parsed.agent; // security: never from repo
        delete parsed.key_ref;
        repoCfg = parsed as RawNorms;
      } catch {
        repoCfg = {};
      }
    }
  }

  // assemble layers, low -> high precedence (project wins on overlapping scalars).
  const layers: { label: string; raw: RawNorms }[] = [{ label: "global", raw: global }];
  for (const name of global.use ?? []) {
    const pack = packs.get(name);
    if (pack) layers.push({ label: name, raw: pack });
  }
  // a repo may pull in packs by NAME only, and only ones already installed locally.
  for (const name of repoCfg.extends ?? []) {
    if (!safePackName(name)) continue; // reject path traversal / non-bare names
    const pack = packs.get(name);
    if (pack) layers.push({ label: name, raw: pack });
  }
  layers.push({ label: "repo", raw: repoCfg });

  let norms = closeShape(DEFAULTS);
  for (const { label, raw } of layers) norms = mergeNorms(norms, raw, label);

  // code transforms run LAST and only when the GLOBAL config activates them — a repo can
  // never trigger code. A broken transform must not kill the review.
  const transforms = await loadTransforms(global.use ?? []);
  if (transforms.length) {
    const tctx: NormCtx = { forge: ctx.forge ?? "github", projectId, mr, diffLines: ctx.diffLines };
    for (const t of transforms) {
      try {
        const out = t.transform(norms, tctx);
        norms = closeShape(out ?? norms);
      } catch {
        // skip a throwing transform
      }
    }
  }

  return closeShape(norms);
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
    if (
      globToRegex(pat).test(path) ||
      globToRegex(stripped).test(path) ||
      globToRegex(stripped).test(basename)
    ) {
      return true;
    }
  }
  return false;
}

export function applyExcludes(diffs: FileDiff[], norms: Norms): FileDiff[] {
  return diffs.filter((d) => !isExcluded(d.newPath || d.oldPath || "", norms));
}
