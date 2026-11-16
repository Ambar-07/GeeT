import hashlib
import sqlite3
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


def _client() -> TestClient:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA_SQL)
    return TestClient(create_app(db_conn=conn))


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
