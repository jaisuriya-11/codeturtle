/** Pure heuristics: changed file -> neighbouring repo paths worth fetching. */

import { posix } from "node:path";

const TS_JS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const TS_EXTS = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

export type Lang = "ts" | "py" | "other";

export function langOf(path: string): Lang {
  const ext = posix.extname(path);
  if (TS_JS.has(ext)) return "ts";
  if (ext === ".py") return "py";
  return "other";
}

export function parseImports(text: string, lang: Lang): string[] {
  const specs: string[] = [];
  const push = (re: RegExp) => {
    for (const m of text.matchAll(re)) specs.push(m[1]);
  };
  if (lang === "ts") {
    push(/import\s[^'"]*?from\s+['"]([^'"]+)['"]/g);
    push(/import\s+['"]([^'"]+)['"]/g);
    push(/require\(\s*['"]([^'"]+)['"]\s*\)/g);
  } else if (lang === "py") {
    push(/^\s*from\s+([.\w]+)\s+import/gm);
    push(/^\s*import\s+([.\w]+)/gm);
  }
  return specs;
}

export function resolveImport(spec: string, fromPath: string, lang: Lang): string[] {
  const folder = posix.dirname(fromPath);
  if (lang === "ts") {
    if (!spec.startsWith(".")) return [];
    const base = posix.normalize(posix.join(folder, spec));
    return TS_EXTS.map((ext) => base + ext);
  }
  if (lang === "py") {
    if (!spec.startsWith(".")) return [];
    const rel = spec.replace(/^\.+/, "").replace(/\./g, "/");
    const ups = spec.length - spec.replace(/^\.+/, "").length;
    const up =
      ups > 1
        ? Array(ups - 1)
            .fill("..")
            .join("/")
        : "";
    const base = posix.normalize(posix.join(folder, up, rel));
    return [`${base}.py`, `${base}/__init__.py`];
  }
  return [];
}

export function exportedSymbols(text: string, lang: Lang): string[] {
  const names: string[] = [];
  const push = (re: RegExp) => {
    for (const m of text.matchAll(re)) names.push(m[1]);
  };
  if (lang === "ts") {
    push(/export\s+(?:async\s+)?function\s+(\w+)/g);
    push(/export\s+const\s+(\w+)/g);
    push(/export\s+(?:default\s+)?class\s+(\w+)/g);
  } else if (lang === "py") {
    push(/^\s*def\s+(\w+)/gm);
    push(/^\s*class\s+(\w+)/gm);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (n && !n.startsWith("_") && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.slice(0, 6);
}

export function testCandidates(path: string, lang: Lang): string[] {
  const ext = posix.extname(path);
  const base = path.slice(0, -ext.length || undefined);
  const name = posix.basename(base);
  const folder = posix.dirname(path);
  if (lang === "ts") {
    return [
      `${base}.test${ext}`,
      `${base}.spec${ext}`,
      posix.join(folder, "__tests__", `${name}.test${ext}`),
      posix.join(folder, "__tests__", `${name}${ext}`),
    ];
  }
  if (lang === "py") {
    return [
      `${base}_test.py`,
      posix.join(folder, `test_${name}.py`),
      posix.join("tests", `test_${name}.py`),
    ];
  }
  return [];
}
