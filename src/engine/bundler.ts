/** Reconstruct what a human reviewer would open: the changed files, their
 * imports, callers, and matching tests — read at the head commit. */

import { limits } from "./config.js";
import type { ForgeClient } from "./forge.js";
import * as rf from "./repoFiles.js";
import type { ContextBundle, ContextFile, FileDiff, Norms } from "./types.js";

const RANK: Record<string, number> = { changed: 0, import: 1, caller: 2, test: 3 };

const clip = (text: string, limit = 6000) =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;

export async function buildContext(
  gl: ForgeClient, projectId: string, head: string, diffs: FileDiff[], _norms: Norms,
  log: (msg: string) => void = () => {},
): Promise<ContextBundle> {
  const files = new Map<string, ContextFile>();
  const notes: string[] = [];
  const seenSymbols = new Set<string>();

  for (const d of diffs) {
    const path = d.newPath || d.oldPath;
    if (!path || d.deletedFile) continue;
    const lang = rf.langOf(path);
    const full = await gl.getFile(projectId, path, head);
    if (!full) continue;

    if (!files.has(path)) files.set(path, { path, reason: "changed", content: clip(full) });

    // imports — one hop, relative only
    for (const spec of rf.parseImports(full, lang)) {
      for (const cand of rf.resolveImport(spec, path, lang)) {
        if (files.has(cand)) break;
        const body = await gl.getFile(projectId, cand, head);
        if (body) {
          files.set(cand, { path: cand, reason: "import", content: clip(body) });
          break;
        }
      }
    }

    // callers — search repo for exported symbols
    for (const sym of rf.exportedSymbols(full, lang)) {
      if (seenSymbols.has(sym)) continue;
      seenSymbols.add(sym);
      const hits = await gl.searchBlobs(projectId, sym, head).catch(() => []);
      for (const hit of hits.slice(0, 3)) {
        if (hit.path && hit.path !== path && !files.has(hit.path)) {
          const body = await gl.getFile(projectId, hit.path, head);
          if (body) files.set(hit.path, { path: hit.path, reason: "caller", content: clip(body) });
        }
      }
    }

    // tests — convention-based
    let foundTest = false;
    for (const cand of rf.testCandidates(path, lang)) {
      if (files.has(cand)) {
        foundTest = true;
        break;
      }
      const body = await gl.getFile(projectId, cand, head);
      if (body) {
        files.set(cand, { path: cand, reason: "test", content: clip(body) });
        foundTest = true;
        break;
      }
    }
    if (!foundTest && (lang === "ts" || lang === "py")) {
      notes.push(`no matching test file found for ${path}`);
    }
  }

  // rank + budget
  const ranked = [...files.values()].sort((a, b) => (RANK[a.reason] ?? 9) - (RANK[b.reason] ?? 9));
  const kept: ContextFile[] = [];
  let total = 0;
  for (const f of ranked) {
    if (kept.length >= limits.maxContextFiles || total + f.content.length > limits.maxContextChars) break;
    kept.push(f);
    total += f.content.length;
  }
  log(`context: ${kept.length} files, ${total} chars, notes=${notes.length}`);
  return { files: kept, notes };
}
