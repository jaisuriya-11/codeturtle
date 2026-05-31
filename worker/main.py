import logging

from fastapi import FastAPI

from shared.schema import Job

from .pipeline import run_review

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("code_turtle.worker")

app = FastAPI(title="Code Turtle — worker")


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.post("/task")
async def task(job: Job):
    """Cloud Tasks push target. In local mode the queue calls run_review
    directly and this endpoint is unused."""
    await run_review(job)
    return {"done": True}