import sqlite3

from fastapi.testclient import TestClient

from host_agent.db import SCHEMA_SQL
from host_agent.main import create_app


def _client(auth_token: str | None = None) -> TestClient:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA_SQL)
    return TestClient(create_app(db_conn=conn, auth_token=auth_token))


def test_lan_room_lifecycle_queue_and_auth():
    client = _client(auth_token="secret-host-token")

    info = client.get("/lan/info")
    assert info.status_code == 200
    assert "lan_ip" in info.json()

    # Creating a room respects host token when configured
    assert client.post("/lan/rooms").status_code == 401
    created = client.post("/lan/rooms", headers={"X-Host-Token": "secret-host-token"})
    assert created.status_code == 200
    room_data = created.json()
    room_id = room_data["room_id"]
    code = room_data["code"]
    cap = room_data["host_capability"]

    # Lookup by code
    lookup = client.get(f"/lan/rooms/by-code/{code.lower()}")
    assert lookup.status_code == 200
    assert lookup.json()["room_id"] == room_id

    # Publish songs requires valid capability
    songs_payload = [
        {"host_song_id": "aaaa1111bbbb2222", "title": "Bohemian Rhapsody", "artist": "Queen", "duration_ms": 354000, "readiness": "ready"},
        {"host_song_id": "cccc3333dddd4444", "title": "Mr. Brightside", "artist": "The Killers", "duration_ms": 222000, "readiness": "raw"},
    ]
    assert (
        client.post(
            f"/lan/rooms/{room_id}/songs",
            json={"songs": songs_payload, "capability": "wrong-cap"},
        ).status_code
        == 403
    )
    pub = client.post(
        f"/lan/rooms/{room_id}/songs",
        json={"songs": songs_payload, "capability": cap},
    )
    assert pub.status_code == 200
    assert pub.json()["count"] == 2

    snap = client.get(f"/lan/rooms/{room_id}/snapshot").json()
    assert len(snap["songs"]) == 2
    song_a_id = snap["songs"][0]["id"]
    song_b_id = snap["songs"][1]["id"]

    # Two guests join
    g1 = client.post(f"/lan/rooms/{room_id}/join", json={"display_name": "Alice"}).json()
    g2 = client.post(f"/lan/rooms/{room_id}/join", json={"display_name": "Bob"}).json()

    # Idempotent queue add
    q1 = client.post(
        f"/lan/rooms/{room_id}/queue",
        json={"song_id": song_a_id, "user_id": g1["user_id"], "idempotency_key": "idem-1"},
    ).json()
    q1_dup = client.post(
        f"/lan/rooms/{room_id}/queue",
        json={"song_id": song_a_id, "user_id": g1["user_id"], "idempotency_key": "idem-1"},
    ).json()
    assert q1["entry_id"] == q1_dup["entry_id"]

    q2 = client.post(
        f"/lan/rooms/{room_id}/queue",
        json={"song_id": song_b_id, "user_id": g2["user_id"], "idempotency_key": "idem-2"},
    ).json()

    # Guest cannot delete another guest's entry, but can delete own or host can
    assert (
        client.delete(
            f"/lan/rooms/{room_id}/queue/{q1['entry_id']}",
            params={"user_id": g2["user_id"]},
        ).status_code
        == 403
    )

    # Reorder queue (put q2 ahead of q1)
    reorder = client.post(
        f"/lan/rooms/{room_id}/queue/reorder",
        json={"ordered_entry_ids": [q2["entry_id"], q1["entry_id"]], "capability": cap},
    )
    assert reorder.status_code == 200

    # Advance queue -> q2 becomes playing
    adv = client.post(
        f"/lan/rooms/{room_id}/queue/advance",
        json={"action": "next", "capability": cap},
    )
    assert adv.status_code == 200
    snap_after = client.get(f"/lan/rooms/{room_id}/snapshot").json()
    assert snap_after["playback"]["song_id"] == song_b_id
    assert snap_after["queue"][0]["id"] == q2["entry_id"]
    assert snap_after["queue"][0]["status"] == "playing"

    # Close room blocks further joins
    closed = client.post(
        f"/lan/rooms/{room_id}/status",
        json={"status": "closed", "capability": cap},
    )
    assert closed.status_code == 200
    assert client.get(f"/lan/rooms/by-code/{code}").json()["room_id"] is None


def test_lan_room_websocket_presence_snapshot_and_reactions():
    client = _client()
    created = client.post("/lan/rooms").json()
    room_id = created["room_id"]
    cap = created["host_capability"]
    host_uid = created["host_user_id"]

    guest = client.post(f"/lan/rooms/{room_id}/join", json={"display_name": "Sam"}).json()

    with client.websocket_connect(
        f"/lan/rooms/{room_id}/ws?user_id={host_uid}&display_name=Host"
    ) as host_ws:
        first = host_ws.receive_json()
        assert first["type"] == "snapshot"
        pres1 = host_ws.receive_json()
        assert pres1["type"] == "presence"
        assert host_uid in pres1["payload"]["online_user_ids"]

        with client.websocket_connect(
            f"/lan/rooms/{room_id}/ws?user_id={guest['user_id']}&display_name=Sam"
        ) as guest_ws:
            assert guest_ws.receive_json()["type"] == "snapshot"
            pres_guest = guest_ws.receive_json()
            assert len(pres_guest["payload"]["online_user_ids"]) == 2
            pres_host = host_ws.receive_json()
            assert len(pres_host["payload"]["online_user_ids"]) == 2

            # Guest sends reaction via WS -> host receives it
            guest_ws.send_json({"type": "reaction", "sender": "Sam", "label": "Encore"})
            react_host = host_ws.receive_json()
            assert react_host == {
                "type": "reaction",
                "payload": {"sender": "Sam", "label": "Encore"},
            }

            # Publish a song -> host WS receives snapshot push
            client.post(
                f"/lan/rooms/{room_id}/songs",
                json={
                    "songs": [
                        {
                            "host_song_id": "1111222233334444",
                            "title": "Test Anthem",
                            "artist": "Band",
                            "duration_ms": 180000,
                            "readiness": "raw",
                        }
                    ],
                    "capability": cap,
                },
            )
            pushed = host_ws.receive_json()
            assert pushed["type"] == "snapshot"
            assert len(pushed["payload"]["songs"]) == 1


def test_alac_transcode_to_browser_aac_and_cache(tmp_path):
    import subprocess
    from mutagen.mp4 import MP4
    from host_agent.lan_rooms import _score_lan_ip
    from host_agent.separator import find_ffmpeg

    # Wi-Fi 192.168.1.46 must beat VPN/virtual adapters
    assert _score_lan_ip("192.168.1.46") > _score_lan_ip("172.16.0.2")
    assert _score_lan_ip("192.168.1.46") > _score_lan_ip("192.168.248.1")
    assert _score_lan_ip("192.168.1.46") > _score_lan_ip("169.254.83.107")

    ffmpeg_exe = find_ffmpeg()
    assert ffmpeg_exe is not None

    music_dir = tmp_path / "music"
    music_dir.mkdir()
    alac_file = music_dir / "tone.m4a"
    subprocess.run(
        [
            ffmpeg_exe,
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.4",
            "-c:a",
            "alac",
            str(alac_file),
        ],
        check=True,
    )
    tags = MP4(alac_file)
    tags["\xa9nam"] = ["505"]
    tags["\xa9ART"] = ["Arctic Monkeys"]
    tags["\xa9lyr"] = ["I'm going back to 505"]
    tags.save()

    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA_SQL)
    cache_dir = tmp_path / "cache"
    client = TestClient(create_app(db_conn=conn, cache_dir=cache_dir))

    assert client.post("/library/select", json={"path": str(music_dir)}).status_code == 200
    assert client.post("/library/scan").json()["scanned"] == 1

    song = client.get("/library/songs").json()["songs"][0]
    assert song["title"] == "505"
    assert song["codec"] == "alac"

    # Embedded lyrics fallback works without sidecar .lrc
    lyr = client.get(f"/songs/{song['id']}/lyrics").json()
    assert "505" in lyr["lrc_text"]

    # Streaming ALAC transparently transcodes to browser-playable AAC + caches on disk
    resp = client.get(f"/media/{song['id']}", headers={"Range": "bytes=0-127"})
    assert resp.status_code == 206
    assert resp.headers["content-type"] == "audio/mp4"
    cached = cache_dir / "playback" / f"{song['id']}.m4a"
    assert cached.is_file()
    assert MP4(cached).info.codec.startswith("mp4a")


def test_lan_room_lyrics_endpoint_and_ws_sync(tmp_path):
    music_dir = tmp_path / "lyrics_music"
    music_dir.mkdir()
    wav_path = music_dir / "hindi_hit.wav"
    wav_path.write_bytes(b"RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x40\x1f\x00\x00\x80>\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00")
    (music_dir / "hindi_hit.lrc").write_text("[00:01.00]दिल मेरा बोल उठा\n", encoding="utf-8")

    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA_SQL)
    client = TestClient(create_app(db_conn=conn, cache_dir=tmp_path / "cache"))

    assert client.post("/library/select", json={"path": str(music_dir)}).status_code == 200
    assert client.post("/library/scan").json()["scanned"] == 1
    song = client.get("/library/songs").json()["songs"][0]

    room = client.post("/lan/rooms").json()
    room_id = room["room_id"]
    cap = room["host_capability"]
    host_uid = room["host_user_id"]

    # Unpublished song returns 404 for room lyrics
    assert client.get(f"/lan/rooms/{room_id}/lyrics/{song['id']}").status_code == 404

    client.post(
        f"/lan/rooms/{room_id}/songs",
        json={
            "capability": cap,
            "songs": [
                {
                    "host_song_id": song["id"],
                    "title": song["title"],
                    "artist": "Artist",
                    "duration_ms": 120000,
                    "readiness": "raw",
                }
            ],
        },
    )

    # Guest can fetch published song lyrics through the LAN room endpoint
    lyr = client.get(f"/lan/rooms/{room_id}/lyrics/{song['id']}")
    assert lyr.status_code == 200
    assert "दिल मेरा बोल उठा" in lyr.json()["lrc_text"]

    # Playback checkpoint with explicit host_song_id updates active room playback even outside queue
    pb = client.post(
        f"/lan/rooms/{room_id}/playback",
        json={"status": "playing", "position_ms": 4200, "capability": cap, "host_song_id": song["id"]},
    )
    assert pb.status_code == 200
    snap = client.get(f"/lan/rooms/{room_id}/snapshot").json()
    assert snap["playback"]["song_id"] is not None
    assert snap["playback"]["position_ms"] == 4200

    # Host lyrics_sync WS frame broadcasts to connected guests
    guest = client.post(f"/lan/rooms/{room_id}/join", json={"display_name": "Riya"}).json()
    with client.websocket_connect(f"/lan/rooms/{room_id}/ws?user_id={host_uid}&display_name=Host") as ws_host:
        ws_host.receive_json()  # snapshot
        ws_host.receive_json()  # presence
        with client.websocket_connect(
            f"/lan/rooms/{room_id}/ws?user_id={guest['user_id']}&display_name=Riya"
        ) as ws_guest:
            ws_guest.receive_json()  # snapshot
            ws_guest.receive_json()  # presence
            ws_host.receive_json()  # presence update

            ws_host.send_json(
                {
                    "type": "lyrics_sync",
                    "payload": {
                        "hostSongId": song["id"],
                        "lrcText": "[00:01.00]दिल मेरा बोल उठा",
                        "offsetMs": 200,
                        "status": "playing",
                        "positionMs": 4500,
                    },
                }
            )
            pushed = ws_guest.receive_json()
            assert pushed["type"] == "lyrics_sync"
            assert pushed["payload"]["offsetMs"] == 200


def test_lan_room_host_remote_control_capability_check():
    client = _client()
    room = client.post("/lan/rooms").json()
    room_id = room["room_id"]
    cap = room["host_capability"]
    host_uid = room["host_user_id"]
    guest = client.post(f"/lan/rooms/{room_id}/join", json={"display_name": "Remote"}).json()

    with client.websocket_connect(f"/lan/rooms/{room_id}/ws?user_id={host_uid}&display_name=Host") as ws_host:
        ws_host.receive_json()  # snapshot
        ws_host.receive_json()  # presence
        with client.websocket_connect(
            f"/lan/rooms/{room_id}/ws?user_id={guest['user_id']}&display_name=Remote"
        ) as ws_remote:
            ws_remote.receive_json()  # snapshot
            ws_remote.receive_json()  # presence
            ws_host.receive_json()  # presence update

            # Invalid capability is ignored; valid capability forwards command and strips secret
            ws_remote.send_json({"type": "host_control", "action": "toggle_tv", "capability": "wrong"})
            ws_remote.send_json({"type": "host_control", "action": "vocal_mix", "value": 1.5, "capability": cap})

            msg = ws_host.receive_json()
            assert msg["type"] == "host_control"
            assert msg["payload"] == {"action": "vocal_mix", "value": 1.0}
            assert "capability" not in msg["payload"]
            assert ws_remote.receive_json()["type"] == "host_control"

            # Wireless phone mic PCM bytes forward directly to host WS only
            ws_remote.send_bytes(b"\x01\x02\x03\x04")
            assert ws_host.receive_bytes() == b"\x01\x02\x03\x04"

            # Direct LAN WebRTC signaling relays guest <-> host with sender identity
            ws_remote.send_json({"type": "mic_rtc", "payload": {"kind": "offer", "sdp": "v=0"}})
            offer = ws_host.receive_json()
            assert offer["type"] == "mic_rtc"
            assert offer["payload"]["kind"] == "offer"
            assert offer["payload"]["from_uid"] == guest["user_id"]
            assert offer["payload"]["from_name"] == "Remote"

            ws_host.send_json(
                {
                    "type": "mic_rtc",
                    "to_uid": guest["user_id"],
                    "payload": {"kind": "answer", "sdp": "v=0"},
                }
            )
            answer = ws_remote.receive_json()
            assert answer["type"] == "mic_rtc"
            assert answer["payload"]["kind"] == "answer"
            assert answer["payload"]["from_uid"] == host_uid

        # Disconnecting a guest phone notifies host to close that peer's duet slot cleanly
        stop_evt = ws_host.receive_json()
        assert stop_evt["type"] == "mic_rtc"
        assert stop_evt["payload"] == {"kind": "stop", "from_uid": guest["user_id"]}
