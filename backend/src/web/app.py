"""JobPilot API — app assembly only.

Each feature lives in its own router under `src/web/routers/` (pipeline,
deepdive, finalround, oa, core). This module just creates the app,
adds middleware, wires the routers, and serves the built frontend (SPA).
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from src.web.deps import FRONTEND_DIST
from src.web.routers import core, deepdive, finalround, oa, pipeline

logger = logging.getLogger(__name__)

app = FastAPI(title="JobPilot API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    # Allow the autofill browser extension to read the profile.
    allow_origin_regex=r"chrome-extension://.*|moz-extension://.*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Wire each section's router. Paths are unchanged (no prefixes) — this is a pure
# internal reorg, so the frontend/extension contract is identical.
for module in (pipeline, core, deepdive, finalround, oa):
    app.include_router(module.router)


@app.on_event("startup")
def _startup() -> None:
    pipeline.startup_precompile()


if FRONTEND_DIST.exists():
    # Serve the built assets directly...
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIST / "assets"),
        name="assets",
    )

    # ...and fall back to index.html for any other GET so client-side
    # routes (e.g. /jobs/32) work on refresh / direct navigation (SPA).
    # Registered last so real routes (e.g. /oa) win.
    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
