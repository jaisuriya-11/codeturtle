from typing import Optional, List, Literal
from pydantic import BaseModel, field_validator

class Job(BaseModel):
    project_id: int
    mr_iid: int
    head_sha: str
    event_uuid: Optional[str] = None

class Finding(BaseModel):
    file: str
    line: int
    severity: Literal["critical", "warning", "info"]
    category: Literal["security", "bug", "perf", "style", "maintainability"]
    confidence: float
    title: str
    comment: str
    suggestion: Optional[str] = None

    @field_validator("severity", mode="before")
    @classmethod
    def clean_severity(cls, v):
        if isinstance(v, str):
            return v.strip().lower()
        return v

    @field_validator("category", mode="before")
    @classmethod
    def clean_category(cls, v):
        if isinstance(v, str):
            return v.strip().lower()
        return v

class ReviewResult(BaseModel):
    findings: List[Finding]
    summary: str

class ContextFile(BaseModel):
    path: str
    reason: str
    content: str

class ContextBundle(BaseModel):
    files: List[ContextFile]
    notes: List[str]

    def render(self) -> str:
        parts = []
        if self.notes:
            parts.append("### Context Notes:")
            for note in self.notes:
                parts.append(f"- {note}")
            parts.append("")
        for f in self.files:
            parts.append(f"### FILE: {f.path} (reason: {f.reason})")
            parts.append(f.content)
            parts.append("")
        return "\n".join(parts)
