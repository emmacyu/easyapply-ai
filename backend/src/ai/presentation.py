"""Generate a presentation deck (structured JSON) from a GitHub repo's code +
README, optionally matching a reference deck's style. Provider-agnostic (uses
the same LLM abstraction as scoring/tailoring)."""

from __future__ import annotations

import logging
from typing import Any

from src.ai.provider import get_provider, load_prompt
from src.integrations.github_repo import build_context, fetch_repo

logger = logging.getLogger(__name__)

DEFAULT_TARGET_SLIDES = 10


def _clean_deck(deck: dict[str, Any]) -> dict[str, Any]:
    slides = []
    for s in deck.get("slides", []) or []:
        if not isinstance(s, dict):
            continue
        bullets = [str(b).strip() for b in (s.get("bullets") or []) if str(b).strip()]
        slides.append(
            {
                "title": str(s.get("title") or "").strip(),
                "bullets": bullets,
                "notes": str(s.get("notes") or "").strip(),
            }
        )
    return {
        "title": str(deck.get("title") or "Untitled").strip(),
        "subtitle": str(deck.get("subtitle") or "").strip(),
        "slides": slides,
    }


def generate_deck(
    repo_url: str,
    reference_text: str = "",
    target_slides: int = DEFAULT_TARGET_SLIDES,
    use_mock: bool = False,
) -> dict[str, Any]:
    repo = fetch_repo(repo_url)
    context = build_context(repo)
    prompt = load_prompt(
        "presentation.md",
        repo_context=context,
        reference=reference_text.strip() or "(none — use a clean, standard technical structure)",
        target_slides=str(target_slides),
    )
    result = get_provider(use_mock=use_mock).complete_json(prompt)
    deck = _clean_deck(result)
    deck["repo"] = {"full_name": repo["full_name"], "url": repo["url"]}
    if not deck["slides"]:
        raise RuntimeError("The model returned no slides.")
    return deck
