"""FinalRoundAI section (audio): captured interviewer audio -> transcribed
question + grounded answer (Gemini), stored into a `finalround` chat session.

The *text* mode of FinalRoundAI reuses the shared chat endpoints in `deepdive.py`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from src.web.deps import BACKEND_ROOT, db, media_for

router = APIRouter()

_FR_AUDIO_DIR = BACKEND_ROOT / "data" / "finalround_audio"
_FR_AUDIO_EXT = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".mp4",
}


@router.post("/api/finalround/audio")
def finalround_audio(body: dict[str, Any]) -> dict[str, Any]:
    """Captured interviewer audio → transcribed question + grounded answer (Gemini).
    Saves the audio file and stores the Q&A into a finalround chat session."""
    import base64
    import time

    from src.ai.finalround_audio import answer_from_audio

    b64 = body.get("audio_base64")
    if not b64:
        raise HTTPException(status_code=400, detail="audio_base64 is required")
    try:
        audio = base64.b64decode(b64)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid base64 audio")
    mime = (body.get("mime_type") or "audio/webm").split(";")[0]

    try:
        result = answer_from_audio(audio, mime)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)[:200])

    question = result.get("question") or "(question)"
    answer = result.get("answer") or ""

    session_id = body.get("session_id")
    if not session_id:
        session_id = db.create_chat_session(title=question[:60], kind="finalround")

    _FR_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"s{session_id}_{int(time.time() * 1000)}{_FR_AUDIO_EXT.get(mime, '.webm')}"
    (_FR_AUDIO_DIR / fname).write_bytes(audio)

    msg_id = db.add_chat_message(session_id, "user", question, audio_path=str(_FR_AUDIO_DIR / fname))
    db.add_chat_message(session_id, "assistant", answer)

    return {
        "session_id": session_id,
        "question": question,
        "answer": answer,
        "message_id": msg_id,
        "audio_url": f"/api/chat/messages/{msg_id}/audio",
    }


@router.get("/api/chat/messages/{message_id}/audio")
def chat_message_audio(message_id: int) -> FileResponse:
    m = db.get_chat_message(message_id)
    if not m or not m.get("audio_path"):
        raise HTTPException(status_code=404, detail="No audio for this message")
    path = Path(m["audio_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="Audio file missing")
    return FileResponse(path, media_type=media_for(path), filename=path.name)
