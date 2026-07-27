from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class Job(BaseModel):
    source: str
    url: str
    title: str
    company: str
    location: str | None = None
    is_remote: bool = False
    salary_min: float | None = None
    salary_max: float | None = None
    salary_currency: str | None = None
    date_posted: str | None = None
    description: str | None = None
    dedupe_key: str

    @classmethod
    def from_jobspy_row(cls, row: dict[str, Any], source: str) -> Job:
        from src.db.database import make_dedupe_key

        is_remote = bool(row.get("is_remote"))
        location = row.get("location") or row.get("location_city")
        if isinstance(location, str) and "remote" in location.lower():
            is_remote = True

        date_posted = row.get("date_posted")
        if isinstance(date_posted, datetime):
            date_posted = date_posted.strftime("%Y-%m-%d")
        elif date_posted is not None:
            date_posted = str(date_posted)[:10]

        company = str(row.get("company") or row.get("company_name") or "Unknown")
        title = str(row.get("title") or "Untitled")
        url = str(row.get("job_url") or row.get("url") or "")

        salary_min = _to_float(row.get("min_amount"))
        salary_max = _to_float(row.get("max_amount"))

        return cls(
            source=source,
            url=url,
            title=title,
            company=company,
            location=str(location) if location else None,
            is_remote=is_remote,
            salary_min=salary_min,
            salary_max=salary_max,
            salary_currency=row.get("currency"),
            date_posted=date_posted,
            description=row.get("description") or row.get("job_description"),
            dedupe_key=make_dedupe_key(company, title),
        )


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class JobResponse(BaseModel):
    id: int
    source: str
    url: str
    title: str
    company: str
    location: str | None = None
    is_remote: bool = False
    salary_min: float | None = None
    salary_max: float | None = None
    salary_currency: str | None = None
    date_posted: str | None = None
    description: str | None = None
    score: int | None = None
    grade: str | None = None
    score_reasons: dict[str, Any] | None = None
    red_flags: list[str] | None = None
    resume_path: str | None = None
    cover_letter_path: str | None = None
    status: str
    created_at: str | None = None
    updated_at: str | None = None


class JobListResponse(BaseModel):
    items: list[JobResponse]
    total: int
    page: int
    page_size: int


class StatusUpdate(BaseModel):
    status: str


class StatsResponse(BaseModel):
    today_new: int
    pending: int
    applied: int
    reply_rate: float


class PipelineStatus(BaseModel):
    running: bool = False
    stage: str | None = None
    message: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
