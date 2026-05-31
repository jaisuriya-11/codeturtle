import json
import logging

from openai import AsyncOpenAI
from pydantic import ValidationError

from shared.schema import ContextBundle, Finding, ReviewResult
from shared.settings import get_settings

log = logging.getLogger("code_turtle.reviewer")

_BASE_PROMPT = """You are a senior engineer reviewing a merge-request diff.

You are given: (a) the surrounding codebase context (the changed files, their
imports, callers, and tests), and (b) the diff itself. Use the context to judge
whether each change is actually correct — e.g. if a function's return shape
changed, check the callers shown.

Hard rules:
- Only comment on lines ADDED in the diff (prefixed '+').
- Use the new-file line number from the hunk header (@@ -a,b +c,d @@).
- Set confidence honestly (0.0-1.0); low-confidence guesses are dropped.
- One finding per issue. Be concrete, short, and kind.
- If the diff is clean, return an empty findings list.

Respond with ONLY a JSON object — no prose, no markdown fences:
{"findings": [{"file","line","severity","category","confidence","title","comment","suggestion"}],
 "summary": "one-line overview"}
severity ∈ critical|warning|info ; category ∈ security|bug|perf|style|maintainability"""


def _system_prompt(norms) -> str:
    parts = [_BASE_PROMPT]
    if norms.guidelines:
        parts.append("TEAM GUIDELINES (follow these):\n" + norms.guidelines)
    if norms.examples:
        ex = "\n".join(f"- BAD: {e.get('bad','')}\n  WHY: {e.get('why','')}" for e in norms.examples)
        parts.append("EXAMPLES OF ISSUES THIS TEAM CARES ABOUT:\n" + ex)
    enabled = [c for c, on in norms.categories.items() if on]
    if enabled:
        parts.append("Only report these categories: " + ", ".join(enabled) + ".")
    return "\n\n".join(parts)


class OpenAICompatReviewer:
    async def review(self, diff_text: str, context: ContextBundle, norms) -> ReviewResult:
        s = get_settings()
        client = AsyncOpenAI(api_key=s.reviewer_api_key, base_url=s.reviewer_base_url)
        user = (
            "## Surrounding codebase context\n" + context.render()
            + "\n\n## Diff to review\n" + diff_text
        )
        messages = [
            {"role": "system", "content": _system_prompt(norms)},
            {"role": "user", "content": user},
        ]
        log.info(f"reviewing model={s.reviewer_model} diff={len(diff_text)} ctx_files={len(context.files)}")

        try:
            resp = await client.chat.completions.create(
                model=s.reviewer_model, messages=messages, temperature=0.2,
                response_format={"type": "json_object"},
            )
        except Exception as e:
            log.warning(f"json mode failed ({e}); retrying without response_format")
            resp = await client.chat.completions.create(
                model=s.reviewer_model, messages=messages, temperature=0.2,
            )

        raw = (resp.choices[0].message.content or "{}").strip()
        if raw.startswith("```"):
            raw = raw.strip("`")
            raw = raw[raw.find("{"):]
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            log.error(f"reviewer returned non-JSON: {raw[:300]}")
            return ReviewResult(findings=[], summary="Reviewer output could not be parsed.")

        findings = []
        for f in data.get("findings", []):
            try:
                findings.append(Finding(**f))
            except ValidationError:
                continue
        return ReviewResult(findings=findings, summary=data.get("summary", ""))