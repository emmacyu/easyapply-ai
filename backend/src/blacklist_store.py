"""Company / industry blacklist (config/blacklist_*.txt).

Plain text, one name per line; anything after " #" is a note. The extension
adds companies here when a LinkedIn job belongs to a blacklisted industry, and
discovery skips blacklisted companies.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

CONFIG_DIR = Path(__file__).resolve().parents[1] / "config"
COMPANIES_PATH = CONFIG_DIR / "blacklist_companies.txt"
INDUSTRIES_PATH = CONFIG_DIR / "blacklist_industries.txt"


def _read(path: Path) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []
    names = (line.split(" #", 1)[0].strip() for line in lines if not line.lstrip().startswith("#"))
    return [n for n in names if n]


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()


def companies() -> list[str]:
    return _read(COMPANIES_PATH)


def industries() -> list[str]:
    return _read(INDUSTRIES_PATH)


def match_company(company: str) -> str | None:
    """The blacklist entry `company` falls under, if any. An entry matches as a
    whole-word phrase, so "Cognizant" covers "Cognizant Technology Solutions"."""
    padded = f" {_norm(company)} "
    for entry in companies():
        key = _norm(entry)
        if key and f" {key} " in padded:
            return entry
    return None


def match_industry(industry: str) -> str | None:
    wanted = _norm(industry)
    for entry in industries():
        if wanted and _norm(entry) == wanted:
            return entry
    return None


def add_company(company: str, note: str = "") -> bool:
    """Append `company` unless already covered. Returns whether it was added."""
    company = " ".join(str(company or "").split())
    if not company or match_company(company):
        return False
    existing = COMPANIES_PATH.read_text(encoding="utf-8") if COMPANIES_PATH.exists() else ""
    line = company + (f"  # {note}, added {date.today().isoformat()}" if note else "")
    sep = "" if not existing or existing.endswith("\n") else "\n"
    COMPANIES_PATH.write_text(existing + sep + line + "\n", encoding="utf-8")
    return True
