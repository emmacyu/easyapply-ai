"""Read-only Gmail integration for fetching sign-up verification codes/links.

Security posture:
- Scope is **gmail.readonly** only — cannot send, delete, or modify anything.
- Only the mailbox in GMAIL_ACCOUNT (default emmayu.cs@gmail.com) may be
  connected; a token for any other account is rejected and discarded.
- No password is ever handled: OAuth grants a revocable, read-only token.
"""

from __future__ import annotations

import base64
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SECRETS_DIR = PROJECT_ROOT / "config" / "secrets"
CREDENTIALS_PATH = SECRETS_DIR / "gmail_credentials.json"
TOKEN_PATH = SECRETS_DIR / "gmail_token.json"

# Only this mailbox may ever be connected (the job-application email).
ALLOWED_ACCOUNT = os.getenv("GMAIL_ACCOUNT", "emmayu.cs@gmail.com").strip().lower()

_CODE_RE = re.compile(r"(?<![0-9A-Za-z])([0-9]{4,8}|[0-9A-Z]{5,8})(?![0-9A-Za-z])")
_LINK_RE = re.compile(r"https?://[^\s\"'<>)]+", re.IGNORECASE)


# --------------------------------------------------------------------------- #
# Credentials / auth
# --------------------------------------------------------------------------- #
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


def _account_email(creds: Any) -> str:
    from googleapiclient.discovery import build

    svc = build("gmail", "v1", credentials=creds, cache_discovery=False)
    return svc.users().getProfile(userId="me").execute().get("emailAddress", "")


def authorize(port: int = 8765, open_browser: bool = False) -> str:
    """Run the OAuth consent flow and persist a token. Returns the email."""
    from google_auth_oauthlib.flow import InstalledAppFlow

    if not CREDENTIALS_PATH.exists():
        raise FileNotFoundError(
            f"Missing {CREDENTIALS_PATH}. Download the OAuth client credentials "
            "(Desktop app) from Google Cloud and save them there."
        )
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_PATH), SCOPES)
    creds = flow.run_local_server(
        host="localhost", bind_addr="0.0.0.0", port=port, open_browser=open_browser
    )
    email = _account_email(creds)
    if email.strip().lower() != ALLOWED_ACCOUNT:
        raise ValueError(
            f"Connected {email}, but only {ALLOWED_ACCOUNT} is allowed. "
            "Token discarded — re-run and pick the correct account."
        )
    TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")
    return email


def status() -> dict[str, Any]:
    creds = _load_credentials()
    if not creds:
        return {"connected": False, "account": None, "allowed": ALLOWED_ACCOUNT}
    try:
        email = _account_email(creds)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Gmail profile lookup failed: %s", exc)
        email = None
    return {"connected": True, "account": email, "allowed": ALLOWED_ACCOUNT}


# --------------------------------------------------------------------------- #
# Reading verification emails
# --------------------------------------------------------------------------- #
def _header(msg: dict[str, Any], name: str) -> str:
    for h in msg.get("payload", {}).get("headers", []):
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _decode(data: str) -> str:
    return base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", "replace")


def _extract_text(payload: dict[str, Any]) -> str:
    """Prefer text/plain; fall back to stripped text/html."""
    mime = payload.get("mimeType", "")
    body = payload.get("body", {})
    if mime == "text/plain" and body.get("data"):
        return _decode(body["data"])
    if mime == "text/html" and body.get("data"):
        return re.sub(r"<[^>]+>", " ", _decode(body["data"]))
    text = []
    for part in payload.get("parts", []) or []:
        text.append(_extract_text(part))
    return "\n".join(t for t in text if t)


def find_verification(sender: str | None = None, minutes: int = 10) -> dict[str, Any]:
    """Return the most recent verification code/link from the allowed mailbox."""
    creds = _load_credentials()
    if not creds:
        raise RuntimeError("Gmail not connected. Run `python main.py gmail-auth` first.")

    from googleapiclient.discovery import build

    email = _account_email(creds)
    if email.strip().lower() != ALLOWED_ACCOUNT:
        raise RuntimeError(f"Connected account {email} is not the allowed {ALLOWED_ACCOUNT}.")

    svc = build("gmail", "v1", credentials=creds, cache_discovery=False)
    query = "newer_than:1d"
    if sender:
        query += f" from:{sender}"
    listing = svc.users().messages().list(userId="me", q=query, maxResults=10).execute()

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    for ref in listing.get("messages", []):
        msg = svc.users().messages().get(userId="me", id=ref["id"], format="full").execute()
        received = datetime.fromtimestamp(int(msg["internalDate"]) / 1000, tz=timezone.utc)
        if received < cutoff:
            continue
        subject = _header(msg, "Subject")
        body = _extract_text(msg.get("payload", {}))
        code_match = _CODE_RE.search(subject) or _CODE_RE.search(body)
        link_match = _LINK_RE.search(body)
        return {
            "found": True,
            "from": _header(msg, "From"),
            "subject": subject,
            "code": code_match.group(1) if code_match else None,
            "link": link_match.group(0) if link_match else None,
            "received": received.isoformat(),
        }
    return {"found": False}
