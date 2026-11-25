import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { buildJoinUrl, type RoomStatus } from "@geet/shared";
import { fetchSongsPage } from "../lib/hostAgent";
import {
  advanceLanRoomQueue,
  buildLanJoinOrigin,
  createLanHostRoom,
  fetchLanInfo,
  fetchLanRoomSnapshot,
  getStoredLanHostUserId,
  publishLanRoomSongs,
  removeLanSongFromQueue,
  reorderLanRoomQueue,
  setLanHostRoomStatus,
  subscribeToLanRoom,
  syncLanPlaybackCheckpoint,
  type LanNetworkInfo,
} from "../lib/lanRooms";
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
import { displayTitle } from "./Cover";
import {
  SyncStatusBadge,
  type RoomTransportMode,
  type SyncConnectionState,
} from "./SyncStatusBadge";

const ACTIVE_ROOM_KEY = "geet_active_host_room";
const ACTIVE_TRANSPORT_KEY = "geet_active_host_transport";

export interface PlaybackEventSignal {
  type: "playing" | "paused" | "ended";
  positionMs: number;
  seq: number;
}

export interface StageReactionBurst {
  id: string;
  sender: string;
  label: string;
  createdAt: number;
  offsetX: number;
}

export interface UpNextItem {
  entryId: string;
  hostSongId: string;
  title: string;
  artist: string;
  requester: string;
  readiness: "raw" | "preparing" | "ready" | "failed";
}

export interface HostStageRoomInfo {
  active: boolean;
  transport: RoomTransportMode;
  roomCode: string | null;
  roomStatus: RoomStatus | null;
  connState: SyncConnectionState;
  joinUrl: string | null;
  qrDataUrl: string | null;
  onlineCount: number;
  queueCount: number;
  upNext: UpNextItem[];
  playNext: (() => void) | null;
}

interface HostRoomPanelProps {
  hostConnected: boolean;
  onPlayHostSong: (hostSongId: string) => void;
  playbackSignal: PlaybackEventSignal | null;
  onStageRoomChange?: (info: HostStageRoomInfo) => void;
  onReactionBurst?: (burst: StageReactionBurst) => void;
}

export function HostRoomPanel({
  hostConnected,
  onPlayHostSong,
  playbackSignal,
  onStageRoomChange,
  onReactionBurst,
}: HostRoomPanelProps) {
  const defaultTransport: RoomTransportMode = isSupabaseConfigured ? "cloud" : "lan";

  const [transport, setTransport] = useState<RoomTransportMode>(() => {
    const saved = sessionStorage.getItem(ACTIVE_TRANSPORT_KEY);
    if (saved === "lan" || (saved === "cloud" && isSupabaseConfigured)) return saved;
    return defaultTransport;
  });
  const [roomId, setRoomId] = useState<string | null>(() => sessionStorage.getItem(ACTIVE_ROOM_KEY));
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [lanInfo, setLanInfo] = useState<LanNetworkInfo | null>(null);
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const [connState, setConnState] = useState<SyncConnectionState>("idle");
  const [reactions, setReactions] = useState<Array<{ sender: string; label: string }>>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const lastPlayingEntryIdRef = useRef<string | null>(null);
  const onReactionBurstRef = useRef(onReactionBurst);
  onReactionBurstRef.current = onReactionBurst;

  useEffect(() => {
    if (transport !== "lan" || !hostConnected) return;
    let active = true;
    fetchLanInfo()
      .then((info) => {
        if (active) setLanInfo(info);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [transport, hostConnected]);

  const appOrigin = useMemo(() => {
    const envOrigin = import.meta.env.VITE_APP_ORIGIN as string | undefined;
    if (transport === "lan") {
      return buildLanJoinOrigin(window.location.origin, lanInfo?.lan_ip);
    }
    return envOrigin || window.location.origin;
  }, [transport, lanInfo?.lan_ip]);

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

  const fetchSnapshotForMode = useCallback(
    async (id: string, mode: RoomTransportMode): Promise<RoomSnapshot> => {
      return mode === "lan" ? fetchLanRoomSnapshot(id) : fetchRoomSnapshot(id);
    },
    []
  );

  const handleIncomingReaction = useCallback((r: { sender: string; label: string }) => {
    setReactions((prev) => [r, ...prev].slice(0, 6));
    onReactionBurstRef.current?.({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sender: r.sender,
      label: r.label,
      createdAt: Date.now(),
      offsetX: Math.round(Math.random() * 44),
    });
  }, []);

  useEffect(() => {
    if (!roomId) {
      setConnState("idle");
      return;
    }
    if (transport === "cloud" && !isSupabaseConfigured) return;

    let active = true;
    let unsub: (() => void) | null = null;

    (async () => {
      try {
        const initial = await fetchSnapshotForMode(roomId, transport);
        if (!active) return;
        setSnapshot((prev) => reconcileSnapshot(prev, initial, true));

        if (transport === "lan") {
          const hostUid = getStoredLanHostUserId(roomId) ?? initial.room.host_user_id;
          const sub = subscribeToLanRoom(roomId, hostUid, "Host", {
            onSnapshot: (snap) => {
              if (active) setSnapshot((prev) => reconcileSnapshot(prev, snap));
            },
            onPresenceCount: (ids) => {
              if (active) setOnlineIds(ids);
            },
            onReaction: handleIncomingReaction,
            onConnectionState: (st) => {
              if (active) setConnState(st);
            },
          });
          unsub = sub.unsubscribe;
        } else {
          const { userId } = await ensureAuthSession();
          if (!active) return;
          const sub = subscribeToRoom(roomId, userId, "Host", {
            onSnapshot: (snap) => {
              if (active) setSnapshot((prev) => reconcileSnapshot(prev, snap));
            },
            onPresenceCount: (ids) => {
              if (active) setOnlineIds(ids);
            },
            onReaction: handleIncomingReaction,
            onConnectionState: (st) => {
              if (active) setConnState(st);
            },
          });
          unsub = sub.unsubscribe;
        }
      } catch (err) {
        if (!active) return;
        // If a saved LAN room expired after host-agent restart, clear stale storage gracefully
        sessionStorage.removeItem(ACTIVE_ROOM_KEY);
        setRoomId(null);
        setSnapshot(null);
        setConnState("idle");
        setMsg(err instanceof Error ? err.message : "Previous room ended; ready to start a new one.");
      }
    })();

    return () => {
      active = false;
      unsub?.();
    };
  }, [roomId, transport, fetchSnapshotForMode, handleIncomingReaction]);

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
      const advancePromise =
        transport === "lan"
          ? advanceLanRoomQueue(roomId, "next", cap)
          : advanceRoomQueue(roomId, "next", cap);
      void advancePromise
        .then(() => fetchSnapshotForMode(roomId, transport).then((s) => setSnapshot(s)))
        .catch(() => {});
      return;
    }

    const syncPromise =
      transport === "lan"
        ? syncLanPlaybackCheckpoint(roomId, playbackSignal.type, playbackSignal.positionMs, cap)
        : syncPlaybackCheckpoint(roomId, playbackSignal.type, playbackSignal.positionMs, cap);
    void syncPromise.catch(() => {});
  }, [playbackSignal, roomId, snapshot?.room.status, transport, fetchSnapshotForMode]);

  const refreshSnapshotNow = useCallback(
    async (id: string, mode = transport) => {
      const fresh = await fetchSnapshotForMode(id, mode);
      setSnapshot((prev) => reconcileSnapshot(prev, fresh, true));
    },
    [fetchSnapshotForMode, transport]
  );

  const publishAllLocalSongs = useCallback(
    async (targetRoomId: string, mode: RoomTransportMode, cap: string) => {
      const allSongs = [];
      let cursor: string | null = null;
      do {
        const page = await fetchSongsPage("", cursor);
        allSongs.push(...page.songs);
        cursor = page.next_cursor;
      } while (cursor);

      if (allSongs.length === 0) return 0;
      return mode === "lan"
        ? publishLanRoomSongs(targetRoomId, allSongs, cap)
        : publishRoomSongs(targetRoomId, allSongs);
    },
    []
  );

  async function handleCreateRoom() {
    setBusy(true);
    setMsg(null);
    try {
      if (transport === "lan") {
        const created = await createLanHostRoom();
        sessionStorage.setItem(ACTIVE_ROOM_KEY, created.roomId);
        sessionStorage.setItem(ACTIVE_TRANSPORT_KEY, "lan");
        setRoomId(created.roomId);
        // Auto-publish indexed songs so guests immediately see the catalogue
        const published = await publishAllLocalSongs(created.roomId, "lan", created.hostCapability).catch(
          () => 0
        );
        await refreshSnapshotNow(created.roomId, "lan");
        setMsg(
          published > 0
            ? `LAN Party started with ${published} songs published.`
            : "LAN Party started. Import a folder & click Sync Library."
        );
      } else {
        const created = await createHostRoom();
        sessionStorage.setItem(ACTIVE_ROOM_KEY, created.roomId);
        sessionStorage.setItem(ACTIVE_TRANSPORT_KEY, "cloud");
        setRoomId(created.roomId);
        const published = await publishAllLocalSongs(
          created.roomId,
          "cloud",
          created.hostCapability
        ).catch(() => 0);
        await refreshSnapshotNow(created.roomId, "cloud");
        if (published > 0) setMsg(`Room created & synced ${published} songs.`);
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to create room");
    } finally {
      setBusy(false);
    }
  }

  async function handlePublishLibrary() {
    if (!roomId) return;
    const cap = getStoredHostCapability(roomId) ?? "";
    setBusy(true);
    try {
      const count = await publishAllLocalSongs(roomId, transport, cap);
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
      if (transport === "lan") {
        await setLanHostRoomStatus(roomId, next, cap);
      } else {
        await setHostRoomStatus(roomId, next, cap);
      }
      if (next === "closed") {
        sessionStorage.removeItem(ACTIVE_ROOM_KEY);
        setRoomId(null);
        setSnapshot(null);
        setOnlineIds([]);
        setReactions([]);
        setConnState("idle");
      } else {
        await refreshSnapshotNow(roomId);
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Status update failed");
    } finally {
      setBusy(false);
    }
  }

  const handleAdvance = useCallback(
    async (action: "next" | "skip" | "play_entry", entryId?: string) => {
      if (!roomId) return;
      const cap = getStoredHostCapability(roomId);
      if (!cap) return;
      setBusy(true);
      try {
        if (transport === "lan") {
          await advanceLanRoomQueue(roomId, action, cap, entryId ?? null);
        } else {
          await advanceRoomQueue(roomId, action, cap, entryId ?? null);
        }
        await refreshSnapshotNow(roomId);
      } catch (err) {
        setMsg(err instanceof Error ? err.message : "Queue advance failed");
      } finally {
        setBusy(false);
      }
    },
    [roomId, transport, refreshSnapshotNow]
  );

  async function handleMove(entryId: string, direction: "up" | "down") {
    if (!roomId || !snapshot) return;
    const cap = getStoredHostCapability(roomId);
    if (!cap) return;
    const ordered = moveQueueEntry(snapshot.queue, entryId, direction);
    setBusy(true);
    try {
      if (transport === "lan") {
        await reorderLanRoomQueue(roomId, ordered, cap);
      } else {
        await reorderRoomQueue(roomId, ordered, cap);
      }
      await refreshSnapshotNow(roomId);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Reorder failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveEntry(entryId: string) {
    if (!roomId) return;
    const cap = getStoredHostCapability(roomId) ?? undefined;
    setBusy(true);
    try {
      if (transport === "lan") {
        await removeLanSongFromQueue(roomId, entryId, { capability: cap });
      } else {
        await removeSongFromQueue(roomId, entryId);
      }
      await refreshSnapshotNow(roomId);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  }

  const queuedEntries = useMemo(
    () => (snapshot?.queue ?? []).filter((q) => q.status === "queued"),
    [snapshot?.queue]
  );
  const playingEntry = useMemo(
    () => (snapshot?.queue ?? []).find((q) => q.status === "playing") ?? null,
    [snapshot?.queue]
  );

  const upNextItems: UpNextItem[] = useMemo(() => {
    return queuedEntries.map((entry) => {
      const song = songMap.get(entry.song_id);
      return {
        entryId: entry.id,
        hostSongId: song?.host_song_id ?? "",
        title: song?.title ?? "Track",
        artist: song?.artist ?? "",
        requester: participantMap.get(entry.requested_by) ?? "Guest",
        readiness: song?.readiness ?? "raw",
      };
    });
  }, [queuedEntries, songMap, participantMap]);

  // Publish live room stage state up to HostPage for TV Overlay & Auto-Prepare
  useEffect(() => {
    if (!onStageRoomChange) return;
    onStageRoomChange({
      active: Boolean(snapshot && snapshot.room.status !== "closed"),
      transport,
      roomCode: snapshot?.room.code ?? null,
      roomStatus: snapshot?.room.status ?? null,
      connState,
      joinUrl,
      qrDataUrl,
      onlineCount: onlineIds.length,
      queueCount: queuedEntries.length,
      upNext: upNextItems,
      playNext:
        queuedEntries.length > 0 && snapshot?.room.status === "open"
          ? () => void handleAdvance("next")
          : null,
    });
  }, [
    onStageRoomChange,
    snapshot,
    transport,
    connState,
    joinUrl,
    qrDataUrl,
    onlineIds.length,
    queuedEntries.length,
    upNextItems,
    handleAdvance,
  ]);

  async function handleCopyJoinUrl() {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setMsg(`Join link: ${joinUrl}`);
    }
  }

  return (
    <section className="rounded-xl border border-white/[0.08] bg-ink-850 p-3.5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="eyebrow">Party Room</h2>
          {snapshot ? (
            <SyncStatusBadge state={connState} transport={transport} />
          ) : (
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-snow/60">
              {transport === "lan" ? "LAN Wi-Fi" : "Cloud"}
            </span>
          )}
        </div>

        {!snapshot && isSupabaseConfigured && (
          <div
            role="group"
            aria-label="Room mode"
            className="flex rounded-full border border-white/10 bg-ink-900 p-0.5 font-mono text-[10px]"
          >
            {(["cloud", "lan"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setTransport(mode)}
                className={`rounded-full px-2 py-0.5 uppercase transition ${
                  transport === mode
                    ? "bg-snow text-ink-950 font-semibold"
                    : "text-snow/55 hover:text-snow"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        )}
      </div>

      {!snapshot ? (
        <div className="space-y-2.5">
          <p className="text-[11px] leading-relaxed text-snow/55">
            {transport === "lan"
              ? "Zero-cloud Wi-Fi party mode. Friends scan the QR code on the same network to queue songs and react live."
              : "Start a cloud-synced room so guests can scan a QR code and queue songs from their phones."}
          </p>
          <button
            type="button"
            disabled={busy || (transport === "lan" && !hostConnected)}
            onClick={() => void handleCreateRoom()}
            className="btn-light w-full py-2 text-xs"
          >
            {busy
              ? "Starting..."
              : transport === "lan"
                ? "Start LAN Party Room"
                : "Create Party Room"}
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            {qrDataUrl && (
              <div className="shrink-0 rounded-xl bg-snow p-1.5 shadow">
                <img
                  src={qrDataUrl}
                  alt={`Join room ${snapshot.room.code}`}
                  className="h-[74px] w-[74px]"
                />
              </div>
            )}
            <div className="min-w-0 flex-1 space-y-1 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-lg font-bold tracking-wider text-snow">
                  {snapshot.room.code}
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopyJoinUrl()}
                  className="rounded border border-white/15 px-1.5 py-0.5 font-mono text-[10px] text-snow/70 transition hover:border-sky hover:text-snow"
                >
                  {copied ? "Copied" : "Copy URL"}
                </button>
              </div>
              <p className="text-[11px] text-snow/55">
                {onlineIds.length} online · {snapshot.songs.length} songs published
              </p>
              {joinUrl && (
                <a
                  href={`/join/${encodeURIComponent(snapshot.room.code)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate font-mono text-[10px] text-sky/85 hover:text-sky hover:underline"
                  title={joinUrl}
                >
                  {joinUrl.replace(/^https?:\/\//, "")}
                </a>
              )}
              {reactions.length > 0 && (
                <p className="truncate text-[11px] text-pink">
                  {reactions
                    .slice(0, 3)
                    .map((r) => `${r.sender}: ${r.label}`)
                    .join(" · ")}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handlePublishLibrary()}
              className="btn-light flex-1 px-2.5 py-1.5 text-[10px]"
            >
              Sync Library
            </button>
            {snapshot.room.status === "open" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleStatusChange("host_disconnected")}
                className="btn-ghost px-2.5 py-1.5 text-[10px]"
              >
                Pause
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleStatusChange("open")}
                className="btn-primary px-2.5 py-1.5 text-[10px]"
              >
                Resume
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleStatusChange("closed")}
              className="btn-ghost px-2.5 py-1.5 text-[10px] text-pink hover:border-pink/50"
            >
              End
            </button>
          </div>

          <div className="border-t border-white/8 pt-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wider text-snow/55">
                Up Next ({queuedEntries.length})
              </span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={busy || queuedEntries.length === 0}
                  onClick={() => void handleAdvance("next")}
                  className="btn-primary px-2.5 py-0.5 text-[10px]"
                >
                  Play Next
                </button>
                <button
                  type="button"
                  disabled={busy || (!playingEntry && queuedEntries.length === 0)}
                  onClick={() => void handleAdvance("skip")}
                  className="btn-ghost px-2.5 py-0.5 text-[10px]"
                >
                  Skip
                </button>
              </div>
            </div>

            {queuedEntries.length === 0 ? (
              <p className="text-[11px] text-snow/40">
                Waiting for guests to pick songs...
              </p>
            ) : (
              <ul className="thin-scroll max-h-[140px] divide-y divide-white/6 overflow-y-auto pr-1">
                {queuedEntries.map((entry, idx) => {
                  const song = songMap.get(entry.song_id);
                  const requester = participantMap.get(entry.requested_by) ?? "Guest";
                  return (
                    <li key={entry.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                      <div className="min-w-0 flex-1 truncate">
                        <span className="mr-1.5 font-mono text-[10px] text-snow/40">
                          {idx + 1}.
                        </span>
                        <span className="font-medium text-snow">
                          {song ? displayTitle(song.title) : "Track"}
                        </span>
                        <span className="ml-1.5 text-[11px] text-snow/45">({requester})</span>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          disabled={busy || idx === 0}
                          onClick={() => void handleMove(entry.id, "up")}
                          aria-label="Move up"
                          className="rounded px-1 py-0.5 text-[10px] text-snow/60 hover:bg-white/10 hover:text-snow disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={busy || idx === queuedEntries.length - 1}
                          onClick={() => void handleMove(entry.id, "down")}
                          aria-label="Move down"
                          className="rounded px-1 py-0.5 text-[10px] text-snow/60 hover:bg-white/10 hover:text-snow disabled:opacity-30"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleAdvance("play_entry", entry.id)}
                          className="px-1 py-0.5 text-[10px] text-sky hover:underline"
                        >
                          Play
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleRemoveEntry(entry.id)}
                          className="px-1 py-0.5 text-[10px] text-pink hover:underline"
                        >
                          ✕
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
        <p role="status" className="text-[11px] text-sky/90">
          {msg}
        </p>
      )}
    </section>
  );
}
