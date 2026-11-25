import {
  PlaybackStateSchema,
  QueueEntrySchema,
  RoomParticipantSchema,
  RoomSchema,
  RoomSongSchema,
  type HostSong,
  type RoomStatus,
} from "@geet/shared";
import { z } from "zod";
import {
  storeHostCapability,
  type RoomSnapshot,
  type RoomSubscriptionCallbacks,
} from "./rooms";

const LAN_API_BASE = "/lan-api";
const LAN_HOST_UID_PREFIX = "geet_lan_host_uid_";
const LAN_GUEST_UID_PREFIX = "geet_lan_guest_uid_";

export interface LanNetworkInfo {
  lan_ip: string;
  host_bind: string;
  port: number;
  active_rooms: number;
}

const LanSnapshotSchema = z.object({
  room: RoomSchema,
  participants: z.array(RoomParticipantSchema),
  songs: z.array(RoomSongSchema),
  queue: z.array(QueueEntrySchema),
  playback: PlaybackStateSchema.nullable(),
});

async function lanFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${LAN_API_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `LAN room request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function fetchLanInfo(): Promise<LanNetworkInfo> {
  return lanFetch<LanNetworkInfo>("/info");
}

/** Build a phone-scannable join origin, swapping localhost for the host's LAN IP when available. */
export function buildLanJoinOrigin(currentOrigin: string, lanIp?: string | null): string {
  if (!lanIp || lanIp === "127.0.0.1") return currentOrigin;
  try {
    const u = new URL(currentOrigin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      u.hostname = lanIp;
      return u.origin;
    }
    return currentOrigin;
  } catch {
    return currentOrigin;
  }
}

export function getStoredLanHostUserId(roomId: string): string | null {
  return sessionStorage.getItem(`${LAN_HOST_UID_PREFIX}${roomId}`);
}

export function getStoredLanGuestUserId(roomId: string): string | null {
  return sessionStorage.getItem(`${LAN_GUEST_UID_PREFIX}${roomId}`);
}

export async function createLanHostRoom(): Promise<{
  roomId: string;
  code: string;
  hostUserId: string;
  hostCapability: string;
}> {
  const data = await lanFetch<{
    room_id: string;
    code: string;
    host_user_id: string;
    host_capability: string;
  }>("/rooms", { method: "POST" });

  storeHostCapability(data.room_id, data.host_capability);
  sessionStorage.setItem(`${LAN_HOST_UID_PREFIX}${data.room_id}`, data.host_user_id);
  return {
    roomId: data.room_id,
    code: data.code,
    hostUserId: data.host_user_id,
    hostCapability: data.host_capability,
  };
}

export async function fetchLanRoomIdByCode(code: string): Promise<string | null> {
  const data = await lanFetch<{ room_id: string | null }>(
    `/rooms/by-code/${encodeURIComponent(code.trim().toUpperCase())}`
  );
  return data.room_id;
}

export async function joinLanRoomAsParticipant(
  code: string,
  displayName: string
): Promise<{ roomId: string; userId: string }> {
  const roomId = await fetchLanRoomIdByCode(code);
  if (!roomId) {
    throw new Error(`Room ${code.trim().toUpperCase()} not found on this network.`);
  }
  const existingUid = getStoredLanGuestUserId(roomId);
  const res = await lanFetch<{ room_id: string; user_id: string }>(
    `/rooms/${encodeURIComponent(roomId)}/join`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        display_name: displayName.trim(),
        user_id: existingUid || undefined,
      }),
    }
  );
  sessionStorage.setItem(`${LAN_GUEST_UID_PREFIX}${res.room_id}`, res.user_id);
  return { roomId: res.room_id, userId: res.user_id };
}

export async function fetchLanRoomSnapshot(roomId: string): Promise<RoomSnapshot> {
  const raw = await lanFetch<unknown>(`/rooms/${encodeURIComponent(roomId)}/snapshot`);
  return LanSnapshotSchema.parse(raw);
}

export async function publishLanRoomSongs(
  roomId: string,
  songs: HostSong[],
  capability: string
): Promise<number> {
  const publishable = songs
    .filter((s) => s.readiness !== "drm_rejected")
    .map((s) => ({
      host_song_id: s.id,
      title: s.title,
      artist: s.artist,
      duration_ms: s.duration_ms,
      readiness:
        s.readiness === "preparing" || s.readiness === "ready" || s.readiness === "failed"
          ? s.readiness
          : "raw",
    }));

  const data = await lanFetch<{ count: number }>(
    `/rooms/${encodeURIComponent(roomId)}/songs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songs: publishable, capability }),
    }
  );
  return data.count;
}

export async function setLanHostRoomStatus(
  roomId: string,
  status: RoomStatus,
  capability: string
): Promise<number> {
  const data = await lanFetch<{ revision: number }>(
    `/rooms/${encodeURIComponent(roomId)}/status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, capability }),
    }
  );
  return data.revision;
}

export async function addLanSongToQueue(
  roomId: string,
  songId: string,
  userId: string,
  idempotencyKey = crypto.randomUUID()
): Promise<string> {
  const data = await lanFetch<{ entry_id: string }>(
    `/rooms/${encodeURIComponent(roomId)}/queue`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        song_id: songId,
        user_id: userId,
        idempotency_key: idempotencyKey,
      }),
    }
  );
  return data.entry_id;
}

export async function removeLanSongFromQueue(
  roomId: string,
  entryId: string,
  opts: { userId?: string; capability?: string }
): Promise<void> {
  const params = new URLSearchParams();
  if (opts.userId) params.set("user_id", opts.userId);
  if (opts.capability) params.set("capability", opts.capability);
  await lanFetch<{ ok: boolean }>(
    `/rooms/${encodeURIComponent(roomId)}/queue/${encodeURIComponent(entryId)}?${params.toString()}`,
    { method: "DELETE" }
  );
}

export async function reorderLanRoomQueue(
  roomId: string,
  orderedEntryIds: string[],
  capability: string
): Promise<number> {
  const data = await lanFetch<{ revision: number }>(
    `/rooms/${encodeURIComponent(roomId)}/queue/reorder`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ordered_entry_ids: orderedEntryIds, capability }),
    }
  );
  return data.revision;
}

export async function advanceLanRoomQueue(
  roomId: string,
  action: "next" | "skip" | "play_entry",
  capability: string,
  entryId: string | null = null
): Promise<number> {
  const data = await lanFetch<{ revision: number }>(
    `/rooms/${encodeURIComponent(roomId)}/queue/advance`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, capability, entry_id: entryId }),
    }
  );
  return data.revision;
}

export async function syncLanPlaybackCheckpoint(
  roomId: string,
  status: "idle" | "playing" | "paused" | "ended",
  positionMs: number,
  capability: string
): Promise<number> {
  const data = await lanFetch<{ revision: number }>(
    `/rooms/${encodeURIComponent(roomId)}/playback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status,
        position_ms: Math.max(0, Math.round(positionMs)),
        capability,
      }),
    }
  );
  return data.revision;
}

export function subscribeToLanRoom(
  roomId: string,
  userId: string,
  displayName: string,
  callbacks: RoomSubscriptionCallbacks
): { sendReaction: (label: string) => void; unsubscribe: () => void } {
  let closed = false;
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = 1000;
  let lastReactionAt = 0;

  const buildWsUrl = () => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      user_id: userId,
      display_name: displayName || "Guest",
    });
    return `${proto}//${window.location.host}${LAN_API_BASE}/rooms/${encodeURIComponent(roomId)}/ws?${params.toString()}`;
  };

  const connect = () => {
    if (closed) return;
    callbacks.onConnectionState("connecting");
    try {
      ws = new WebSocket(buildWsUrl());
    } catch {
      callbacks.onConnectionState("disconnected");
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      if (closed) return;
      retryMs = 1000;
      callbacks.onConnectionState("subscribed");
    };

    ws.onmessage = (event) => {
      if (closed) return;
      try {
        const msg = JSON.parse(String(event.data));
        if (msg?.type === "snapshot" && msg.payload) {
          callbacks.onSnapshot(LanSnapshotSchema.parse(msg.payload));
        } else if (msg?.type === "presence" && Array.isArray(msg.payload?.online_user_ids)) {
          callbacks.onPresenceCount(msg.payload.online_user_ids.map(String));
        } else if (msg?.type === "reaction" && msg.payload?.sender && msg.payload?.label) {
          callbacks.onReaction({
            sender: String(msg.payload.sender),
            label: String(msg.payload.label),
          });
        }
      } catch {
        // Ignore malformed frames
      }
    };

    ws.onerror = () => {
      if (!closed) callbacks.onConnectionState("disconnected");
    };

    ws.onclose = (ev) => {
      if (closed) return;
      callbacks.onConnectionState("disconnected");
      // 4404 means room no longer exists; stop retrying
      if (ev.code === 4404) return;
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (closed) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryMs = Math.min(8000, retryMs * 1.8);
      connect();
    }, retryMs);
  };

  connect();

  return {
    sendReaction(label: string) {
      const now = Date.now();
      if (now - lastReactionAt < 1800) return;
      lastReactionAt = now;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "reaction", sender: displayName, label }));
      } else {
        void lanFetch(`/rooms/${encodeURIComponent(roomId)}/reaction`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender: displayName || "Guest", label }),
        }).catch(() => {});
      }
    },
    unsubscribe() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        ws = null;
      }
    },
  };
}
