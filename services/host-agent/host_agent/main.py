import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from mutagen import File as MutagenFile
from pydantic import BaseModel

from .config import get_config
from .db import connect_db
from .separator import (
    detect_compute_device,
    has_demucs,
    run_demucs_separation,
    verify_stem_integrity,
)

MIN_FREE_CACHE_BYTES = 200 * 1024 * 1024
SeparatorFn = Callable[[Path, Path, str, Callable[[], bool]], tuple[Path, Path]]

SUPPORTED_EXTS = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".flac": "audio/flac"}
DRM_EXTS = {".m4p"}
LRC_TIMESTAMP_RE = re.compile(r"\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]")


def _has_timed_lrc(lrc_text: str) -> bool:
    return bool(LRC_TIMESTAMP_RE.search(lrc_text))


def _song_id(canonical_path: Path) -> str:
    return hashlib.sha256(str(canonical_path).encode("utf-8")).hexdigest()[:16]


def _is_within_approved(file_path: Path, approved_dirs: list[Path]) -> bool:
    resolved = file_path.resolve()
    return any(resolved == d or d in resolved.parents for d in approved_dirs)


def _has_drm(file_path: Path) -> bool:
    if file_path.suffix.lower() in DRM_EXTS:
        return True
    if file_path.suffix.lower() == ".m4a":
        with file_path.open("rb") as f:
            head = f.read(65536)
        if b"drms" in head or b"sinf" in head:
            return True
    return False


def _content_fingerprint(file_path: Path, size_bytes: int) -> str:
    h = hashlib.sha256()
    h.update(str(size_bytes).encode("ascii"))
    with file_path.open("rb") as f:
        h.update(f.read(65536))
        if size_bytes > 65536:
            f.seek(max(0, size_bytes - 65536))
            h.update(f.read(65536))
    return h.hexdigest()[:24]


def _ffprobe_metadata(file_path: Path) -> tuple[str, str, str | None, int] | None:
    if shutil.which("ffprobe") is None:
        return None
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(file_path)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if proc.returncode != 0:
            return None
        fmt = json.loads(proc.stdout).get("format", {})
        tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
        title = tags.get("title") or file_path.stem
        artist = tags.get("artist") or ""
        album = tags.get("album")
        duration_ms = int(float(fmt.get("duration") or 0) * 1000)
        return title, artist, album, duration_ms
    except Exception:
        return None


def _read_metadata(file_path: Path) -> tuple[str, str, str | None, int]:
    probed = _ffprobe_metadata(file_path)
    if probed is not None and probed[3] > 0:
        return probed

    title = probed[0] if probed else file_path.stem
    artist = probed[1] if probed else ""
    album = probed[2] if probed else None
    duration_ms = probed[3] if probed else 0
    try:
        audio = MutagenFile(file_path, easy=True)
        if audio is not None:
            if duration_ms == 0 and getattr(audio, "info", None) and getattr(audio.info, "length", 0):
                duration_ms = int(audio.info.length * 1000)
            if audio.tags:
                title = (audio.tags.get("title") or [title])[0]
                artist = (audio.tags.get("artist") or [artist])[0]
                album_list = audio.tags.get("album")
                album = album_list[0] if album_list else album
    except Exception:
        pass
    return title, artist, album, duration_ms


def _song_row_to_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "title": r["title"],
        "artist": r["artist"],
        "album": r["album"],
        "duration_ms": r["duration_ms"],
        "format": r["format"],
        "readiness": r["readiness"],
        "has_lyrics": bool(r["has_lyrics"]),
        "has_instrumental": bool(r["has_instrumental"]),
        "duplicate_of": r["duplicate_of"],
    }


def _encode_cursor(title: str, song_id: str) -> str:
    raw = json.dumps([title, song_id]).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[str, str]:
    try:
        title, song_id = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8"))
        return str(title), str(song_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid cursor") from exc


class SelectLibraryRequest(BaseModel):
    path: str


class UpdateLyricsRequest(BaseModel):
    lrc_text: str
    offset_ms: int = 0
    source: str = "manual"


class PrepareSongRequest(BaseModel):
    reprocess: bool = False


def _stream_file_range(file_path: Path, mime: str, request: Request) -> StreamingResponse:
    file_size = file_path.stat().st_size
    range_header = request.headers.get("range")
    start = 0
    end = file_size - 1
    status_code = 200

    if range_header and range_header.startswith("bytes="):
        spec = range_header.removeprefix("bytes=").split(",")[0].strip()
        parts = spec.split("-")
        if parts[0]:
            start = int(parts[0])
        if len(parts) > 1 and parts[1]:
            end = min(int(parts[1]), file_size - 1)
        if start > end or start >= file_size:
            raise HTTPException(status_code=416, detail="Requested range not satisfiable")
        status_code = 206

    length = end - start + 1

    def iter_file() -> Iterator[bytes]:
        with file_path.open("rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
    }
    if status_code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"

    return StreamingResponse(iter_file(), status_code=status_code, media_type=mime, headers=headers)


def create_app(
    db_conn: sqlite3.Connection | None = None,
    cache_dir: Path | None = None,
    separator_fn: SeparatorFn | None = None,
    data_dir: Path | None = None,
    auth_token: str | None = None,
) -> FastAPI:
    cfg = get_config()
    conn = db_conn or connect_db(cfg["db_path"])
    active_cache_dir = (cache_dir or cfg["cache_dir"]).resolve()
    active_data_dir = (data_dir or cfg["data_dir"]).resolve()
    active_token = cfg["auth_token"] if auth_token is None else auth_token
    stems_root = active_cache_dir / "stems"
    tmp_root = active_cache_dir / "tmp"
    backups_root = active_data_dir / "backups"
    stems_root.mkdir(parents=True, exist_ok=True)
    tmp_root.mkdir(parents=True, exist_ok=True)
    backups_root.mkdir(parents=True, exist_ok=True)

    run_separator: SeparatorFn = separator_fn or run_demucs_separation
    compute_device = detect_compute_device()
    db_lock = threading.Lock()
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="geet-sep")

    app = FastAPI(title="GeeT Host Agent", version="0.4.0")
    origins = list({cfg["app_origin"], "http://localhost:5173", "http://127.0.0.1:5173"})
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST", "PUT", "OPTIONS"],
        allow_headers=["Content-Type", "Range", "X-Host-Token"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
    )

    def _require_host_token(x_host_token: str | None = Header(default=None)) -> None:
        if active_token and not hmac.compare_digest(x_host_token or "", active_token):
            raise HTTPException(status_code=401, detail="Invalid or missing host token")

    def _approved_paths() -> list[Path]:
        rows = conn.execute("SELECT path FROM approved_dirs").fetchall()
        return [Path(r["path"]).resolve() for r in rows]

    @app.get("/health")
    def health():
        with db_lock:
            dir_count = conn.execute("SELECT COUNT(*) FROM approved_dirs").fetchone()[0]
            song_count = conn.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
        return {
            "status": "ok",
            "sqlite": True,
            "ffmpeg": shutil.which("ffmpeg") is not None,
            "ffprobe": shutil.which("ffprobe") is not None,
            "demucs": has_demucs(),
            "compute_device": compute_device,
            "auth_required": bool(active_token),
            "approved_dirs": dir_count,
            "song_count": song_count,
        }

    @app.post("/library/select", dependencies=[Depends(_require_host_token)])
    def select_library(req: SelectLibraryRequest):
        target = Path(req.path).expanduser().resolve()
        if not target.exists() or not target.is_dir():
            raise HTTPException(status_code=400, detail="Directory does not exist")
        conn.execute("INSERT OR IGNORE INTO approved_dirs (path) VALUES (?)", (str(target),))
        conn.commit()
        return {"ok": True, "approved_dirs": len(_approved_paths())}

    @app.post("/library/scan", dependencies=[Depends(_require_host_token)])
    def scan_library():
        job_id = uuid.uuid4().hex[:12]
        conn.execute("INSERT INTO jobs (id, kind, status, progress) VALUES (?, 'scan', 'running', 0)", (job_id,))
        conn.commit()

        dirs = _approved_paths()
        existing = {
            r["id"]: (r["size_bytes"], r["mtime_ns"], r["file_path"])
            for r in conn.execute("SELECT id, size_bytes, mtime_ns, file_path FROM songs").fetchall()
        }

        scanned = 0
        skipped_unchanged = 0
        rejected_drm = 0
        duplicates = 0
        seen_ids: set[str] = set()
        cancelled = False

        for d in dirs:
            if not d.exists():
                continue
            for p in d.rglob("*"):
                if conn.execute("SELECT cancel_requested FROM jobs WHERE id = ?", (job_id,)).fetchone()[0]:
                    cancelled = True
                    break
                if not p.is_file():
                    continue
                ext = p.suffix.lower()
                if ext in DRM_EXTS or (ext in SUPPORTED_EXTS and _has_drm(p)):
                    rejected_drm += 1
                    continue
                if ext not in SUPPORTED_EXTS:
                    continue

                canonical = p.resolve()
                sid = _song_id(canonical)
                seen_ids.add(sid)
                stat = canonical.stat()
                prev = existing.get(sid)
                if prev and prev[0] == stat.st_size and prev[1] == stat.st_mtime_ns:
                    skipped_unchanged += 1
                    continue

                title, artist, album, duration_ms = _read_metadata(canonical)
                chash = _content_fingerprint(canonical, stat.st_size)
                dup_row = conn.execute(
                    "SELECT id FROM songs WHERE content_hash = ? AND id <> ? ORDER BY updated_at ASC LIMIT 1",
                    (chash, sid),
                ).fetchone()
                dup_of = dup_row["id"] if dup_row else None
                if dup_of:
                    duplicates += 1

                conn.execute(
                    """
                    INSERT INTO songs (
                        id, file_path, title, artist, album, duration_ms, format,
                        size_bytes, mtime_ns, content_hash, duplicate_of
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title = excluded.title,
                        artist = excluded.artist,
                        album = excluded.album,
                        duration_ms = excluded.duration_ms,
                        size_bytes = excluded.size_bytes,
                        mtime_ns = excluded.mtime_ns,
                        content_hash = excluded.content_hash,
                        duplicate_of = excluded.duplicate_of,
                        updated_at = datetime('now')
                    """,
                    (
                        sid,
                        str(canonical),
                        title,
                        artist,
                        album,
                        duration_ms,
                        ext.lstrip("."),
                        stat.st_size,
                        stat.st_mtime_ns,
                        chash,
                        dup_of,
                    ),
                )
                scanned += 1
            if cancelled:
                break

        removed = 0
        if not cancelled:
            for sid in set(existing.keys()) - seen_ids:
                conn.execute("DELETE FROM songs WHERE id = ?", (sid,))
                removed += 1

        final_status = "cancelled" if cancelled else "completed"
        detail = f"scanned={scanned} unchanged={skipped_unchanged} removed={removed} drm={rejected_drm} dup={duplicates}"
        conn.execute(
            "UPDATE jobs SET status = ?, progress = 100, detail = ?, updated_at = datetime('now') WHERE id = ?",
            (final_status, detail, job_id),
        )
        conn.commit()
        return {
            "job_id": job_id,
            "status": final_status,
            "scanned": scanned,
            "skipped_unchanged": skipped_unchanged,
            "removed": removed,
            "rejected_drm": rejected_drm,
            "duplicates": duplicates,
        }

    @app.get("/library/songs")
    def list_songs(
        query: str = "",
        cursor: str | None = None,
        limit: int = Query(default=50, ge=1, le=200),
    ):
        like = f"%{query.strip()}%"
        params: list = [like, like]
        cursor_clause = ""
        if cursor:
            c_title, c_id = _decode_cursor(cursor)
            cursor_clause = "AND (title > ? OR (title = ? AND id > ?))"
            params.extend([c_title, c_title, c_id])

        params.append(limit + 1)
        rows = conn.execute(
            f"""
            SELECT id, title, artist, album, duration_ms, format, readiness, has_lyrics, has_instrumental, duplicate_of
            FROM songs
            WHERE (title LIKE ? OR artist LIKE ?)
            {cursor_clause}
            ORDER BY title ASC, id ASC
            LIMIT ?
            """,
            params,
        ).fetchall()

        has_more = len(rows) > limit
        page_rows = rows[:limit]
        next_cursor = _encode_cursor(page_rows[-1]["title"], page_rows[-1]["id"]) if has_more else None
        return {"songs": [_song_row_to_dict(r) for r in page_rows], "next_cursor": next_cursor}

    @app.get("/library/songs/{song_id}")
    def get_song(song_id: str):
        row = conn.execute(
            """
            SELECT id, title, artist, album, duration_ms, format, readiness, has_lyrics, has_instrumental, duplicate_of
            FROM songs WHERE id = ?
            """,
            (song_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Song not found")
        return _song_row_to_dict(row)

    @app.get("/jobs/{job_id}")
    def get_job(job_id: str):
        with db_lock:
            row = conn.execute(
                "SELECT id, kind, song_id, status, progress, detail FROM jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Job not found")
        return dict(row)

    @app.post("/jobs/{job_id}/cancel", dependencies=[Depends(_require_host_token)])
    def cancel_job(job_id: str):
        with db_lock:
            row = conn.execute("SELECT id, kind, status FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Job not found")
            if row["status"] in ("completed", "failed", "cancelled"):
                return {"id": job_id, "status": row["status"]}
            if row["kind"] == "separate" and row["status"] == "running":
                conn.execute(
                    "UPDATE jobs SET cancel_requested = 1, updated_at = datetime('now') WHERE id = ?",
                    (job_id,),
                )
                conn.commit()
                return {"id": job_id, "status": "cancelling"}
            conn.execute(
                "UPDATE jobs SET cancel_requested = 1, status = 'cancelled', updated_at = datetime('now') WHERE id = ?",
                (job_id,),
            )
            conn.commit()
        return {"id": job_id, "status": "cancelled"}

    def _run_separation_worker(job_id: str, song_id: str, source_path: Path, expected_ms: int) -> None:
        job_tmp = tmp_root / job_id

        def is_cancelled() -> bool:
            with db_lock:
                r = conn.execute("SELECT cancel_requested FROM jobs WHERE id = ?", (job_id,)).fetchone()
                return bool(r and r["cancel_requested"])

        final_job_status: str | None = None
        final_detail: str | None = None

        try:
            if is_cancelled():
                final_job_status = "cancelled"
                return

            job_tmp.mkdir(parents=True, exist_ok=True)
            with db_lock:
                conn.execute(
                    "UPDATE jobs SET status = 'running', progress = 15, detail = ?, updated_at = datetime('now') WHERE id = ?",
                    (f"device={compute_device}", job_id),
                )
                conn.commit()

            inst_tmp, voc_tmp = run_separator(source_path, job_tmp, compute_device, is_cancelled)
            if is_cancelled():
                raise RuntimeError("Cancelled")

            verify_stem_integrity(inst_tmp, expected_ms)
            verify_stem_integrity(voc_tmp, expected_ms)

            # Atomic cache promotion inside stems_root/<song_id>
            song_stem_dir = stems_root / song_id
            song_stem_dir.mkdir(parents=True, exist_ok=True)
            inst_dest = song_stem_dir / "instrumental.wav"
            voc_dest = song_stem_dir / "vocal.wav"
            inst_stage = song_stem_dir / f".instrumental.{job_id}.tmp"
            voc_stage = song_stem_dir / f".vocal.{job_id}.tmp"
            shutil.copy2(inst_tmp, inst_stage)
            shutil.copy2(voc_tmp, voc_stage)
            os.replace(inst_stage, inst_dest)
            os.replace(voc_stage, voc_dest)

            with db_lock:
                conn.execute(
                    """
                    UPDATE songs
                    SET readiness = 'ready',
                        has_instrumental = 1,
                        instrumental_path = ?,
                        vocal_path = ?,
                        updated_at = datetime('now')
                    WHERE id = ?
                    """,
                    (str(inst_dest), str(voc_dest), song_id),
                )
                conn.commit()
            final_job_status = "completed"
            final_detail = f"cached ({compute_device})"
        except Exception as exc:
            err_msg = str(exc)
            was_cancelled = is_cancelled() or err_msg == "Cancelled"
            final_job_status = "cancelled" if was_cancelled else "failed"
            final_detail = None if was_cancelled else err_msg[:300]
        finally:
            shutil.rmtree(job_tmp, ignore_errors=True)
            if final_job_status is not None:
                with db_lock:
                    if final_job_status == "completed":
                        conn.execute(
                            "UPDATE jobs SET status = 'completed', progress = 100, detail = ?, updated_at = datetime('now') WHERE id = ?",
                            (final_detail, job_id),
                        )
                    elif final_job_status == "failed":
                        conn.execute(
                            "UPDATE jobs SET status = 'failed', progress = 100, detail = ?, updated_at = datetime('now') WHERE id = ?",
                            (final_detail, job_id),
                        )
                        conn.execute(
                            "UPDATE songs SET readiness = CASE WHEN has_instrumental = 1 THEN 'ready' ELSE 'failed' END WHERE id = ?",
                            (song_id,),
                        )
                    else:
                        conn.execute(
                            "UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?",
                            (job_id,),
                        )
                        conn.execute(
                            "UPDATE songs SET readiness = CASE WHEN has_instrumental = 1 THEN 'ready' ELSE 'raw' END WHERE id = ?",
                            (song_id,),
                        )
                    conn.commit()

    @app.post("/songs/{song_id}/prepare", dependencies=[Depends(_require_host_token)])
    def prepare_song(song_id: str, req: PrepareSongRequest | None = None):
        reprocess = req.reprocess if req else False
        with db_lock:
            song = conn.execute(
                "SELECT id, file_path, duration_ms, has_instrumental, instrumental_path FROM songs WHERE id = ?",
                (song_id,),
            ).fetchone()
            if not song:
                raise HTTPException(status_code=404, detail="Song not found")

            source_path = Path(song["file_path"]).resolve()
            if not _is_within_approved(source_path, _approved_paths()) or not source_path.is_file():
                raise HTTPException(status_code=403, detail="Source audio file inaccessible")

            if (
                not reprocess
                and song["has_instrumental"]
                and song["instrumental_path"]
                and Path(song["instrumental_path"]).is_file()
            ):
                return {"job_id": None, "song_id": song_id, "status": "ready", "device": compute_device}

            active_job = conn.execute(
                "SELECT id, status FROM jobs WHERE song_id = ? AND kind = 'separate' AND status IN ('queued', 'running') LIMIT 1",
                (song_id,),
            ).fetchone()
            if active_job:
                return {
                    "job_id": active_job["id"],
                    "song_id": song_id,
                    "status": active_job["status"],
                    "device": compute_device,
                }

            free_bytes = shutil.disk_usage(active_cache_dir).free
            if free_bytes < MIN_FREE_CACHE_BYTES:
                raise HTTPException(status_code=507, detail="Insufficient disk space for stem cache")

            job_id = uuid.uuid4().hex[:12]
            conn.execute(
                "INSERT INTO jobs (id, kind, song_id, status, progress, detail) VALUES (?, 'separate', ?, 'queued', 0, ?)",
                (job_id, song_id, f"queued ({compute_device})"),
            )
            conn.execute("UPDATE songs SET readiness = 'preparing' WHERE id = ?", (song_id,))
            conn.commit()

        executor.submit(_run_separation_worker, job_id, song_id, source_path, song["duration_ms"])
        return {"job_id": job_id, "song_id": song_id, "status": "queued", "device": compute_device}

    @app.post("/songs/{song_id}/cache/clear", dependencies=[Depends(_require_host_token)])
    def clear_song_cache(song_id: str):
        with db_lock:
            song = conn.execute("SELECT id FROM songs WHERE id = ?", (song_id,)).fetchone()
            if not song:
                raise HTTPException(status_code=404, detail="Song not found")

            stem_dir = (stems_root / song_id).resolve()
            if stems_root in stem_dir.parents and stem_dir.exists():
                shutil.rmtree(stem_dir, ignore_errors=True)

            conn.execute(
                """
                UPDATE songs
                SET has_instrumental = 0,
                    instrumental_path = NULL,
                    vocal_path = NULL,
                    readiness = 'raw',
                    updated_at = datetime('now')
                WHERE id = ?
                """,
                (song_id,),
            )
            conn.commit()
        return {"ok": True, "song_id": song_id}

    @app.get("/songs/{song_id}/lyrics")
    def get_lyrics(song_id: str):
        song = conn.execute("SELECT id, file_path FROM songs WHERE id = ?", (song_id,)).fetchone()
        if not song:
            raise HTTPException(status_code=404, detail="Song not found")

        row = conn.execute(
            "SELECT song_id, lrc_text, offset_ms, source, synchronized_ready FROM lyrics WHERE song_id = ?",
            (song_id,),
        ).fetchone()
        if row:
            return {
                "song_id": row["song_id"],
                "lrc_text": row["lrc_text"],
                "offset_ms": row["offset_ms"],
                "source": row["source"],
                "synchronized_ready": bool(row["synchronized_ready"]),
            }

        sidecar = Path(song["file_path"]).resolve().with_suffix(".lrc")
        if sidecar.is_file() and _is_within_approved(sidecar, _approved_paths()):
            text = sidecar.read_text(encoding="utf-8", errors="replace")
            sync_ready = _has_timed_lrc(text)
            conn.execute(
                """
                INSERT INTO lyrics (song_id, lrc_text, offset_ms, source, synchronized_ready)
                VALUES (?, ?, 0, 'sidecar', ?)
                """,
                (song_id, text, int(sync_ready)),
            )
            conn.execute("UPDATE songs SET has_lyrics = ? WHERE id = ?", (int(sync_ready), song_id))
            conn.commit()
            return {
                "song_id": song_id,
                "lrc_text": text,
                "offset_ms": 0,
                "source": "sidecar",
                "synchronized_ready": sync_ready,
            }

        return {
            "song_id": song_id,
            "lrc_text": "",
            "offset_ms": 0,
            "source": "none",
            "synchronized_ready": False,
        }

    @app.put("/songs/{song_id}/lyrics", dependencies=[Depends(_require_host_token)])
    def put_lyrics(song_id: str, req: UpdateLyricsRequest):
        if not conn.execute("SELECT 1 FROM songs WHERE id = ?", (song_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Song not found")
        source = req.source if req.source in ("sidecar", "manual", "lrclib") else "manual"
        sync_ready = _has_timed_lrc(req.lrc_text)
        conn.execute(
            """
            INSERT INTO lyrics (song_id, lrc_text, offset_ms, source, synchronized_ready, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(song_id) DO UPDATE SET
                lrc_text = excluded.lrc_text,
                offset_ms = excluded.offset_ms,
                source = excluded.source,
                synchronized_ready = excluded.synchronized_ready,
                updated_at = datetime('now')
            """,
            (song_id, req.lrc_text, req.offset_ms, source, int(sync_ready)),
        )
        conn.execute("UPDATE songs SET has_lyrics = ? WHERE id = ?", (int(sync_ready), song_id))
        conn.commit()
        return {
            "song_id": song_id,
            "lrc_text": req.lrc_text,
            "offset_ms": req.offset_ms,
            "source": source,
            "synchronized_ready": sync_ready,
        }

    @app.post("/songs/{song_id}/lyrics/lookup", dependencies=[Depends(_require_host_token)])
    def lookup_lrclib(song_id: str):
        song = conn.execute(
            "SELECT title, artist, album, duration_ms FROM songs WHERE id = ?", (song_id,)
        ).fetchone()
        if not song:
            raise HTTPException(status_code=404, detail="Song not found")
        if not song["title"] or not song["artist"]:
            return {"found": False, "reason": "Missing title or artist metadata"}

        params: dict[str, str | int] = {
            "track_name": song["title"],
            "artist_name": song["artist"],
        }
        if song["album"]:
            params["album_name"] = song["album"]
        if song["duration_ms"] > 0:
            params["duration"] = round(song["duration_ms"] / 1000)

        try:
            resp = httpx.get("https://lrclib.net/api/get", params=params, timeout=8.0)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"LRCLIB lookup failed: {exc}") from exc

        if resp.status_code == 404:
            return {"found": False, "reason": "No match on LRCLIB"}
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"LRCLIB returned {resp.status_code}")

        data = resp.json()
        synced = data.get("syncedLyrics") or ""
        remote_dur = data.get("duration") or 0
        if song["duration_ms"] > 0 and remote_dur > 0:
            if abs(remote_dur - (song["duration_ms"] / 1000)) > 5:
                return {"found": False, "reason": "Duration mismatch (>5s)"}

        return {
            "found": bool(synced),
            "synced_lyrics": synced,
            "plain_lyrics": data.get("plainLyrics") or "",
            "duration_s": remote_dur,
            "reason": None if synced else "Only unsynced lyrics found",
        }

    @app.post("/backup", dependencies=[Depends(_require_host_token)])
    def backup_metadata():
        """Create an atomic SQLite metadata and lyrics backup (never includes audio files)."""
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        dest_path = (backups_root / f"host_agent-{stamp}.sqlite3").resolve()
        if backups_root not in dest_path.parents:
            raise HTTPException(status_code=400, detail="Invalid backup destination")
        with db_lock:
            dest_conn = sqlite3.connect(dest_path)
            try:
                conn.backup(dest_conn)
            finally:
                dest_conn.close()
        return {"ok": True, "filename": dest_path.name, "size_bytes": dest_path.stat().st_size}

    @app.get("/media/{song_id}")
    def stream_media(
        song_id: str,
        request: Request,
        mode: str = Query(default="original", pattern="^(original|instrumental|vocal)$"),
    ):
        if not re.fullmatch(r"[a-f0-9]{16}", song_id):
            raise HTTPException(status_code=400, detail="Invalid song ID")
        with db_lock:
            row = conn.execute(
                "SELECT file_path, instrumental_path, vocal_path FROM songs WHERE id = ?",
                (song_id,),
            ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Song not found")

        if mode == "original":
            file_path = Path(row["file_path"]).resolve()
            if not _is_within_approved(file_path, _approved_paths()) or not file_path.is_file():
                raise HTTPException(status_code=403, detail="Access denied")
            mime = SUPPORTED_EXTS.get(file_path.suffix.lower())
            if not mime:
                raise HTTPException(status_code=415, detail="Unsupported media type")
            return _stream_file_range(file_path, mime, request)

        raw_stem = row["instrumental_path"] if mode == "instrumental" else row["vocal_path"]
        if not raw_stem:
            raise HTTPException(status_code=404, detail=f"{mode} stem not prepared")
        stem_path = Path(raw_stem).resolve()
        if not _is_within_approved(stem_path, [stems_root]) or not stem_path.is_file():
            raise HTTPException(status_code=404, detail=f"{mode} stem missing")
        return _stream_file_range(stem_path, "audio/wav", request)

    return app


app = create_app()
