from __future__ import annotations

import json
import logging
import os
import re
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"


def load_prompt(name: str, **kwargs: str) -> str:
    template = (PROMPTS_DIR / name).read_text(encoding="utf-8")
    for key, value in kwargs.items():
        template = template.replace(f"{{{{{key}}}}}", value)
    return template


def extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            return json.loads(match.group())
        raise


def strip_code_fence(text: str) -> str:
    """Remove a leading/trailing markdown code fence if the model added one."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
    return text.strip()


class LLMProvider(ABC):
    @abstractmethod
    def complete_json(self, prompt: str, system: str | None = None) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def complete_text(self, prompt: str, system: str | None = None) -> str:
        """Return raw text (used for LaTeX, where JSON escaping is unreliable)."""
        raise NotImplementedError


class MockLLMProvider(LLMProvider):
    """Deterministic provider for tests."""

    def complete_json(self, prompt: str, system: str | None = None) -> dict[str, Any]:
        if "dimension_scores" in prompt or "Scoring Dimensions" in prompt:
            return {
                "dimension_scores": {
                    dim: {"score": 75, "reason": f"Mock score for {dim}"}
                    for dim in [
                        "skill_match",
                        "experience_level",
                        "title_alignment",
                        "salary_fit",
                        "location_remote",
                        "visa_feasibility",
                        "company_signal",
                        "growth_potential",
                        "jd_quality",
                        "red_flags",
                    ]
                },
                "total": 78,
                "grade": "B",
                "reasons": ["Strong skill overlap", "Good location fit"],
                "red_flags": [],
            }
        if "changes_note" in prompt or "Hard Constraints" in prompt:
            return {
                "summary": "Experienced software engineer focused on backend systems.",
                "experience": [
                    {
                        "company": "Example Corp",
                        "title": "Software Engineer",
                        "start": "2022-01",
                        "end": "present",
                        "location": "Toronto, ON",
                        "bullets": ["Built REST APIs serving 50K+ daily requests"],
                        "tech": ["Python", "FastAPI"],
                    }
                ],
                "projects": [],
                "education": [
                    {"school": "University of Toronto", "degree": "B.Sc. CS", "year": "2020"}
                ],
                "skills": {
                    "languages": ["Python", "JavaScript"],
                    "frameworks": ["FastAPI", "React"],
                    "tools": ["Docker", "Git"],
                },
                "changes_note": "Emphasized backend API experience",
            }
        return {
            "cover_letter": (
                "Dear Hiring Manager,\n\n"
                "I am excited to apply for this role at your company.\n\n"
                "At Example Corp, I built REST APIs serving 50K+ daily requests.\n\n"
                "I would welcome the opportunity to discuss how I can contribute.\n\n"
                "Sincerely,\nYour Name"
            ),
            "word_count": 45,
        }

    def complete_text(self, prompt: str, system: str | None = None) -> str:
        # Deterministic stub: return nothing usable so callers fall back to
        # the original LaTeX (keeps --mock runs from producing junk documents).
        return "MOCK_NO_REWRITE"


class AnthropicProvider(LLMProvider):
    def __init__(self, model: str | None = None, timeout: int = 60, max_retries: int = 3) -> None:
        import anthropic

        self.client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        self.model = model or os.getenv("LLM_MODEL", "claude-sonnet-4-20250514")
        self.timeout = timeout
        self.max_retries = max_retries

    def complete_json(self, prompt: str, system: str | None = None) -> dict[str, Any]:
        return _retry_call(
            self.max_retries,
            lambda: extract_json(
                self.client.messages.create(
                    model=self.model,
                    max_tokens=4096,
                    system=system or "You are a helpful assistant. Respond with valid JSON only.",
                    messages=[{"role": "user", "content": prompt}],
                    timeout=self.timeout,
                ).content[0].text
            ),
        )

    def complete_text(self, prompt: str, system: str | None = None) -> str:
        return _retry_call(
            self.max_retries,
            lambda: strip_code_fence(
                self.client.messages.create(
                    model=self.model,
                    max_tokens=8192,
                    system=system or "You are a helpful assistant.",
                    messages=[{"role": "user", "content": prompt}],
                    timeout=self.timeout,
                ).content[0].text
            ),
        )


class OpenAIProvider(LLMProvider):
    def __init__(self, model: str | None = None, timeout: int = 60, max_retries: int = 3) -> None:
        from openai import OpenAI

        self.client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], timeout=timeout)
        self.model = model or os.getenv("LLM_MODEL", "gpt-4o-mini")
        self.max_retries = max_retries

    def complete_json(self, prompt: str, system: str | None = None) -> dict[str, Any]:
        return _retry_call(
            self.max_retries,
            lambda: extract_json(
                self.client.chat.completions.create(
                    model=self.model,
                    response_format={"type": "json_object"},
                    messages=[
                        {"role": "system", "content": system or "Respond with valid JSON only."},
                        {"role": "user", "content": prompt},
                    ],
                ).choices[0].message.content
                or "{}"
            ),
        )

    def complete_text(self, prompt: str, system: str | None = None) -> str:
        return _retry_call(
            self.max_retries,
            lambda: strip_code_fence(
                self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": system or "You are a helpful assistant."},
                        {"role": "user", "content": prompt},
                    ],
                ).choices[0].message.content
                or ""
            ),
        )


class GeminiProvider(LLMProvider):
    def __init__(self, model: str | None = None, timeout: int = 60, max_retries: int = 3) -> None:
        import google.generativeai as genai

        genai.configure(api_key=os.environ["GEMINI_API_KEY"])
        self._genai = genai
        # Free tier caps each model ~per day; a different model = a fresh bucket.
        # Try the primary first, then LLM_FALLBACK_MODELS in order on failure.
        primary = model or os.getenv("LLM_MODEL", "gemini-flash-latest")
        fallbacks = [
            m.strip()
            for m in os.getenv("LLM_FALLBACK_MODELS", "").split(",")
            if m.strip()
        ]
        self.model_names = [primary] + [m for m in fallbacks if m != primary]
        self.max_retries = max_retries

    def _generate(self, text: str) -> Any:
        last_exc: Exception | None = None
        for name in self.model_names:
            try:
                return self._genai.GenerativeModel(name).generate_content(text)
            except Exception as exc:
                last_exc = exc
                logger.warning("Gemini model %s failed, trying next: %s", name, str(exc)[:150])
        raise last_exc  # type: ignore[misc]

    def complete_json(self, prompt: str, system: str | None = None) -> dict[str, Any]:
        def call() -> dict[str, Any]:
            response = self._generate(
                f"{system or 'Respond with valid JSON only.'}\n\n{prompt}"
            )
            return extract_json(response.text)

        return _retry_call(self.max_retries, call)

    def complete_text(self, prompt: str, system: str | None = None) -> str:
        def call() -> str:
            response = self._generate(f"{system}\n\n{prompt}" if system else prompt)
            return strip_code_fence(response.text)

        return _retry_call(self.max_retries, call)


class OllamaProvider(LLMProvider):
    def __init__(self, model: str | None = None, timeout: int = 60, max_retries: int = 3) -> None:
        import httpx

        self.base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        self.model = model or os.getenv("OLLAMA_MODEL", "llama3")
        self.timeout = timeout
        self.max_retries = max_retries
        self.client = httpx.Client(timeout=timeout)

    def complete_json(self, prompt: str, system: str | None = None) -> dict[str, Any]:
        def call() -> dict[str, Any]:
            response = self.client.post(
                f"{self.base_url}/api/chat",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system or "Respond with valid JSON only."},
                        {"role": "user", "content": prompt},
                    ],
                    "stream": False,
                    "format": "json",
                },
            )
            response.raise_for_status()
            return extract_json(response.json()["message"]["content"])

        return _retry_call(self.max_retries, call)

    def complete_text(self, prompt: str, system: str | None = None) -> str:
        def call() -> str:
            response = self.client.post(
                f"{self.base_url}/api/chat",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system or "You are a helpful assistant."},
                        {"role": "user", "content": prompt},
                    ],
                    "stream": False,
                },
            )
            response.raise_for_status()
            return strip_code_fence(response.json()["message"]["content"])

        return _retry_call(self.max_retries, call)


def _retry_call(max_retries: int, fn: Any) -> dict[str, Any]:
    delay = 1.0
    last_exc: Exception | None = None
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            logger.warning("LLM call failed (attempt %d/%d): %s", attempt + 1, max_retries, exc)
            if attempt < max_retries - 1:
                time.sleep(delay)
                delay *= 2
    raise RuntimeError(f"LLM call failed after {max_retries} retries") from last_exc


def get_provider(use_mock: bool = False) -> LLMProvider:
    if use_mock or os.getenv("LLM_PROVIDER", "").lower() == "mock":
        return MockLLMProvider()

    provider = os.getenv("LLM_PROVIDER", "anthropic").lower()
    timeout = int(os.getenv("LLM_TIMEOUT", "60"))
    max_retries = int(os.getenv("LLM_MAX_RETRIES", "3"))

    if provider == "anthropic":
        return AnthropicProvider(timeout=timeout, max_retries=max_retries)
    if provider == "openai":
        return OpenAIProvider(timeout=timeout, max_retries=max_retries)
    if provider == "gemini":
        return GeminiProvider(timeout=timeout, max_retries=max_retries)
    if provider == "ollama":
        return OllamaProvider(timeout=timeout, max_retries=max_retries)
    raise ValueError(f"Unknown LLM provider: {provider}")
