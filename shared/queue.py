import asyncio
import json
import logging

from .schema import Job
from .settings import get_settings

log = logging.getLogger("code_turtle.queue")


async def enqueue(job: Job) -> None:
    """Hand a review job to the worker.

    local      -> run the worker pipeline in-process (single-process dev mode).
    cloudtasks -> create a Cloud Tasks task that POSTs to the worker service.
    """
    s = get_settings()
    if s.queue_backend == "cloudtasks":
        _enqueue_cloudtasks(job)
    else:
        # Lazy import avoids a circular import at module load time.
        from worker.pipeline import run_review
        asyncio.create_task(run_review(job))


def _enqueue_cloudtasks(job: Job) -> None:
    # Optional dependency — only needed when QUEUE_BACKEND=cloudtasks.
    from google.cloud import tasks_v2  # type: ignore

    s = get_settings()
    client = tasks_v2.CloudTasksClient()
    task = {
        "http_request": {
            "http_method": tasks_v2.HttpMethod.POST,
            "url": f"{s.worker_url}/task",
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(job.model_dump()).encode(),
        }
    }
    client.create_task(parent=s.cloudtasks_queue, task=task)
    log.info(f"enqueued cloudtasks job mr={job.mr_iid}")