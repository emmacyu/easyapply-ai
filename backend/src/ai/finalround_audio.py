"""FinalRoundAI audio: send the interviewer's captured audio to Gemini, which
transcribes the question AND answers it as the candidate — in one call.

Gemini-only (multimodal audio). Reuses the same grounding rules as finalround.md.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import yaml

from src.ai.provider import extract_json, load_prompt
from src.config_store import load_profile

logger = logging.getLogger(__name__)


def answer_from_audio(audio_bytes: bytes, mime_type: str = "audio/webm") -> dict[str, Any]:
    if os.getenv("LLM_PROVIDER", "").lower() != "gemini":
        raise RuntimeError("Audio answering requires LLM_PROVIDER=gemini")

    import google.generativeai as genai

    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    model_name = os.getenv("LLM_MODEL", "gemini-flash-latest")
    profile_yaml = yaml.safe_dump(load_profile(), allow_unicode=True, sort_keys=False)
    prompt = load_prompt("finalround_audio.md", profile=profile_yaml)

    # Try the primary model, then any fallbacks (same idea as the text provider).
    fallbacks = [m.strip() for m in os.getenv("LLM_FALLBACK_MODELS", "").split(",") if m.strip()]
    last_exc: Exception | None = None
    for name in [model_name] + [m for m in fallbacks if m != model_name]:
        try:
            resp = genai.GenerativeModel(name).generate_content(
                [prompt, {"mime_type": mime_type, "data": audio_bytes}]
            )
            data = extract_json(resp.text)
            return {
                "question": (data.get("question") or "").strip(),
                "answer": (data.get("answer") or "").strip(),
            }
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            logger.warning("Gemini audio model %s failed: %s", name, str(exc)[:150])
    raise RuntimeError(f"Audio answering failed: {str(last_exc)[:200]}")
