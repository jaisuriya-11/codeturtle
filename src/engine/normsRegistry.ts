/** The norms "plugin" system: named declarative packs (*.yml) and power-user code
 * transforms (*.mjs), both loaded from the trusted ~/.codeturtle/norms dir, plus the
 * layer-merge rules. A pack is just a reusable RawNorms; a transform is code that runs
 * ONLY when the global config activates it (a repo can never trigger code). */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "yaml";

import { normsDir } from "./config.js";
import type { NormPlugin, Norms, RawNorms } from "./types.js";

/** A pack/transform name must be a bare identifier — no path separators, dots, or
 * traversal. This is the wall that keeps a repo's `extends` from escaping the dir. */
export function safePackName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9_-]+$/.test(name);
}

/** Load every declarative pack from ~/.codeturtle/norms/*.yml, keyed by `name`
 * (fallback: filename). Malformed packs are skipped silently. `agent`/`key_ref` are
 * stripped defensively even though these are trusted-dir files. */
export function loadPacks(): Map<string, RawNorms> {
  const dir = normsDir();
  const packs = new Map<string, RawNorms>();
  if (!existsSync(dir)) return packs;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return packs;
  }
  for (const file of entries) {
    if (!/\.ya?ml$/.test(file)) continue;
    try {
      const cfg = (parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>) ?? {};
      delete cfg.agent;
      delete cfg.key_ref;
      const name = (typeof cfg.name === "string" && cfg.name) || file.replace(/\.ya?ml$/, "");
      if (!safePackName(name)) continue;
      packs.set(name, cfg as RawNorms);
    } catch {
      // skip a malformed pack — hostile-input posture
    }
  }
  return packs;
}

/** Dynamic-import the *.mjs transforms named in `active` (the GLOBAL use list only).
 * Each must default-export `{ name?, transform(norms, ctx) }`; invalid ones are dropped. */
export async function loadTransforms(active: string[]): Promise<NormPlugin[]> {
  const dir = normsDir();
  const out: NormPlugin[] = [];
  if (!existsSync(dir)) return out;
  for (const name of active) {
    if (!safePackName(name)) continue;
    const file = join(dir, `${name}.mjs`);
    if (!existsSync(file)) continue;
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: Partial<NormPlugin> };
      const plugin = mod.default;
      if (plugin && typeof plugin.transform === "function") {
        out.push({
          name: typeof plugin.name === "string" ? plugin.name : name,
          transform: plugin.transform,
        });
      }
    } catch {
      // skip a broken transform — a bad plugin must not kill the review
    }
  }
  return out;
}

function union(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...a, ...b]) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/** Merge one raw layer onto a base. Scalars are last-writer-wins; `categories` shallow-
 * merge; `exclude`/`examples` accumulate (union/concat); `guidelines` append with a source
 * label so each layer's voice reaches the prompt instead of clobbering the baseline. */
export function mergeNorms(base: Norms, layer: RawNorms, label = ""): Norms {
  const merged: Norms = {
    confidenceThreshold: layer.confidence_threshold ?? base.confidenceThreshold,
    maxFindings: layer.max_findings ?? base.maxFindings,
    exclude: union(base.exclude, layer.exclude ?? []),
    categories: { ...base.categories, ...(layer.categories ?? {}) },
    guidelines: base.guidelines,
    examples: [...base.examples, ...(layer.examples ?? [])],
  };
  if (typeof layer.guidelines === "string" && layer.guidelines.trim()) {
    const header = label ? `# ${label}\n` : "";
    merged.guidelines = base.guidelines
      ? `${base.guidelines}\n\n${header}${layer.guidelines}`
      : `${header}${layer.guidelines}`;
  }
  return merged;
}

/** Build a fresh, closed 6-field Norms — strips any stray key a layer or transform added
 * (invariant 2: nothing arbitrary may leak into Norms). */
export function closeShape(n: Norms): Norms {
  return {
    confidenceThreshold: Number(n.confidenceThreshold),
    maxFindings: Number(n.maxFindings),
    exclude: [...(n.exclude ?? [])],
    categories: { ...(n.categories ?? {}) },
    guidelines: String(n.guidelines ?? ""),
    examples: [...(n.examples ?? [])],
  };
}
