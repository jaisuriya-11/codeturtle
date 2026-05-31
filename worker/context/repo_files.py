"""Pure, I/O-free heuristics that turn a changed file into a list of
neighbouring repo paths worth fetching. The bundler does the actual fetching.
"""
import posixpath
import re

_TS_JS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
_PY = {".py"}

_TS_EXTS = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"]


def lang_of(path: str) -> str:
    ext = posixpath.splitext(path)[1]
    if ext in _TS_JS:
        return "ts"
    if ext in _PY:
        return "py"
    return "other"


def parse_imports(text: str, lang: str) -> list[str]:
    """Return raw module specifiers imported by the file."""
    specs: list[str] = []
    if lang == "ts":
        specs += re.findall(r"""import\s[^'"]*?from\s+['"]([^'"]+)['"]""", text)
        specs += re.findall(r"""import\s+['"]([^'"]+)['"]""", text)
        specs += re.findall(r"""require\(\s*['"]([^'"]+)['"]\s*\)""", text)
    elif lang == "py":
        specs += re.findall(r"^\s*from\s+([.\w]+)\s+import", text, re.M)
        specs += re.findall(r"^\s*import\s+([.\w]+)", text, re.M)
    return specs


def resolve_import(spec: str, from_path: str, lang: str) -> list[str]:
    """Resolve a *relative* import to candidate repo paths. Bare/stdlib imports
    return [] (we don't fetch node_modules or the standard library)."""
    folder = posixpath.dirname(from_path)
    if lang == "ts":
        if not spec.startswith("."):
            return []  # bare package import
        base = posixpath.normpath(posixpath.join(folder, spec))
        return [base + ext for ext in _TS_EXTS]
    if lang == "py":
        if not spec.startswith("."):
            return []  # treat absolute as external for safety
        rel = spec.lstrip(".").replace(".", "/")
        ups = len(spec) - len(spec.lstrip("."))
        up = "/".join([".."] * (ups - 1)) if ups > 1 else ""
        base = posixpath.normpath(posixpath.join(folder, up, rel))
        return [base + ".py", base + "/__init__.py"]
    return []


def exported_symbols(text: str, lang: str) -> list[str]:
    """Names that other files might call — used to find callers."""
    names: list[str] = []
    if lang == "ts":
        names += re.findall(r"export\s+(?:async\s+)?function\s+(\w+)", text)
        names += re.findall(r"export\s+const\s+(\w+)", text)
        names += re.findall(r"export\s+(?:default\s+)?class\s+(\w+)", text)
    elif lang == "py":
        names += re.findall(r"^\s*def\s+(\w+)", text, re.M)
        names += re.findall(r"^\s*class\s+(\w+)", text, re.M)
    # drop private-ish names, dedupe, keep it short
    seen, out = set(), []
    for n in names:
        if n and not n.startswith("_") and n not in seen:
            seen.add(n)
            out.append(n)
    return out[:6]


def test_candidates(path: str, lang: str) -> list[str]:
    base, ext = posixpath.splitext(path)
    name = posixpath.basename(base)
    folder = posixpath.dirname(path)
    if lang == "ts":
        return [
            f"{base}.test{ext}", f"{base}.spec{ext}",
            posixpath.join(folder, "__tests__", f"{name}.test{ext}"),
            posixpath.join(folder, "__tests__", f"{name}{ext}"),
        ]
    if lang == "py":
        return [
            f"{base}_test.py",
            posixpath.join(folder, f"test_{name}.py"),
            posixpath.join("tests", f"test_{name}.py"),
        ]
    return []