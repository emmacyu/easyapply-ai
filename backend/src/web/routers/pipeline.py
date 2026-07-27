"""Run Pipeline section: the job board + discovery/scoring/tailoring pipeline.

Covers the whole `/` board surface — job list/detail/status, generated materials
(resume/cover PDFs, diff, template A/B), manual save, pipeline run/status, stats.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import FileResponse

from src.discovery.models import (
    JobListResponse,
    JobResponse,
    PipelineStatus,
    StatsResponse,
    StatusUpdate,
)
from src.pipeline import Pipeline, job_to_response
from src.render.latex import USER_TEMPLATES_DIR, compile_latex
from src.web.deps import BACKEND_ROOT, db, media_for

logger = logging.getLogger(__name__)
router = APIRouter()


# --------------------------------------------------------------------------- #
# Background pipeline run
# --------------------------------------------------------------------------- #
_pipeline_lock = threading.Lock()
_pipeline_state: dict[str, Any] = {
    "running": False,
    "stage": None,
    "message": None,
    "started_at": None,
    "finished_at": None,
    "error": None,
}


def _run_pipeline_background(use_mock: bool = False) -> None:
    global _pipeline_state
    with _pipeline_lock:
        if _pipeline_state["running"]:
            return
        _pipeline_state = {
            "running": True,
            "stage": "starting",
            "message": "Pipeline started",
            "started_at": datetime.utcnow().isoformat(),
            "finished_at": None,
            "error": None,
        }

    try:
        pipeline = Pipeline(db=db, use_mock=use_mock)

        _pipeline_state.update({"stage": "discover", "message": "Discovering jobs"})
        pipeline.discover()

        _pipeline_state.update({"stage": "score", "message": "Scoring jobs"})
        pipeline.score()

        _pipeline_state.update({"stage": "tailor", "message": "Generating materials"})
        pipeline.tailor(min_grade="B")

        _pipeline_state.update(
            {
                "running": False,
                "stage": "done",
                "message": "Pipeline completed",
                "finished_at": datetime.utcnow().isoformat(),
            }
        )
    except Exception as exc:
        logger.exception("Pipeline failed")
        _pipeline_state.update(
            {
                "running": False,
                "stage": "error",
                "message": str(exc),
                "error": str(exc),
                "finished_at": datetime.utcnow().isoformat(),
            }
        )


# Per-job, per-kind outcome of the most recent generation, surfaced to the UI
# so a quota/LLM failure is shown clearly instead of silently using the template.
_material_state: dict[int, dict[str, dict]] = {}


def _kinds_for(kind: str) -> list[str]:
    return ["resume", "cover"] if kind == "both" else [kind]


def _tailor_job_background(job_id: int, kind: str = "both", use_mock: bool = False) -> None:
    slot = _material_state.setdefault(job_id, {})
    for k in _kinds_for(kind):
        slot[k] = {"state": "running"}
    try:
        pipeline = Pipeline(db=db, use_mock=use_mock)
        result = pipeline.materials.tailor_job(db, job_id, kind=kind)
        for k, meta in result.items():
            slot[k] = {
                "state": "tailored" if meta["tailored"] else "fallback",
                "pdf": meta["pdf"],
            }
    except Exception as exc:
        logger.exception("Tailor job %s (%s) failed: %s", job_id, kind, exc)
        for k in _kinds_for(kind):
            slot[k] = {"state": "error", "message": str(exc)[:200]}


# --------------------------------------------------------------------------- #
# Original (un-tailored) template PDFs, for A/B comparison
# --------------------------------------------------------------------------- #
_BASE_DIR = BACKEND_ROOT / "data" / "output" / "_base"
_BASE_SOURCES = {"resume": "resume.tex", "cover": "coverletter.tex"}


def _base_pdf(kind: str) -> Path | None:
    """Compile the pristine template to PDF once and cache it (recompile if the
    source .tex is newer)."""
    src = USER_TEMPLATES_DIR / _BASE_SOURCES[kind]
    out = _BASE_DIR / f"{kind}.pdf"
    if out.exists() and src.exists() and out.stat().st_mtime >= src.stat().st_mtime:
        return out
    if not src.exists():
        return None
    pdf, _ = compile_latex(src.read_text(encoding="utf-8"), out, job_name=f"base_{kind}")
    return pdf


def startup_precompile() -> None:
    """Warm the base template PDFs in the background (called on app startup)."""

    def run() -> None:
        for kind in _BASE_SOURCES:
            try:
                _base_pdf(kind)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Base template precompile (%s) failed: %s", kind, exc)

    threading.Thread(target=run, daemon=True).start()


# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #
@router.get("/api/jobs", response_model=JobListResponse)
def list_jobs(
    status: str | None = None,
    grade: str | None = None,
    search: str | None = None,
    source: str | None = None,
    sort: str = Query(default="score"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> JobListResponse:
    jobs, total = db.list_jobs(
        status=status,
        grade=grade,
        search=search,
        source=source,
        sort=sort,
        page=page,
        page_size=page_size,
    )
    return JobListResponse(
        items=[JobResponse(**job_to_response(j)) for j in jobs],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/api/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: int) -> JobResponse:
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobResponse(**job_to_response(job))


@router.patch("/api/jobs/{job_id}/status", response_model=JobResponse)
def update_status(job_id: int, body: StatusUpdate) -> JobResponse:
    if not db.update_job_status(job_id, body.status):
        job = db.get_job(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        raise HTTPException(
            status_code=400,
            detail=f"Invalid transition from '{job['status']}' to '{body.status}'",
        )
    job = db.get_job(job_id)
    return JobResponse(**job_to_response(job))


@router.get("/api/jobs/{job_id}/resume")
def download_resume(job_id: int, inline: bool = False) -> FileResponse:
    job = db.get_job(job_id)
    if not job or not job.get("resume_path"):
        raise HTTPException(status_code=404, detail="Resume not found")
    path = Path(job["resume_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="Resume file missing")
    return FileResponse(
        path,
        media_type=media_for(path),
        filename=path.name,
        content_disposition_type="inline" if inline else "attachment",
    )


@router.get("/api/jobs/{job_id}/cover-letter")
def download_cover_letter(job_id: int, inline: bool = False) -> FileResponse:
    job = db.get_job(job_id)
    if not job or not job.get("cover_letter_path"):
        raise HTTPException(status_code=404, detail="Cover letter not found")
    path = Path(job["cover_letter_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="Cover letter file missing")
    return FileResponse(
        path,
        media_type=media_for(path),
        filename=path.name,
        content_disposition_type="inline" if inline else "attachment",
    )


@router.get("/api/templates/{kind}")
def template_pdf(kind: str, inline: bool = False) -> FileResponse:
    if kind not in _BASE_SOURCES:
        raise HTTPException(status_code=404, detail="Unknown template")
    pdf = _base_pdf(kind)
    if not pdf or not pdf.exists():
        raise HTTPException(status_code=503, detail="Template PDF unavailable (tectonic?)")
    return FileResponse(
        pdf,
        media_type="application/pdf",
        filename=f"{kind}_original.pdf",
        content_disposition_type="inline" if inline else "attachment",
    )


@router.get("/api/jobs/{job_id}/diff/{kind}")
def job_diff(job_id: int, kind: str) -> dict[str, Any]:
    """Word-level prose diff between the original template and the tailored doc."""
    from src.render.textdiff import diff_segments

    if kind not in _BASE_SOURCES:
        raise HTTPException(status_code=404, detail="Unknown kind")
    job = db.get_job(job_id)
    path_key = "resume_path" if kind == "resume" else "cover_letter_path"
    if not job or not job.get(path_key):
        raise HTTPException(status_code=404, detail="Material not generated yet")

    tex_name = "resume.tex" if kind == "resume" else "cover_letter.tex"
    tailored_tex = Path(job[path_key]).parent / tex_name
    if not tailored_tex.exists():
        raise HTTPException(status_code=404, detail="Tailored source not found")
    original_tex = USER_TEMPLATES_DIR / _BASE_SOURCES[kind]

    segments = diff_segments(
        original_tex.read_text(encoding="utf-8"),
        tailored_tex.read_text(encoding="utf-8"),
    )
    return {"segments": segments}


@router.post("/api/jobs/{job_id}/tailor")
def tailor_job(
    job_id: int,
    background_tasks: BackgroundTasks,
    kind: str = Query("both", pattern="^(resume|cover|both)$"),
) -> dict[str, str]:
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    background_tasks.add_task(_tailor_job_background, job_id, kind)
    return {"status": "started", "message": f"Tailoring job {job_id} ({kind})"}


@router.get("/api/jobs/{job_id}/materials-status")
def materials_status(job_id: int) -> dict[str, dict]:
    """Latest generation outcome per kind: running | tailored | fallback | error."""
    return _material_state.get(job_id, {})


@router.post("/api/jobs/save")
def save_job(body: dict[str, Any]) -> dict[str, Any]:
    """Save a job the user found while browsing (extension or pasted URL)."""
    from src.discovery.manual import save_manual_job

    url = (body.get("url") or "").strip()
    if not url.startswith("http"):
        raise HTTPException(status_code=400, detail="A valid job URL is required")
    return save_manual_job(
        db,
        url=url,
        page_text=body.get("page_text"),
        title_hint=body.get("title", ""),
        company_hint=body.get("company", ""),
    )


# --------------------------------------------------------------------------- #
# Pipeline run + stats
# --------------------------------------------------------------------------- #
@router.post("/api/pipeline/run")
def run_pipeline(background_tasks: BackgroundTasks) -> dict[str, str]:
    if _pipeline_state.get("running"):
        raise HTTPException(status_code=409, detail="Pipeline already running")
    background_tasks.add_task(_run_pipeline_background)
    return {"status": "started", "message": "Pipeline started"}


@router.get("/api/pipeline/status", response_model=PipelineStatus)
def pipeline_status() -> PipelineStatus:
    return PipelineStatus(**_pipeline_state)


@router.get("/api/stats", response_model=StatsResponse)
def get_stats() -> StatsResponse:
    return StatsResponse(**db.get_stats())
