from typing import Protocol

from shared.schema import ContextBundle, ReviewResult


class Reviewer(Protocol):
    async def review(
        self, diff_text: str, context: ContextBundle, norms
    ) -> ReviewResult:
        ...


def get_reviewer(norms) -> Reviewer:
    """Return the configured agent. Today everything routes through the
    OpenAI-compatible adapter (covers Gemini, OpenAI, OpenRouter, Groq, and
    self-hosted models). Add native SDK / BYO-agent adapters here later."""
    from .openai_compat import OpenAICompatReviewer
    return OpenAICompatReviewer()