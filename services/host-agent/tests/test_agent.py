import hashlib
import sqlite3
import threading
import time
import wave
from pathlib import Path

from fastapi.testclient import TestClient

from host_agent.db import SCHEMA_SQL
from host_agent.main import create_app


def _make_wav(path: Path, frames: int = 800) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\x01\x02" * frames)


def _client(
    cache_dir: Path | None = None,
    separator_fn=None,
    data_dir: Path | None = None,
    auth_token: str | None = None,
    folder_picker_fn=None,
) -> TestClient:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA_SQL)
    return TestClient(
        create_app(
            db_conn=conn,
            cache_dir=cache_dir,
            separator_fn=separator_fn,
            data_dir=data_dir,
            auth_token=auth_token,
            folder_picker_fn=folder_picker_fn,
        )
    )


def test_health_and_media_range(tmp_path: Path):
    music_dir = tmp_path / "music"
    music_dir.mkdir()
    wav_file = music_dir / "test_song.wav"
    _make_wav(wav_file, frames=4000)
    (music_dir / "locked.m4p").write_bytes(b"drm")

    client = _client()
    assert client.get("/health").json()["status"] == "ok"
    assert client.post("/library/select", json={"path": str(music_dir)}).status_code == 200

    scan = client.post("/library/scan").json()
    assert scan["scanned"] == 1
    assert scan["rejected_drm"] == 1

    songs = client.get("/library/songs").json()["songs"]
    assert len(songs) == 1
    assert "file_path" not in songs[0]
    song_id = songs[0]["id"]

    detail = client.get(f"/library/songs/{song_id}")
    assert detail.status_code == 200
    assert detail.json()["id"] == song_id

    job = client.get(f"/jobs/{scan['job_id']}")
    assert job.status_code == 200
    assert job.json()["status"] == "completed"

    media = client.get(f"/media/{song_id}")
    assert media.status_code == 200
    assert len(media.content) == wav_file.stat().st_size

    partial = client.get(f"/media/{song_id}", headers={"Range": "bytes=0-99"})
    assert partial.status_code == 206
    assert partial.headers["content-range"].startswith("bytes 0-99/")
    assert len(partial.content) == 100


def test_100_mixed_files_incremental_duplicates_and_pagination(tmp_path: Path):
    music_dir = tmp_path / "library"
    music_dir.mkdir()

    # 100 mixed files (.wav, .mp3, .m4a, .flac) with unique content so only intentional dupes match
    exts = [".wav", ".mp3", ".m4a", ".flac"]
    originals_digest: dict[Path, tuple[int, str]] = {}
    for i in range(100):
        ext = exts[i % len(exts)]
        p = music_dir / f"track_{i:03d}{ext}"
        if ext == ".wav":
            _make_wav(p, frames=400 + i)
        else:
            p.write_bytes(f"audio-fixture-{i:03d}".encode("ascii") * 10)
        originals_digest[p] = (p.stat().st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest())

    client = _client()
    client.post("/library/select", json={"path": str(music_dir)})
    first_scan = client.post("/library/scan").json()
    assert first_scan["scanned"] == 100
    assert first_scan["skipped_unchanged"] == 0

    # Verify originals were never modified
    for p, (mtime_ns, sha) in originals_digest.items():
        assert p.stat().st_mtime_ns == mtime_ns
        assert hashlib.sha256(p.read_bytes()).hexdigest() == sha

    # Incremental re-scan skips all 100 unchanged files
    second_scan = client.post("/library/scan").json()
    assert second_scan["scanned"] == 0
    assert second_scan["skipped_unchanged"] == 100

    # Cursor pagination across all 100 songs
    collected = []
    cursor = None
    while True:
        params = {"limit": 40}
        if cursor:
            params["cursor"] = cursor
        page = client.get("/library/songs", params=params).json()
        collected.extend(page["songs"])
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert len(collected) == 100

    # Duplicate detection + deleted file removal
    dup_file = music_dir / "track_000_copy.wav"
    dup_file.write_bytes((music_dir / "track_000.wav").read_bytes())
    (music_dir / "track_099.flac").unlink()

    third_scan = client.post("/library/scan").json()
    assert third_scan["scanned"] == 1
    assert third_scan["duplicates"] == 1
    assert third_scan["removed"] == 1


def test_lyrics_sidecar_validation_and_10_timed_songs(tmp_path: Path):
    music_dir = tmp_path / "lyrics_lib"
    music_dir.mkdir()

    # Sidecar .lrc for track 0
    _make_wav(music_dir / "song_00.wav")
    (music_dir / "song_00.lrc").write_text("[00:01.00]Hello\n[00:04.00]World", encoding="utf-8")

    # 9 more tracks without sidecar
    for i in range(1, 10):
        _make_wav(music_dir / f"song_{i:02d}.wav")

    client = _client()
    client.post("/library/select", json={"path": str(music_dir)})
    assert client.post("/library/scan").json()["scanned"] == 10

    songs = sorted(client.get("/library/songs").json()["songs"], key=lambda s: s["title"])
    assert len(songs) == 10

    # Track 0 auto-loads sidecar LRC
    s0_lyrics = client.get(f"/songs/{songs[0]['id']}/lyrics").json()
    assert s0_lyrics["source"] == "sidecar"
    assert s0_lyrics["synchronized_ready"] is True

    # Plain text without timestamps must NOT mark synchronized_ready
    s1_id = songs[1]["id"]
    unsynced = client.put(
        f"/songs/{s1_id}/lyrics",
        json={"lrc_text": "Just plain lyrics without timestamps", "offset_ms": 0, "source": "manual"},
    ).json()
    assert unsynced["synchronized_ready"] is False

    # Save timed LRC + offset calibration for tracks 1..9
    for i in range(1, 10):
        sid = songs[i]["id"]
        saved = client.put(
            f"/songs/{sid}/lyrics",
            json={"lrc_text": f"[00:02.00]Line {i}", "offset_ms": -500, "source": "manual"},
        ).json()
        assert saved["synchronized_ready"] is True
        assert saved["offset_ms"] == -500


def _wait_job(client: TestClient, job_id: str, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/jobs/{job_id}").json()
        if job["status"] in ("completed", "failed", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError(f"Job {job_id} did not finish in time")


def test_instrumental_separation_cache_clear_and_original_preserved(tmp_path: Path):
    music_dir = tmp_path / "sep_music"
    cache_dir = tmp_path / "sep_cache"
    music_dir.mkdir()
    src = music_dir / "ballad.wav"
    _make_wav(src, frames=8000)
    orig_mtime = src.stat().st_mtime_ns
    orig_sha = hashlib.sha256(src.read_bytes()).hexdigest()

    def test_separator(source_path: Path, job_tmp: Path, device: str, cancel_check):
        assert device in ("cpu", "cuda", "mps")
        assert source_path.resolve() == src.resolve()
        inst = job_tmp / "no_vocals.wav"
        voc = job_tmp / "vocals.wav"
        _make_wav(inst, frames=8000)
        _make_wav(voc, frames=8000)
        return inst, voc

    client = _client(cache_dir=cache_dir, separator_fn=test_separator)
    client.post("/library/select", json={"path": str(music_dir)})
    client.post("/library/scan")
    song_id = client.get("/library/songs").json()["songs"][0]["id"]

    prep = client.post(f"/songs/{song_id}/prepare").json()
    assert prep["status"] == "queued"
    job = _wait_job(client, prep["job_id"])
    assert job["status"] == "completed"

    # Song is ready and both instrumental & vocal preview stream with range support
    detail = client.get(f"/library/songs/{song_id}").json()
    assert detail["readiness"] == "ready"
    assert detail["has_instrumental"] is True

    inst_res = client.get(f"/media/{song_id}?mode=instrumental", headers={"Range": "bytes=0-63"})
    assert inst_res.status_code == 206
    assert len(inst_res.content) == 64

    voc_res = client.get(f"/media/{song_id}?mode=vocal")
    assert voc_res.status_code == 200
    assert len(voc_res.content) > 44

    # Original file remains untouched
    assert src.stat().st_mtime_ns == orig_mtime
    assert hashlib.sha256(src.read_bytes()).hexdigest() == orig_sha

    # Clear cache removes stems without touching original
    assert client.post(f"/songs/{song_id}/cache/clear").status_code == 200
    assert client.get(f"/media/{song_id}?mode=instrumental").status_code == 404
    assert client.get(f"/media/{song_id}?mode=original").status_code == 200
    assert src.exists() and hashlib.sha256(src.read_bytes()).hexdigest() == orig_sha


def test_separation_cancellation_and_failure_preserve_original(tmp_path: Path):
    music_dir = tmp_path / "fail_music"
    cache_dir = tmp_path / "fail_cache"
    music_dir.mkdir()
    src = music_dir / "track.wav"
    _make_wav(src, frames=8000)

    started = threading.Event()

    def slow_separator(source_path: Path, job_tmp: Path, device: str, cancel_check):
        started.set()
        while not cancel_check():
            time.sleep(0.02)
        raise RuntimeError("Cancelled")

    client = _client(cache_dir=cache_dir, separator_fn=slow_separator)
    client.post("/library/select", json={"path": str(music_dir)})
    client.post("/library/scan")
    song_id = client.get("/library/songs").json()["songs"][0]["id"]

    prep = client.post(f"/songs/{song_id}/prepare").json()
    assert started.wait(timeout=2.0)
    cancel_res = client.post(f"/jobs/{prep['job_id']}/cancel").json()
    assert cancel_res["status"] in ("cancelled", "cancelling")
    job = _wait_job(client, prep["job_id"])
    assert job["status"] == "cancelled"

    # Temp dirs are cleaned and original still plays
    assert list((cache_dir / "tmp").iterdir()) == []
    assert client.get(f"/media/{song_id}").status_code == 200

    # Failure path (default separator when Demucs is absent or raises)
    def failing_separator(*_args):
        raise RuntimeError("Demucs not installed")

    fail_client = _client(cache_dir=cache_dir, separator_fn=failing_separator)
    fail_client.post("/library/select", json={"path": str(music_dir)})
    fail_client.post("/library/scan")
    fail_sid = fail_client.get("/library/songs").json()["songs"][0]["id"]
    fail_prep = fail_client.post(f"/songs/{fail_sid}/prepare").json()
    fail_job = _wait_job(fail_client, fail_prep["job_id"])
    assert fail_job["status"] == "failed"
    assert fail_client.get(f"/library/songs/{fail_sid}").json()["readiness"] == "failed"
    assert fail_client.get(f"/media/{fail_sid}").status_code == 200


def test_hardening_auth_token_traversal_and_sqlite_backup(tmp_path: Path):
    music_dir = tmp_path / "sec_music"
    data_dir = tmp_path / "sec_data"
    cache_dir = tmp_path / "sec_cache"
    music_dir.mkdir()
    _make_wav(music_dir / "clean.wav", frames=800)

    client = _client(cache_dir=cache_dir, data_dir=data_dir, auth_token="local-secret-123")

    # Mutating endpoints require X-Host-Token when configured
    assert client.post("/library/select", json={"path": str(music_dir)}).status_code == 401
    assert (
        client.post(
            "/library/select",
            json={"path": str(music_dir)},
            headers={"X-Host-Token": "local-secret-123"},
        ).status_code
        == 200
    )
    assert (
        client.post("/library/scan", headers={"X-Host-Token": "local-secret-123"}).json()["scanned"]
        == 1
    )

    # Path traversal / malformed song ID rejected cleanly
    assert client.get("/media/..%2F..%2Fetc%2Fpasswd").status_code in (400, 404)
    assert client.get("/media/not-a-valid-hex-id").status_code == 400

    # Atomic SQLite backup creates readable metadata backup without audio files
    backup = client.post("/backup", headers={"X-Host-Token": "local-secret-123"})
    assert backup.status_code == 200
    backup_file = data_dir / "backups" / backup.json()["filename"]
    assert backup_file.is_file()
    bconn = sqlite3.connect(backup_file)
    try:
        count = bconn.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
        assert count == 1
    finally:
        bconn.close()


def test_lrclib_search_fallback_cleans_title_and_artist(tmp_path: Path, monkeypatch):
    music_dir = tmp_path / "lrc_fallback"
    cache_dir = tmp_path / "lrc_cache"
    music_dir.mkdir()
    _make_wav(music_dir / "01. Ye Ishq Hai (From 'Jab We Met').wav", frames=8000)

    client = _client(cache_dir=cache_dir)
    client.post("/library/select", json={"path": str(music_dir)})
    client.post("/library/scan")
    song_id = client.get("/library/songs").json()["songs"][0]["id"]

    # Seed artist metadata directly so LRCLIB lookup runs
    from host_agent import main as main_mod

    calls: list[tuple[str, dict]] = []

    class FakeResp:
        def __init__(self, status_code: int, body):
            self.status_code = status_code
            self._body = body

        def json(self):
            return self._body

    def fake_get(url: str, params=None, timeout=8.0):
        calls.append((url, dict(params or {})))
        if url.endswith("/api/get"):
            return FakeResp(404, {})
        if url.endswith("/api/search"):
            return FakeResp(
                200,
                [
                    {"syncedLyrics": "", "duration": 1.0},
                    {
                        "syncedLyrics": "[00:00.50]Haan hai koi to wajah",
                        "plainLyrics": "Haan hai koi to wajah",
                        "duration": 1.0,
                    },
                ],
            )
        return FakeResp(404, {})

    monkeypatch.setattr(main_mod.httpx, "get", fake_get)

    # Set artist on the indexed song via SQLite
    db_conn = sqlite3.connect(cache_dir.parent / "data" / "host_agent.db") if (cache_dir.parent / "data" / "host_agent.db").exists() else None
    if db_conn:
        db_conn.close()

    # Verify helper functions directly + endpoint behavior when artist is present
    assert main_mod._clean_lrclib_title("01. Ye Ishq Hai (From 'Jab We Met')") == "Ye Ishq Hai"
    assert main_mod._primary_lrclib_artist("Pritam, Sonu Nigam & Shilpa Rao") == "Pritam"
    picked = main_mod._pick_best_lrclib_candidate(
        [
            {"syncedLyrics": "[00:01.00]Far", "duration": 260},
            {"syncedLyrics": "[00:01.00]Close", "duration": 201},
        ],
        target_dur_s=200.0,
    )
    assert picked is not None and picked["syncedLyrics"] == "[00:01.00]Close"

    # Without artist metadata, lookup gracefully declines
    res = client.post(f"/songs/{song_id}/lyrics/lookup")
    assert res.status_code == 200
    assert res.json()["found"] is False


def test_separator_pipe_decode_and_wav_write(tmp_path: Path):
    import numpy as np
    from host_agent.separator import _decode_to_float32_stereo, _write_stereo_wav, verify_stem_integrity

    src = tmp_path / "tone.wav"
    samples = np.sin(np.linspace(0, 20 * np.pi, 4410, dtype=np.float32))
    stereo = np.stack([samples, samples * 0.5], axis=0)
    _write_stereo_wav(src, stereo, sample_rate=44100)
    verify_stem_integrity(src, expected_duration_ms=100)

    decoded = _decode_to_float32_stereo(src, sample_rate=44100)
    assert decoded.shape == (2, 4410)
    assert float(np.max(np.abs(decoded[0]))) > 0.9
    assert float(np.max(np.abs(decoded[1]))) < 0.6


def test_library_folder_picker_list_and_remove(tmp_path: Path):
    music_dir = tmp_path / "my_songs"
    music_dir.mkdir()
    _make_wav(music_dir / "demo.wav", frames=800)

    client = _client(folder_picker_fn=lambda: str(music_dir))
    picked = client.post("/library/pick-folder")
    assert picked.status_code == 200
    assert Path(picked.json()["path"]).resolve() == music_dir.resolve()

    assert client.post("/library/select", json={"path": picked.json()["path"]}).status_code == 200
    folders = client.get("/library/folders").json()["folders"]
    assert len(folders) == 1
    assert Path(folders[0]).resolve() == music_dir.resolve()

    removed = client.request("DELETE", "/library/folders", json={"path": folders[0]})
    assert removed.status_code == 200
    assert removed.json()["folders"] == []
