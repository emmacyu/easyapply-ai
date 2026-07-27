"""Per-feature API routers. Each module exposes a `router` (APIRouter):

- pipeline     — Run Pipeline: job board, discovery/scoring/tailoring, stats
- deepdive     — chat sessions (also serves FinalRoundAI text via `kind`)
- finalround   — FinalRoundAI audio (transcribe + answer)
- oa           — OA screenshot answering + `/oa` iPad viewer
- presentation — GitHub repo → slide deck → .pptx / Google Slides
- core         — shared: answer bank, profile, gmail
"""

from . import core, deepdive, finalround, oa, pipeline, presentation

__all__ = ["core", "deepdive", "finalround", "oa", "pipeline", "presentation"]
