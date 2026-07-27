"""Google Slides integration (OAuth-gated):

- read the text of a reference Google Slides deck (from its share link), and
- create a new Google Slides deck from a generated deck dict.

Reuses the same OAuth *client* file as Gmail (`config/secrets/gmail_credentials.json`
— it's just the app identity) but a **separate token + scopes**. Unlike Gmail,
this is NOT account-restricted (creating your own slides isn't sensitive), so any
Google account you consent with works.

Until you authorize (`python main.py gslides-auth`), the read/create calls raise a
clear "not connected" error and the feature stays disabled in the UI.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/presentations",       # create/edit decks
    "https://www.googleapis.com/auth/drive.readonly",      # read a reference deck
]

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SECRETS_DIR = PROJECT_ROOT / "config" / "secrets"
CREDENTIALS_PATH = SECRETS_DIR / "gmail_credentials.json"   # shared OAuth client
TOKEN_PATH = SECRETS_DIR / "google_slides_token.json"


def _load_credentials() -> Any | None:
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    if not TOKEN_PATH.exists():
        return None
    creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")
    return creds if creds and creds.valid else None


def authorize(port: int = 8766, open_browser: bool = False) -> str:
    from google_auth_oauthlib.flow import InstalledAppFlow

    if not CREDENTIALS_PATH.exists():
        raise FileNotFoundError(
            f"Missing {CREDENTIALS_PATH}. Download an OAuth client (Desktop app) from "
            "Google Cloud (enable the Google Slides API + Drive API) and save it there."
        )
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_PATH), SCOPES)
    creds = flow.run_local_server(
        host="localhost", bind_addr="0.0.0.0", port=port, open_browser=open_browser
    )
    TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")
    return "connected"


def status() -> dict[str, Any]:
    return {"connected": _load_credentials() is not None}


def _require() -> Any:
    creds = _load_credentials()
    if not creds:
        raise RuntimeError(
            "Google Slides not connected. Run `python main.py gslides-auth` "
            "(needs config/secrets/gmail_credentials.json + Slides/Drive APIs enabled)."
        )
    return creds


# --------------------------------------------------------------------------- #
# Read a reference deck
# --------------------------------------------------------------------------- #
def _presentation_id(url: str) -> str:
    m = re.search(r"/presentation/d/([a-zA-Z0-9_-]+)", url)
    if not m:
        raise ValueError("Not a Google Slides URL (expected /presentation/d/<id>/).")
    return m.group(1)


def read_presentation_text(url: str) -> str:
    """Flatten a reference deck to text (title + bullets per slide) for grounding."""
    from googleapiclient.discovery import build

    svc = build("slides", "v1", credentials=_require(), cache_discovery=False)
    pres = svc.presentations().get(presentationId=_presentation_id(url)).execute()

    lines: list[str] = []
    for i, slide in enumerate(pres.get("slides", []), 1):
        texts: list[str] = []
        for el in slide.get("pageElements", []):
            shape = el.get("shape", {})
            for te in shape.get("text", {}).get("textElements", []):
                content = te.get("textRun", {}).get("content", "")
                if content.strip():
                    texts.append(content.strip())
        if texts:
            lines.append(f"Slide {i}: " + " | ".join(texts))
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Create a new deck
# --------------------------------------------------------------------------- #
def create_presentation(deck: dict[str, Any]) -> dict[str, str]:
    """Create a Google Slides deck from a deck dict. Returns {url, id}."""
    from googleapiclient.discovery import build

    svc = build("slides", "v1", credentials=_require(), cache_discovery=False)
    pres = svc.presentations().create(body={"title": deck.get("title") or "Presentation"}).execute()
    pid = pres["presentationId"]

    # The created deck already has one default (title) slide.
    first = pres["slides"][0]
    requests: list[dict[str, Any]] = []

    # Fill the default title slide.
    for ph in first.get("pageElements", []):
        ptype = ph.get("shape", {}).get("placeholder", {}).get("type")
        if ptype in ("CENTERED_TITLE", "TITLE"):
            requests.append({"insertText": {"objectId": ph["objectId"], "text": deck.get("title") or ""}})
        elif ptype in ("SUBTITLE", "BODY"):
            requests.append({"insertText": {"objectId": ph["objectId"], "text": deck.get("subtitle") or ""}})

    # Content slides — map our own object IDs to layout placeholders so we can
    # insert text in the same batch (no extra round-trips).
    for i, s in enumerate(deck.get("slides", [])):
        tid, bid, sid = f"t_{i}", f"b_{i}", f"s_{i}"
        requests.append(
            {
                "createSlide": {
                    "objectId": sid,
                    "slideLayoutReference": {"predefinedLayout": "TITLE_AND_BODY"},
                    "placeholderIdMappings": [
                        {"layoutPlaceholder": {"type": "TITLE"}, "objectId": tid},
                        {"layoutPlaceholder": {"type": "BODY"}, "objectId": bid},
                    ],
                }
            }
        )
        requests.append({"insertText": {"objectId": tid, "text": s.get("title") or ""}})
        body_text = "\n".join(str(b) for b in (s.get("bullets") or []))
        if body_text:
            requests.append({"insertText": {"objectId": bid, "text": body_text}})
            requests.append(
                {
                    "createParagraphBullets": {
                        "objectId": bid,
                        "textRange": {"type": "ALL"},
                        "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE",
                    }
                }
            )

    if requests:
        svc.presentations().batchUpdate(presentationId=pid, body={"requests": requests}).execute()

    return {"id": pid, "url": f"https://docs.google.com/presentation/d/{pid}/edit"}
