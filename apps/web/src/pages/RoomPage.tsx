import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Logo } from "../components/Brand";
import { Cover, displayTitle } from "../components/Cover";
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
  type LiveLyricsSyncPayload,
  type RoomSnapshot,
} from "../lib/rooms";
import { isSupabaseConfigured } from "../lib/supabase";

const NAME_KEY = "geet_participant_name";
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
  const [playbackClock, setPlaybackClock] = useState<{
    status: "idle" | "playing" | "paused" | "ended";
    positionMs: number;
    localMs: number;
  }>({ status: "idle", positionMs: 0, localMs: performance.now() });

  const sendReactionRef = useRef<((label: string) => void) | null>(null);
  const requestLyricsSyncRef = useRef<(() => void) | null>(null);
  const prevTurnStateRef = useRef<"none" | "up_next" | "on_stage">("none");

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
    };

    const sub =
      transport === "lan"
        ? subscribeToLanRoom(roomId, userId, displayName || "Guest", callbacks)
        : subscribeToRoom(roomId, userId, displayName || "Guest", callbacks);

    sendReactionRef.current = sub.sendReaction;
    requestLyricsSyncRef.current = sub.requestLyricsSync;

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
      <div className="stage-ambient min-h-screen text-snow">
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
          <div className="surface p-7 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between gap-2">
              <Logo size={26} suffix="Join" />
              <span className="rounded-full border border-white/12 bg-white/[0.04] px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-snow/60">
                {isSupabaseConfigured ? "Cloud / LAN" : "LAN Wi-Fi"}
              </span>
            </div>
            <div>
              <p className="eyebrow">Room Code</p>
              <h1 className="mt-1 font-mono text-2xl font-bold tracking-wider text-snow">
                {normalizedCode}
              </h1>
            </div>
            <form onSubmit={handleJoin} className="space-y-3">
              <input
                aria-label="Your display name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your display name"
                maxLength={40}
                className="field"
              />
              <button
                type="submit"
                disabled={joining || !displayName.trim()}
                className="btn-primary w-full py-2.5 text-sm"
              >
                {joining ? "Joining..." : "Enter Room"}
              </button>
            </form>
            {error && (
              <p role="alert" className="text-xs text-pink">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between pt-1 text-xs">
              <Link to="/" className="text-snow/50 hover:text-snow">
                Back to Home
              </Link>
              <Link to="/host" className="text-sky/80 hover:text-sky">
                Host Console →
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950 text-snow">
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-6 sm:px-5">
        <header className="surface flex items-center justify-between gap-2 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <Logo size={22} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-mono text-xs font-semibold tracking-wider text-white/90">
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
              <h1 className="truncate text-[11px] font-medium text-white/50">
                {snapshot ? `${onlineIds.length} online` : "Loading..."}
              </h1>
            </div>
          </div>
          <Link to="/" className="btn-ghost shrink-0 px-3.5 py-1.5 text-xs">
            Leave
          </Link>
        </header>

        {snapshot?.room.status === "host_disconnected" && (
          <div role="status" className="surface border-pink/40 p-3.5 text-xs text-pink">
            Host is temporarily paused. Waiting for host to resume.
          </div>
        )}

        {snapshot?.room.status === "closed" && (
          <div role="alert" className="surface border-pink/60 p-3.5 text-xs text-pink">
            This room has ended.
          </div>
        )}

        {isMyTurnNow && playingSong && (
          <div
            role="status"
            className="surface flex flex-wrap items-center justify-between gap-3 border-pink/55 bg-pink/15 px-4 py-3 text-xs text-snow shadow-[0_0_24px_rgba(241,105,137,0.18)]"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 animate-ping rounded-full bg-pink" />
                <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-pink">
                  You&apos;re On Stage Now! 🎤
                </span>
              </div>
              <p className="mt-0.5 truncate font-semibold text-snow">
                {displayTitle(playingSong.title)}
                {playingSong.artist ? ` — ${playingSong.artist}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setLyricsFullscreen(true)}
              className="btn-primary shrink-0 px-3.5 py-1.5 text-[11px]"
            >
              Sing-Along Lyrics
            </button>
          </div>
        )}

        {myNextSong && (
          <div
            role="status"
            className={`surface px-4 py-3 text-xs text-snow ${myNextQueueIdx === 0
              ? "border-sky/60 bg-sky/15 shadow-[0_0_22px_rgba(5,147,198,0.18)]"
              : "border-sky/35 bg-sky/10"
              }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-sky">
                {myNextQueueIdx === 0 && (
                  <span className="h-2 w-2 animate-pulse rounded-full bg-sky" />
                )}
                {myNextQueueIdx === 0
                  ? "You're Up Next!"
                  : `Your Turn: #${myNextQueueIdx + 1} in queue`}
              </span>
              {myNextQueueIdx === 0 && (
                <span className="rounded-full bg-sky/20 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-sky">
                  Get Ready
                </span>
              )}
            </div>
            <p className="mt-0.5 font-semibold text-snow">
              {displayTitle(myNextSong.title)}
              {myNextSong.artist ? ` — ${myNextSong.artist}` : ""}
            </p>
          </div>
        )}

        {playingSong && (
          <section className="surface stage-ambient p-4 sm:p-5">
            <div className="flex items-center gap-4">
              <Cover
                title={playingSong.title}
                coverSrc={
                  transport === "lan" && roomId
                    ? `/lan-api/rooms/${encodeURIComponent(roomId)}/cover/${encodeURIComponent(playingSong.host_song_id)}`
                    : undefined
                }
                size={52}
                className="rounded-xl shadow-md"
              />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-white/55">
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
              coverSrc={
                transport === "lan" && roomId
                  ? `/lan-api/rooms/${encodeURIComponent(roomId)}/cover/${encodeURIComponent(playingSong.host_song_id)}`
                  : undefined
              }
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

        {queuedEntries.length > 0 && (
          <section className="surface p-4 sm:p-5 space-y-3">
            <h2 className="text-sm font-semibold text-white">Up Next ({queuedEntries.length})</h2>
            <ul className="divide-y divide-white/6">
              {queuedEntries.map((entry, idx) => {
                const s = songMap.get(entry.song_id);
                const requester = participantMap.get(entry.requested_by) ?? "Guest";
                const isMine = entry.requested_by === userId;
                return (
                  <li key={entry.id} className="flex items-center justify-between gap-2 py-2.5 text-xs">
                    <div className="min-w-0 truncate">
                      <span className="mr-2 font-mono text-white/40">{idx + 1}.</span>
                      <span className="font-semibold text-white">
                        {s ? displayTitle(s.title) : "Song"}
                      </span>
                      <span className="ml-2 text-white/50">({requester})</span>
                    </div>
                    {isMine && (
                      <button
                        type="button"
                        disabled={queueBusyId === entry.id}
                        onClick={() => void handleRemoveOwnEntry(entry.id)}
                        className="shrink-0 text-xs font-medium text-pink hover:underline disabled:opacity-40"
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

        <section className="surface space-y-2.5 p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Cheer the Singer</span>
            {recentReactions.length > 0 && (
              <span className="truncate font-mono text-[10px] text-pink/90">
                {recentReactions[0].sender}: {recentReactions[0].label}
              </span>
            )}
          </div>
          <div className="grid grid-cols-4 gap-2">
            {REACTION_BUTTONS.map(({ label, icon }) => (
              <button
                key={label}
                type="button"
                disabled={reactionCooldown}
                onClick={() => handleSendReaction(label)}
                className="btn-ghost py-2 text-xs"
              >
                <span aria-hidden="true">{icon}</span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="surface p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-snow">
              Room Catalogue ({filteredSongs.length})
            </h2>
            <input
              aria-label="Search room songs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search songs..."
              className="field max-w-xs py-1.5 text-xs"
            />
          </div>

          {filteredSongs.length === 0 ? (
            <p className="text-xs text-snow/45">No songs published by the host yet.</p>
          ) : (
            <ul className="divide-y divide-white/6">
              {filteredSongs.map((song) => {
                const isJustQueued = justQueuedId === song.id;
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
                          <p className="truncate text-xs text-white/45">{song.artist}</p>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={snapshot?.room.status !== "open" || queueBusyId === song.id}
                      onClick={() => void handleQueueSong(song.id)}
                      className={`${isJustQueued ? "btn-light" : "btn-ghost hover:border-white/35"
                        } shrink-0 px-3.5 py-1.5 text-xs font-semibold`}
                    >
                      {queueBusyId === song.id
                        ? "Adding..."
                        : isJustQueued
                          ? "Queued ✓"
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
