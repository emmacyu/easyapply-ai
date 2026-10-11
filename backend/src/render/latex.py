from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
# User-provided Overleaf templates + fonts live under config/templates.
USER_TEMPLATES_DIR = PROJECT_ROOT / "config" / "templates"
# The user's own documents live under data/ (kept out of git and the image):
# data/resume/resume.tex (+ optionally their own PDF build), data/coverletter/
# coverletter.tex. When present they replace the config/templates copies, which
# stay as the fallback and still provide the shared .cls files and fonts.
USER_DOCS_DIR = PROJECT_ROOT / "data"
_USER_DOCS = {"resume": ("resume", "resume.tex"), "cover": ("coverletter", "coverletter.tex")}


def source_tex(kind: str) -> Path:
    """The .tex that is the source of truth for ``kind`` ("resume" | "cover")."""
    subdir, name = _USER_DOCS[kind]
    own = USER_DOCS_DIR / subdir / name
    return own if own.exists() else USER_TEMPLATES_DIR / name


def own_pdf(kind: str) -> Path | None:
    """A PDF the user placed beside their .tex — their own build of the base
    document, used as-is (and under its own filename) instead of recompiling."""
    subdir, _ = _USER_DOCS[kind]
    pdfs = sorted((USER_DOCS_DIR / subdir).glob("*.pdf"))
    return pdfs[0] if pdfs else None


def tectonic_available() -> bool:
    return shutil.which("tectonic") is not None


def _stage_assets(build_dir: Path) -> None:
    """Copy the class files and fonts the templates depend on into build_dir."""
    # Later dirs win, so a .cls / font shipped with the user's own document
    # overrides the bundled one.
    for src_dir in [USER_TEMPLATES_DIR, *(USER_DOCS_DIR / sub for sub, _ in _USER_DOCS.values())]:
        for cls_file in src_dir.glob("*.cls"):
            shutil.copy(cls_file, build_dir / cls_file.name)
        fonts_src = src_dir / "fonts"
        if fonts_src.is_dir():
            shutil.copytree(fonts_src, build_dir / "fonts", dirs_exist_ok=True)


def compile_latex(
    tex_source: str, out_pdf: Path, job_name: str = "doc"
) -> tuple[Path | None, str]:
    """Compile a full LaTeX document to PDF with tectonic.

    Returns ``(pdf_path, "")`` on success, or ``(None, error_text)`` if tectonic
    is unavailable or the build fails (callers fall back to shipping the raw
    .tex, and may feed ``error_text`` back to the model for a repair attempt).
    """
    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    if not tectonic_available():
        logger.info("tectonic not installed; skipping PDF build for %s", out_pdf.name)
        return None, "tectonic not installed"

    build_dir = out_pdf.parent / ".latex_build" / job_name
    if build_dir.exists():
        shutil.rmtree(build_dir)
    build_dir.mkdir(parents=True, exist_ok=True)

    _stage_assets(build_dir)
    tex_file = build_dir / "main.tex"
    tex_file.write_text(tex_source, encoding="utf-8")

    try:
        subprocess.run(
            ["tectonic", "-X", "compile", "--outdir", str(build_dir), str(tex_file)],
            check=True,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        stderr = getattr(exc, "stderr", "") or str(exc)
        logger.warning("tectonic failed for %s: %s", out_pdf.name, stderr[-800:])
        return None, stderr[-1500:]

    built_pdf = build_dir / "main.pdf"
    if not built_pdf.exists():
        logger.warning("tectonic produced no PDF for %s", out_pdf.name)
        return None, "no PDF produced"

    shutil.copy(built_pdf, out_pdf)
    return out_pdf, ""
