import logging

from shared.schema import Job

from . import poster, state
from .config import apply_excludes, load_norms
from .context.bundler import build_context
from .gitlab_client import GitLabClient
from .reviewers.base import get_reviewer
from .reviewers.openai_compat import OpenAICompatReviewer 

log = logging.getLogger("code_turtle.pipeline")


def _format_diff(diffs: list[dict], max_chars: int) -> str:
    parts, total = [], 0
    for d in diffs:
        path = d.get("new_path") or d.get("old_path")
        chunk = f"### FILE: {path}\n{d.get('diff', '')}\n"
        if total + len(chunk) > max_chars:
            parts.append("### (truncated — diff too large)")
            break
        parts.append(chunk)
        total += len(chunk)
    return "\n".join(parts)


async def run_review(job: Job):
    from shared.settings import get_settings
    s = get_settings()
    p, iid, head = job.project_id, job.mr_iid, job.head_sha
    if not await state.is_latest(p, iid, head):
        log.info(f"mr={iid} superseded; skipping {head}")
        return
    if not await state.acquire_lock(p, iid):
        log.info(f"mr={iid} already locked; skipping")
        return

    gl = GitLabClient()
    status_id = None
    try:
        status_id = await poster.post_status(gl, p, iid, "🐢 **Code Turtle** is reviewing this MR…")
        mr = await gl.get_mr(p, iid)
        refs = mr["diff_refs"]                      
        head_ref = refs.get("head_sha") or head
        diffs = await gl.get_diffs(p, iid)
        if not diffs:
            await gl.edit_note(p, iid, status_id, "<!-- ct:status -->\n🐢 Nothing to review.")
            return
        norms = await load_norms(gl, p, mr)          
        diffs = apply_excludes(diffs, norms)         
        if not diffs:
            await gl.edit_note(p, iid, status_id, "<!-- ct:status -->\n🐢 All changed files are excluded by norms.")
            return
        context = await build_context(gl, p, head_ref, diffs, norms)  
        reviewer = get_reviewer(norms)                                 
        result = await reviewer.review(_format_diff(diffs, s.max_diff_chars), context, norms)
        kept = [f for f in result.findings if f.confidence >= norms.confidence_threshold]
        kept = kept[: norms.max_findings]
        log.info(f"mr={iid} found={len(result.findings)} kept={len(kept)}")
        await poster.finalize(gl, p, iid, refs, result, kept, status_id)

    except Exception as e:
        log.exception(f"review failed mr={iid}: {e}")
        if status_id:
            try:
                await poster.mark_failed(gl, p, iid, status_id)
            except Exception:
                pass
    finally:
        await gl.close()
        await state.release_lock(p, iid)