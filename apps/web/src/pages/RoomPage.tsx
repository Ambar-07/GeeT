import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Logo } from "../components/Brand";
import { Cover, StageBackdrop, displayTitle } from "../components/Cover";
import { GuestLyricsCard } from "../components/GuestLyricsCard";
import {
  SyncStatusBadge,
  type RoomTransportMode,
  type SyncConnectionState,
} from "../components/SyncStatusBadge";
import {
  addLanSongToQueue,
  fetchLanRoomIdByCode,
  fetchLanRoomLyrics,
  fetchLanRoomSnapshot,
  getStoredLanGuestUserId,
  joinLanRoomAsParticipant,
  removeLanSongFromQueue,
  subscribeToLanRoom,
} from "../lib/lanRooms";
import {
  addSongToQueue,
  ensureAuthSession,
  fetchRoomIdByCode,
  fetchRoomSnapshot,
  joinRoomAsParticipant,
  reconcileSnapshot,
  removeSongFromQueue,
  subscribeToRoom,
  type HostRemoteCommand,
  type LiveLyricsSyncPayload,
  type MicRtcSignal,
  type RoomSnapshot,
} from "../lib/rooms";
import { PhoneMicSender, type PhoneMicTransport } from "../lib/liveMic";
import { isSupabaseConfigured } from "../lib/supabase";

const NAME_KEY = "geet_participant_name";
const REMOTE_CAP_PREFIX = "geet_remote_cap_";

function readRemoteCapability(code: string): string | null {
  if (!code) return null;
  // Extract #host=<cap> from hash fragment once and immediately strip it from the URL bar
  try {
    const hash = window.location.hash;
    if (hash.startsWith("#host=")) {
      const cap = decodeURIComponent(hash.slice(6)).trim();
      if (cap) {
        sessionStorage.setItem(`${REMOTE_CAP_PREFIX}${code}`, cap);
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        return cap;
      }
    }
    return sessionStorage.getItem(`${REMOTE_CAP_PREFIX}${code}`);
  } catch {
    return null;
  }
}
const REACTION_BUTTONS = [
  { label: "Clap", icon: "👏" },
  { label: "Encore", icon: "🔥" },
  { label: "Cheer", icon: "🎉" },
  { label: "Sing", icon: "🎤" },
] as const;

export function RoomPage() {
  const { code = "" } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const normalizedCode = code.trim().toUpperCase();

  const [transport, setTransport] = useState<RoomTransportMode>(
    isSupabaseConfigured ? "cloud" : "lan"
  );
  const [displayName, setDisplayName] = useState(() => sessionStorage.getItem(NAME_KEY) ?? "");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const [connState, setConnState] = useState<SyncConnectionState>("idle");
  const [recentReactions, setRecentReactions] = useState<Array<{ id: string; sender: string; label: string }>>([]);
  const [reactionCooldown, setReactionCooldown] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [queueBusyId, setQueueBusyId] = useState<string | null>(null);
  const [justQueuedId, setJustQueuedId] = useState<string | null>(null);
  const [guestLyrics, setGuestLyrics] = useState<{
    hostSongId: string;
    lrcText: string;
    offsetMs: number;
  } | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsFullscreen, setLyricsFullscreen] = useState(false);
  const [remoteCap, setRemoteCap] = useState<string | null>(() =>
    readRemoteCapability(normalizedCode)
  );
  const [remoteVocalMix, setRemoteVocalMix] = useState(0.15);
  const [phoneMicOn, setPhoneMicOn] = useState(false);
  const [phoneMicLevel, setPhoneMicLevel] = useState(0);
  const [phoneMicMode, setPhoneMicMode] = useState<PhoneMicTransport>("idle");
  const [phoneMicError, setPhoneMicError] = useState<string | null>(null);
  const [playbackClock, setPlaybackClock] = useState<{
    status: "idle" | "playing" | "paused" | "ended";
    positionMs: number;
    localMs: number;
  }>({ status: "idle", positionMs: 0, localMs: performance.now() });

  const sendReactionRef = useRef<((label: string) => void) | null>(null);
  const requestLyricsSyncRef = useRef<(() => void) | null>(null);
  const sendHostControlRef = useRef<((cmd: HostRemoteCommand, cap: string) => void) | null>(null);
  const sendMicAudioRef = useRef<((pcm: ArrayBuffer) => void) | null>(null);
  const sendMicRtcSignalRef = useRef<((signal: MicRtcSignal) => void) | null>(null);
  const phoneMicRef = useRef<PhoneMicSender | null>(null);
  const prevTurnStateRef = useRef<"none" | "up_next" | "on_stage">("none");

  useEffect(() => {
    const cap = readRemoteCapability(normalizedCode);
    if (cap) setRemoteCap(cap);
  }, [normalizedCode]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Attempt automatic session recovery on reload (Cloud or LAN)
  useEffect(() => {
    if (!normalizedCode) return;
    let active = true;
    (async () => {
      try {
        if (isSupabaseConfigured) {
          const { userId: uid } = await ensureAuthSession();
          const existingId = await fetchRoomIdByCode(normalizedCode);
          if (active && existingId) {
            setTransport("cloud");
            setUserId(uid);
            setRoomId(existingId);
            return;
          }
        }
      } catch {
        // Fall through to LAN check
      }

      try {
        const lanId = await fetchLanRoomIdByCode(normalizedCode);
        if (active && lanId) {
          setTransport("lan");
          const storedUid = getStoredLanGuestUserId(lanId);
          if (storedUid) {
            setUserId(storedUid);
            setRoomId(lanId);
          }
        }
      } catch {
        // Wait for explicit join submission
      }
    })();
    return () => {
      active = false;
    };
  }, [normalizedCode]);

  useEffect(() => {
    if (!roomId || !userId) return;
    if (transport === "cloud" && !isSupabaseConfigured) return;
    let active = true;

    const callbacks = {
      onSnapshot: (snap: RoomSnapshot) => {
        if (active) setSnapshot((prev) => reconcileSnapshot(prev, snap));
      },
      onPresenceCount: (ids: string[]) => {
        if (active) setOnlineIds(ids);
      },
      onReaction: (r: { sender: string; label: string }) => {
        if (!active) return;
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        setRecentReactions((prev) => [{ id, ...r }, ...prev].slice(0, 4));
      },
      onConnectionState: (state: SyncConnectionState) => {
        if (active) setConnState(state);
      },
      onLyricsSync: (payload: LiveLyricsSyncPayload) => {
        if (!active) return;
        setGuestLyrics({
          hostSongId: payload.hostSongId,
          lrcText: payload.lrcText,
          offsetMs: payload.offsetMs,
        });
        setLyricsLoading(false);
        if (payload.status !== undefined && payload.positionMs !== undefined) {
          setPlaybackClock({
            status: payload.status,
            positionMs: payload.positionMs,
            localMs: performance.now(),
          });
        }
      },
      onMicRtcSignal: (signal: MicRtcSignal) => {
        if (!active) return;
        void phoneMicRef.current?.handleRtcSignal(signal);
      },
    };

    const sub =
      transport === "lan"
        ? subscribeToLanRoom(roomId, userId, displayName || "Guest", callbacks)
        : subscribeToRoom(roomId, userId, displayName || "Guest", callbacks);

    sendReactionRef.current = sub.sendReaction;
    requestLyricsSyncRef.current = sub.requestLyricsSync;
    sendHostControlRef.current = sub.sendHostControl;
    sendMicAudioRef.current = sub.sendMicAudio;
    sendMicRtcSignalRef.current = sub.sendMicRtcSignal;

    const initialFetch =
      transport === "lan" ? fetchLanRoomSnapshot(roomId) : fetchRoomSnapshot(roomId);
    initialFetch
      .then((snap) => {
        if (active) setSnapshot((prev) => reconcileSnapshot(prev, snap, true));
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load room");
      });

    return () => {
      active = false;
      sendReactionRef.current = null;
      requestLyricsSyncRef.current = null;
      sendHostControlRef.current = null;
      sendMicAudioRef.current = null;
      sendMicRtcSignalRef.current = null;
      phoneMicRef.current?.stop();
      sub.unsubscribe();
    };
  }, [roomId, userId, displayName, transport]);

  const filteredSongs = useMemo(() => {
    const list = snapshot?.songs ?? [];
    if (!debouncedSearch) return list;
    return list.filter(
      (s) =>
        s.title.toLowerCase().includes(debouncedSearch) ||
        s.artist.toLowerCase().includes(debouncedSearch)
    );
  }, [snapshot?.songs, debouncedSearch]);

  const songMap = useMemo(
    () => new Map((snapshot?.songs ?? []).map((s) => [s.id, s])),
    [snapshot?.songs]
  );
  const participantMap = useMemo(
    () => new Map((snapshot?.participants ?? []).map((p) => [p.user_id, p.display_name])),
    [snapshot?.participants]
  );

  const queuedEntries = (snapshot?.queue ?? []).filter((q) => q.status === "queued");
  const queuedSongIds = useMemo(
    () => new Set(queuedEntries.map((q) => q.song_id)),
    [queuedEntries]
  );
  const playingEntry = (snapshot?.queue ?? []).find((q) => q.status === "playing") ?? null;
  const playingSong = snapshot?.playback?.song_id
    ? songMap.get(snapshot.playback.song_id) ?? null
    : playingEntry
      ? songMap.get(playingEntry.song_id) ?? null
      : null;

  const isMyTurnNow = Boolean(playingEntry && playingEntry.requested_by === userId);
  const myNextQueueIdx = queuedEntries.findIndex((q) => q.requested_by === userId);
  const myNextEntry = myNextQueueIdx >= 0 ? queuedEntries[myNextQueueIdx] : null;
  const myNextSong = myNextEntry ? songMap.get(myNextEntry.song_id) ?? null : null;

  // Keep local interpolated clock aligned with room snapshot playback updates
  useEffect(() => {
    const pb = snapshot?.playback;
    if (!pb) return;
    let driftMs = 0;
    if (pb.status === "playing" && pb.updated_at) {
      const updatedTs = Date.parse(pb.updated_at);
      if (Number.isFinite(updatedTs)) {
        driftMs = Math.min(12_000, Math.max(0, Date.now() - updatedTs));
      }
    }
    setPlaybackClock({
      status: pb.status,
      positionMs: pb.position_ms + driftMs,
      localMs: performance.now(),
    });
  }, [
    snapshot?.playback?.status,
    snapshot?.playback?.position_ms,
    snapshot?.playback?.updated_at,
    snapshot?.playback?.revision,
  ]);

  // Load active song's lyrics over LAN HTTP or request broadcast in Cloud mode
  useEffect(() => {
    const hostSongId = playingSong?.host_song_id;
    if (!roomId || !hostSongId) {
      setGuestLyrics(null);
      setLyricsLoading(false);
      return;
    }

    if (transport === "lan") {
      let active = true;
      setLyricsLoading(true);
      fetchLanRoomLyrics(roomId, hostSongId)
        .then((rec) => {
          if (!active) return;
          setGuestLyrics({
            hostSongId,
            lrcText: rec.lrc_text,
            offsetMs: rec.offset_ms,
          });
        })
        .catch(() => {
          if (active) setGuestLyrics(null);
        })
        .finally(() => {
          if (active) setLyricsLoading(false);
        });
      return () => {
        active = false;
      };
    }

    // Cloud mode: ask host to broadcast active lyrics on join / track change
    if (connState === "subscribed" && guestLyrics?.hostSongId !== hostSongId) {
      setLyricsLoading(true);
      requestLyricsSyncRef.current?.();
      const t = setTimeout(() => setLyricsLoading(false), 2500);
      return () => clearTimeout(t);
    }
  }, [roomId, playingSong?.host_song_id, transport, connState]);

  // Subtle mobile haptic buzz when transitioning into "You're Up Next!" or "You're On Stage!"
  useEffect(() => {
    const nextState: "none" | "up_next" | "on_stage" = isMyTurnNow
      ? "on_stage"
      : myNextQueueIdx === 0
        ? "up_next"
        : "none";
    if (nextState !== "none" && nextState !== prevTurnStateRef.current) {
      try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          navigator.vibrate(nextState === "on_stage" ? [160, 70, 160] : [110, 60, 110]);
        }
      } catch {
        // Ignore on unsupported browsers
      }
    }
    prevTurnStateRef.current = nextState;
  }, [isMyTurnNow, myNextQueueIdx]);

  async function handleManualSync() {
    if (!roomId) return;
    try {
      const fresh =
        transport === "lan"
          ? await fetchLanRoomSnapshot(roomId)
          : await fetchRoomSnapshot(roomId);
      setSnapshot((prev) => reconcileSnapshot(prev, fresh, true));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    }
  }

  async function handleQueueSong(songId: string) {
    if (!roomId || !userId || queueBusyId) return;
    setQueueBusyId(songId);
    setError(null);
    try {
      if (transport === "lan") {
        await addLanSongToQueue(roomId, songId, userId);
      } else {
        await addSongToQueue(roomId, songId);
      }
      setJustQueuedId(songId);
      setTimeout(() => setJustQueuedId((cur) => (cur === songId ? null : cur)), 1800);
      await handleManualSync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to queue song");
    } finally {
      setQueueBusyId(null);
    }
  }

  async function handleRemoveOwnEntry(entryId: string) {
    if (!roomId || !userId || queueBusyId) return;
    setQueueBusyId(entryId);
    setError(null);
    try {
      if (transport === "lan") {
        await removeLanSongFromQueue(roomId, entryId, { userId });
      } else {
        await removeSongFromQueue(roomId, entryId);
      }
      await handleManualSync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove song");
    } finally {
      setQueueBusyId(null);
    }
  }

  function handleSendReaction(label: string) {
    if (reactionCooldown) return;
    sendReactionRef.current?.(label);
    setReactionCooldown(true);
    setTimeout(() => setReactionCooldown(false), 1800);
  }

  function handleRemoteAction(command: HostRemoteCommand) {
    if (!remoteCap) return;
    sendHostControlRef.current?.(command, remoteCap);
  }

  useEffect(() => {
    if (!phoneMicOn) {
      setPhoneMicLevel(0);
      setPhoneMicMode("idle");
      return;
    }
    const timer = window.setInterval(() => {
      setPhoneMicLevel(phoneMicRef.current?.getLevel() ?? 0);
      setPhoneMicMode(phoneMicRef.current?.getMode() ?? "idle");
    }, 65);
    return () => window.clearInterval(timer);
  }, [phoneMicOn]);

  useEffect(() => {
    return () => {
      phoneMicRef.current?.stop();
    };
  }, []);

  async function togglePhoneMic() {
    setPhoneMicError(null);
    if (phoneMicOn) {
      phoneMicRef.current?.stop();
      setPhoneMicOn(false);
      setPhoneMicMode("idle");
      return;
    }
    try {
      if (!phoneMicRef.current) phoneMicRef.current = new PhoneMicSender();
      await phoneMicRef.current.start(
        (pcm) => sendMicAudioRef.current?.(pcm),
        (sig) => sendMicRtcSignalRef.current?.(sig)
      );
      setPhoneMicOn(true);
      setPhoneMicMode(phoneMicRef.current.getMode());
    } catch (err) {
      phoneMicRef.current?.stop();
      setPhoneMicOn(false);
      setPhoneMicMode("idle");
      setPhoneMicError(err instanceof Error ? err.message : "Could not access phone microphone.");
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!displayName.trim() || !normalizedCode) return;
    setJoining(true);
    setError(null);
    try {
      let joinedRoomId: string | null = null;
      let joinedUserId: string | null = null;
      let chosenTransport: RoomTransportMode = isSupabaseConfigured ? "cloud" : "lan";

      if (isSupabaseConfigured) {
        try {
          const { userId: uid } = await ensureAuthSession();
          const cloudRoomId = await joinRoomAsParticipant(normalizedCode, displayName.trim());
          joinedRoomId = cloudRoomId;
          joinedUserId = uid;
          chosenTransport = "cloud";
        } catch {
          // Try LAN Party fallback if code exists on local Wi-Fi host
          const lanRes = await joinLanRoomAsParticipant(normalizedCode, displayName.trim());
          joinedRoomId = lanRes.roomId;
          joinedUserId = lanRes.userId;
          chosenTransport = "lan";
        }
      } else {
        const lanRes = await joinLanRoomAsParticipant(normalizedCode, displayName.trim());
        joinedRoomId = lanRes.roomId;
        joinedUserId = lanRes.userId;
        chosenTransport = "lan";
      }

      sessionStorage.setItem(NAME_KEY, displayName.trim());
      setTransport(chosenTransport);
      setUserId(joinedUserId);
      setRoomId(joinedRoomId);
      navigate(`/room/${encodeURIComponent(normalizedCode)}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to join room");
    } finally {
      setJoining(false);
    }
  }

  if (!roomId) {
    return (
      <div className="home-shell relative min-h-dvh overflow-hidden text-snow">
        <div className="pointer-events-none fixed inset-0 z-0" aria-hidden="true">
          <StageBackdrop title={normalizedCode || null} playing={true} />
          <div className="absolute inset-0 bg-[#08060e]/75" />
        </div>
        <main className="relative z-10 mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
          <div className="space-y-6 rounded-3xl border border-white/14 bg-[#0d0a14]/78 p-7 shadow-[0_24px_70px_rgba(0,0,0,0.6)] backdrop-blur-2xl">
            <div className="flex items-center justify-between gap-2">
              <Logo size={26} suffix="Party" />
              <span className="rounded-full border border-white/12 bg-white/[0.06] px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-white/70">
                {isSupabaseConfigured ? "Cloud / LAN" : "LAN Wi-Fi"}
              </span>
            </div>
            <div>
              <p className="eyebrow">Room Code</p>
              <h1 className="mt-1 font-mono text-3xl font-bold tracking-[0.14em] text-white">
                {normalizedCode}
              </h1>
            </div>
            <form onSubmit={handleJoin} className="space-y-3">
              <p className="text-sm leading-relaxed text-white/65">
                Pick a display name to queue tracks and sing along on your phone.
              </p>
              <input
                aria-label="Your display name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your display name"
                maxLength={40}
                className="field bg-white/[0.07]"
              />
              <button
                type="submit"
                disabled={joining || !displayName.trim()}
                className="btn-primary w-full py-3 text-sm"
              >
                {joining ? "Joining…" : "Enter Room"}
              </button>
            </form>
            {error && (
              <p role="alert" className="text-xs text-pink">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between border-t border-white/8 pt-4 text-xs">
              <Link to="/" className="text-white/55 transition hover:text-white">
                ← Home
              </Link>
              <Link to="/host" className="text-white/75 transition hover:text-white">
                Host Console ↗
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const playingCoverSrc =
    playingSong && transport === "lan" && roomId
      ? `/lan-api/rooms/${encodeURIComponent(roomId)}/cover/${encodeURIComponent(playingSong.host_song_id)}`
      : undefined;

  return (
    <div className="home-shell relative min-h-dvh overflow-x-hidden text-snow">
      {/* Live subtle album-art ambient glow matching the TV stage */}
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden="true">
        <StageBackdrop
          coverSrc={playingCoverSrc}
          hasCover={Boolean(playingCoverSrc)}
          title={playingSong?.title ?? normalizedCode}
          playing={playbackClock.status === "playing"}
        />
        <div className="absolute inset-0 bg-[#09070f]/78" />
      </div>

      <main className="relative z-10 mx-auto max-w-2xl space-y-4 px-4 pb-10 pt-4 sm:px-5">
        {/* Sticky floating frosted-glass pill header */}
        <header className="sticky top-3 z-30 flex items-center justify-between gap-2 rounded-full border border-white/14 bg-[#0d0a15]/78 py-1.5 pl-3.5 pr-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
          <div className="flex min-w-0 items-center gap-2.5">
            <Logo size={22} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="font-mono text-xs font-semibold tracking-wider text-white">
                  {normalizedCode}
                </p>
                <button
                  type="button"
                  onClick={() => void handleManualSync()}
                  title="Tap to refresh room state"
                  className="shrink-0"
                >
                  <SyncStatusBadge state={connState} transport={transport} />
                </button>
              </div>
              <h1 className="truncate text-[10px] font-medium text-white/55">
                {snapshot ? `${onlineIds.length} online · ${queuedEntries.length} queued` : "Loading…"}
              </h1>
            </div>
          </div>
          <Link
            to="/"
            className="inline-flex h-8 shrink-0 items-center rounded-full bg-white/[0.1] px-3.5 text-xs font-medium text-white/85 ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.16] hover:text-white"
          >
            Leave
          </Link>
        </header>

        {snapshot?.room.status === "host_disconnected" && (
          <div role="status" className="surface border-pink/40 bg-black/45 p-3.5 text-xs text-pink">
            Host is temporarily paused. Waiting for host to resume.
          </div>
        )}

        {snapshot?.room.status === "closed" && (
          <div role="alert" className="surface border-pink/60 bg-black/45 p-3.5 text-xs text-pink">
            This room has ended.
          </div>
        )}

        {isMyTurnNow && playingSong && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#fa2d48]/55 bg-[#fa2d48]/16 px-4 py-3 text-xs text-white shadow-[0_8px_32px_rgba(250,45,72,0.22)] backdrop-blur-xl"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#ff7a98]">
                  You&apos;re On Stage Now!
                </span>
              </div>
              <p className="mt-0.5 truncate font-semibold text-white">
                {displayTitle(playingSong.title)}
                {playingSong.artist ? ` — ${playingSong.artist}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setLyricsFullscreen(true)}
              className="btn-primary shrink-0 px-4 py-1.5 text-[11px]"
            >
              Sing-Along Lyrics
            </button>
          </div>
        )}

        {myNextSong && (
          <div
            role="status"
            className={`rounded-2xl border px-4 py-3 text-xs text-white backdrop-blur-xl ${
              myNextQueueIdx === 0
                ? "border-white/25 bg-white/[0.1] shadow-[0_8px_28px_rgba(0,0,0,0.3)]"
                : "border-white/12 bg-white/[0.05]"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#ff7a98]">
                {myNextQueueIdx === 0
                  ? "You're Up Next!"
                  : `Your Turn: #${myNextQueueIdx + 1} in queue`}
              </span>
              {myNextQueueIdx === 0 && (
                <span className="rounded-full bg-[#fa2d48]/20 px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[#ff8da6]">
                  Get Ready
                </span>
              )}
            </div>
            <p className="mt-0.5 font-semibold text-white">
              {displayTitle(myNextSong.title)}
              {myNextSong.artist ? ` — ${myNextSong.artist}` : ""}
            </p>
          </div>
        )}

        {playingSong && (
          <section className="rounded-3xl border border-white/12 bg-black/38 p-4 shadow-[0_16px_48px_rgba(0,0,0,0.4)] backdrop-blur-2xl sm:p-5">
            <div className="flex items-center gap-3.5">
              <Cover
                title={playingSong.title}
                coverSrc={playingCoverSrc}
                size={52}
                className="rounded-xl shadow-md ring-1 ring-white/15"
              />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-white/60">
                  {snapshot?.playback?.status === "paused" ? "Paused" : "Now Playing"}
                  {playingEntry
                    ? ` · ${participantMap.get(playingEntry.requested_by) ?? "Guest"}`
                    : ""}
                </p>
                <p className="mt-0.5 truncate text-base font-bold text-white">
                  {displayTitle(playingSong.title)}
                  {playingSong.artist ? ` — ${playingSong.artist}` : ""}
                </p>
              </div>
            </div>

            <GuestLyricsCard
              songTitle={playingSong.title}
              songArtist={playingSong.artist}
              durationMs={playingSong.duration_ms}
              coverSrc={playingCoverSrc}
              lrcText={
                guestLyrics?.hostSongId === playingSong.host_song_id ? guestLyrics.lrcText : ""
              }
              offsetMs={
                guestLyrics?.hostSongId === playingSong.host_song_id ? guestLyrics.offsetMs : 0
              }
              playbackStatus={playbackClock.status}
              anchorPositionMs={playbackClock.positionMs}
              anchorLocalMs={playbackClock.localMs}
              loading={lyricsLoading}
              fullscreen={lyricsFullscreen}
              onToggleFullscreen={() => setLyricsFullscreen((v) => !v)}
              onSendReaction={handleSendReaction}
              reactionCooldown={reactionCooldown}
            />
          </section>
        )}

        {/* Private Host Remote Control Deck (unlocked only via #host=<capability> link) */}
        {remoteCap && (
          <section
            aria-label="Host remote controls"
            className="space-y-3 rounded-2xl border border-[#fa2d48]/30 bg-[#0d0a15]/75 p-4 shadow-[0_12px_36px_rgba(0,0,0,0.45)] backdrop-blur-xl"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#ff7a98]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#fa2d48]" />
                Host Remote
              </span>
              <span className="text-[10px] text-white/45">Controls TV Stage</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => handleRemoteAction({ action: "toggle_play" })}
                className="btn-light py-2 text-xs"
              >
                {playbackClock.status === "playing" ? "Pause" : "Play"}
              </button>
              <button
                type="button"
                onClick={() => handleRemoteAction({ action: "next" })}
                className="btn-ghost py-2 text-xs"
              >
                Next ⏭
              </button>
              <button
                type="button"
                onClick={() => handleRemoteAction({ action: "toggle_tv" })}
                className="btn-ghost py-2 text-xs"
              >
                TV Stage
              </button>
            </div>
            <div className="flex items-center gap-3 pt-0.5">
              <label htmlFor="remote-vocal-mix" className="shrink-0 text-[11px] font-medium text-white/65">
                Vocal Guide
              </label>
              <input
                id="remote-vocal-mix"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={remoteVocalMix}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setRemoteVocalMix(val);
                  handleRemoteAction({ action: "vocal_mix", value: val });
                }}
                className="range h-1 flex-1"
              />
              <span className="w-8 text-right font-mono text-[10px] text-white/60">
                {Math.round(remoteVocalMix * 100)}%
              </span>
            </div>
          </section>
        )}

        {/* Wireless Phone Microphone (streams voice live to Host PC speakers over LAN Wi-Fi) */}
        {transport === "lan" && (
          <section className="space-y-2.5 rounded-2xl border border-white/12 bg-black/38 p-3.5 backdrop-blur-xl sm:px-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-white">Wireless Phone Mic</p>
                <p className="mt-0.5 text-[11px] text-white/50">
                  {phoneMicOn
                    ? connState !== "subscribed"
                      ? "Mic open — waiting for room WebSocket…"
                      : phoneMicMode === "webrtc"
                        ? "Direct LAN audio (low latency)"
                        : phoneMicMode === "connecting"
                          ? "Connecting direct LAN audio…"
                          : "Streaming over Wi-Fi (low-latency fallback)"
                    : "Sing into your phone over Wi-Fi"}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-label="Wireless phone microphone"
                aria-checked={phoneMicOn}
                onClick={() => void togglePhoneMic()}
                className={`shrink-0 rounded-full px-4 py-2 text-xs font-semibold transition ${
                  phoneMicOn
                    ? "bg-white text-ink-950"
                    : "btn-primary px-4 py-2 text-xs"
                }`}
              >
                {phoneMicOn ? "Mic On" : "Start Mic"}
              </button>
            </div>
            {phoneMicOn && (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/12" aria-hidden="true">
                <div
                  className="h-full rounded-full bg-white/85 transition-[width] duration-75"
                  style={{ width: `${Math.round(phoneMicLevel * 100)}%` }}
                />
              </div>
            )}
            {phoneMicError && (
              <p role="alert" className="text-[11px] leading-relaxed text-[#ff7a98]">
                {phoneMicError}
              </p>
            )}
          </section>
        )}

        {/* Compact single-row Cheer Bar */}
        <section className="rounded-2xl border border-white/10 bg-black/35 p-3.5 backdrop-blur-xl sm:px-4">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <span className="eyebrow">Cheer the Singer</span>
            {recentReactions.length > 0 && (
              <span className="truncate font-mono text-[10px] text-[#ff7a98]">
                {recentReactions[0].sender}: {recentReactions[0].label}
              </span>
            )}
          </div>
          <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
            {REACTION_BUTTONS.map(({ label, icon }) => (
              <button
                key={label}
                type="button"
                disabled={reactionCooldown}
                onClick={() => handleSendReaction(label)}
                className="btn-ghost min-h-[38px] px-2 py-1.5 text-[11px] sm:text-xs"
              >
                <span aria-hidden="true">{icon}</span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </section>

        {queuedEntries.length > 0 && (
          <section className="space-y-3 rounded-2xl border border-white/10 bg-black/35 p-4 backdrop-blur-xl sm:p-5">
            <h2 className="text-sm font-semibold text-white">Up Next ({queuedEntries.length})</h2>
            <ul className="divide-y divide-white/[0.06]">
              {queuedEntries.map((entry, idx) => {
                const s = songMap.get(entry.song_id);
                const requester = participantMap.get(entry.requested_by) ?? "Guest";
                const isMine = entry.requested_by === userId;
                return (
                  <li key={entry.id} className="flex items-center justify-between gap-2 py-2.5 text-xs">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="w-5 shrink-0 font-mono text-white/40">{idx + 1}.</span>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-white">
                          {s ? displayTitle(s.title) : "Song"}
                        </p>
                        <p className="truncate text-[11px] text-white/50">{requester}</p>
                      </div>
                    </div>
                    {isMine && (
                      <button
                        type="button"
                        disabled={queueBusyId === entry.id}
                        onClick={() => void handleRemoveOwnEntry(entry.id)}
                        className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium text-[#ff6b8b] transition hover:bg-white/10 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="space-y-4 rounded-2xl border border-white/10 bg-black/35 p-4 backdrop-blur-xl sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <h2 className="text-sm font-semibold text-snow">
              Room Catalogue ({filteredSongs.length})
            </h2>
            <input
              aria-label="Search room songs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search songs…"
              className="field max-w-xs bg-white/[0.07] py-1.5 text-xs"
            />
          </div>

          {filteredSongs.length === 0 ? (
            <p className="py-5 text-sm text-snow/60">
              {search.trim()
                ? "No songs match your search. Try another title or artist."
                : "The host hasn’t shared any songs yet. They’ll appear here when the library is ready."}
            </p>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {filteredSongs.map((song) => {
                const isJustQueued = justQueuedId === song.id;
                const alreadyInQueue = queuedSongIds.has(song.id);
                return (
                  <li key={song.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div className="flex min-w-0 items-center gap-3">
                      <Cover
                        title={song.title}
                        coverSrc={
                          transport === "lan" && roomId
                            ? `/lan-api/rooms/${encodeURIComponent(roomId)}/cover/${encodeURIComponent(song.host_song_id)}`
                            : undefined
                        }
                        size={40}
                        className="rounded-lg shadow-sm"
                      />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-white">
                          {displayTitle(song.title)}
                        </p>
                        {song.artist && (
                          <p className="truncate text-xs text-white/50">{song.artist}</p>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={snapshot?.room.status !== "open" || queueBusyId === song.id}
                      onClick={() => void handleQueueSong(song.id)}
                      className={`${
                        isJustQueued
                          ? "btn-light"
                          : alreadyInQueue
                            ? "btn-ghost border-[#fa2d48]/40 bg-[#fa2d48]/12 text-[#ff8da6]"
                            : "btn-ghost hover:border-white/35"
                      } shrink-0 px-3.5 py-1.5 text-xs font-semibold`}
                    >
                      {queueBusyId === song.id
                        ? "Adding…"
                        : isJustQueued
                          ? "Queued ✓"
                          : alreadyInQueue
                            ? "+ Again"
                            : "Queue"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {error && (
          <p role="alert" className="text-xs text-pink">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
