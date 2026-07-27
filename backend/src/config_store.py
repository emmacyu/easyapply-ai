"""Read/write the profile.yaml that the UI edits.

`profile.yaml` stays the single source of truth (hand-editable or UI-edited).
Writes use ruamel round-trip so hand-authored comments, key order, and
formatting survive UI saves.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import yaml
from ruamel.yaml import YAML

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PROFILE_PATH = PROJECT_ROOT / "config" / "profile.yaml"

_ruamel = YAML()
_ruamel.preserve_quotes = True
_ruamel.width = 4096  # don't wrap long answer strings


def load_profile() -> dict[str, Any]:
    """Return the whole profile as plain JSON-serializable data (for the UI)."""
    return yaml.safe_load(PROFILE_PATH.read_text(encoding="utf-8")) or {}


def _reconcile(target: Any, source: Any) -> None:
    """Make the ruamel `target` map match `source`, preserving comments on
    surviving keys. Removes keys absent from source; adds/updates the rest."""
    for key in list(target.keys()):
        if key not in source:
            del target[key]
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _reconcile(target[key], value)
        else:
            target[key] = value


def save_profile(data: dict[str, Any]) -> None:
    """Merge `data` into profile.yaml, preserving comments/order/formatting."""
    doc = _ruamel.load(PROFILE_PATH.read_text(encoding="utf-8"))
    _reconcile(doc, data)
    buf = io.StringIO()
    _ruamel.dump(doc, buf)
    PROFILE_PATH.write_text(buf.getvalue(), encoding="utf-8")
