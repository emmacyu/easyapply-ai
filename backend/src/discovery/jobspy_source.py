from __future__ import annotations

import logging
import time
from typing import Any

import yaml

from src.db.database import Database
from src.discovery.models import Job

logger = logging.getLogger(__name__)

MIN_INTERVAL_SECONDS = 5


class JobSpySource:
    def __init__(self, search_config_path: str = "config/search.yaml") -> None:
        with open(search_config_path, encoding="utf-8") as f:
            self.config = yaml.safe_load(f)

    def discover(self, db: Database | None = None) -> list[Job]:
        try:
            from jobspy import scrape_jobs
        except ImportError as exc:
            raise RuntimeError(
                "python-jobspy is required. Install with: pip install python-jobspy"
            ) from exc

        all_jobs: list[Job] = []
        sites = self.config.get("sites", ["indeed", "linkedin"])
        results_per_site = self.config.get("results_per_site", 30)
        hours_old = self.config.get("hours_old", 72)
        country_indeed = self.config.get("country_indeed", "Canada")
        skipped_sites: set[str] = set()

        for search in self.config.get("searches", []):
            term = search["term"]
            location = search["location"]
            logger.info("Searching: %s in %s", term, location)
            active_sites = [s for s in sites if s not in skipped_sites]
            if not active_sites:
                logger.warning("All sites skipped due to rate limits")
                break

            try:
                df = scrape_jobs(
                    site_name=active_sites,
                    search_term=term,
                    location=location,
                    results_wanted=min(results_per_site, 30),
                    hours_old=hours_old,
                    country_indeed=country_indeed,
                    linkedin_fetch_description=True,
                )
            except Exception as exc:
                msg = str(exc).lower()
                if "429" in msg or "rate" in msg:
                    logger.warning("Rate limited, skipping sites this round: %s", exc)
                    skipped_sites.update(active_sites)
                    continue
                logger.exception("JobSpy scrape failed for %s: %s", term, exc)
                continue

            if df is None or df.empty:
                logger.info("No results for %s in %s", term, location)
                time.sleep(MIN_INTERVAL_SECONDS)
                continue

            for _, row in df.iterrows():
                row_dict = row.to_dict()
                source = str(row_dict.get("site") or row_dict.get("via") or "unknown").lower()
                try:
                    job = Job.from_jobspy_row(row_dict, source)
                    if job.url:
                        all_jobs.append(job)
                except Exception as exc:
                    logger.debug("Skipping malformed row: %s", exc)

            time.sleep(MIN_INTERVAL_SECONDS)

        logger.info("Discovered %d raw jobs", len(all_jobs))
        return all_jobs

    def persist(self, jobs: list[Job], db: Database) -> int:
        inserted = 0
        for job in jobs:
            job_id = db.insert_job(job.model_dump())
            if job_id:
                inserted += 1
        logger.info("Inserted %d new jobs into database", inserted)
        return inserted
