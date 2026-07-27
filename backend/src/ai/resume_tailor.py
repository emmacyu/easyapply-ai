from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from src.ai.provider import LLMProvider, load_prompt
from src.db.database import Database
from src.render.latex import USER_TEMPLATES_DIR, compile_latex

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = PROJECT_ROOT / "data" / "output"

RESUME_TEX = USER_TEMPLATES_DIR / "resume.tex"
COVER_TEX = USER_TEMPLATES_DIR / "coverletter.tex"

# A bare "&" is an alignment tab in LaTeX; neither template uses tables, so an
# unescaped "&" in the model's prose (e.g. "R&D") is always a slip. Escape it.
_BARE_AMP = re.compile(r"(?<!\\)&")


def _sanitize_latex(tex: str) -> str:
    return _BARE_AMP.sub(r"\\&", tex)


def _looks_like_latex(text: str, original: str) -> bool:
    """Guard against the model returning prose/garbage instead of a document."""
    if "\\documentclass" not in text or "\\end{document}" not in text:
        return False
    # A conservative rewrite should be roughly the same size as the original.
    return len(text) >= len(original) * 0.5


def _compile_with_repair(
    provider: LLMProvider,
    tex: str,
    original_tex: str,
    out_pdf: Path,
    job_name: str,
) -> Path | None:
    """Compile, and on failure ask the model once to fix the LaTeX error."""
    tex = _sanitize_latex(tex)
    pdf, err = compile_latex(tex, out_pdf, job_name=job_name)
    if pdf is not None:
        return pdf
    if tex == original_tex:
        return None  # even the pristine template failed; nothing to repair

    logger.info("Attempting LaTeX repair for %s", out_pdf.name)
    try:
        prompt = load_prompt("fix_latex.md", latex=tex, error=err)
        fixed = _sanitize_latex(provider.complete_text(prompt))
    except Exception as exc:
        logger.warning("LaTeX repair call failed for %s: %s", out_pdf.name, exc)
        return None
    if not _looks_like_latex(fixed, original_tex):
        return None
    out_pdf.parent.joinpath(out_pdf.stem + ".tex").write_text(fixed, encoding="utf-8")
    pdf, _ = compile_latex(fixed, out_pdf, job_name=job_name)
    return pdf


class ResumeTailor:
    """Conservatively rewrite the user's resume.tex to align with a JD."""

    def __init__(self, provider: LLMProvider) -> None:
        self.provider = provider
        self.base_tex = RESUME_TEX.read_text(encoding="utf-8")

    def tailor(self, job: dict[str, Any]) -> tuple[str, bool]:
        """Return (latex, tailored). tailored=False means we fell back to the
        original template (LLM unavailable / invalid output)."""
        prompt = load_prompt(
            "tailor_resume_tex.md",
            resume_tex=self.base_tex,
            title=job.get("title", ""),
            company=job.get("company", ""),
            description=job.get("description") or "",
        )
        try:
            out = self.provider.complete_text(prompt)
        except Exception as exc:
            logger.warning("Resume rewrite failed, using original: %s", exc)
            return self.base_tex, False
        if not _looks_like_latex(out, self.base_tex):
            logger.warning("Resume rewrite looked invalid, using original")
            return self.base_tex, False
        return out, True


class CoverLetterGenerator:
    """Tailor the user's coverletter.tex to a JD, grounded in the resume."""

    def __init__(self, provider: LLMProvider) -> None:
        self.provider = provider
        self.base_tex = COVER_TEX.read_text(encoding="utf-8")
        self.background = RESUME_TEX.read_text(encoding="utf-8")

    def generate(self, job: dict[str, Any]) -> tuple[str, bool]:
        """Return (latex, tailored). tailored=False means we fell back to the
        original template (LLM unavailable / invalid output)."""
        prompt = load_prompt(
            "cover_letter_tex.md",
            cover_tex=self.base_tex,
            background=self.background,
            title=job.get("title", ""),
            company=job.get("company", ""),
            description=job.get("description") or "",
        )
        try:
            out = self.provider.complete_text(prompt)
        except Exception as exc:
            logger.warning("Cover letter rewrite failed, using original: %s", exc)
            return self.base_tex, False
        if not _looks_like_latex(out, self.base_tex):
            logger.warning("Cover letter rewrite looked invalid, using original")
            return self.base_tex, False
        return out, True


class MaterialGenerator:
    def __init__(self, provider: LLMProvider) -> None:
        self.provider = provider
        self.tailor = ResumeTailor(provider)
        self.cover_letter_gen = CoverLetterGenerator(provider)

    def _out_dir(self, job: dict[str, Any]) -> Path:
        company = _safe_dirname(job.get("company", "unknown"))
        title = _safe_dirname(job.get("title", "role"))
        out_dir = OUTPUT_DIR / f"{company}_{title}"
        out_dir.mkdir(parents=True, exist_ok=True)
        return out_dir

    def generate_resume(self, job: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        out_dir = self._out_dir(job)
        raw, tailored = self.tailor.tailor(job)
        tex = _sanitize_latex(raw)
        out_tex = out_dir / "resume.tex"
        out_tex.write_text(tex, encoding="utf-8")
        pdf = _compile_with_repair(
            self.provider, tex, _sanitize_latex(self.tailor.base_tex),
            out_dir / "resume.pdf", "resume",
        )
        path = str(pdf) if pdf else str(out_tex)
        return path, {"tailored": tailored, "pdf": pdf is not None}

    def generate_cover(self, job: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        out_dir = self._out_dir(job)
        raw, tailored = self.cover_letter_gen.generate(job)
        tex = _sanitize_latex(raw)
        out_tex = out_dir / "cover_letter.tex"
        out_tex.write_text(tex, encoding="utf-8")
        pdf = _compile_with_repair(
            self.provider, tex, _sanitize_latex(self.cover_letter_gen.base_tex),
            out_dir / "cover_letter.pdf", "cover",
        )
        path = str(pdf) if pdf else str(out_tex)
        return path, {"tailored": tailored, "pdf": pdf is not None}

    def tailor_job(self, db: Database, job_id: int, kind: str = "both") -> dict[str, dict]:
        """Generate the requested materials and return per-kind outcome metadata."""
        job = db.get_job(job_id)
        if not job:
            raise ValueError(f"Job {job_id} not found")
        result: dict[str, dict] = {}
        if kind in ("resume", "both"):
            path, meta = self.generate_resume(job)
            db.update_job_resume(job_id, path)
            result["resume"] = meta
        if kind in ("cover", "both"):
            path, meta = self.generate_cover(job)
            db.update_job_cover(job_id, path)
            result["cover"] = meta
        return result


def _safe_dirname(value: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in value)[:50]
