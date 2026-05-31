"""Shared coordination state.

This is the in-memory (single-process) backend used for local development.
The function signatures are the interface a production backend (Firestore,
Redis) must implement — swap the bodies, keep the API.
"""
import asyncio
import time

_seen_events: dict[str, float] = {}        # event_uuid -> ts (dedupe)
_latest_commit: dict[tuple, str] = {}       # (project, iid) -> head_sha (supersede)
_locks: dict[tuple, float] = {}             # (project, iid) -> lease expiry ts
_guard = asyncio.Lock()

_SEEN_TTL = 3600       # forget event ids after an hour
_LOCK_TTL = 600        # a review lease lasts 10 minutes


async def seen_event(event_uuid: str | None) -> bool:
    """Return True if we've already processed this delivery (and mark it seen)."""
    if not event_uuid:
        return False
    async with _guard:
        now = time.time()
        for k, ts in list(_seen_events.items()):
            if now - ts > _SEEN_TTL:
                _seen_events.pop(k, None)
        if event_uuid in _seen_events:
            return True
        _seen_events[event_uuid] = now
        return False


async def record_latest(project_id: int, mr_iid: int, head_sha: str | None) -> None:
    if head_sha:
        async with _guard:
            _latest_commit[(project_id, mr_iid)] = head_sha


async def is_latest(project_id: int, mr_iid: int, head_sha: str | None) -> bool:
    """A job is stale if a newer commit has been recorded for the same MR."""
    if not head_sha:
        return True
    async with _guard:
        latest = _latest_commit.get((project_id, mr_iid))
        return latest is None or latest == head_sha


async def acquire_lock(project_id: int, mr_iid: int) -> bool:
    key = (project_id, mr_iid)
    async with _guard:
        now = time.time()
        exp = _locks.get(key)
        if exp and exp > now:
            return False
        _locks[key] = now + _LOCK_TTL
        return True


async def release_lock(project_id: int, mr_iid: int) -> None:
    async with _guard:
        _locks.pop((project_id, mr_iid), None)