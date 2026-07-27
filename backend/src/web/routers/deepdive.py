"""DeepDive section: the chat sessions engine.

DeepDive owns the chat infrastructure (`/api/chat/sessions*`). FinalRoundAI's
*text* mode reuses these exact endpoints via the `kind` field (deepdive|finalround);
FinalRoundAI's *audio* endpoints live in `finalround.py`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from src.web.deps import db

router = APIRouter()


@router.get("/api/chat/sessions")
def chat_sessions(kind: str | None = None) -> list[dict[str, Any]]:
    return db.list_chat_sessions(kind=kind)


@router.post("/api/chat/sessions")
def chat_new_session(kind: str = "deepdive") -> dict[str, Any]:
    from src.ai.deepdive import start_session

    return start_session(db, kind=kind)


@router.get("/api/chat/sessions/{session_id}")
def chat_get_session(session_id: int) -> dict[str, Any]:
    msgs = db.get_chat_messages(session_id)
    for m in msgs:
        m["audio_url"] = f"/api/chat/messages/{m['id']}/audio" if m.get("audio_path") else None
        m.pop("audio_path", None)
    return {"session_id": session_id, "messages": msgs}


@router.post("/api/chat/sessions/{session_id}/message")
def chat_send(session_id: int, body: dict[str, Any]) -> dict[str, Any]:
    from src.ai.deepdive import send_message

    msg = (body.get("message") or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="message is required")
    return send_message(db, session_id, msg)


@router.post("/api/chat/sessions/{session_id}/extract")
def chat_extract(session_id: int) -> dict[str, Any]:
    from src.ai.deepdive import extract_insights

    try:
        return extract_insights(db, session_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)[:200])


@router.delete("/api/chat/sessions/{session_id}")
def chat_delete(session_id: int) -> dict[str, str]:
    for m in db.get_chat_messages(session_id):  # remove saved audio files too
        p = m.get("audio_path")
        if p:
            try:
                Path(p).unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass
    db.delete_chat_session(session_id)
    return {"status": "ok"}
