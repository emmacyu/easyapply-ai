"""Per-feature API routers. Each module exposes a `router` (APIRouter):

- pipeline — Run Pipeline: job board, discovery/scoring/tailoring, stats
- core     — shared: answer bank, profile, gmail

(The interview/assessment features were extracted to their own repos:
DeepDive + FinalRoundAI + OA → jobpilot-copilot; Presentation → jobpilot-presentation.)
"""

from . import core, pipeline

__all__ = ["core", "pipeline"]
