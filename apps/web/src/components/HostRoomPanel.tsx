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
  const [, setConnState] = useState<"idle" | "connecting" | "subscribed" | "disconnected">("idle");
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
    QRCode.toDataURL(joinUrl, { width: 160, margin: 1 })
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
          onReaction: (r) => setReactions((prev) => [r, ...prev].slice(0, 6)),
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

  useEffect(() => {
    const playing = snapshot?.queue.find((q) => q.status === "playing");
    if (!playing || playing.id === lastPlayingEntryIdRef.current) return;
    lastPlayingEntryIdRef.current = playing.id;
    const roomSong = songMap.get(playing.song_id);
    if (roomSong) onPlayHostSong(roomSong.host_song_id);
  }, [snapshot?.queue, songMap, onPlayHostSong]);

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
      <section className="rounded-xl border border-white/[0.06] bg-ink-850 px-3.5 py-2.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-medium text-snow/75">Party Room</span>
          <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-snow/50">
            Solo Mode
          </span>
        </div>
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
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to create room");
    } finally {
      setBusy(false);
    }
  }

  async function handlePublishLibrary() {
    if (!roomId) return;
    setBusy(true);
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
      setMsg(`Synced ${count} songs to room.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleStatusChange(next: "open" | "host_disconnected" | "closed") {
    if (!roomId) return;
    const cap = getStoredHostCapability(roomId);
    if (!cap) return setMsg("Missing host capability.");
    setBusy(true);
    try {
      await setHostRoomStatus(roomId, next, cap);
      if (next === "closed") {
        sessionStorage.removeItem(ACTIVE_ROOM_KEY);
        setRoomId(null);
        setSnapshot(null);
      } else {
        await refreshSnapshotNow(roomId);
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Status update failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleAdvance(action: "next" | "skip" | "play_entry", entryId?: string) {
    if (!roomId) return;
    const cap = getStoredHostCapability(roomId);
    if (!cap) return;
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
    if (!cap) return;
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
    <section className="rounded-xl border border-white/[0.07] bg-ink-850 p-4 space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="eyebrow">Party Room</h2>

        {!snapshot ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleCreateRoom()}
            className="btn-light px-3 py-1 text-xs"
          >
            Create Room
          </button>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handlePublishLibrary()}
              className="btn-light px-2.5 py-1 text-[11px]"
            >
              Publish Library
            </button>
            {snapshot.room.status === "open" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleStatusChange("host_disconnected")}
                className="btn-ghost px-2.5 py-1 text-[11px]"
              >
                Pause Room
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleStatusChange("open")}
                className="btn-primary px-2.5 py-1 text-[11px]"
              >
                Resume Room
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleStatusChange("closed")}
              className="btn-ghost px-2.5 py-1 text-[11px] text-pink"
            >
              Close Room
            </button>
          </div>
        )}
      </div>

      {snapshot && (
        <>
          <div className="flex items-center gap-3.5">
            {qrDataUrl && (
              <div className="shrink-0 rounded-xl bg-snow p-1.5">
                <img src={qrDataUrl} alt={`Join room ${snapshot.room.code}`} className="h-20 w-20" />
              </div>
            )}
            <div className="min-w-0 space-y-1 text-xs">
              <div className="font-mono text-lg font-bold tracking-wider text-snow">
                {snapshot.room.code}
              </div>
              <p className="text-snow/55">
                {onlineIds.length} online • {snapshot.songs.length} songs
              </p>
              {reactions.length > 0 && (
                <p className="truncate text-pink">
                  {reactions.map((r) => `${r.sender}: ${r.label}`).join(" · ")}
                </p>
              )}
            </div>
          </div>

          <div className="border-t border-white/8 pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-snow/55">
                Up Next ({queuedEntries.length})
              </span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={busy || queuedEntries.length === 0}
                  onClick={() => void handleAdvance("next")}
                  className="btn-primary px-2.5 py-0.5 text-[11px]"
                >
                  Play Next
                </button>
                <button
                  type="button"
                  disabled={busy || (!playingEntry && queuedEntries.length === 0)}
                  onClick={() => void handleAdvance("skip")}
                  className="btn-ghost px-2.5 py-0.5 text-[11px]"
                >
                  Skip
                </button>
              </div>
            </div>

            {queuedEntries.length > 0 && (
              <ul className="divide-y divide-white/6">
                {queuedEntries.map((entry, idx) => {
                  const song = songMap.get(entry.song_id);
                  const requester = participantMap.get(entry.requested_by) ?? "Guest";
                  return (
                    <li key={entry.id} className="flex items-center justify-between py-1.5 text-xs">
                      <div className="truncate">
                        <span className="mr-1.5 text-snow/40">{idx + 1}.</span>
                        <span className="font-medium text-snow">{song?.title ?? "Track"}</span>
                        <span className="ml-1.5 text-snow/50">({requester})</span>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          disabled={busy || idx === 0}
                          onClick={() => void handleMove(entry.id, "up")}
                          className="px-1.5 py-0.5 text-[10px] text-snow/60 hover:text-snow disabled:opacity-30"
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          disabled={busy || idx === queuedEntries.length - 1}
                          onClick={() => void handleMove(entry.id, "down")}
                          className="px-1.5 py-0.5 text-[10px] text-snow/60 hover:text-snow disabled:opacity-30"
                        >
                          Down
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleAdvance("play_entry", entry.id)}
                          className="px-1.5 py-0.5 text-[10px] text-sky hover:underline"
                        >
                          Play
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleRemoveEntry(entry.id)}
                          className="px-1.5 py-0.5 text-[10px] text-pink hover:underline"
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

      {msg && (
        <p role="status" className="text-xs text-snow/65">
          {msg}
        </p>
      )}
    </section>
  );
}
