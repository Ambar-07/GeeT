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
  type HostRemoteCommand,
  type MicRtcSignal,
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
  hostSongId?: string;
}

export interface HostActiveLyrics {
  songId: string;
  title: string;
  artist: string;
  lrcText: string;
  offsetMs: number;
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

export interface CurrentSingerInfo {
  entryId: string;
  hostSongId: string;
  title: string;
  singer: string;
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
  currentSinger: CurrentSingerInfo | null;
  upNext: UpNextItem[];
  playNext: (() => void) | null;
}

interface HostRoomPanelProps {
  hostConnected: boolean;
  onPlayHostSong: (hostSongId: string) => void;
  playbackSignal: PlaybackEventSignal | null;
  activeLyrics?: HostActiveLyrics | null;
  getPlaybackClock?: () => { status: "idle" | "playing" | "paused" | "ended"; positionMs: number };
  onStageRoomChange?: (info: HostStageRoomInfo) => void;
  onReactionBurst?: (burst: StageReactionBurst) => void;
  onRemoteCommand?: (command: HostRemoteCommand) => void;
  onMicAudio?: (pcm: ArrayBuffer) => void;
  onMicRtcSignal?: (signal: MicRtcSignal, sendReply: (reply: MicRtcSignal) => void) => void;
}

export function HostRoomPanel({
  hostConnected,
  onPlayHostSong,
  playbackSignal,
  activeLyrics,
  getPlaybackClock,
  onStageRoomChange,
  onReactionBurst,
  onRemoteCommand,
  onMicAudio,
  onMicRtcSignal,
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
  const [copiedRemote, setCopiedRemote] = useState(false);
  const [qrMode, setQrMode] = useState<"guest" | "remote">("guest");
  const [busy, setBusy] = useState(false);

  const lastPlayingEntryIdRef = useRef<string | null>(null);
  const onReactionBurstRef = useRef(onReactionBurst);
  onReactionBurstRef.current = onReactionBurst;
  const onRemoteCommandRef = useRef(onRemoteCommand);
  onRemoteCommandRef.current = onRemoteCommand;
  const onMicAudioRef = useRef(onMicAudio);
  onMicAudioRef.current = onMicAudio;
  const onMicRtcSignalRef = useRef(onMicRtcSignal);
  onMicRtcSignalRef.current = onMicRtcSignal;
  const activeLyricsRef = useRef(activeLyrics);
  activeLyricsRef.current = activeLyrics;
  const getPlaybackClockRef = useRef(getPlaybackClock);
  getPlaybackClockRef.current = getPlaybackClock;
  const sendLyricsSyncRef = useRef<((payload: import("../lib/rooms").LiveLyricsSyncPayload) => void) | null>(null);

  const pushLiveLyrics = useCallback(() => {
    const lyr = activeLyricsRef.current;
    const send = sendLyricsSyncRef.current;
    if (!lyr || !send) return;
    const clock = getPlaybackClockRef.current?.();
    send({
      hostSongId: lyr.songId,
      title: lyr.title,
      artist: lyr.artist,
      lrcText: lyr.lrcText,
      offsetMs: lyr.offsetMs,
      status: clock?.status ?? "playing",
      positionMs: clock?.positionMs ?? 0,
    });
  }, []);

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
  const remoteJoinUrl = useMemo(() => {
    if (!joinUrl || !roomId) return null;
    const cap = getStoredHostCapability(roomId);
    return cap ? `${joinUrl}#host=${encodeURIComponent(cap)}` : null;
  }, [joinUrl, roomId]);

  const activeQrUrl = qrMode === "remote" && remoteJoinUrl ? remoteJoinUrl : joinUrl;

  useEffect(() => {
    if (!activeQrUrl) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(activeQrUrl, { width: 180, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [activeQrUrl]);

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
            onLyricsRequest: () => pushLiveLyrics(),
            onHostControl: (cmd) => onRemoteCommandRef.current?.(cmd),
            onMicAudio: (pcm) => onMicAudioRef.current?.(pcm),
            onMicRtcSignal: (sig) =>
              onMicRtcSignalRef.current?.(sig, (reply) => sub.sendMicRtcSignal(reply)),
          });
          sendLyricsSyncRef.current = sub.sendLyricsSync;
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
            onLyricsRequest: () => pushLiveLyrics(),
            onHostControl: (cmd) => onRemoteCommandRef.current?.(cmd),
            onMicAudio: (pcm) => onMicAudioRef.current?.(pcm),
            onMicRtcSignal: (sig) =>
              onMicRtcSignalRef.current?.(sig, (reply) => sub.sendMicRtcSignal(reply)),
          });
          sendLyricsSyncRef.current = sub.sendLyricsSync;
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
      sendLyricsSyncRef.current = null;
      unsub?.();
    };
  }, [roomId, transport, fetchSnapshotForMode, handleIncomingReaction, pushLiveLyrics]);

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
        ? syncLanPlaybackCheckpoint(
            roomId,
            playbackSignal.type,
            playbackSignal.positionMs,
            cap,
            playbackSignal.hostSongId
          )
        : syncPlaybackCheckpoint(roomId, playbackSignal.type, playbackSignal.positionMs, cap);
    void syncPromise.catch(() => {});
    pushLiveLyrics();
  }, [playbackSignal, roomId, snapshot?.room.status, transport, fetchSnapshotForMode, pushLiveLyrics]);

  // Broadcast live lyrics immediately whenever the host loads, auto-fetches, edits, or calibrates lyrics
  useEffect(() => {
    if (!roomId || connState !== "subscribed" || !activeLyrics) return;
    pushLiveLyrics();
  }, [
    roomId,
    connState,
    activeLyrics?.songId,
    activeLyrics?.lrcText,
    activeLyrics?.offsetMs,
    pushLiveLyrics,
  ]);

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
        // Immediately sync any song already playing on the host stage so guests see Now Playing & Live Lyrics
        const curLyr = activeLyricsRef.current;
        const curClock = getPlaybackClockRef.current?.();
        if (curLyr?.songId && curClock && curClock.status !== "idle") {
          await syncLanPlaybackCheckpoint(
            created.roomId,
            curClock.status,
            curClock.positionMs,
            created.hostCapability,
            curLyr.songId
          ).catch(() => {});
        }
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

  const currentSinger: CurrentSingerInfo | null = useMemo(() => {
    if (!playingEntry) return null;
    const song = songMap.get(playingEntry.song_id);
    return {
      entryId: playingEntry.id,
      hostSongId: song?.host_song_id ?? "",
      title: song?.title ?? "Track",
      singer: participantMap.get(playingEntry.requested_by) ?? "Guest",
    };
  }, [playingEntry, songMap, participantMap]);

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
      currentSinger,
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
    currentSinger,
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

  async function handleCopyRemoteUrl() {
    if (!joinUrl || !roomId) return;
    const cap = getStoredHostCapability(roomId);
    if (!cap) return;
    // Put host capability in URL hash fragment so it stays out of server access logs
    const remoteUrl = `${joinUrl}#host=${encodeURIComponent(cap)}`;
    try {
      await navigator.clipboard.writeText(remoteUrl);
      setCopiedRemote(true);
      setTimeout(() => setCopiedRemote(false), 1800);
    } catch {
      setMsg("Could not copy remote link.");
    }
  }

  return (
    <section className="thin-scroll flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3.5 backdrop-blur-xl">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold tracking-tight text-white/90">Party Room</h2>
          {snapshot ? (
            <SyncStatusBadge state={connState} transport={transport} />
          ) : (
            <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-0.5 text-[10px] font-medium text-white/60">
              {transport === "lan" ? "LAN Wi-Fi" : "Cloud"}
            </span>
          )}
        </div>

        {!snapshot && isSupabaseConfigured && (
          <div
            role="group"
            aria-label="Room mode"
            className="flex rounded-full border border-white/10 bg-black/35 p-0.5 text-[10px]"
          >
            {(["cloud", "lan"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setTransport(mode)}
                className={`rounded-full px-2.5 py-0.5 font-medium capitalize transition ${
                  transport === mode
                    ? "bg-white text-ink-950"
                    : "text-white/55 hover:text-white"
                }`}
              >
                {mode === "lan" ? "LAN" : "Cloud"}
              </button>
            ))}
          </div>
        )}
      </div>

      {!snapshot ? (
        <div className="space-y-3 pt-1">
          <p className="text-xs leading-relaxed text-white/55">
            {transport === "lan"
              ? "Guests on your Wi-Fi scan a QR code to queue tracks and cheer live."
              : "Start a synced room so friends can scan a QR code and queue songs from their phones."}
          </p>
          <button
            type="button"
            disabled={busy || (transport === "lan" && !hostConnected)}
            onClick={() => void handleCreateRoom()}
            className="btn-primary w-full py-2.5 text-xs"
          >
            {busy
              ? "Starting…"
              : transport === "lan"
                ? "Start LAN Party Room"
                : "Create Party Room"}
          </button>
        </div>
      ) : (
        <>
          {/* Compact Room Code & Scannable Guest/Remote QR Card */}
          <div className="space-y-2 rounded-2xl border border-white/[0.08] bg-black/30 p-2.5">
            {remoteJoinUrl && (
              <div className="flex items-center justify-between gap-2">
                <div role="group" aria-label="QR code mode" className="flex rounded-full border border-white/10 bg-black/40 p-0.5 text-[10px]">
                  <button
                    type="button"
                    onClick={() => setQrMode("guest")}
                    className={`rounded-full px-2.5 py-0.5 font-medium transition ${
                      qrMode === "guest" ? "bg-white text-ink-950" : "text-white/55 hover:text-white"
                    }`}
                  >
                    Guest QR
                  </button>
                  <button
                    type="button"
                    onClick={() => setQrMode("remote")}
                    className={`rounded-full px-2.5 py-0.5 font-medium transition ${
                      qrMode === "remote" ? "bg-[#fa2d48] text-white" : "text-white/55 hover:text-white"
                    }`}
                  >
                    Host Remote QR
                  </button>
                </div>
              </div>
            )}
            <div className="flex items-center gap-3">
              {qrDataUrl && (
                <div className="shrink-0 rounded-xl bg-white p-1.5 shadow-sm">
                  <img
                    src={qrDataUrl}
                    alt={qrMode === "remote" ? `Host remote QR for room ${snapshot.room.code}` : `Join room ${snapshot.room.code}`}
                    className="h-[68px] w-[68px]"
                  />
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="font-mono text-base font-bold tracking-[0.12em] text-white">
                    {snapshot.room.code}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void handleCopyJoinUrl()}
                      className="rounded-full bg-white/[0.1] px-2.5 py-1 text-[10px] font-medium text-white/85 transition hover:bg-white/[0.18] hover:text-white"
                    >
                      {copied ? "Copied ✓" : "Copy"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCopyRemoteUrl()}
                      title="Copy private Host Remote link for your phone"
                      className="rounded-full bg-[#fa2d48]/18 px-2.5 py-1 text-[10px] font-medium text-[#ff8da6] transition hover:bg-[#fa2d48]/30 hover:text-white"
                    >
                      {copiedRemote ? "Copied ✓" : "Remote"}
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-white/55">
                  {onlineIds.length} online · {snapshot.songs.length} songs
                </p>
                {joinUrl && (
                  <a
                    href={`/join/${encodeURIComponent(snapshot.room.code)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate font-mono text-[10px] text-white/60 transition hover:text-white hover:underline"
                    title={joinUrl}
                  >
                    {joinUrl.replace(/^https?:\/\//, "")}
                  </a>
                )}
                {reactions.length > 0 && (
                  <p className="truncate text-[11px] text-[#ff7a98]">
                    {reactions
                      .slice(0, 2)
                      .map((r) => `${r.sender}: ${r.label}`)
                      .join(" · ")}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Balanced Room Actions */}
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handlePublishLibrary()}
              className="inline-flex h-8 items-center justify-center rounded-full bg-white/[0.1] px-2.5 text-[11px] font-medium text-white/90 transition hover:bg-white/[0.16] disabled:opacity-40"
            >
              Sync
            </button>
            {snapshot.room.status === "open" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleStatusChange("host_disconnected")}
                className="inline-flex h-8 items-center justify-center rounded-full bg-white/[0.06] px-2.5 text-[11px] font-medium text-white/75 transition hover:bg-white/[0.12] hover:text-white disabled:opacity-40"
              >
                Pause
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleStatusChange("open")}
                className="inline-flex h-8 items-center justify-center rounded-full bg-[#fa2d48] px-2.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
              >
                Resume
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleStatusChange("closed")}
              className="inline-flex h-8 items-center justify-center rounded-full bg-white/[0.06] px-2.5 text-[11px] font-medium text-[#ff7a98] transition hover:bg-[#fa2d48]/18 disabled:opacity-40"
            >
              End
            </button>
          </div>

          {/* Queue Section */}
          <div className="flex min-h-0 flex-1 flex-col space-y-2.5 border-t border-white/[0.07] pt-3">
            <div className="flex shrink-0 items-center justify-between gap-2">
              <span className="text-xs font-semibold text-white/80">
                Up Next <span className="font-normal text-white/45">({queuedEntries.length})</span>
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy || queuedEntries.length === 0}
                  onClick={() => void handleAdvance("next")}
                  className="inline-flex h-7 items-center rounded-full bg-white px-3 text-[11px] font-semibold text-ink-950 transition hover:bg-white/90 disabled:opacity-35"
                >
                  Play Next
                </button>
                <button
                  type="button"
                  disabled={busy || (!playingEntry && queuedEntries.length === 0)}
                  onClick={() => void handleAdvance("skip")}
                  className="inline-flex h-7 items-center rounded-full bg-white/[0.08] px-2.5 text-[11px] font-medium text-white/75 transition hover:bg-white/[0.15] hover:text-white disabled:opacity-35"
                >
                  Skip
                </button>
              </div>
            </div>

            {queuedEntries.length === 0 ? (
              <p className="py-6 text-center text-xs text-white/40">
                Waiting for guests to queue songs…
              </p>
            ) : (
              <ul className="thin-scroll min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
                {queuedEntries.map((entry, idx) => {
                  const song = songMap.get(entry.song_id);
                  const requester = participantMap.get(entry.requested_by) ?? "Guest";
                  return (
                    <li
                      key={entry.id}
                      className="group flex items-center justify-between gap-2 rounded-xl px-2 py-1.5 transition hover:bg-white/[0.05]"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-white/95">
                          <span className="mr-1.5 font-mono text-[10px] text-white/35">
                            {idx + 1}
                          </span>
                          {song ? displayTitle(song.title) : "Track"}
                        </p>
                        <p className="truncate pl-4 text-[11px] text-white/45">{requester}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          disabled={busy || idx === 0}
                          onClick={() => void handleMove(entry.id, "up")}
                          aria-label="Move up"
                          title="Move up"
                          className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] text-white/50 transition hover:bg-white/10 hover:text-white disabled:opacity-25"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={busy || idx === queuedEntries.length - 1}
                          onClick={() => void handleMove(entry.id, "down")}
                          aria-label="Move down"
                          title="Move down"
                          className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] text-white/50 transition hover:bg-white/10 hover:text-white disabled:opacity-25"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleAdvance("play_entry", entry.id)}
                          aria-label="Play now"
                          title="Play now"
                          className="flex h-6 w-6 items-center justify-center rounded-full text-white/75 transition hover:bg-white hover:text-ink-950 disabled:opacity-35"
                        >
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <polygon points="6,4 20,12 6,20" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleRemoveEntry(entry.id)}
                          aria-label="Remove from queue"
                          title="Remove"
                          className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] text-white/45 transition hover:bg-[#fa2d48]/20 hover:text-[#ff7a98] disabled:opacity-35"
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
