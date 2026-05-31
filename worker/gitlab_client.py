import logging
from typing import Any
from urllib.parse import quote

import httpx

from shared.settings import get_settings

log = logging.getLogger("code_turtle.gitlab")

STATUS_MARKER = "<!-- ct:status -->"


def finding_marker(file: str, line: int) -> str:
    return f"<!-- ct:f:{file}:{line} -->"


class GitLabClient:
    def __init__(self):
        s = get_settings()
        self.base = f"{s.gitlab_url}/api/v4"
        self.client = httpx.AsyncClient(
            headers={"PRIVATE-TOKEN": s.gitlab_token}, timeout=30
        )

    async def close(self):
        await self.client.aclose()

    async def get_mr(self, project_id: int, mr_iid: int) -> dict[str, Any]:
        r = await self.client.get(f"{self.base}/projects/{project_id}/merge_requests/{mr_iid}")
        r.raise_for_status()
        return r.json()

    async def get_diffs(self, project_id: int, mr_iid: int) -> list[dict]:
        r = await self.client.get(
            f"{self.base}/projects/{project_id}/merge_requests/{mr_iid}/diffs"
        )
        r.raise_for_status()
        return r.json()

    async def get_file(self, project_id: int, path: str, ref: str) -> str | None:
        enc = quote(path, safe="")
        r = await self.client.get(
            f"{self.base}/projects/{project_id}/repository/files/{enc}/raw",
            params={"ref": ref},
        )
        return r.text if r.status_code < 400 else None

    async def get_tree(self, project_id: int, path: str, ref: str) -> list[dict]:
        r = await self.client.get(
            f"{self.base}/projects/{project_id}/repository/tree",
            params={"path": path, "ref": ref, "per_page": 100},
        )
        return r.json() if r.status_code < 400 else []

    async def search_blobs(self, project_id: int, query: str, ref: str) -> list[dict]:
        r = await self.client.get(
            f"{self.base}/projects/{project_id}/search",
            params={"scope": "blobs", "search": query, "ref": ref, "per_page": 20},
        )
        return r.json() if r.status_code < 400 else []


    async def create_note(self, project_id: int, mr_iid: int, body: str) -> int:
        r = await self.client.post(
            f"{self.base}/projects/{project_id}/merge_requests/{mr_iid}/notes",
            data={"body": body},
        )
        r.raise_for_status()
        return r.json()["id"]

    async def edit_note(self, project_id: int, mr_iid: int, note_id: int, body: str):
        r = await self.client.put(
            f"{self.base}/projects/{project_id}/merge_requests/{mr_iid}/notes/{note_id}",
            data={"body": body},
        )
        r.raise_for_status()

    async def list_notes(self, project_id: int, mr_iid: int) -> list[dict]:
        r = await self.client.get(
            f"{self.base}/projects/{project_id}/merge_requests/{mr_iid}/notes",
            params={"per_page": 100},
        )
        r.raise_for_status()
        return r.json()

    async def post_status(self, project_id: int, mr_iid: int, body: str) -> int:
        full = f"{STATUS_MARKER}\n{body}"
        for note in await self.list_notes(project_id, mr_iid):
            if STATUS_MARKER in (note.get("body") or ""):
                await self.edit_note(project_id, mr_iid, note["id"], full)
                return note["id"]
        return await self.create_note(project_id, mr_iid, full)

    # ---- inline comments ---------------------------------------------------
    async def post_inline_note(
        self, project_id: int, mr_iid: int, file_path: str, new_line: int,
        body: str, refs: dict,
    ) -> bool:
        position = {
            "position_type": "text",
            "base_sha": refs["base_sha"],
            "start_sha": refs["start_sha"],
            "head_sha": refs["head_sha"],
            "new_path": file_path,
            "old_path": file_path,
            "new_line": new_line,
        }
        data = {"body": body}
        for k, v in position.items():
            data[f"position[{k}]"] = v
        r = await self.client.post(
            f"{self.base}/projects/{project_id}/merge_requests/{mr_iid}/discussions",
            data=data,
        )
        if r.status_code >= 400:
            log.warning(f"inline note failed @ {file_path}:{new_line} -> {r.text[:200]}")
        return r.status_code < 400
    
    async def add_labels(self, project_id: int, mr_iid: int, labels: list[str]):
        r = await self.client.put(
            f"{self.base}/projects/{project_id}/merge_requests/{mr_iid}",
            data={"add_labels": ",".join(labels)},
        )
        r.raise_for_status()