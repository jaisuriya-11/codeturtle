import hmac
import logging

from fastapi import FastAPI, Header, HTTPException, Request

from shared.queue import enqueue
from shared.schema import Job
from shared.settings import get_settings
from worker import state

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("code_turtle.ingest")

app = FastAPI(title="Code Turtle — ingest")


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.post("/webhook")
async def webhook(
    request: Request,
    x_gitlab_token: str | None = Header(default=None),
    x_gitlab_event: str | None = Header(default=None),
    x_gitlab_event_uuid: str | None = Header(default=None),
):
    s = get_settings()
    if not x_gitlab_token or not hmac.compare_digest(x_gitlab_token, s.webhook_secret):
        log.warning("rejected webhook: bad token")
        raise HTTPException(status_code=401, detail="invalid token")
    if x_gitlab_event != "Merge Request Hook":
        return {"skipped": "not an MR event"}
    payload = await request.json()
    attrs = payload.get("object_attributes", {})
    action = attrs.get("action")
    if action not in {"open", "reopen", "update"}:
        return {"skipped": f"action={action}"}
    if await state.seen_event(x_gitlab_event_uuid):
        return {"skipped": "duplicate delivery"}
    project_id = payload["project"]["id"]
    mr_iid = attrs["iid"]
    head_sha = (attrs.get("last_commit") or {}).get("id")
    await state.record_latest(project_id, mr_iid, head_sha)
    job = Job(project_id=project_id, mr_iid=mr_iid, head_sha=head_sha,
              event_uuid=x_gitlab_event_uuid)
    await enqueue(job)

    log.info(f"queued review project={project_id} mr={mr_iid} head={head_sha}")
    return {"queued": True, "project_id": project_id, "mr_iid": mr_iid}