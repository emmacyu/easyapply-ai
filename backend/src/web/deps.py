"""Shared web dependencies used by the per-feature routers:
the single process-wide Database instance, common filesystem paths, and a
content-type helper. Keeping these here lets each router import them without
depending on `app.py` (avoids import cycles)."""

from __future__ import annotations

from pathlib import Path

from src.db.database import Database

BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_ROOT.parent
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"

# One shared Database instance for the whole app.
db = Database()


def media_for(path: Path) -> str:
    return {
        ".pdf": "application/pdf",
        ".tex": "application/x-tex",
        ".md": "text/markdown",
        ".txt": "text/plain",
        ".webm": "audio/webm",
        ".ogg": "audio/ogg",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".mp4": "audio/mp4",
    }.get(path.suffix, "application/octet-stream")
