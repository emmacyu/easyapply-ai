"""Chat engine for two modes, both grounded in the user's profile:

- **deepdive**   — a coach that interviews the user to mine their experience.
- **finalround** — FinalRoundAI: answers a live interview question AS the user
                   (first person), from their profile / prepared bq answers.

Both share the chat_sessions / chat_messages tables (distinguished by `kind`).
"""

from __future__ import annotations

import logging

import yaml

from src.ai.provider import get_provider, load_prompt, strip_code_fence
from src.config_store import load_profile
from src.db.database import Database

logger = logging.getLogger(__name__)

MAX_HISTORY = 24  # cap turns sent to the model

# kind -> config. `assistant_label` is how the model's turn is named in the
# rendered transcript; `auto_open` = the assistant speaks first (deepdive asks
# the opening question; finalround waits for the interviewer's question).
MODES = {
    "deepdive": {"system": "deepdive.md", "assistant_label": "Interviewer", "auto_open": True},
    "finalround": {"system": "finalround.md", "assistant_label": "You", "auto_open": False},
}


def _profile_context() -> str:
    try:
        return yaml.safe_dump(load_profile(), allow_unicode=True, sort_keys=False)
    except Exception:  # noqa: BLE001
        return "(profile unavailable)"


def _render(history: list[dict[str, str]], assistant_label: str, user_label: str) -> str:
    lines = []
    for m in history[-MAX_HISTORY:]:
        who = user_label if m["role"] == "user" else assistant_label
        lines.append(f"{who}: {m['content']}")
    return "\n".join(lines)


def _kind_of(db: Database, session_id: int) -> str:
    s = db.get_chat_session(session_id)
    kind = (s or {}).get("kind") or "deepdive"
    return kind if kind in MODES else "deepdive"


def _reply(kind: str, history: list[dict[str, str]], use_mock: bool = False) -> str:
    cfg = MODES[kind]
    system = load_prompt(cfg["system"], profile=_profile_context())
    user_label = "Interviewer" if kind == "finalround" else "Candidate"
    convo = _render(history, cfg["assistant_label"], user_label)
    prompt = f"{convo}\n{cfg['assistant_label']}:" if convo else f"{cfg['assistant_label']}:"
    return strip_code_fence(
        get_provider(use_mock=use_mock).complete_text(prompt, system=system)
    ).strip()


def start_session(db: Database, kind: str = "deepdive") -> dict:
    if kind not in MODES:
        kind = "deepdive"
    title = "New interview" if kind == "deepdive" else "New session"
    session_id = db.create_chat_session(title=title, kind=kind)
    if MODES[kind]["auto_open"]:
        opening = _reply(kind, [])
        db.add_chat_message(session_id, "assistant", opening)
    return {
        "session_id": session_id,
        "kind": kind,
        "messages": db.get_chat_messages(session_id),
    }


def send_message(db: Database, session_id: int, message: str) -> dict:
    kind = _kind_of(db, session_id)
    db.add_chat_message(session_id, "user", message)
    history = db.get_chat_messages(session_id)
    try:
        reply = _reply(kind, history)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Chat reply (%s) failed: %s", kind, exc)
        reply = "Sorry — I couldn't respond just now (LLM quota or error). Try again in a bit."
    db.add_chat_message(session_id, "assistant", reply)
    s = db.get_chat_session(session_id)
    if s and (not s.get("title") or s["title"] in ("New interview", "New session")):
        db.rename_chat_session(session_id, message.strip()[:60])
    return {"role": "assistant", "content": reply}


def extract_insights(db: Database, session_id: int, use_mock: bool = False) -> dict:
    """Distill a deepdive conversation into copy-pasteable resume/answer material."""
    history = db.get_chat_messages(session_id)
    if not history:
        return {"insights": ""}
    prompt = load_prompt(
        "deepdive_extract.md",
        profile=_profile_context(),
        transcript=_render(history, "Interviewer", "Candidate"),
    )
    try:
        insights = strip_code_fence(get_provider(use_mock=use_mock).complete_text(prompt)).strip()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(str(exc)[:200])
    return {"insights": insights}
