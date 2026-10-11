CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    url TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT,
    is_remote BOOLEAN DEFAULT 0,
    salary_min REAL,
    salary_max REAL,
    salary_currency TEXT,
    date_posted TEXT,
    description TEXT,
    dedupe_key TEXT NOT NULL,
    score INTEGER,
    grade TEXT,
    score_reasons TEXT,
    red_flags TEXT,
    resume_path TEXT,
    cover_letter_path TEXT,
    status TEXT DEFAULT 'discovered',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_dedupe ON jobs(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_grade ON jobs(grade);
CREATE INDEX IF NOT EXISTS idx_score ON jobs(score);

-- Career-interview chat: sessions + messages (mines experience for future use).
CREATE TABLE IF NOT EXISTS chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    kind TEXT DEFAULT 'deepdive',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    audio_path TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id);

-- OA screening: screenshot → question + answer, shown on a second device (iPad).
CREATE TABLE IF NOT EXISTS oa_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT,
    answer TEXT,              -- latest assistant answer (kept for /latest + history display)
    image_base64 TEXT,        -- original screenshot, re-sent on refine (server-side only)
    mime_type TEXT,
    messages TEXT,            -- JSON thread: [{role: assistant|user, content}], grows on refine
    created_at TEXT DEFAULT (datetime('now'))
);

-- Cached LLM answers to application questions (AIHawk-style answer memory).
CREATE TABLE IF NOT EXISTS answers (
    key TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    options TEXT,
    job_id INTEGER,
    answer TEXT,
    reviewed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

-- Blocker queue (ApplyPilot-style): things that stopped an application and need
-- attention — captcha / login / 2fa / missing_file / dropdown / upload / other.
CREATE TABLE IF NOT EXISTS blockers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER,
    kind TEXT NOT NULL,
    detail TEXT,
    needs_user INTEGER DEFAULT 1,
    resolved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_blocker_job ON blockers(job_id);

-- Applications the user actually submitted, recorded by the browser extension
-- when a submission is confirmed. Independent of `jobs`: most applications are
-- for postings that were never saved to the board (job_id is then NULL).
CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,        -- application page; re-submitting updates the row
    company TEXT,
    title TEXT,
    page_title TEXT,
    job_id INTEGER,                  -- jobs.id when a tailored résumé was used
    resume TEXT,                     -- file name that was uploaded
    answers TEXT,                    -- JSON [{label, value, source}] as submitted
    confirmation TEXT,               -- how we know: 'page' (confirmation seen) | 'manual'
    applied_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_applications_company ON applications(company);
