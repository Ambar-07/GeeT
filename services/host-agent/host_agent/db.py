import sqlite3
from pathlib import Path

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS approved_dirs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    album TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    format TEXT NOT NULL,
    codec TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    mtime_ns INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT,
    duplicate_of TEXT,
    readiness TEXT NOT NULL DEFAULT 'raw',
    has_lyrics INTEGER NOT NULL DEFAULT 0,
    has_instrumental INTEGER NOT NULL DEFAULT 0,
    has_cover INTEGER NOT NULL DEFAULT 0,
    instrumental_path TEXT,
    vocal_path TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_songs_title_id ON songs(title, id);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    song_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lyrics (
    song_id TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
    lrc_text TEXT NOT NULL DEFAULT '',
    offset_ms INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    synchronized_ready INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def _ensure_columns(conn: sqlite3.Connection, table: str, migrations: dict[str, str]) -> None:
    cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    for name, ddl in migrations.items():
        if name not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


def connect_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.executescript(SCHEMA_SQL)
    _ensure_columns(
        conn,
        "songs",
        {
            "codec": "TEXT",
            "size_bytes": "INTEGER NOT NULL DEFAULT 0",
            "mtime_ns": "INTEGER NOT NULL DEFAULT 0",
            "content_hash": "TEXT",
            "duplicate_of": "TEXT",
            "has_cover": "INTEGER NOT NULL DEFAULT 0",
            "instrumental_path": "TEXT",
            "vocal_path": "TEXT",
        },
    )
    _ensure_columns(conn, "jobs", {"song_id": "TEXT"})
    conn.execute("CREATE INDEX IF NOT EXISTS idx_songs_content_hash ON songs(content_hash);")
    conn.commit()
    return conn
