from __future__ import annotations

import logging
from typing import Any

import yaml

from src.ai.provider import LLMProvider, load_prompt
from src.db.database import Database

logger = logging.getLogger(__name__)


class JobScorer:
    def __init__(
        self,
        provider: LLMProvider,
        profile_path: str = "config/profile.yaml",
        scoring_path: str = "config/scoring.yaml",
        search_path: str = "config/search.yaml",
    ) -> None:
        self.provider = provider
        with open(profile_path, encoding="utf-8") as f:
            self.profile = yaml.safe_dump(yaml.safe_load(f), allow_unicode=True)
        with open(scoring_path, encoding="utf-8") as f:
            self.scoring_raw = yaml.safe_load(f)
            self.scoring_config = yaml.safe_dump(self.scoring_raw, allow_unicode=True)
        with open(search_path, encoding="utf-8") as f:
            self.score_threshold = yaml.safe_load(f).get("score_threshold", 70)

    def score_job(self, job: dict[str, Any]) -> dict[str, Any]:
        prompt = load_prompt(
            "score_job.md",
            profile=self.profile,
            scoring_config=self.scoring_config,
            title=job.get("title", ""),
            company=job.get("company", ""),
            location=job.get("location") or "N/A",
            description=job.get("description") or "No description available.",
        )
        result = self.provider.complete_json(prompt)
        total = int(result.get("total", 0))
        grade = result.get("grade") or self._grade_from_score(total)
        result["total"] = total
        result["grade"] = grade
        return result

    def _grade_from_score(self, score: int) -> str:
        grades = self.scoring_raw.get("grades", {"A": 85, "B": 70, "C": 55, "D": 40})
        ordered = sorted(grades.items(), key=lambda x: x[1], reverse=True)
        for letter, threshold in ordered:
            if score >= threshold:
                return letter
        return "F"

    def score_all_discovered(self, db: Database) -> dict[str, int]:
        jobs = db.get_jobs_by_status("discovered")
        stats = {"scored": 0, "discarded": 0, "failed": 0}
        for job in jobs:
            try:
                result = self.score_job(job)
                total = result["total"]
                grade = result["grade"]
                status = "scored" if total >= self.score_threshold else "discarded"
                db.update_job_score(
                    job["id"],
                    total,
                    grade,
                    result.get("dimension_scores", {}),
                    result.get("red_flags", []),
                    status=status,
                )
                if status == "scored":
                    stats["scored"] += 1
                else:
                    stats["discarded"] += 1
                logger.info("Scored job %s: %s (%d)", job["id"], grade, total)
            except Exception as exc:
                stats["failed"] += 1
                logger.exception("Failed to score job %s: %s", job["id"], exc)
        return stats
