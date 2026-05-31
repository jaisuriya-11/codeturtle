import logging
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path

import yaml

from shared.settings import get_settings

log = logging.getLogger("code_turtle.config")

_DEFAULTS_PATH = Path(__file__).resolve().parent.parent / "defaults" / "norms.yml"


@dataclass
class EffectiveNorms:
    # mechanical (used in code)
    confidence_threshold: float = 0.7
    max_findings: int = 25
    exclude: list[str] = field(default_factory=list)
    categories: dict[str, bool] = field(default_factory=dict)
    # judgment (sent to the model)
    guidelines: str = ""
    examples: list[dict] = field(default_factory=list)


def _merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def _to_norms(d: dict) -> EffectiveNorms:
    s = get_settings()
    return EffectiveNorms(
        confidence_threshold=float(d.get("confidence_threshold", s.confidence_threshold)),
        max_findings=int(d.get("max_findings", 25)),
        exclude=list(d.get("exclude", [])),
        categories=dict(d.get("categories", {})),
        guidelines=str(d.get("guidelines", "")),
        examples=list(d.get("examples", [])),
    )


async def load_norms(gl, project_id: int, mr: dict) -> EffectiveNorms:
    """defaults  <-  repo .codeturtle.yml  (last wins).

    Note: we intentionally DO NOT honor any `agent`/`key_ref` override from the
    repo file — that would let a fork redirect the reviewer or leak keys. Only
    guidelines/excludes/etc. are taken from the repo.
    """
    base = yaml.safe_load(_DEFAULTS_PATH.read_text()) or {}

    repo_cfg = {}
    ref = (mr.get("diff_refs") or {}).get("head_sha") or mr.get("source_branch")
    if ref:
        raw = await gl.get_file(project_id, ".codeturtle.yml", ref)
        if raw:
            try:
                repo_cfg = yaml.safe_load(raw) or {}
                repo_cfg.pop("agent", None)        # security: never from repo
                repo_cfg.pop("key_ref", None)
                log.info("loaded .codeturtle.yml from repo")
            except yaml.YAMLError as e:
                log.warning(f"ignoring malformed .codeturtle.yml: {e}")

    return _to_norms(_merge(base, repo_cfg))


def is_excluded(path: str, norms: EffectiveNorms) -> bool:
    from os.path import basename
    for pat in norms.exclude:
        # `**/` should mean "any depth, including zero" — fnmatch requires a
        # dir, so also try the pattern with the prefix stripped, and basename.
        stripped = pat[3:] if pat.startswith("**/") else pat
        if (fnmatch(path, pat) or fnmatch(path, stripped)
                or fnmatch(basename(path), stripped)):
            return True
    return False


def apply_excludes(diffs: list[dict], norms: EffectiveNorms) -> list[dict]:
    kept = []
    for d in diffs:
        path = d.get("new_path") or d.get("old_path") or ""
        if not is_excluded(path, norms):
            kept.append(d)
    return kept