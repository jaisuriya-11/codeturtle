import logging

from shared.schema import Finding, ReviewResult

from .gitlab_client import STATUS_MARKER, GitLabClient, finding_marker

log = logging.getLogger("code_turtle.poster")

LABEL = {
    "critical": "code-turtle/critical",
    "warning": "code-turtle/warning",
    "info": "code-turtle/info",
}
RANK = {"info": 0, "warning": 1, "critical": 2}
EMOJI = {"critical": "🛑", "warning": "⚠️", "info": "💡"}


def _comment_body(f: Finding) -> str:
    body = (
        f"{finding_marker(f.file, f.line)}\n"
        f"{EMOJI.get(f.severity, '💬')} **{f.title}** "
        f"`{f.category}` _(confidence {f.confidence:.2f})_\n\n{f.comment}"
    )
    if f.suggestion:
        body += f"\n\n**Suggestion**\n\n{f.suggestion}"
    body += "\n\n---\n_🐢 Code Turtle_"
    return body


async def post_status(gl: GitLabClient, project_id: int, mr_iid: int, text: str) -> int:
    return await gl.post_status(project_id, mr_iid, text)


async def finalize(
    gl: GitLabClient, project_id: int, mr_iid: int, refs: dict,
    result: ReviewResult, kept: list[Finding], status_id: int,
):
    # idempotency: don't repost a finding the bot already left (retry-safe)
    existing = "\n".join(n.get("body", "") for n in await gl.list_notes(project_id, mr_iid))

    max_sev = None
    for f in kept:
        if finding_marker(f.file, f.line) in existing:
            continue
        ok = await gl.post_inline_note(project_id, mr_iid, f.file, f.line, _comment_body(f), refs)
        if not ok:
            await gl.create_note(
                project_id, mr_iid,
                f"_(couldn't anchor inline — {f.file}:{f.line})_\n\n" + _comment_body(f),
            )
        if max_sev is None or RANK[f.severity] > RANK[max_sev]:
            max_sev = f.severity

    # edit the sticky status note into the final summary
    if kept:
        counts = {"critical": 0, "warning": 0, "info": 0}
        for f in kept:
            counts[f.severity] += 1
        summary = (
            f"{STATUS_MARKER}\n### 🐢 Code Turtle review\n\n{result.summary}\n\n"
            f"- 🛑 critical: **{counts['critical']}**\n"
            f"- ⚠️ warnings: **{counts['warning']}**\n"
            f"- 💡 info: **{counts['info']}**"
        )
        await gl.edit_note(project_id, mr_iid, status_id, summary)
        if max_sev:
            await gl.add_labels(project_id, mr_iid, [LABEL[max_sev]])
    else:
        await gl.edit_note(
            project_id, mr_iid, status_id,
            f"{STATUS_MARKER}\n### 🐢 Code Turtle review\n\n"
            "✅ No issues found above the confidence threshold.",
        )
        await gl.add_labels(project_id, mr_iid, ["code-turtle/clean"])


async def mark_failed(gl: GitLabClient, project_id: int, mr_iid: int, status_id: int):
    await gl.edit_note(
        project_id, mr_iid, status_id,
        f"{STATUS_MARKER}\n⚠️ Code Turtle hit an error reviewing this MR.",
    )