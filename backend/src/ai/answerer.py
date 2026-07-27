"""Answer arbitrary job-application questions from the profile, with caching.

Borrowed from AIHawk's idea of an answer memory: the first time a question is
seen it's answered by the LLM (grounded in profile.yaml); the answer is cached
so the same question is instant and consistent next time, and reviewable/editable.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any

import yaml

from src.ai.provider import get_provider, load_prompt, strip_code_fence
from src.config_store import load_profile
from src.db.database import Database

logger = logging.getLogger(__name__)


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip().lower())


def _cache_key(question: str, options: list[str] | None, job_id: int | None) -> str:
    opt_sig = "|".join(sorted(_norm(o) for o in options)) if options else ""
    raw = f"{_norm(question)}::{opt_sig}::{job_id or 'global'}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _match_option(answer: str, options: list[str]) -> str | None:
    na = _norm(answer)
    for o in options:
        if _norm(o) == na:
            return o
    for o in options:
        if na and (_norm(o) in na or na in _norm(o)):
            return o
    return None


def answer_question(
    db: Database,
    question: str,
    options: list[str] | None = None,
    field_type: str | None = None,
    job_id: int | None = None,
    use_mock: bool = False,
) -> dict[str, Any]:
    # 1) The user's hand-written answers (bq.yaml) win over everything.
    from src.bq_store import lookup as bq_lookup

    bq_answer = bq_lookup(question)
    if bq_answer:
        if not options:
            return {"answer": bq_answer, "cached": True, "needs_review": False, "source": "bq"}
        matched = _match_option(bq_answer, options)
        if matched:
            return {"answer": matched, "cached": True, "needs_review": False, "source": "bq"}
        # bq answer doesn't fit the options → fall through to cache/LLM

    # 2) Previously generated/edited answers.
    key = _cache_key(question, options, job_id)
    cached = db.get_answer(key)
    if cached and cached.get("answer") is not None:
        return {
            "answer": cached["answer"],
            "cached": True,
            "needs_review": not bool(cached.get("reviewed")),
        }

    profile_yaml = yaml.safe_dump(load_profile(), allow_unicode=True, sort_keys=False)

    job_block = ""
    if job_id:
        job = db.get_job(job_id)
        if job:
            job_block = (
                f"Title: {job.get('title', '')}\nCompany: {job.get('company', '')}\n\n"
                f"{job.get('description') or ''}"
            )

    options_block = ""
    if options:
        options_block = "Choose EXACTLY one of these options:\n- " + "\n- ".join(options)

    from src.bq_store import prepared_text

    prepared = prepared_text()

    prompt = load_prompt(
        "answer_question.md",
        profile=profile_yaml,
        job=job_block or "(no specific job context)",
        question=question,
        options=options_block or "(free text — answer concisely)",
        field_type=field_type or "text",
        prepared=prepared or "(none)",
    )

    try:
        raw = strip_code_fence(get_provider(use_mock=use_mock).complete_text(prompt)).strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("answer_question LLM failed: %s", exc)
        return {"answer": "", "cached": False, "needs_review": True, "error": str(exc)[:200]}

    answer = raw
    if options:
        answer = _match_option(raw, options) or raw

    db.upsert_answer(
        key=key,
        question=question,
        answer=answer,
        options=json.dumps(options) if options else None,
        job_id=job_id,
        reviewed=0,
    )
    return {"answer": answer, "cached": False, "needs_review": True}
