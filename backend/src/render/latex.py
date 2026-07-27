from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
# User-provided Overleaf templates + fonts live under config/templates.
USER_TEMPLATES_DIR = PROJECT_ROOT / "config" / "templates"


def tectonic_available() -> bool:
    return shutil.which("tectonic") is not None


def _stage_assets(build_dir: Path) -> None:
    """Copy the class files and fonts the templates depend on into build_dir."""
    for cls_file in USER_TEMPLATES_DIR.glob("*.cls"):
        shutil.copy(cls_file, build_dir / cls_file.name)
    fonts_src = USER_TEMPLATES_DIR / "fonts"
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
