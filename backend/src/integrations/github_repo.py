"""Fetch a public GitHub repo's README + a size-capped slice of its source code,
for feeding into the presentation generator. Uses the public GitHub REST API
(anonymous; set GITHUB_TOKEN for private repos / higher rate limits)."""

from __future__ import annotations

import base64
import logging
import os
import re
from typing import Any

import httpx

logger = logging.getLogger(__name__)

API = "https://api.github.com"

# Source extensions worth showing the model, roughly in priority order.
CODE_EXTS = (
    ".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".kt", ".rb",
    ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".swift", ".scala", ".php",
    ".sql", ".sh", ".md",
)
SKIP_DIRS = (
    "node_modules/", "dist/", "build/", ".venv/", "venv/", "__pycache__/",
    ".git/", "vendor/", "target/", ".next/", "coverage/", "fonts/",
)
SKIP_SUFFIXES = (".min.js", ".min.css", ".lock", ".map", ".svg", ".png", ".jpg")

MAX_FILES = 25
MAX_FILE_CHARS = 6000
MAX_TOTAL_CHARS = 45000


def parse_repo_url(url: str) -> tuple[str, str]:
    """'https://github.com/owner/repo(.git)(/tree/…)' -> ('owner', 'repo')."""
    m = re.search(r"github\.com[/:]([^/]+)/([^/#?]+)", url.strip())
    if not m:
        raise ValueError(f"Not a GitHub repo URL: {url!r}")
    owner, repo = m.group(1), m.group(2)
    return owner, repo[:-4] if repo.endswith(".git") else repo


def _headers() -> dict[str, str]:
    h = {"Accept": "application/vnd.github+json", "User-Agent": "JobPilot/1.0"}
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _rank(path: str) -> int:
    ext = "." + path.rsplit(".", 1)[-1] if "." in path else ""
    base = CODE_EXTS.index(ext) if ext in CODE_EXTS else len(CODE_EXTS)
    # Prefer shallow, entrypoint-ish files.
    depth = path.count("/")
    boost = -3 if re.search(r"(main|app|index|__init__|server|cli)\.", path) else 0
    return base + depth + boost


def fetch_repo(url: str) -> dict[str, Any]:
    owner, repo = parse_repo_url(url)
    with httpx.Client(headers=_headers(), timeout=30, follow_redirects=True) as client:
        meta = client.get(f"{API}/repos/{owner}/{repo}")
        if meta.status_code == 404:
            raise ValueError(f"Repo not found (or private): {owner}/{repo}")
        meta.raise_for_status()
        meta = meta.json()
        branch = meta.get("default_branch", "main")

        readme = ""
        r = client.get(f"{API}/repos/{owner}/{repo}/readme")
        if r.status_code == 200:
            readme = base64.b64decode(r.json().get("content", "")).decode("utf-8", "replace")

        tree_resp = client.get(
            f"{API}/repos/{owner}/{repo}/git/trees/{branch}", params={"recursive": "1"}
        )
        tree_resp.raise_for_status()
        blobs = [
            t for t in tree_resp.json().get("tree", [])
            if t.get("type") == "blob"
            and any(t["path"].endswith(e) for e in CODE_EXTS)
            and not any(d in t["path"] for d in SKIP_DIRS)
            and not any(t["path"].endswith(s) for s in SKIP_SUFFIXES)
            and t["path"].lower() != "readme.md"
        ]
        blobs.sort(key=lambda t: _rank(t["path"]))

        files: list[dict[str, str]] = []
        total = 0
        for blob in blobs[: MAX_FILES * 2]:
            if len(files) >= MAX_FILES or total >= MAX_TOTAL_CHARS:
                break
            # Blobs API works for both public and private repos with the token
            # (raw.githubusercontent is unreliable for private).
            br = client.get(f"{API}/repos/{owner}/{repo}/git/blobs/{blob['sha']}")
            if br.status_code != 200:
                continue
            bj = br.json()
            if bj.get("encoding") != "base64":
                continue
            try:
                content = base64.b64decode(bj["content"]).decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                continue
            content = content[:MAX_FILE_CHARS]
            files.append({"path": blob["path"], "content": content})
            total += len(content)

    return {
        "full_name": meta.get("full_name", f"{owner}/{repo}"),
        "url": meta.get("html_url", url),
        "description": meta.get("description") or "",
        "language": meta.get("language") or "",
        "topics": meta.get("topics", []),
        "stars": meta.get("stargazers_count", 0),
        "readme": readme,
        "files": files,
    }


def build_context(repo: dict[str, Any]) -> str:
    """Flatten the repo dict into one prompt-ready text blob."""
    parts = [
        f"# Repository: {repo['full_name']}",
        f"URL: {repo['url']}",
        f"Description: {repo['description']}",
        f"Primary language: {repo['language']}   Topics: {', '.join(repo.get('topics', []))}",
        "",
        "## README",
        (repo.get("readme") or "(no README)").strip()[:16000],
        "",
        "## Source files (excerpts)",
    ]
    for f in repo["files"]:
        parts.append(f"\n### {f['path']}\n```\n{f['content']}\n```")
    return "\n".join(parts)
