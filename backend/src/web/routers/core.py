"""Core / shared endpoints that aren't specific to one nav section:
the answer-bank (used by the autofill extension), profile read/write (Profile
page + extension), and the read-only Gmail verification-code integration."""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from src.web.deps import BACKEND_ROOT, db, media_for

# Supporting documents the user drops in (not in git; bind-mounted in Docker).
DOCUMENTS_DIR = BACKEND_ROOT / "data" / "supportive_documents"

router = APIRouter()


# --------------------------------------------------------------------------- #
# Application-question answer bank
# --------------------------------------------------------------------------- #
@router.post("/api/answer")
def answer(body: dict[str, Any]) -> dict[str, Any]:
    """Answer an application question from the profile (cached, reviewable)."""
    from src.ai.answerer import answer_question

    question = (body.get("question") or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    options = body.get("options")
    if options is not None and not isinstance(options, list):
        raise HTTPException(status_code=400, detail="options must be a list")
    return answer_question(
        db,
        question=question,
        options=options,
        field_type=body.get("type"),
        job_id=body.get("job_id"),
    )


@router.get("/api/answers")
def list_answers() -> list[dict[str, Any]]:
    return db.list_answers()


@router.put("/api/answers/{key}")
def edit_answer(key: str, body: dict[str, Any]) -> dict[str, str]:
    existing = db.get_answer(key)
    if not existing:
        raise HTTPException(status_code=404, detail="Answer not found")
    db.upsert_answer(
        key=key,
        question=existing["question"],
        answer=body.get("answer", ""),
        options=existing.get("options"),
        job_id=existing.get("job_id"),
        reviewed=1,  # user-edited => reviewed, no longer flagged for review
    )
    return {"status": "ok"}


@router.delete("/api/answers/{key}")
def remove_answer(key: str) -> dict[str, str]:
    db.delete_answer(key)
    return {"status": "ok"}


# --------------------------------------------------------------------------- #
# Submitted applications
# --------------------------------------------------------------------------- #
@router.post("/api/applications")
def record_application(body: dict[str, Any]) -> dict[str, Any]:
    """Record an application the user submitted (called by the extension once
    the site confirmed it, or when the user marks it submitted by hand)."""
    import json

    url = (body.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url is required")
    job_id = body.get("job_id")
    job_id = int(job_id) if str(job_id or "").isdigit() else None
    answers = [
        {"label": str(a.get("label", ""))[:300], "value": str(a.get("value", ""))[:4000], "source": a.get("source") or ""}
        for a in (body.get("answers") or [])
        if isinstance(a, dict)
    ][:200]
    app_id = db.record_application(
        {
            "url": url,
            "company": (body.get("company") or "").strip()[:200] or None,
            "title": (body.get("title") or "").strip()[:300] or None,
            "page_title": (body.get("page_title") or "").strip()[:300] or None,
            "job_id": job_id,
            "resume": (body.get("resume") or "").strip()[:200] or None,
            "answers": json.dumps(answers, ensure_ascii=False),
            "confirmation": "manual" if body.get("confirmation") == "manual" else "page",
        }
    )
    # A saved job that was applied to with its tailored résumé moves along the board too.
    job_updated = bool(job_id and db.update_job_status(job_id, "applied", evidence=f"extension: {url}"))
    return {"id": app_id, "job_updated": job_updated}


@router.delete("/api/applications/{app_id}")
def delete_application(app_id: int) -> dict[str, str]:
    db.delete_application(app_id)
    return {"status": "ok"}


@router.get("/api/applications")
def list_applications() -> list[dict[str, Any]]:
    import json

    rows = db.list_applications()
    for row in rows:
        try:
            row["answers"] = json.loads(row.get("answers") or "[]")
        except json.JSONDecodeError:
            row["answers"] = []
    return rows


# --------------------------------------------------------------------------- #
# Company / industry blacklist
# --------------------------------------------------------------------------- #
@router.get("/api/blacklist")
def get_blacklist() -> dict[str, list[str]]:
    from src import blacklist_store

    return {"companies": blacklist_store.companies(), "industries": blacklist_store.industries()}


@router.post("/api/blacklist/check")
def check_blacklist(body: dict[str, Any]) -> dict[str, Any]:
    """Is this company off-limits? Blacklisted itself, or in a blacklisted
    industry — in which case it is added to the company blacklist as well."""
    from src import blacklist_store

    company = (body.get("company") or "").strip()
    industry = (body.get("industry") or "").strip()
    entry = blacklist_store.match_company(company) if company else None
    if entry:
        return {"blocked": True, "reason": "company", "match": entry, "added": False}
    bad_industry = blacklist_store.match_industry(industry) if industry else None
    if bad_industry:
        added = blacklist_store.add_company(company, note=f"industry: {bad_industry}") if company else False
        return {"blocked": True, "reason": "industry", "match": bad_industry, "added": added}
    return {"blocked": False, "reason": None, "match": None, "added": False}


# --------------------------------------------------------------------------- #
# Gmail (read-only verification codes)
# --------------------------------------------------------------------------- #
@router.get("/api/gmail/status")
def gmail_status() -> dict[str, Any]:
    from src.integrations.gmail_client import status

    try:
        return status()
    except Exception as exc:  # noqa: BLE001
        return {"connected": False, "account": None, "error": str(exc)[:200]}


@router.get("/api/gmail/verification")
def gmail_verification(
    sender: str | None = None, minutes: int = 10, digits: int | None = None
) -> dict[str, Any]:
    """Latest sign-up verification code/link from the connected job-app mailbox."""
    from src.integrations.gmail_client import find_verification

    try:
        return find_verification(sender=sender, minutes=minutes, digits=digits)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)[:200])


# --------------------------------------------------------------------------- #
# Profile
# --------------------------------------------------------------------------- #
@router.get("/api/profile")
def get_profile() -> dict[str, Any]:
    """Compact profile for the autofill browser extension."""
    from src.config_store import load_profile

    data = load_profile()
    personal = data.get("personal", {}) or {}
    prefs = data.get("preferences", {}) or {}
    return {
        "personal": personal,
        "min_salary_cad": prefs.get("min_salary_cad"),
        # Extra upload fields: {form label: file name in data/supportive_documents}
        "documents": data.get("documents", {}) or {},
        # Password for the accounts ATS sites make you create (kept in .env, not
        # in the git-tracked profile). The login e-mail is personal.email.
        "account": {"password": os.getenv("ATS_ACCOUNT_PASSWORD") or ""},
    }


@router.get("/api/documents/{name}")
def get_document(name: str) -> FileResponse:
    """A supporting document (paper, transcript, …) for the extension to upload."""
    path = (DOCUMENTS_DIR / name).resolve()
    if path.parent != DOCUMENTS_DIR.resolve() or not path.is_file():
        raise HTTPException(status_code=404, detail="Document not found")
    return FileResponse(path, media_type=media_for(path), filename=path.name)


@router.get("/api/profile/raw")
def get_profile_raw() -> dict[str, Any]:
    """Full profile.yaml (for the profile management UI)."""
    from src.config_store import load_profile

    return load_profile()


@router.put("/api/profile/raw")
def put_profile_raw(body: dict[str, Any]) -> dict[str, Any]:
    """Persist the edited profile back to profile.yaml (comments preserved)."""
    from src.config_store import load_profile, save_profile

    if not isinstance(body, dict) or "personal" not in body:
        raise HTTPException(status_code=400, detail="Body must be the full profile object")
    try:
        save_profile(body)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to save: {exc}")
    return load_profile()
