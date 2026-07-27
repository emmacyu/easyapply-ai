from __future__ import annotations

import json
import logging
from typing import Any

from src.ai.provider import LLMProvider, get_provider
from src.ai.resume_tailor import MaterialGenerator
from src.ai.scorer import JobScorer
from src.db.database import Database
from src.discovery.jobspy_source import JobSpySource

logger = logging.getLogger(__name__)


class Pipeline:
    def __init__(
        self,
        db: Database | None = None,
        provider: LLMProvider | None = None,
        use_mock: bool = False,
    ) -> None:
        self.db = db or Database()
        self.provider = provider or get_provider(use_mock=use_mock)
        self.discovery = JobSpySource()
        self.scorer = JobScorer(self.provider)
        self.materials = MaterialGenerator(self.provider)

    def discover(self) -> dict[str, int]:
        jobs = self.discovery.discover()
        inserted = self.discovery.persist(jobs, self.db)
        return {"discovered": len(jobs), "inserted": inserted}

    def score(self) -> dict[str, int]:
        return self.scorer.score_all_discovered(self.db)

    def tailor(self, job_id: int | None = None, min_grade: str = "B") -> dict[str, int]:
        grade_order = {"A": 4, "B": 3, "C": 2, "D": 1, "F": 0}
        min_rank = grade_order.get(min_grade, 3)
        stats = {"tailored": 0, "failed": 0, "skipped": 0}

        if job_id:
            jobs = [self.db.get_job(job_id)]
            jobs = [j for j in jobs if j]
        else:
            jobs = self.db.get_jobs_by_status("scored")

        for job in jobs:
            grade = job.get("grade") or "F"
            if grade_order.get(grade, 0) < min_rank:
                stats["skipped"] += 1
                continue
            try:
                self.materials.tailor_job(self.db, job["id"])
                stats["tailored"] += 1
                logger.info("Generated materials for job %s", job["id"])
            except Exception as exc:
                stats["failed"] += 1
                logger.exception("Failed to tailor job %s: %s", job["id"], exc)
        return stats

    def run(self) -> dict[str, Any]:
        logger.info("=== Pipeline: Discover ===")
        discover_stats = self.discover()
        logger.info(
            "Discovery: %d raw, %d inserted",
            discover_stats["discovered"],
            discover_stats["inserted"],
        )

        logger.info("=== Pipeline: Score ===")
        score_stats = self.score()
        logger.info(
            "Scoring: %d scored, %d discarded, %d failed",
            score_stats["scored"],
            score_stats["discarded"],
            score_stats["failed"],
        )

        logger.info("=== Pipeline: Tailor (A/B) ===")
        tailor_stats = self.tailor(min_grade="B")
        logger.info(
            "Tailoring: %d tailored, %d skipped, %d failed",
            tailor_stats["tailored"],
            tailor_stats["skipped"],
            tailor_stats["failed"],
        )

        return {
            "discover": discover_stats,
            "score": score_stats,
            "tailor": tailor_stats,
        }


def print_results_table(db: Database) -> None:
    jobs, _ = db.list_jobs(sort="score", page_size=100)
    if not jobs:
        print("No jobs found.")
        return
    header = f"{'ID':<5} {'Grade':<6} {'Score':<6} {'Status':<16} {'Company':<24} Title"
    print(header)
    print("-" * len(header))
    for job in jobs:
        print(
            f"{job['id']:<5} "
            f"{(job.get('grade') or '-'):<6} "
            f"{str(job.get('score') or '-'):<6} "
            f"{job['status']:<16} "
            f"{job['company'][:24]:<24} "
            f"{job['title'][:40]}"
        )


def job_to_response(job: dict[str, Any]) -> dict[str, Any]:
    result = dict(job)
    if isinstance(result.get("score_reasons"), str):
        try:
            result["score_reasons"] = json.loads(result["score_reasons"])
        except json.JSONDecodeError:
            result["score_reasons"] = {}
    if isinstance(result.get("red_flags"), str):
        try:
            result["red_flags"] = json.loads(result["red_flags"])
        except json.JSONDecodeError:
            result["red_flags"] = []
    result["is_remote"] = bool(result.get("is_remote"))
    return result
