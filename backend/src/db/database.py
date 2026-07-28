from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterator

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "jobs.db"
SCHEMA_PATH = Path(__file__).parent / "schema.sql"

VALID_TRANSITIONS: dict[str, set[str]] = {
    "discovered": {"scored", "discarded"},
    "scored": {"shortlisted", "discarded"},
    "shortlisted": {"materials_ready", "discarded"},
    "materials_ready": {"applied", "discarded"},
    "applied": {"interviewing", "rejected"},
    "interviewing": {"offer", "rejected"},
    "discarded": set(),
    "offer": set(),
    "rejected": set(),
}


def normalize_title(title: str) -> str:
    t = title.lower().strip()
    t = re.sub(r"\([^)]*\)", "", t)
    t = re.sub(r"[^a-z0-9\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def make_dedupe_key(company: str, title: str) -> str:
    return f"{company.lower().strip()}|{normalize_title(title)}"


def parse_date_posted(value: str | None) -> datetime | None:
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value[:19], fmt)
        except ValueError:
            continue
    return None


class Database:
    def __init__(self, db_path: Path | str | None = None) -> None:
        self.db_path = Path(db_path) if db_path else DEFAULT_DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _init_schema(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA_PATH.read_text())
            # Lightweight migrations for pre-existing DBs (CREATE IF NOT EXISTS
            # won't add new columns to an existing table).
            for stmt in (
                "ALTER TABLE chat_sessions ADD COLUMN kind TEXT DEFAULT 'deepdive'",
                "ALTER TABLE chat_messages ADD COLUMN audio_path TEXT",
                "ALTER TABLE oa_answers ADD COLUMN image_base64 TEXT",
                "ALTER TABLE oa_answers ADD COLUMN mime_type TEXT",
                "ALTER TABLE oa_answers ADD COLUMN messages TEXT",
                # Confirmation evidence for a real submission (ApplyPilot: only
                # count 'applied' when there's confirmation, not a blind flip).
                "ALTER TABLE jobs ADD COLUMN applied_at TEXT",
                "ALTER TABLE jobs ADD COLUMN applied_evidence TEXT",
            ):
                try:
                    conn.execute(stmt)
                except sqlite3.OperationalError:
                    pass

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def job_exists_by_url(self, url: str) -> bool:
        with self.connect() as conn:
            row = conn.execute("SELECT 1 FROM jobs WHERE url = ?", (url,)).fetchone()
            return row is not None

    def get_job_by_url(self, url: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE url = ?", (url,)).fetchone()
            return dict(row) if row else None

    def find_duplicate_by_dedupe_key(
        self, dedupe_key: str, date_posted: str | None
    ) -> dict[str, Any] | None:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM jobs WHERE dedupe_key = ? ORDER BY created_at DESC",
                (dedupe_key,),
            ).fetchall()
        if not rows:
            return None
        new_date = parse_date_posted(date_posted)
        for row in rows:
            existing = dict(row)
            existing_date = parse_date_posted(existing.get("date_posted"))
            if new_date and existing_date:
                if abs((new_date - existing_date).days) < 14:
                    return existing
            elif not new_date or not existing_date:
                return existing
        return None

    def insert_job(self, job: dict[str, Any]) -> int | None:
        if self.job_exists_by_url(job["url"]):
            return None
        duplicate = self.find_duplicate_by_dedupe_key(
            job["dedupe_key"], job.get("date_posted")
        )
        if duplicate and self._is_duplicate_richer(duplicate, job):
            return None
        if duplicate and not self._is_duplicate_richer(duplicate, job):
            self.delete_job(duplicate["id"])
        now = datetime.utcnow().isoformat()
        with self.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO jobs (
                    source, url, title, company, location, is_remote,
                    salary_min, salary_max, salary_currency, date_posted,
                    description, dedupe_key, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)
                """,
                (
                    job["source"],
                    job["url"],
                    job["title"],
                    job["company"],
                    job.get("location"),
                    int(bool(job.get("is_remote"))),
                    job.get("salary_min"),
                    job.get("salary_max"),
                    job.get("salary_currency"),
                    job.get("date_posted"),
                    job.get("description"),
                    job["dedupe_key"],
                    now,
                    now,
                ),
            )
            return cursor.lastrowid

    def _is_duplicate_richer(self, existing: dict[str, Any], new: dict[str, Any]) -> bool:
        existing_len = len(existing.get("description") or "")
        new_len = len(new.get("description") or "")
        return existing_len >= new_len

    def delete_job(self, job_id: int) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))

    def get_job(self, job_id: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return dict(row) if row else None

    def list_jobs(
        self,
        status: str | None = None,
        grade: str | None = None,
        search: str | None = None,
        source: str | None = None,
        sort: str = "score",
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses: list[str] = []
        params: list[Any] = []
        if status:
            clauses.append("status = ?")
            params.append(status)
        if source:
            clauses.append("source = ?")
            params.append(source)
        if grade:
            grades = [g.strip() for g in grade.split(",") if g.strip()]
            if grades:
                placeholders = ",".join("?" * len(grades))
                clauses.append(f"grade IN ({placeholders})")
                params.extend(grades)
        if search:
            clauses.append("(title LIKE ? OR company LIKE ? OR location LIKE ?)")
            like = f"%{search}%"
            params.extend([like, like, like])
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sort_map = {
            "score": "score IS NULL, score DESC, created_at DESC",
            "date": "date_posted IS NULL, date_posted DESC, created_at DESC",
            "created": "created_at DESC",
        }
        order = sort_map.get(sort, sort_map["score"])
        offset = (page - 1) * page_size
        with self.connect() as conn:
            total = conn.execute(
                f"SELECT COUNT(*) FROM jobs {where}", params
            ).fetchone()[0]
            rows = conn.execute(
                f"""
                SELECT * FROM jobs {where}
                ORDER BY {order}
                LIMIT ? OFFSET ?
                """,
                [*params, page_size, offset],
            ).fetchall()
        return [dict(r) for r in rows], total

    def get_jobs_by_status(self, status: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC",
                (status,),
            ).fetchall()
        return [dict(r) for r in rows]

    def update_job_score(
        self,
        job_id: int,
        score: int,
        grade: str,
        score_reasons: dict[str, Any],
        red_flags: list[str],
        status: str = "scored",
    ) -> None:
        now = datetime.utcnow().isoformat()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE jobs SET score = ?, grade = ?, score_reasons = ?,
                red_flags = ?, status = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    score,
                    grade,
                    json.dumps(score_reasons),
                    json.dumps(red_flags),
                    status,
                    now,
                    job_id,
                ),
            )

    def update_job_materials(
        self,
        job_id: int,
        resume_path: str | None,
        cover_letter_path: str | None,
        status: str = "materials_ready",
    ) -> None:
        now = datetime.utcnow().isoformat()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE jobs SET resume_path = ?, cover_letter_path = ?,
                status = ?, updated_at = ?
                WHERE id = ?
                """,
                (resume_path, cover_letter_path, status, now, job_id),
            )

    def update_job_resume(self, job_id: int, resume_path: str) -> None:
        """Set only the résumé path, leaving any existing cover letter intact."""
        now = datetime.utcnow().isoformat()
        with self.connect() as conn:
            conn.execute(
                "UPDATE jobs SET resume_path = ?, status = ?, updated_at = ? WHERE id = ?",
                (resume_path, "materials_ready", now, job_id),
            )

    def update_job_cover(self, job_id: int, cover_letter_path: str) -> None:
        """Set only the cover-letter path, leaving any existing résumé intact."""
        now = datetime.utcnow().isoformat()
        with self.connect() as conn:
            conn.execute(
                "UPDATE jobs SET cover_letter_path = ?, status = ?, updated_at = ? WHERE id = ?",
                (cover_letter_path, "materials_ready", now, job_id),
            )

    # --- Chat sessions (DeepDive + FinalRoundAI) ---
    def create_chat_session(self, title: str = "New session", kind: str = "deepdive") -> int:
        now = datetime.utcnow().isoformat()
        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO chat_sessions (title, kind, updated_at) VALUES (?, ?, ?)",
                (title, kind, now),
            )
            return cur.lastrowid

    def get_chat_session(self, session_id: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM chat_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            return dict(row) if row else None

    def list_chat_sessions(self, kind: str | None = None) -> list[dict[str, Any]]:
        with self.connect() as conn:
            if kind:
                rows = conn.execute(
                    "SELECT * FROM chat_sessions WHERE kind = ? ORDER BY updated_at DESC",
                    (kind,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM chat_sessions ORDER BY updated_at DESC"
                ).fetchall()
            return [dict(r) for r in rows]

    def get_chat_messages(self, session_id: int) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT id, role, content, audio_path, created_at FROM chat_messages "
                "WHERE session_id = ? ORDER BY id",
                (session_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_chat_message(self, message_id: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM chat_messages WHERE id = ?", (message_id,)
            ).fetchone()
            return dict(row) if row else None

    def add_chat_message(
        self, session_id: int, role: str, content: str, audio_path: str | None = None
    ) -> int:
        now = datetime.utcnow().isoformat()
        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO chat_messages (session_id, role, content, audio_path) VALUES (?, ?, ?, ?)",
                (session_id, role, content, audio_path),
            )
            conn.execute(
                "UPDATE chat_sessions SET updated_at = ? WHERE id = ?", (now, session_id)
            )
            return cur.lastrowid

    def rename_chat_session(self, session_id: int, title: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE chat_sessions SET title = ? WHERE id = ?", (title[:80], session_id)
            )

    def delete_chat_session(self, session_id: int) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM chat_messages WHERE session_id = ?", (session_id,))
            conn.execute("DELETE FROM chat_sessions WHERE id = ?", (session_id,))

    # --- OA screening answers ---
    @staticmethod
    def _oa_messages(raw: Any, fallback_answer: Any) -> list[dict[str, Any]]:
        if raw:
            try:
                parsed = json.loads(raw)
                if parsed:
                    return parsed
            except (TypeError, json.JSONDecodeError):
                pass
        return [{"role": "assistant", "content": fallback_answer or ""}]

    def _oa_public(self, row: sqlite3.Row) -> dict[str, Any]:
        """Row → API dict: parsed messages, and NO image_base64 (kept off the
        1.5s polling payload; it's only needed server-side for refine)."""
        d = dict(row)
        d.pop("image_base64", None)
        d["messages"] = self._oa_messages(d.get("messages"), d.get("answer"))
        return d

    # Columns safe to ship to the client (excludes the heavy image_base64 blob).
    _OA_COLS = "id, question, answer, messages, created_at"

    def add_oa_answer(
        self,
        question: str,
        answer: str,
        image_base64: str | None = None,
        mime_type: str | None = None,
    ) -> int:
        messages = json.dumps([{"role": "assistant", "content": answer}])
        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO oa_answers (question, answer, image_base64, mime_type, messages) "
                "VALUES (?, ?, ?, ?, ?)",
                (question, answer, image_base64, mime_type, messages),
            )
            return cur.lastrowid

    def get_latest_oa(self) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                f"SELECT {self._OA_COLS} FROM oa_answers ORDER BY id DESC LIMIT 1"
            ).fetchone()
            return self._oa_public(row) if row else None

    def get_oa(self, oid: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                f"SELECT {self._OA_COLS} FROM oa_answers WHERE id = ?", (oid,)
            ).fetchone()
            return self._oa_public(row) if row else None

    def get_oa_full(self, oid: int) -> dict[str, Any] | None:
        """Includes image_base64 — server-side only (refine re-grounding)."""
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM oa_answers WHERE id = ?", (oid,)).fetchone()
            if not row:
                return None
            d = dict(row)
            d["messages"] = self._oa_messages(d.get("messages"), d.get("answer"))
            return d

    def list_oa_answers(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT {self._OA_COLS} FROM oa_answers ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
            return [self._oa_public(r) for r in rows]

    def append_oa_messages(self, oid: int, user_message: str, assistant_message: str) -> None:
        current = self.get_oa_full(oid)
        if not current:
            return
        messages = current["messages"] + [
            {"role": "user", "content": user_message},
            {"role": "assistant", "content": assistant_message},
        ]
        with self.connect() as conn:
            conn.execute(
                "UPDATE oa_answers SET messages = ?, answer = ? WHERE id = ?",
                (json.dumps(messages), assistant_message, oid),
            )

    def clear_oa_answers(self) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM oa_answers")

    # --- Cached application answers ---
    def get_answer(self, key: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM answers WHERE key = ?", (key,)).fetchone()
            return dict(row) if row else None

    def upsert_answer(
        self,
        key: str,
        question: str,
        answer: str,
        options: str | None = None,
        job_id: int | None = None,
        reviewed: int = 0,
    ) -> None:
        now = datetime.utcnow().isoformat()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO answers (key, question, options, job_id, answer, reviewed, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    answer = excluded.answer,
                    reviewed = excluded.reviewed,
                    updated_at = excluded.updated_at
                """,
                (key, question, options, job_id, answer, reviewed, now),
            )

    def list_answers(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM answers ORDER BY updated_at DESC").fetchall()
            return [dict(r) for r in rows]

    def delete_answer(self, key: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM answers WHERE key = ?", (key,))

    def update_job_status(
        self, job_id: int, new_status: str, evidence: str | None = None
    ) -> bool:
        job = self.get_job(job_id)
        if not job:
            return False
        current = job["status"]
        allowed = VALID_TRANSITIONS.get(current, set())
        if new_status not in allowed:
            return False
        now = datetime.utcnow().isoformat()
        with self.connect() as conn:
            conn.execute(
                "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
                (new_status, now, job_id),
            )
            # Record confirmation evidence when the job is marked applied.
            if new_status == "applied":
                conn.execute(
                    "UPDATE jobs SET applied_at = ?, applied_evidence = ? WHERE id = ?",
                    (now, (evidence or "").strip() or None, job_id),
                )
        return True

    # --- Blocker queue ---
    def add_blocker(
        self, job_id: int | None, kind: str, detail: str = "", needs_user: bool = True
    ) -> int:
        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO blockers (job_id, kind, detail, needs_user) VALUES (?, ?, ?, ?)",
                (job_id, kind, detail, 1 if needs_user else 0),
            )
            return cur.lastrowid

    def list_blockers(
        self, job_id: int | None = None, resolved: bool | None = None
    ) -> list[dict[str, Any]]:
        clauses, params = [], []
        if job_id is not None:
            clauses.append("job_id = ?")
            params.append(job_id)
        if resolved is not None:
            clauses.append("resolved = ?")
            params.append(1 if resolved else 0)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM blockers {where} ORDER BY id DESC", params
            ).fetchall()
            return [dict(r) for r in rows]

    def resolve_blocker(self, blocker_id: int) -> bool:
        now = datetime.utcnow().isoformat()
        with self.connect() as conn:
            cur = conn.execute(
                "UPDATE blockers SET resolved = 1, resolved_at = ? WHERE id = ?",
                (now, blocker_id),
            )
            return cur.rowcount > 0

    def get_stats(self) -> dict[str, Any]:
        today = datetime.utcnow().date().isoformat()
        with self.connect() as conn:
            today_new = conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE date(created_at) = ?",
                (today,),
            ).fetchone()[0]
            pending = conn.execute(
                """
                SELECT COUNT(*) FROM jobs
                WHERE status IN ('discovered', 'scored', 'shortlisted', 'materials_ready')
                """
            ).fetchone()[0]
            applied = conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE status = 'applied'"
            ).fetchone()[0]
            responded = conn.execute(
                """
                SELECT COUNT(*) FROM jobs
                WHERE status IN ('interviewing', 'offer', 'rejected')
                """
            ).fetchone()[0]
        reply_rate = round(responded / applied * 100, 1) if applied else 0.0
        return {
            "today_new": today_new,
            "pending": pending,
            "applied": applied,
            "reply_rate": reply_rate,
        }
