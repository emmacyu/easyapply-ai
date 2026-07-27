from __future__ import annotations

import logging
from pathlib import Path

import yaml
from apscheduler.schedulers.background import BackgroundScheduler

from src.pipeline import Pipeline

logger = logging.getLogger(__name__)


def start_scheduler() -> BackgroundScheduler | None:
    config_path = Path("config/search.yaml")
    if not config_path.exists():
        return None

    with open(config_path, encoding="utf-8") as f:
        config = yaml.safe_load(f)

    cron = config.get("schedule_cron")
    if not cron:
        return None

    parts = cron.split()
    if len(parts) != 5:
        logger.warning("Invalid schedule_cron: %s", cron)
        return None

    minute, hour, day, month, day_of_week = parts
    scheduler = BackgroundScheduler()

    def run_job() -> None:
        logger.info("Scheduled pipeline run started")
        try:
            Pipeline().run()
        except Exception:
            logger.exception("Scheduled pipeline failed")

    scheduler.add_job(
        run_job,
        trigger="cron",
        minute=minute,
        hour=hour,
        day=day,
        month=month,
        day_of_week=day_of_week,
        id="daily_pipeline",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("Scheduler started with cron: %s", cron)
    return scheduler
