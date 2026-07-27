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
