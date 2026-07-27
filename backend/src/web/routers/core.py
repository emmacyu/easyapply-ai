"""Core / shared endpoints that aren't specific to one nav section:
the answer-bank (used by the autofill extension), profile read/write (Profile
page + extension), and the read-only Gmail verification-code integration."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from src.web.deps import db

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
def gmail_verification(sender: str | None = None, minutes: int = 10) -> dict[str, Any]:
    """Latest sign-up verification code/link from the connected job-app mailbox."""
    from src.integrations.gmail_client import find_verification

    try:
        return find_verification(sender=sender, minutes=minutes)
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
    }


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
