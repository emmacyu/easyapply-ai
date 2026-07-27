"""Read-only lookup into config/bq.yaml — the user's hand-written answers to
professional / behavioral application questions.

Checked BEFORE the LLM in the answering flow: if a form question matches one of
these curated Q&A, that exact answer is used (no LLM call, no cache write).

This module NEVER writes to bq.yaml.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

BQ_PATH = Path(__file__).resolve().parents[1] / "config" / "bq.yaml"
# High bar for the "use verbatim, skip the LLM" fast path: behavioral questions
# share boilerplate ("tell me about a time you…"), so only near-identical wording
# should auto-hit. Reworded questions are handled by feeding bq into the LLM.
_THRESHOLD = 0.7


def _norm(s: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def _sim(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    A = {x for x in a.split() if len(x) > 2}
    B = {x for x in b.split() if len(x) > 2}
    if not A or not B:
        return 0.6 if (a in b or b in a) else 0.0
    inter = len(A & B)
    jac = inter / (len(A) + len(B) - inter)
    bonus = 0.3 if (a in b or b in a) else 0.0
    return min(1.0, jac + bonus)


def _entries() -> list[tuple[list[str], str, str]]:
    """Return [(normalized_variants, original_question, answer)] from bq.yaml."""
    try:
        data = yaml.safe_load(BQ_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except Exception as exc:  # noqa: BLE001
        logger.warning("bq.yaml parse failed: %s", exc)
        return []
    if not data:
        return []

    out: list[tuple[list[str], str, str]] = []
    if isinstance(data, dict):
        for q, a in data.items():
            if a:
                out.append(([_norm(q)], str(q), str(a)))
    elif isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            answer = item.get("answer")
            if not answer:
                continue
            question = item.get("question", "")
            variants = [question] + list(item.get("aliases", []) or [])
            out.append(([_norm(v) for v in variants if v], str(question), str(answer)))
    return out


def lookup(question: str) -> str | None:
    """High-confidence exact-ish match → the user's answer verbatim (no LLM)."""
    q = _norm(question)
    best: str | None = None
    score = 0.0
    for variants, _orig, answer in _entries():
        for v in variants:
            s = _sim(q, v)
            if s > score:
                score = s
                best = answer
    return best if score >= _THRESHOLD else None


def prepared_text(limit: int = 30) -> str:
    """All bq Q&A formatted for LLM grounding (so reworded questions reuse them)."""
    lines = [f"Q: {orig}\nA: {answer}" for _v, orig, answer in _entries()[:limit]]
    return "\n\n".join(lines)
