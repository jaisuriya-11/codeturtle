import logging

from shared.schema import ContextBundle, ContextFile
from shared.settings import get_settings

from . import repo_files as rf

log = logging.getLogger("code_turtle.context")

_RANK = {"changed": 0, "import": 1, "caller": 2, "test": 3}


def _clip(text: str, limit: int = 6000) -> str:
    return text if len(text) <= limit else text[:limit] + "\n… (truncated)"


async def build_context(gl, project_id: int, head: str, diffs: list[dict], norms) -> ContextBundle:
    """Reconstruct what a human reviewer would open: the changed files, their
    imports, who calls them, and the matching tests — read at the head commit."""
    s = get_settings()
    files: dict[str, ContextFile] = {}    # path -> file (dedupe)
    notes: list[str] = []
    seen_symbols: set[str] = set()

    for d in diffs:
        path = d.get("new_path") or d.get("old_path")
        if not path or d.get("deleted_file"):
            continue
        lang = rf.lang_of(path)
        full = await gl.get_file(project_id, path, head)
        if not full:
            continue

        # 1. enclosing scope — the whole changed file (the function lives here)
        files.setdefault(path, ContextFile(path=path, reason="changed", content=_clip(full)))

        # 2. imports — one hop, relative only
        for spec in rf.parse_imports(full, lang):
            for cand in rf.resolve_import(spec, path, lang):
                if cand in files:
                    break
                body = await gl.get_file(project_id, cand, head)
                if body:
                    files[cand] = ContextFile(path=cand, reason="import", content=_clip(body))
                    break

        # 3. callers — search the repo for the file's exported symbols
        for sym in rf.exported_symbols(full, lang):
            if sym in seen_symbols:
                continue
            seen_symbols.add(sym)
            try:
                hits = await gl.search_blobs(project_id, sym, head)
            except Exception as e:
                log.warning(f"caller search failed for {sym}: {e}")
                hits = []
            for hit in hits[:3]:
                hp = hit.get("path")
                if hp and hp != path and hp not in files:
                    body = await gl.get_file(project_id, hp, head)
                    if body:
                        files[hp] = ContextFile(path=hp, reason="caller", content=_clip(body))

        # 4. tests — convention-based
        found_test = False
        for cand in rf.test_candidates(path, lang):
            if cand in files:
                found_test = True
                break
            body = await gl.get_file(project_id, cand, head)
            if body:
                files[cand] = ContextFile(path=cand, reason="test", content=_clip(body))
                found_test = True
                break
        if not found_test and lang in ("ts", "py"):
            notes.append(f"no matching test file found for {path}")

    # 5. rank + budget
    ranked = sorted(files.values(), key=lambda f: _RANK.get(f.reason, 9))
    kept, total = [], 0
    for f in ranked:
        if len(kept) >= s.max_context_files or total + len(f.content) > s.max_context_chars:
            break
        kept.append(f)
        total += len(f.content)

    log.info(f"context: {len(kept)} files, {total} chars, notes={len(notes)}")
    return ContextBundle(files=kept, notes=notes)