import pytest
from datetime import datetime, timedelta

from src.db.database import Database, make_dedupe_key, normalize_title
from src.ai.provider import MockLLMProvider
from src.ai.scorer import JobScorer
from src.pipeline import Pipeline


@pytest.fixture
def db(tmp_path):
    return Database(db_path=tmp_path / "test.db")


def test_normalize_title():
    assert normalize_title("Senior Software Engineer (Remote)") == "senior software engineer"


def test_make_dedupe_key():
    key = make_dedupe_key("Google", "Software Engineer")
    assert key == "google|software engineer"


def test_insert_and_dedupe_by_url(db):
    job = {
        "source": "linkedin",
        "url": "https://example.com/job/1",
        "title": "Backend Engineer",
        "company": "Acme",
        "location": "Toronto",
        "is_remote": False,
        "dedupe_key": make_dedupe_key("Acme", "Backend Engineer"),
        "description": "Build APIs",
        "date_posted": "2026-07-10",
    }
    id1 = db.insert_job(job)
    id2 = db.insert_job(job)
    assert id1 is not None
    assert id2 is None


def test_cross_platform_dedupe_within_14_days(db):
    base = {
        "source": "linkedin",
        "title": "Software Engineer",
        "company": "Acme Corp",
        "location": "Toronto",
        "is_remote": False,
        "dedupe_key": make_dedupe_key("Acme Corp", "Software Engineer"),
        "description": "Short JD",
        "date_posted": "2026-07-10",
    }
    job1 = {**base, "url": "https://linkedin.com/jobs/1"}
    job2 = {
        **base,
        "source": "indeed",
        "url": "https://indeed.com/jobs/2",
        "description": "Much longer job description with more details about the role and requirements.",
        "date_posted": "2026-07-12",
    }
    id1 = db.insert_job(job1)
    id2 = db.insert_job(job2)
    assert id1 is not None
    assert id2 is not None
    remaining = db.get_job(id2)
    assert len(remaining["description"]) > len("Short JD")


def test_status_transitions(db):
    job = {
        "source": "indeed",
        "url": "https://example.com/job/status",
        "title": "Engineer",
        "company": "Co",
        "dedupe_key": make_dedupe_key("Co", "Engineer"),
    }
    job_id = db.insert_job(job)
    assert db.update_job_status(job_id, "scored")
    assert db.get_job(job_id)["status"] == "scored"
    assert db.update_job_status(job_id, "shortlisted")
    assert not db.update_job_status(job_id, "applied")


def test_scorer_with_mock(db):
    job = {
        "id": 1,
        "title": "Software Engineer",
        "company": "Test Co",
        "location": "Toronto",
        "description": "Python, FastAPI, backend development",
        "status": "discovered",
    }
    db.insert_job(
        {
            "source": "test",
            "url": "https://test.com/1",
            "title": job["title"],
            "company": job["company"],
            "location": job["location"],
            "description": job["description"],
            "dedupe_key": make_dedupe_key(job["company"], job["title"]),
        }
    )
    scorer = JobScorer(MockLLMProvider())
    stats = scorer.score_all_discovered(db)
    assert stats["scored"] == 1
    updated = db.get_jobs_by_status("scored")[0]
    assert updated["grade"] == "B"
    assert updated["score"] == 78


def test_pipeline_score_only_mock(db, monkeypatch):
    db.insert_job(
        {
            "source": "test",
            "url": "https://test.com/pipe",
            "title": "Backend Dev",
            "company": "PipeCo",
            "description": "Backend role",
            "dedupe_key": make_dedupe_key("PipeCo", "Backend Dev"),
        }
    )

    pipeline = Pipeline(db=db, provider=MockLLMProvider())
    pipeline.score()
    jobs = db.list_jobs()[0]
    assert len(jobs) == 1
    assert jobs[0]["status"] == "scored"
