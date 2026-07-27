"""OA screening: send a screenshot to Gemini (vision), which reads the on-screen
question and answers it — coding solution, behavioral answer (grounded in the
profile), or MCQ. The candidate can then follow up (on the iPad `/oa` page) to
tweak the solution; `refine_answer` re-sends the same screenshot + conversation
so the model keeps full visual context. Gemini-only."""

from __future__ import annotations

import logging
import os
from typing import Any

import yaml

from src.ai.provider import extract_json, load_prompt
from src.config_store import load_profile

logger = logging.getLogger(__name__)


def _require_gemini() -> Any:
    if os.getenv("LLM_PROVIDER", "").lower() != "gemini":
        raise RuntimeError("OA screening requires LLM_PROVIDER=gemini")
    import google.generativeai as genai

    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    return genai


def _generate(genai: Any, parts: list[Any]) -> dict[str, Any]:
    """Try the primary model then any LLM_FALLBACK_MODELS (independent quota buckets)."""
    model_name = os.getenv("LLM_MODEL", "gemini-flash-latest")
    fallbacks = [m.strip() for m in os.getenv("LLM_FALLBACK_MODELS", "").split(",") if m.strip()]
    last_exc: Exception | None = None
    for name in [model_name] + [m for m in fallbacks if m != model_name]:
        try:
            resp = genai.GenerativeModel(name).generate_content(parts)
            return extract_json(resp.text)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            logger.warning("Gemini vision model %s failed: %s", name, str(exc)[:150])
    raise RuntimeError(f"OA answering failed: {str(last_exc)[:200]}")


def _profile_yaml() -> str:
    return yaml.safe_dump(load_profile(), allow_unicode=True, sort_keys=False)


def answer_from_image(image_bytes: bytes, mime_type: str = "image/jpeg") -> dict[str, Any]:
    genai = _require_gemini()
    prompt = load_prompt("oa_answer.md", profile=_profile_yaml())
    data = _generate(genai, [prompt, {"mime_type": mime_type, "data": image_bytes}])
    return {
        "question": (data.get("question") or "").strip(),
        "answer": (data.get("answer") or "").strip(),
    }


def _render(messages: list[dict[str, str]]) -> str:
    label = {"assistant": "Answer", "user": "Candidate request"}
    return "\n\n".join(
        f"{label.get(m.get('role', ''), m.get('role', ''))}: {m.get('content', '')}"
        for m in messages
    )


def refine_answer(
    question: str,
    messages: list[dict[str, str]],
    request: str,
    image_bytes: bytes | None = None,
    mime_type: str = "image/jpeg",
) -> dict[str, Any]:
    """Follow-up turn: revise the prior answer per the candidate's request.

    Re-attaches the original screenshot when available so the model keeps the
    full on-screen context (exact constraints, code stubs, MCQ options)."""
    genai = _require_gemini()
    prompt = load_prompt(
        "oa_refine.md",
        profile=_profile_yaml(),
        question=question or "(not captured)",
        transcript=_render(messages) or "(none)",
        request=request,
    )
    parts: list[Any] = [prompt]
    if image_bytes:
        parts.append({"mime_type": mime_type, "data": image_bytes})
    data = _generate(genai, parts)
    return {"answer": (data.get("answer") or "").strip()}
