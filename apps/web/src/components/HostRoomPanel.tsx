import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { buildJoinUrl } from "@geet/shared";
import { fetchSongsPage } from "../lib/hostAgent";
import {
  advanceRoomQueue,
  createHostRoom,
  ensureAuthSession,
  fetchRoomSnapshot,
  getStoredHostCapability,
  moveQueueEntry,
  publishRoomSongs,
  reconcileSnapshot,
  removeSongFromQueue,
  reorderRoomQueue,
  setHostRoomStatus,
  subscribeToRoom,
  syncPlaybackCheckpoint,
  type RoomSnapshot,
} from "../lib/rooms";
import { isSupabaseConfigured } from "../lib/supabase";

const ACTIVE_ROOM_KEY = "geet_active_host_room";

export interface PlaybackEventSignal {
  type: "playing" | "paused" | "ended";
  positionMs: number;
  seq: number;
}

interface HostRoomPanelProps {
  onPlayHostSong: (hostSongId: string) => void;
  playbackSignal: PlaybackEventSignal | null;
}

export function HostRoomPanel({ onPlayHostSong, playbackSignal }: HostRoomPanelProps) {
  const [roomId, setRoomId] = useState<string | null>(() => sessionStorage.getItem(ACTIVE_ROOM_KEY));
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const [connState, setConnState] = useState<"idle" | "connecting" | "subscribed" | "disconnected">("idle");
  const [reactions, setReactions] = useState<Array<{ sender: string; label: string }>>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lastPlayingEntryIdRef = useRef<string | null>(null);

  const appOrigin = (import.meta.env.VITE_APP_ORIGIN as string | undefined) || window.location.origin;
  const joinUrl = snapshot ? buildJoinUrl(appOrigin, snapshot.room.code) : null;

  useEffect(() => {
    if (!joinUrl) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(joinUrl, { width: 180, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [joinUrl]);

  useEffect(() => {
    if (!roomId || !isSupabaseConfigured) return;
    let active = true;
    let unsub: (() => void) | null = null;

    (async () => {
      try {
        const { userId } = await ensureAuthSession();
        const initial = await fetchRoomSnapshot(roomId);
        if (!active) return;
        setSnapshot((prev) => reconcileSnapshot(prev, initial, true));

        const sub = subscribeToRoom(roomId, userId, "Host", {
          onSnapshot: (snap) => setSnapshot((prev) => reconcileSnapshot(prev, snap)),
          onPresenceCount: setOnlineIds,
          onReaction: (r) => setReactions((prev) => [r, ...prev].slice(0, 8)),
          onConnectionState: setConnState,
        });
        unsub = sub.unsubscribe;
      } catch (err) {
        if (active) setMsg(err instanceof Error ? err.message : "Failed to restore room");
      }
    })();

    return () => {
      active = false;
      unsub?.();
    };
  }, [roomId]);

  const songMap = useMemo(
    () => new Map((snapshot?.songs ?? []).map((s) => [s.id, s])),
    [snapshot?.songs]
  );
  const participantMap = useMemo(
    () => new Map((snapshot?.participants ?? []).map((p) => [p.user_id, p.display_name])),
    [snapshot?.participants]
  );

  // When a new queue entry enters 'playing', load its local song on the host player
  useEffect(() => {
    const playing = snapshot?.queue.find((q) => q.status === "playing");
    if (!playing || playing.id === lastPlayingEntryIdRef.current) return;
    lastPlayingEntryIdRef.current = playing.id;
    const roomSong = songMap.get(playing.song_id);
    if (roomSong) onPlayHostSong(roomSong.host_song_id);
  }, [snapshot?.queue, songMap, onPlayHostSong]);

  // Publish sparse playback checkpoints or advance queue on track end without blocking local playback
  useEffect(() => {
    if (!playbackSignal || !roomId || !snapshot || snapshot.room.status !== "open") return;
    const cap = getStoredHostCapability(roomId);
    if (!cap) return;

    if (playbackSignal.type === "ended") {
      void advanceRoomQueue(roomId, "next", cap)
        .then(() => fetchRoomSnapshot(roomId).then(setSnapshot))
        .catch(() => {});
      return;
    }

    void syncPlaybackCheckpoint(roomId, playbackSignal.type, playbackSignal.positionMs, cap).catch(
      () => {}
    );
  }, [playbackSignal, roomId, snapshot?.room.status]);

  if (!isSupabaseConfigured) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-semibold text-slate-300">Cloud Room</h2>
        <p className="mt-1 text-xs text-slate-400">
          Configure VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to enable rooms and QR join.
        </p>
      </section>
    );
  }

  async function refreshSnapshotNow(id: string) {
    const fresh = await fetchRoomSnapshot(id);
    setSnapshot((prev) => reconcileSnapshot(prev, fresh, true));
  }

  async function handleCreateRoom() {
    setBusy(true);
    setMsg(null);
    try {
      const created = await createHostRoom();
      sessionStorage.setItem(ACTIVE_ROOM_KEY, created.roomId);
      setRoomId(created.roomId);
      setMsg(`Room ${created.code} created.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to create room");
    } finally {
      setBusy(false);
    }
  }

  async function handlePublishLibrary() {
    if (!roomId) return;
    setBusy(true);
    setMsg("Publishing catalogue metadata...");
    try {
      const allSongs = [];
      let cursor: string | null = null;
      do {
        const page = await fetchSongsPage("", cursor);
        allSongs.push(...page.songs);
        cursor = page.next_cursor;
      } while (cursor);

      const count = await publishRoomSongs(roomId, allSongs);
      await refreshSnapshotNow(roomId);
      setMsg(`Published ${count} song metadata record(s) to room.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleStatusChange(next: "open" | "host_disconnected" | "closed") {
    if (!roomId) return;
    const cap = getStoredHostCapability(roomId);
    if (!cap) {
      setMsg("Missing host capability in this browser session.");
      return;
    }
    setBusy(true);
    try {
      await setHostRoomStatus(roomId, next, cap);
      if (next === "closed") {
        sessionStorage.removeItem(ACTIVE_ROOM_KEY);
        setRoomId(null);
        setSnapshot(null);
        setConnState("idle");
      } else {
        await refreshSnapshotNow(roomId);
      }
      setMsg(`Room status updated to ${next}.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Status update failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleAdvance(action: "next" | "skip" | "play_entry", entryId?: string) {
    if (!roomId) return;
    const cap = getStoredHostCapability(roomId);
    if (!cap) return setMsg("Missing host capability.");
    setBusy(true);
    try {
      await advanceRoomQueue(roomId, action, cap, entryId ?? null);
      await refreshSnapshotNow(roomId);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Queue advance failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleMove(entryId: string, direction: "up" | "down") {
    if (!roomId || !snapshot) return;
    const cap = getStoredHostCapability(roomId);
    if (!cap) return setMsg("Missing host capability.");
    const ordered = moveQueueEntry(snapshot.queue, entryId, direction);
    setBusy(true);
    try {
      await reorderRoomQueue(roomId, ordered, cap);
      await refreshSnapshotNow(roomId);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Reorder failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveEntry(entryId: string) {
    if (!roomId) return;
    setBusy(true);
    try {
      await removeSongFromQueue(roomId, entryId);
      await refreshSnapshotNow(roomId);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  }

  const queuedEntries = (snapshot?.queue ?? []).filter((q) => q.status === "queued");
  const playingEntry = (snapshot?.queue ?? []).find((q) => q.status === "playing") ?? null;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-300">Cloud Room & QR Join</h2>
          <p className="text-xs text-slate-400">
            Realtime: {connState} {snapshot ? `• Rev ${snapshot.room.revision}` : ""}
          </p>
        </div>

        {!snapshot ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleCreateRoom()}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            Create Room
          </button>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handlePublishLibrary()}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              Publish Library
            </button>
            {snapshot.room.status === "open" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleStatusChange("host_disconnected")}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800"
              >
                Pause Room
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleStatusChange("open")}
                className="rounded-lg border border-emerald-700 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-950"
              >
                Resume Room
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleStatusChange("closed")}
              className="rounded-lg border border-rose-800 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-950"
            >
              Close Room
            </button>
          </div>
        )}
      </div>

      {snapshot && (
        <>
          <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
            {qrDataUrl && (
              <div className="rounded-lg bg-white p-2 w-fit">
                <img src={qrDataUrl} alt={`Join room ${snapshot.room.code}`} className="h-40 w-40" />
              </div>
            )}
            <div className="space-y-2 text-xs">
              <p>
                Room Code:{" "}
                <span className="font-mono text-base font-bold text-indigo-300">{snapshot.room.code}</span>
                <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 uppercase">
                  {snapshot.room.status}
                </span>
              </p>
              {joinUrl && (
                <p className="break-all text-slate-400">
                  Join URL: <span className="text-slate-200">{joinUrl}</span>
                </p>
              )}
              <p className="text-slate-400">
                Published songs: {snapshot.songs.length} • Participants: {snapshot.participants.length} (
                {onlineIds.length} online)
              </p>
              {snapshot.participants.length > 0 && (
                <p className="text-slate-300">
                  Members:{" "}
                  {snapshot.participants.map((p) => `${p.display_name} (${p.role})`).join(", ")}
                </p>
              )}
              {reactions.length > 0 && (
                <p className="text-indigo-300">
                  Recent reactions: {reactions.map((r) => `${r.sender}: ${r.label}`).join(" | ")}
                </p>
              )}
            </div>
          </div>

          <div className="border-t border-slate-800 pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Room Queue ({queuedEntries.length} upcoming)
              </h3>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy || queuedEntries.length === 0}
                  onClick={() => void handleAdvance("next")}
                  className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium hover:bg-indigo-500 disabled:opacity-40"
                >
                  Play Next
                </button>
                <button
                  type="button"
                  disabled={busy || (!playingEntry && queuedEntries.length === 0)}
                  onClick={() => void handleAdvance("skip")}
                  className="rounded border border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-800 disabled:opacity-40"
                >
                  Skip
                </button>
              </div>
            </div>

            {playingEntry && (
              <div className="rounded-lg border border-indigo-500/40 bg-slate-950 px-3 py-2 text-xs">
                <span className="text-indigo-400 font-semibold">Playing: </span>
                <span className="text-slate-200">
                  {songMap.get(playingEntry.song_id)?.title ?? "Unknown Song"}
                </span>
                <span className="ml-2 text-slate-500">
                  by {participantMap.get(playingEntry.requested_by) ?? "Member"}
                </span>
              </div>
            )}

            {queuedEntries.length === 0 ? (
              <p className="text-xs text-slate-500">Queue is empty.</p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {queuedEntries.map((entry, idx) => {
                  const song = songMap.get(entry.song_id);
                  const requester = participantMap.get(entry.requested_by) ?? "Member";
                  return (
                    <li key={entry.id} className="flex items-center justify-between py-2 text-xs">
                      <div>
                        <span className="mr-2 text-slate-500">{idx + 1}.</span>
                        <span className="font-medium text-slate-200">{song?.title ?? entry.song_id}</span>
                        <span className="ml-2 text-slate-400">({requester})</span>
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          disabled={busy || idx === 0}
                          onClick={() => void handleMove(entry.id, "up")}
                          className="rounded border border-slate-700 px-2 py-0.5 hover:bg-slate-800 disabled:opacity-30"
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          disabled={busy || idx === queuedEntries.length - 1}
                          onClick={() => void handleMove(entry.id, "down")}
                          className="rounded border border-slate-700 px-2 py-0.5 hover:bg-slate-800 disabled:opacity-30"
                        >
                          Down
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleAdvance("play_entry", entry.id)}
                          className="rounded border border-slate-700 px-2 py-0.5 text-indigo-300 hover:bg-slate-800"
                        >
                          Play
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleRemoveEntry(entry.id)}
                          className="rounded border border-rose-900 px-2 py-0.5 text-rose-300 hover:bg-rose-950"
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {msg && <p className="text-xs text-slate-300">{msg}</p>}
    </section>
  );
}
