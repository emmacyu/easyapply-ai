#!/usr/bin/env python3
"""JobPilot CLI — personal job search automation pipeline."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

# .env lives at the repo root (one level up from backend/)
load_dotenv(PROJECT_ROOT.parent / ".env")


def setup_logging(verbose: bool = False) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def cmd_run(args: argparse.Namespace) -> None:
    from src.pipeline import Pipeline, print_results_table

    pipeline = Pipeline(use_mock=args.mock)
    pipeline.run()
    print("\n=== Results ===")
    print_results_table(pipeline.db)


def cmd_discover(args: argparse.Namespace) -> None:
    from src.pipeline import Pipeline, print_results_table

    pipeline = Pipeline(use_mock=args.mock)
    stats = pipeline.discover()
    print(f"Discovered: {stats['discovered']}, Inserted: {stats['inserted']}")
    print_results_table(pipeline.db)


def cmd_score(args: argparse.Namespace) -> None:
    from src.pipeline import Pipeline, print_results_table

    pipeline = Pipeline(use_mock=args.mock)
    stats = pipeline.score()
    print(f"Scored: {stats['scored']}, Discarded: {stats['discarded']}, Failed: {stats['failed']}")
    print_results_table(pipeline.db)


def cmd_tailor(args: argparse.Namespace) -> None:
    from src.pipeline import Pipeline

    pipeline = Pipeline(use_mock=args.mock)
    stats = pipeline.tailor(job_id=args.id)
    print(f"Tailored: {stats['tailored']}, Skipped: {stats['skipped']}, Failed: {stats['failed']}")


def cmd_serve(args: argparse.Namespace) -> None:
    import uvicorn

    scheduler = None
    if args.schedule:
        from src.scheduler import start_scheduler

        scheduler = start_scheduler()

    try:
        uvicorn.run(
            "src.web.app:app",
            host=args.host,
            port=args.port,
            reload=args.reload,
        )
    finally:
        if scheduler:
            scheduler.shutdown(wait=False)


def cmd_gmail_auth(args: argparse.Namespace) -> None:
    from src.integrations.gmail_client import ALLOWED_ACCOUNT, authorize

    print(f"Authorizing read-only Gmail access for: {ALLOWED_ACCOUNT}")
    print(
        "A URL will be printed. Open it in your browser, sign in as that account, "
        "and approve. (In Docker, ensure the auth port is published.)"
    )
    email = authorize(port=args.port, open_browser=args.open_browser)
    print(f"\n✅ Connected: {email}")


def main() -> None:
    parser = argparse.ArgumentParser(description="JobPilot — job search automation")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("--mock", action="store_true", help="Use mock LLM provider")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("run", help="Full pipeline: discover → score → tailor")
    sub.add_parser("discover", help="Discover jobs only")
    sub.add_parser("score", help="Score discovered jobs")
    tailor_p = sub.add_parser("tailor", help="Generate materials for a job")
    tailor_p.add_argument("--id", type=int, required=True, help="Job ID")

    serve_p = sub.add_parser("serve", help="Start FastAPI server")
    serve_p.add_argument("--host", default="0.0.0.0")
    serve_p.add_argument("--port", type=int, default=8000)
    serve_p.add_argument("--reload", action="store_true")
    serve_p.add_argument(
        "--schedule",
        action="store_true",
        help="Enable daily cron pipeline from config/search.yaml",
    )

    gmail_p = sub.add_parser("gmail-auth", help="Connect the read-only Gmail account (OAuth)")
    gmail_p.add_argument("--port", type=int, default=8765, help="Loopback OAuth port")
    gmail_p.add_argument("--open-browser", action="store_true", help="Try to open a browser")

    args = parser.parse_args()
    setup_logging(args.verbose)

    os.chdir(PROJECT_ROOT)
    commands = {
        "run": cmd_run,
        "discover": cmd_discover,
        "score": cmd_score,
        "tailor": cmd_tailor,
        "serve": cmd_serve,
        "gmail-auth": cmd_gmail_auth,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
