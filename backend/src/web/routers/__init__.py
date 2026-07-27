"""Per-feature API routers. Each module exposes a `router` (APIRouter):

- pipeline     — Run Pipeline: job board, discovery/scoring/tailoring, stats
- deepdive     — chat sessions (also serves FinalRoundAI text via `kind`)
- finalround   — FinalRoundAI audio (transcribe + answer)
- oa           — OA screenshot answering + `/oa` iPad viewer
- core         — shared: answer bank, profile, gmail

(Presentation was extracted to its own repo: jobpilot-presentation.)
"""

from . import core, deepdive, finalround, oa, pipeline

__all__ = ["core", "deepdive", "finalround", "oa", "pipeline"]
