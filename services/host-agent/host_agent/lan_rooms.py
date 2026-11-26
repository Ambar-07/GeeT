from __future__ import annotations

import hmac
import secrets
import socket
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field


ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ALLOWED_REACTIONS = {"Clap", "Encore", "Cheer", "Fire", "Sing", "Love"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _score_lan_ip(ip: str) -> int:
    """Rank LAN IPv4 addresses so real Wi-Fi/Ethernet beats virtual adapters, VPNs, and APIPA."""
    if not ip or ip.startswith("127.") or ip.startswith("169.254."):
        return -100
    parts = ip.split(".")
    if len(parts) != 4:
        return -100
    is_gateway_one = parts[3] == "1"
    if parts[0] == "192" and parts[1] == "168":
        return 40 if is_gateway_one else 100
    if parts[0] == "10":
        return 35 if is_gateway_one else 85
    if parts[0] == "172" and parts[1].isdigit() and 16 <= int(parts[1]) <= 31:
        # Often virtual/VPN adapters (e.g. Cloudflare WARP 172.16.0.2, Docker, WSL)
        return 20 if is_gateway_one else 50
    return 10


def detect_lan_ip() -> str:
    """Detect best non-loopback local Wi-Fi/Ethernet IPv4 address without sending packets."""
    candidates: set[str] = set()
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            candidates.add(ip)
    except OSError:
        pass
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("8.8.8.8", 80))
            candidates.add(sock.getsockname()[0])
        finally:
            sock.close()
    except OSError:
        pass

    ranked = sorted(candidates, key=_score_lan_ip, reverse=True)
    if ranked and _score_lan_ip(ranked[0]) > 0:
        return ranked[0]
    return "127.0.0.1"


def _generate_room_code(existing_codes: set[str], length: int = 8) -> str:
    for _ in range(32):
        code = "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(length))
        if code not in existing_codes:
            return code
    return uuid.uuid4().hex[:8].upper()


class PublishSongItem(BaseModel):
    host_song_id: str
    title: str
    artist: str = ""
    duration_ms: int = Field(default=0, ge=0)
    readiness: str = "raw"


class PublishSongsRequest(BaseModel):
    songs: list[PublishSongItem]
    capability: str


class JoinLanRoomRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=40)
    user_id: str | None = None


class SetStatusRequest(BaseModel):
    status: str
    capability: str


class AddQueueRequest(BaseModel):
    song_id: str
    user_id: str
    idempotency_key: str = Field(min_length=1, max_length=128)


class ReorderQueueRequest(BaseModel):
    ordered_entry_ids: list[str]
    capability: str


class AdvanceQueueRequest(BaseModel):
    action: str
    capability: str
    entry_id: str | None = None


class PlaybackCheckpointRequest(BaseModel):
    status: str
    position_ms: int = Field(default=0, ge=0)
    capability: str
    host_song_id: str | None = None


class ReactionRequest(BaseModel):
    sender: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1, max_length=24)


class _LanRoomState:
    def __init__(self, code: str) -> None:
        now = datetime.now(timezone.utc)
        now_iso = now.isoformat().replace("+00:00", "Z")
        expires_iso = (now + timedelta(hours=12)).isoformat().replace("+00:00", "Z")
        room_id = str(uuid.uuid4())
        host_user_id = str(uuid.uuid4())

        self.room: dict[str, Any] = {
            "id": room_id,
            "code": code,
            "host_user_id": host_user_id,
            "status": "open",
            "revision": 1,
            "created_at": now_iso,
            "expires_at": expires_iso,
        }
        self.host_capability = secrets.token_urlsafe(32)
        self.participants: dict[str, dict[str, Any]] = {
            host_user_id: {
                "room_id": room_id,
                "user_id": host_user_id,
                "display_name": "Host",
                "role": "host",
                "joined_at": now_iso,
                "last_seen": now_iso,
                "revoked_at": None,
            }
        }
        self.songs: dict[str, dict[str, Any]] = {}
        self.host_song_to_room_song_id: dict[str, str] = {}
        self.queue: list[dict[str, Any]] = []
        self.idempotency_map: dict[str, str] = {}
        self.playback: dict[str, Any] = {
            "room_id": room_id,
            "song_id": None,
            "status": "idle",
            "position_ms": 0,
            "revision": 1,
            "updated_at": now_iso,
        }
        self.connections: dict[WebSocket, str] = {}
        self.last_reaction_by_key: dict[str, float] = {}

    def verify_capability(self, capability: str) -> None:
        if not capability or not hmac.compare_digest(capability, self.host_capability):
            raise HTTPException(status_code=403, detail="Invalid host capability")

    def bump_revision(self) -> int:
        self.room["revision"] += 1
        return int(self.room["revision"])

    def snapshot(self) -> dict[str, Any]:
        active_participants = [
            p for p in self.participants.values() if p.get("revoked_at") is None
        ]
        sorted_songs = sorted(
            self.songs.values(), key=lambda s: (s["title"].lower(), s["id"])
        )
        active_queue = sorted(
            [q for q in self.queue if q["status"] in ("playing", "queued")],
            key=lambda q: (0 if q["status"] == "playing" else 1, q["position"], q["created_at"]),
        )
        return {
            "room": dict(self.room),
            "participants": active_participants,
            "songs": sorted_songs,
            "queue": active_queue,
            "playback": dict(self.playback) if self.playback else None,
        }

    def online_user_ids(self) -> list[str]:
        return sorted(set(self.connections.values()))


class LanRoomManager:
    def __init__(self) -> None:
        self.rooms_by_id: dict[str, _LanRoomState] = {}
        self.code_to_id: dict[str, str] = {}

    def cleanup_expired(self) -> None:
        now_iso = _now_iso()
        stale_ids = [
            rid
            for rid, st in self.rooms_by_id.items()
            if (st.room["status"] == "closed" or st.room["expires_at"] < now_iso)
            and not st.connections
        ]
        for rid in stale_ids:
            st = self.rooms_by_id.pop(rid, None)
            if st:
                self.code_to_id.pop(st.room["code"], None)

    def create_room(self) -> _LanRoomState:
        self.cleanup_expired()
        code = _generate_room_code(set(self.code_to_id.keys()))
        state = _LanRoomState(code)
        self.rooms_by_id[state.room["id"]] = state
        self.code_to_id[code] = state.room["id"]
        return state

    def get_room(self, room_id: str) -> _LanRoomState:
        state = self.rooms_by_id.get(room_id)
        if not state:
            raise HTTPException(status_code=404, detail="LAN room not found")
        return state

    def get_room_by_code(self, code: str) -> _LanRoomState | None:
        rid = self.code_to_id.get(code.strip().upper())
        return self.rooms_by_id.get(rid) if rid else None

    async def _broadcast(self, state: _LanRoomState, message: dict[str, Any]) -> None:
        stale: list[WebSocket] = []
        for ws in list(state.connections.keys()):
            try:
                await ws.send_json(message)
            except Exception:
                stale.append(ws)
        for ws in stale:
            state.connections.pop(ws, None)

    async def broadcast_snapshot(self, state: _LanRoomState) -> None:
        await self._broadcast(state, {"type": "snapshot", "payload": state.snapshot()})

    async def broadcast_presence(self, state: _LanRoomState) -> None:
        await self._broadcast(
            state,
            {"type": "presence", "payload": {"online_user_ids": state.online_user_ids()}},
        )

    async def broadcast_reaction(
        self, state: _LanRoomState, sender: str, label: str, rate_key: str
    ) -> bool:
        now = time.monotonic()
        last = state.last_reaction_by_key.get(rate_key, 0.0)
        if now - last < 1.5:
            return False
        state.last_reaction_by_key[rate_key] = now
        clean_label = label.strip()[:24]
        clean_sender = sender.strip()[:40] or "Guest"
        if clean_label not in ALLOWED_REACTIONS:
            clean_label = "Cheer"
        await self._broadcast(
            state,
            {
                "type": "reaction",
                "payload": {"sender": clean_sender, "label": clean_label},
            },
        )
        return True


def create_lan_router(
    require_host_token: Any,
    host_bind: str,
    host_port: int,
) -> tuple[APIRouter, LanRoomManager]:
    router = APIRouter(prefix="/lan", tags=["lan-rooms"])
    manager = LanRoomManager()

    @router.get("/info")
    def lan_info():
        open_rooms = sum(
            1 for r in manager.rooms_by_id.values() if r.room["status"] != "closed"
        )
        return {
            "lan_ip": detect_lan_ip(),
            "host_bind": host_bind,
            "port": host_port,
            "active_rooms": open_rooms,
        }

    @router.post("/rooms", dependencies=[Depends(require_host_token)])
    def create_lan_room():
        state = manager.create_room()
        return {
            "room_id": state.room["id"],
            "code": state.room["code"],
            "host_user_id": state.room["host_user_id"],
            "host_capability": state.host_capability,
        }

    @router.get("/rooms/by-code/{code}")
    def lookup_lan_room_by_code(code: str):
        state = manager.get_room_by_code(code)
        if not state or state.room["status"] == "closed":
            return {"room_id": None, "code": code.strip().upper(), "status": None}
        return {
            "room_id": state.room["id"],
            "code": state.room["code"],
            "status": state.room["status"],
        }

    @router.get("/rooms/{room_id}/snapshot")
    def get_lan_snapshot(room_id: str):
        state = manager.get_room(room_id)
        return state.snapshot()

    @router.post("/rooms/{room_id}/join")
    async def join_lan_room(room_id: str, req: JoinLanRoomRequest):
        state = manager.get_room(room_id)
        if state.room["status"] == "closed":
            raise HTTPException(status_code=409, detail="Room is closed")
        clean_name = req.display_name.strip()
        if not clean_name:
            raise HTTPException(status_code=400, detail="Display name required")

        uid = req.user_id
        try:
            if uid:
                uuid.UUID(uid)
            else:
                uid = str(uuid.uuid4())
        except ValueError:
            uid = str(uuid.uuid4())

        now = _now_iso()
        existing = state.participants.get(uid)
        if existing:
            existing["display_name"] = clean_name
            existing["last_seen"] = now
            existing["revoked_at"] = None
        else:
            state.participants[uid] = {
                "room_id": state.room["id"],
                "user_id": uid,
                "display_name": clean_name,
                "role": "participant",
                "joined_at": now,
                "last_seen": now,
                "revoked_at": None,
            }
        state.bump_revision()
        await manager.broadcast_snapshot(state)
        return {"room_id": state.room["id"], "user_id": uid, "display_name": clean_name}

    @router.post("/rooms/{room_id}/songs")
    async def publish_lan_songs(room_id: str, req: PublishSongsRequest):
        state = manager.get_room(room_id)
        state.verify_capability(req.capability)
        count = 0
        for item in req.songs:
            readiness = (
                item.readiness
                if item.readiness in ("raw", "preparing", "ready", "failed")
                else "raw"
            )
            existing_song_id = state.host_song_to_room_song_id.get(item.host_song_id)
            song_id = existing_song_id or str(uuid.uuid4())
            state.host_song_to_room_song_id[item.host_song_id] = song_id
            state.songs[song_id] = {
                "id": song_id,
                "room_id": state.room["id"],
                "host_song_id": item.host_song_id,
                "title": item.title,
                "artist": item.artist,
                "duration_ms": item.duration_ms,
                "readiness": readiness,
            }
            count += 1
        state.bump_revision()
        await manager.broadcast_snapshot(state)
        return {"count": count, "revision": state.room["revision"]}

    @router.post("/rooms/{room_id}/status")
    async def set_lan_status(room_id: str, req: SetStatusRequest):
        state = manager.get_room(room_id)
        state.verify_capability(req.capability)
        if req.status not in ("open", "host_disconnected", "closed"):
            raise HTTPException(status_code=400, detail="Invalid room status")
        state.room["status"] = req.status
        rev = state.bump_revision()
        await manager.broadcast_snapshot(state)
        return {"revision": rev, "status": req.status}

    @router.post("/rooms/{room_id}/queue")
    async def add_lan_queue_entry(room_id: str, req: AddQueueRequest):
        state = manager.get_room(room_id)
        if state.room["status"] != "open":
            raise HTTPException(status_code=409, detail="Room is not accepting requests")
        if req.user_id not in state.participants:
            raise HTTPException(status_code=403, detail="Join the room before queuing songs")
        if req.song_id not in state.songs:
            raise HTTPException(status_code=404, detail="Song not found in room catalogue")

        existing_entry_id = state.idempotency_map.get(req.idempotency_key)
        if existing_entry_id:
            return {"entry_id": existing_entry_id, "revision": state.room["revision"]}

        max_pos = max((q["position"] for q in state.queue if q["status"] == "queued"), default=0)
        entry_id = str(uuid.uuid4())
        entry = {
            "id": entry_id,
            "room_id": state.room["id"],
            "song_id": req.song_id,
            "requested_by": req.user_id,
            "position": max_pos + 1,
            "status": "queued",
            "idempotency_key": req.idempotency_key,
            "created_at": _now_iso(),
        }
        state.queue.append(entry)
        state.idempotency_map[req.idempotency_key] = entry_id
        rev = state.bump_revision()
        await manager.broadcast_snapshot(state)
        return {"entry_id": entry_id, "revision": rev}

    @router.delete("/rooms/{room_id}/queue/{entry_id}")
    async def remove_lan_queue_entry(
        room_id: str,
        entry_id: str,
        user_id: str = Query(default=""),
        capability: str = Query(default=""),
    ):
        state = manager.get_room(room_id)
        is_host = bool(capability and hmac.compare_digest(capability, state.host_capability))
        target = next((q for q in state.queue if q["id"] == entry_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Queue entry not found")
        if not is_host and target["requested_by"] != user_id:
            raise HTTPException(status_code=403, detail="Cannot remove another singer's entry")

        state.queue = [q for q in state.queue if q["id"] != entry_id]
        rev = state.bump_revision()
        await manager.broadcast_snapshot(state)
        return {"ok": True, "revision": rev}

    @router.post("/rooms/{room_id}/queue/reorder")
    async def reorder_lan_queue(room_id: str, req: ReorderQueueRequest):
        state = manager.get_room(room_id)
        state.verify_capability(req.capability)
        order_map = {eid: idx + 1 for idx, eid in enumerate(req.ordered_entry_ids)}
        next_pos = len(order_map) + 1
        for q in state.queue:
            if q["status"] == "queued":
                if q["id"] in order_map:
                    q["position"] = order_map[q["id"]]
                else:
                    q["position"] = next_pos
                    next_pos += 1
        rev = state.bump_revision()
        await manager.broadcast_snapshot(state)
        return {"revision": rev}

    @router.post("/rooms/{room_id}/queue/advance")
    async def advance_lan_queue(room_id: str, req: AdvanceQueueRequest):
        state = manager.get_room(room_id)
        state.verify_capability(req.capability)
        if req.action not in ("next", "skip", "play_entry"):
            raise HTTPException(status_code=400, detail="Invalid advance action")

        for q in state.queue:
            if q["status"] == "playing":
                q["status"] = "skipped" if req.action == "skip" else "played"

        queued = sorted(
            [q for q in state.queue if q["status"] == "queued"],
            key=lambda q: (q["position"], q["created_at"]),
        )
        chosen = None
        if req.action == "play_entry" and req.entry_id:
            chosen = next((q for q in queued if q["id"] == req.entry_id), None)
        elif queued:
            chosen = queued[0]

        rev = state.bump_revision()
        now = _now_iso()
        if chosen:
            chosen["status"] = "playing"
            state.playback = {
                "room_id": state.room["id"],
                "song_id": chosen["song_id"],
                "status": "playing",
                "position_ms": 0,
                "revision": rev,
                "updated_at": now,
            }
        else:
            state.playback = {
                "room_id": state.room["id"],
                "song_id": None,
                "status": "idle",
                "position_ms": 0,
                "revision": rev,
                "updated_at": now,
            }
        await manager.broadcast_snapshot(state)
        return {"revision": rev}

    @router.post("/rooms/{room_id}/playback")
    async def sync_lan_playback(room_id: str, req: PlaybackCheckpointRequest):
        state = manager.get_room(room_id)
        state.verify_capability(req.capability)
        if req.status not in ("idle", "playing", "paused", "ended"):
            raise HTTPException(status_code=400, detail="Invalid playback status")
        rev = state.bump_revision()
        playing = next((q for q in state.queue if q["status"] == "playing"), None)
        explicit_song_id = (
            state.host_song_to_room_song_id.get(req.host_song_id)
            if req.host_song_id
            else None
        )
        resolved_song_id = (
            explicit_song_id
            or (playing["song_id"] if playing else None)
            or state.playback.get("song_id")
        )
        state.playback = {
            "room_id": state.room["id"],
            "song_id": resolved_song_id,
            "status": req.status,
            "position_ms": req.position_ms,
            "revision": rev,
            "updated_at": _now_iso(),
        }
        await manager.broadcast_snapshot(state)
        return {"revision": rev}

    @router.post("/rooms/{room_id}/reaction")
    async def send_lan_reaction(room_id: str, req: ReactionRequest):
        state = manager.get_room(room_id)
        sent = await manager.broadcast_reaction(
            state, req.sender, req.label, rate_key=f"http:{req.sender.strip().lower()}"
        )
        return {"ok": sent}

    @router.websocket("/rooms/{room_id}/ws")
    async def lan_room_ws(
        websocket: WebSocket,
        room_id: str,
        user_id: str = Query(default=""),
        display_name: str = Query(default="Guest"),
    ):
        state = manager.rooms_by_id.get(room_id)
        if not state:
            await websocket.close(code=4404)
            return
        await websocket.accept()
        client_uid = user_id or str(uuid.uuid4())
        state.connections[websocket] = client_uid
        try:
            await websocket.send_json({"type": "snapshot", "payload": state.snapshot()})
            await manager.broadcast_presence(state)
            while True:
                data = await websocket.receive_json()
                msg_type = data.get("type")
                if msg_type == "reaction":
                    label = str(data.get("label") or "Cheer")
                    sender = str(data.get("sender") or display_name or "Guest")
                    await manager.broadcast_reaction(
                        state, sender, label, rate_key=f"ws:{client_uid}"
                    )
                elif msg_type == "lyrics_sync" and client_uid == state.room["host_user_id"]:
                    payload = data.get("payload")
                    if isinstance(payload, dict):
                        await manager._broadcast(
                            state,
                            {"type": "lyrics_sync", "payload": payload},
                        )
                elif msg_type == "ping":
                    await websocket.send_json({"type": "pong"})
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            state.connections.pop(websocket, None)
            await manager.broadcast_presence(state)

    return router, manager
