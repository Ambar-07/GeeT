import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  PlaybackStateSchema,
  QueueEntrySchema,
  RoomParticipantSchema,
  RoomSchema,
  RoomSongSchema,
  type HostSong,
  type PlaybackState,
  type QueueEntry,
  type Room,
  type RoomParticipant,
  type RoomSong,
  type RoomStatus,
} from "@geet/shared";
import { z } from "zod";
import { supabase } from "./supabase";

export interface RoomSnapshot {
  room: Room;
  participants: RoomParticipant[];
  songs: RoomSong[];
  queue: QueueEntry[];
  playback: PlaybackState | null;
}

const CAP_STORAGE_PREFIX = "geet_host_cap_";
const ROOM_SELECT_COLS = "id, code, host_user_id, status, revision, created_at, expires_at";

export interface QuotaTelemetry {
  activeChannels: number;
  realtimeMessages: number;
  snapshotFetches: number;
  lastError: string | null;
}

const telemetry: QuotaTelemetry = {
  activeChannels: 0,
  realtimeMessages: 0,
  snapshotFetches: 0,
  lastError: null,
};

export function getQuotaTelemetry(): QuotaTelemetry {
  return { ...telemetry };
}

function requireSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export function getStoredHostCapability(roomId: string): string | null {
  return sessionStorage.getItem(`${CAP_STORAGE_PREFIX}${roomId}`);
}

export function storeHostCapability(roomId: string, capability: string): void {
  sessionStorage.setItem(`${CAP_STORAGE_PREFIX}${roomId}`, capability);
}

/** Ensure an authenticated Supabase session exists using anonymous sign-in. */
export async function ensureAuthSession(): Promise<{ userId: string }> {
  const client = requireSupabase();
  const { data: existing, error: sessionErr } = await client.auth.getSession();
  if (sessionErr) throw sessionErr;
  if (existing.session?.user) {
    return { userId: existing.session.user.id };
  }

  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.user) {
    throw error ?? new Error("Anonymous sign-in failed");
  }
  return { userId: data.user.id };
}

export async function createHostRoom(): Promise<{
  roomId: string;
  code: string;
  hostCapability: string;
}> {
  const client = requireSupabase();
  await ensureAuthSession();
  const { data, error } = await client.rpc("create_room");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.room_id || !row?.code || !row?.host_capability) {
    throw new Error("Invalid create_room response");
  }
  storeHostCapability(row.room_id, row.host_capability);
  return {
    roomId: row.room_id as string,
    code: row.code as string,
    hostCapability: row.host_capability as string,
  };
}

export async function joinRoomAsParticipant(code: string, displayName: string): Promise<string> {
  const client = requireSupabase();
  await ensureAuthSession();
  const { data, error } = await client.rpc("join_room", {
    p_code: code.trim().toUpperCase(),
    p_display_name: displayName.trim(),
  });
  if (error) throw error;
  if (!data) throw new Error("join_room did not return a room ID");
  return data as string;
}

export async function setHostRoomStatus(
  roomId: string,
  status: RoomStatus,
  capability: string
): Promise<number> {
  const client = requireSupabase();
  const { data, error } = await client.rpc("set_room_status", {
    p_room_id: roomId,
    p_status: status,
    p_capability: capability,
  });
  if (error) throw error;
  return Number(data);
}

/** Publish safe searchable song metadata in batches of 100 (never audio or file paths). */
export async function publishRoomSongs(roomId: string, songs: HostSong[]): Promise<number> {
  const client = requireSupabase();
  const publishable = songs
    .filter((s) => s.readiness !== "drm_rejected")
    .map((s) => ({
      room_id: roomId,
      host_song_id: s.id,
      title: s.title,
      artist: s.artist,
      duration_ms: s.duration_ms,
      readiness: s.readiness === "preparing" || s.readiness === "ready" || s.readiness === "failed"
        ? s.readiness
        : "raw",
    }));

  const BATCH_SIZE = 100;
  for (let i = 0; i < publishable.length; i += BATCH_SIZE) {
    const chunk = publishable.slice(i, i + BATCH_SIZE);
    const { error } = await client
      .from("room_songs")
      .upsert(chunk, { onConflict: "room_id,host_song_id" });
    if (error) throw error;
  }
  return publishable.length;
}

export async function fetchRoomIdByCode(code: string): Promise<string | null> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("rooms")
    .select("id")
    .eq("code", code.trim().toUpperCase())
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

export async function fetchRoomSnapshot(roomId: string): Promise<RoomSnapshot> {
  const client = requireSupabase();
  telemetry.snapshotFetches += 1;
  const [roomRes, partRes, songsRes, queueRes, pbRes] = await Promise.all([
    client.from("rooms").select(ROOM_SELECT_COLS).eq("id", roomId).single(),
    client.from("room_participants").select("*").eq("room_id", roomId).is("revoked_at", null),
    client.from("room_songs").select("*").eq("room_id", roomId).order("title").limit(200),
    client
      .from("queue_entries")
      .select("*")
      .eq("room_id", roomId)
      .in("status", ["playing", "queued"])
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    client.from("playback_state").select("*").eq("room_id", roomId).maybeSingle(),
  ]);

  if (roomRes.error) throw roomRes.error;
  if (partRes.error) throw partRes.error;
  if (songsRes.error) throw songsRes.error;
  if (queueRes.error) throw queueRes.error;
  if (pbRes.error) throw pbRes.error;

  return {
    room: RoomSchema.parse(roomRes.data),
    participants: z.array(RoomParticipantSchema).parse(partRes.data ?? []),
    songs: z.array(RoomSongSchema).parse(songsRes.data ?? []),
    queue: z.array(QueueEntrySchema).parse(queueRes.data ?? []),
    playback: pbRes.data ? PlaybackStateSchema.parse(pbRes.data) : null,
  };
}

export async function addSongToQueue(
  roomId: string,
  songId: string,
  idempotencyKey = crypto.randomUUID()
): Promise<string> {
  const client = requireSupabase();
  const { data, error } = await client.rpc("add_song", {
    p_room_id: roomId,
    p_song_id: songId,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return String(data);
}

export async function removeSongFromQueue(roomId: string, entryId: string): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.rpc("remove_song", {
    p_room_id: roomId,
    p_entry_id: entryId,
  });
  if (error) throw error;
}

export async function reorderRoomQueue(
  roomId: string,
  orderedEntryIds: string[],
  capability: string
): Promise<number> {
  const client = requireSupabase();
  const { data, error } = await client.rpc("reorder_queue", {
    p_room_id: roomId,
    p_ordered_entry_ids: orderedEntryIds,
    p_capability: capability,
  });
  if (error) throw error;
  return Number(data);
}

export async function advanceRoomQueue(
  roomId: string,
  action: "next" | "skip" | "play_entry",
  capability: string,
  entryId: string | null = null
): Promise<number> {
  const client = requireSupabase();
  const { data, error } = await client.rpc("advance_queue", {
    p_room_id: roomId,
    p_action: action,
    p_capability: capability,
    p_entry_id: entryId,
  });
  if (error) throw error;
  return Number(data);
}

export async function syncPlaybackCheckpoint(
  roomId: string,
  status: "idle" | "playing" | "paused" | "ended",
  positionMs: number,
  capability: string
): Promise<number> {
  const client = requireSupabase();
  const { data, error } = await client.rpc("sync_playback_checkpoint", {
    p_room_id: roomId,
    p_status: status,
    p_position_ms: Math.max(0, Math.round(positionMs)),
    p_capability: capability,
  });
  if (error) throw error;
  return Number(data);
}

/** Compute next ordered IDs for queued entries after shifting one entry up or down. */
export function moveQueueEntry(
  entries: readonly QueueEntry[],
  entryId: string,
  direction: "up" | "down"
): string[] {
  const queued = entries.filter((e) => e.status === "queued").map((e) => e.id);
  const idx = queued.indexOf(entryId);
  if (idx === -1) return queued;
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= queued.length) return queued;
  [queued[idx], queued[swapIdx]] = [queued[swapIdx], queued[idx]];
  return queued;
}

/** Reconcile snapshot against current local revision; returns incoming if newer or on reconnect. */
export function reconcileSnapshot(
  current: RoomSnapshot | null,
  incoming: RoomSnapshot,
  force = false
): RoomSnapshot {
  if (!current || force) return incoming;
  return incoming.room.revision >= current.room.revision ? incoming : current;
}

export interface LiveLyricsSyncPayload {
  hostSongId: string;
  title?: string;
  artist?: string;
  lrcText: string;
  offsetMs: number;
  status?: "idle" | "playing" | "paused" | "ended";
  positionMs?: number;
  sentAtMs?: number;
}

export type HostRemoteAction = "toggle_play" | "next" | "toggle_tv" | "vocal_mix";

export interface HostRemoteCommand {
  action: HostRemoteAction;
  value?: number;
}

export interface MicRtcSignal {
  fromUid?: string;
  toUid?: string;
  kind: "offer" | "answer" | "ice" | "stop";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export interface RoomSubscriptionCallbacks {
  onSnapshot: (snap: RoomSnapshot) => void;
  onPresenceCount: (onlineUserIds: string[]) => void;
  onReaction: (payload: { sender: string; label: string }) => void;
  onConnectionState: (state: "connecting" | "subscribed" | "disconnected") => void;
  onLyricsSync?: (payload: LiveLyricsSyncPayload) => void;
  onLyricsRequest?: () => void;
  onHostControl?: (command: HostRemoteCommand) => void;
  onMicAudio?: (pcm: ArrayBuffer) => void;
  onMicRtcSignal?: (signal: MicRtcSignal) => void;
}

export interface RoomSubscriptionHandle {
  sendReaction: (label: string) => void;
  sendLyricsSync: (payload: LiveLyricsSyncPayload) => void;
  requestLyricsSync: () => void;
  sendHostControl: (command: HostRemoteCommand, capability: string) => void;
  sendMicAudio: (pcm: ArrayBuffer) => void;
  sendMicRtcSignal: (signal: MicRtcSignal) => void;
  unsubscribe: () => void;
}

export function subscribeToRoom(
  roomId: string,
  userId: string,
  displayName: string,
  callbacks: RoomSubscriptionCallbacks
): RoomSubscriptionHandle {
  const client = requireSupabase();
  let lastReactionAt = 0;

  const refresh = async (force = false) => {
    telemetry.realtimeMessages += 1;
    try {
      const snap = await fetchRoomSnapshot(roomId);
      telemetry.lastError = null;
      callbacks.onSnapshot(snap);
      void force;
    } catch (err) {
      telemetry.lastError = err instanceof Error ? err.message : "Snapshot sync error";
    }
  };

  callbacks.onConnectionState("connecting");
  telemetry.activeChannels += 1;
  const channel: RealtimeChannel = client.channel(`room:${roomId}`, {
    config: { presence: { key: userId } },
  });

  channel
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
      () => void refresh()
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "room_participants", filter: `room_id=eq.${roomId}` },
      () => void refresh()
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "room_songs", filter: `room_id=eq.${roomId}` },
      () => void refresh()
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "queue_entries", filter: `room_id=eq.${roomId}` },
      () => void refresh()
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "playback_state", filter: `room_id=eq.${roomId}` },
      () => void refresh()
    )
    .on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      callbacks.onPresenceCount(Object.keys(state));
    })
    .on("broadcast", { event: "reaction" }, ({ payload }) => {
      telemetry.realtimeMessages += 1;
      if (payload?.sender && payload?.label) {
        callbacks.onReaction({ sender: String(payload.sender), label: String(payload.label) });
      }
    })
    .on("broadcast", { event: "lyrics_sync" }, ({ payload }) => {
      telemetry.realtimeMessages += 1;
      if (payload?.hostSongId && typeof payload.lrcText === "string") {
        callbacks.onLyricsSync?.({
          hostSongId: String(payload.hostSongId),
          title: payload.title ? String(payload.title) : undefined,
          artist: payload.artist ? String(payload.artist) : undefined,
          lrcText: payload.lrcText,
          offsetMs: Number(payload.offsetMs ?? 0),
          status: payload.status,
          positionMs: typeof payload.positionMs === "number" ? payload.positionMs : undefined,
          sentAtMs: typeof payload.sentAtMs === "number" ? payload.sentAtMs : undefined,
        });
      }
    })
    .on("broadcast", { event: "lyrics_request" }, () => {
      callbacks.onLyricsRequest?.();
    })
    .on("broadcast", { event: "host_control" }, ({ payload }) => {
      telemetry.realtimeMessages += 1;
      const expectedCap = getStoredHostCapability(roomId);
      if (
        expectedCap &&
        payload?.capability === expectedCap &&
        typeof payload?.action === "string"
      ) {
        callbacks.onHostControl?.({
          action: payload.action as HostRemoteAction,
          value: typeof payload.value === "number" ? payload.value : undefined,
        });
      }
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        callbacks.onConnectionState("subscribed");
        await channel.track({ user_id: userId, display_name: displayName });
        await refresh(true);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        callbacks.onConnectionState("disconnected");
      }
    });

  return {
    sendReaction(label: string) {
      const now = Date.now();
      // Client-side rate limit: max 1 reaction every 2000ms to protect Realtime message quota
      if (now - lastReactionAt < 2000) return;
      lastReactionAt = now;
      telemetry.realtimeMessages += 1;
      void channel.send({
        type: "broadcast",
        event: "reaction",
        payload: { sender: displayName, label },
      });
    },
    sendLyricsSync(payload: LiveLyricsSyncPayload) {
      telemetry.realtimeMessages += 1;
      void channel.send({
        type: "broadcast",
        event: "lyrics_sync",
        payload: { ...payload, sentAtMs: Date.now() },
      });
    },
    requestLyricsSync() {
      telemetry.realtimeMessages += 1;
      void channel.send({
        type: "broadcast",
        event: "lyrics_request",
        payload: { requester: userId },
      });
    },
    sendHostControl(command: HostRemoteCommand, capability: string) {
      telemetry.realtimeMessages += 1;
      void channel.send({
        type: "broadcast",
        event: "host_control",
        payload: { ...command, capability },
      });
    },
    sendMicAudio() {
      // Wireless phone mic streaming is LAN-only (low-latency local Wi-Fi)
    },
    sendMicRtcSignal() {
      // Direct LAN WebRTC signaling is LAN-only
    },
    unsubscribe() {
      telemetry.activeChannels = Math.max(0, telemetry.activeChannels - 1);
      void client.removeChannel(channel);
    },
  };
}
