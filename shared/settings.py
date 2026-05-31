import os
from dataclasses import dataclass
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    # GitLab
    gitlab_url: str
    gitlab_token: str
    webhook_secret: str
    # Reviewer (OpenAI-compatible; defaults point at Gemini)
    reviewer_base_url: str
    reviewer_api_key: str
    reviewer_model: str
    # Behaviour
    confidence_threshold: float
    max_diff_chars: int
    # Context budget (pillar 3)
    max_context_files: int
    max_context_chars: int
    # Plumbing
    queue_backend: str        # "local" (in-process) | "cloudtasks"
    worker_url: str           # used only by the cloudtasks backend
    cloudtasks_queue: str     # projects/.../locations/.../queues/...


@lru_cache
def get_settings() -> Settings:
    reviewer_key = os.environ.get("REVIEWER_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not reviewer_key:
        raise RuntimeError("Set REVIEWER_API_KEY (or GEMINI_API_KEY) in your environment / .env")
    return Settings(
        gitlab_url=os.environ.get("GITLAB_URL", "https://gitlab.com"),
        gitlab_token=os.environ["GITLAB_TOKEN"],
        webhook_secret=os.environ["WEBHOOK_SECRET"],
        reviewer_base_url=os.environ.get(
            "REVIEWER_BASE_URL",
            "https://generativelanguage.googleapis.com/v1beta/openai/",
        ),
        reviewer_api_key=reviewer_key,
        reviewer_model=os.environ.get("REVIEWER_MODEL", "gemini-2.5-flash"),
        confidence_threshold=float(os.environ.get("CONFIDENCE_THRESHOLD", "0.7")),
        max_diff_chars=int(os.environ.get("MAX_DIFF_CHARS", "40000")),
        max_context_files=int(os.environ.get("MAX_CONTEXT_FILES", "12")),
        max_context_chars=int(os.environ.get("MAX_CONTEXT_CHARS", "40000")),
        queue_backend=os.environ.get("QUEUE_BACKEND", "local"),
        worker_url=os.environ.get("WORKER_URL", ""),
        cloudtasks_queue=os.environ.get("CLOUDTASKS_QUEUE", ""),
    )