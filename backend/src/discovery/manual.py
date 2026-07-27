"""Save a job the user found while browsing (company site, Greenhouse, etc.).

Extends discovery beyond jobspy's platforms: the extension (or a pasted URL)
sends the page, an LLM extracts title/company/JD, and it enters the pipeline as
a normal `source="manual"`, `status="discovered"` job — ready to score/tailor.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from src.ai.provider import get_provider, load_prompt
from src.db.database import Database, make_dedupe_key

logger = logging.getLogger(__name__)


def _strip_html(html: str) -> str:
    html = re.sub(r"(?is)<(script|style|nav|footer)[^>]*>.*?</\1>", " ", html)
    return re.sub(r"<[^>]+>", " ", html)


def _fetch(url: str) -> str:
    import httpx

    r = httpx.get(
        url,
        follow_redirects=True,
        timeout=20,
        headers={"User-Agent": "Mozilla/5.0 (compatible; JobPilot/1.0)"},
    )
    r.raise_for_status()
    return _strip_html(r.text)


def save_manual_job(
    db: Database,
    url: str,
    page_text: str | None = None,
    title_hint: str = "",
    company_hint: str = "",
    use_mock: bool = False,
) -> dict[str, Any]:
    existing = db.get_job_by_url(url)
    if existing:
        return {
            "saved": False,
            "duplicate": True,
            "id": existing["id"],
            "title": existing["title"],
            "company": existing["company"],
        }

    text = (page_text or "").strip()
    if not text:
        try:
            text = _fetch(url)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Fetch failed for %s: %s", url, exc)
            text = ""
    text = re.sub(r"\s+", " ", text)[:12000]

    title = title_hint or "Unknown role"
    company = company_hint or "Unknown company"
    location: str | None = None
    is_remote = False
    description = text

    if text:
        try:
            prompt = load_prompt(
                "extract_job.md",
                page=text,
                title_hint=title_hint or "(unknown)",
                company_hint=company_hint or "(unknown)",
            )
            r = get_provider(use_mock=use_mock).complete_json(prompt)
            title = (r.get("title") or title).strip()
            company = (r.get("company") or company).strip()
            location = r.get("location") or None
            is_remote = bool(r.get("is_remote"))
            description = r.get("description") or text
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM extract failed for %s: %s", url, exc)

    job = {
        "source": "manual",
        "url": url,
        "title": title,
        "company": company,
        "location": location,
        "is_remote": is_remote,
        "description": description,
        "dedupe_key": make_dedupe_key(company, title),
    }
    job_id = db.insert_job(job)
    if job_id is None:
        dup = db.get_job_by_url(url) or db.find_duplicate_by_dedupe_key(job["dedupe_key"], None)
        return {
            "saved": False,
            "duplicate": True,
            "id": dup["id"] if dup else None,
            "title": title,
            "company": company,
        }
    return {"saved": True, "duplicate": False, "id": job_id, "title": title, "company": company}
