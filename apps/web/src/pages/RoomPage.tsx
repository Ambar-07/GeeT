import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Logo } from "../components/Brand";
import { Cover, displayTitle } from "../components/Cover";
import {
  SyncStatusBadge,
  type RoomTransportMode,
  type SyncConnectionState,
} from "../components/SyncStatusBadge";
import {
  addLanSongToQueue,
  fetchLanRoomIdByCode,
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

  const sendReactionRef = useRef<((label: string) => void) | null>(null);

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
    };

    const sub =
      transport === "lan"
        ? subscribeToLanRoom(roomId, userId, displayName || "Guest", callbacks)
        : subscribeToRoom(roomId, userId, displayName || "Guest", callbacks);

    sendReactionRef.current = sub.sendReaction;

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
  const playingSong = snapshot?.playback?.song_id
    ? songMap.get(snapshot.playback.song_id) ?? null
    : null;

  const myNextQueueIdx = queuedEntries.findIndex((q) => q.requested_by === userId);
  const myNextEntry = myNextQueueIdx >= 0 ? queuedEntries[myNextQueueIdx] : null;
  const myNextSong = myNextEntry ? songMap.get(myNextEntry.song_id) ?? null : null;

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
        <header className="surface flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
          <div className="flex items-center gap-3">
            <Logo size={24} />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="eyebrow text-sky">Room {normalizedCode}</p>
                <SyncStatusBadge state={connState} transport={transport} />
              </div>
              <h1 className="mt-0.5 text-sm font-semibold text-snow sm:text-base">
                {snapshot
                  ? `${snapshot.participants.length} Joined (${onlineIds.length} Online)`
                  : "Loading..."}
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleManualSync()}
              className="btn-ghost px-3 py-1.5 text-[11px]"
            >
              Sync
            </button>
            <Link to="/" className="btn-ghost px-3 py-1.5 text-[11px]">
              Leave
            </Link>
          </div>
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

        {myNextSong && (
          <div
            role="status"
            className="surface border-sky/40 bg-sky/10 px-4 py-3 text-xs text-snow"
          >
            <span className="font-mono text-[10px] uppercase tracking-wider text-sky">
              {myNextQueueIdx === 0
                ? "You're Up Next!"
                : `Your Turn: #${myNextQueueIdx + 1} in queue`}
            </span>
            <p className="mt-0.5 font-semibold text-snow">
              {displayTitle(myNextSong.title)}
              {myNextSong.artist ? ` — ${myNextSong.artist}` : ""}
            </p>
          </div>
        )}

        {playingSong && (
          <section className="surface stage-ambient flex items-center gap-4 p-4 sm:p-5">
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
            <div className="min-w-0">
              <p className="eyebrow text-sky">
                Now Playing ({snapshot?.playback?.status ?? "playing"})
              </p>
              <p className="mt-0.5 truncate text-base font-bold text-snow">
                {displayTitle(playingSong.title)}
                {playingSong.artist ? ` — ${playingSong.artist}` : ""}
              </p>
            </div>
          </section>
        )}

        <section className="surface p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-semibold text-snow">Up Next ({queuedEntries.length})</h2>
          {queuedEntries.length === 0 ? (
            <p className="text-xs text-snow/45">Queue is empty. Pick a song below.</p>
          ) : (
            <ul className="divide-y divide-white/6">
              {queuedEntries.map((entry, idx) => {
                const s = songMap.get(entry.song_id);
                const requester = participantMap.get(entry.requested_by) ?? "Guest";
                const isMine = entry.requested_by === userId;
                return (
                  <li key={entry.id} className="flex items-center justify-between gap-2 py-2.5 text-xs">
                    <div className="min-w-0 truncate">
                      <span className="mr-2 font-mono text-snow/45">{idx + 1}.</span>
                      <span className="font-semibold text-snow">
                        {s ? displayTitle(s.title) : "Song"}
                      </span>
                      <span className="ml-2 text-snow/50">({requester})</span>
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
          )}
        </section>

        <section className="surface space-y-2.5 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs font-medium text-snow/65">Cheer the Singer</span>
            <div className="flex flex-wrap gap-2">
              {REACTION_BUTTONS.map(({ label, icon }) => (
                <button
                  key={label}
                  type="button"
                  disabled={reactionCooldown}
                  onClick={() => handleSendReaction(label)}
                  className="btn-ghost px-3 py-1.5 text-[11px]"
                >
                  <span aria-hidden="true">{icon}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
          {recentReactions.length > 0 && (
            <p className="truncate font-mono text-[10px] text-pink/90">
              Live: {recentReactions.map((r) => `${r.sender} sent ${r.label}`).join(" · ")}
            </p>
          )}
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
                        <div className="flex items-center gap-1.5">
                          <p className="truncate font-medium text-snow">
                            {displayTitle(song.title)}
                          </p>
                          {song.readiness === "ready" && (
                            <span className="shrink-0 rounded bg-sky/15 px-1.5 py-0.5 font-mono text-[9px] uppercase text-sky">
                              Inst
                            </span>
                          )}
                        </div>
                        {song.artist && (
                          <p className="truncate text-xs text-snow/50">{song.artist}</p>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={snapshot?.room.status !== "open" || queueBusyId === song.id}
                      onClick={() => void handleQueueSong(song.id)}
                      className={`${
                        isJustQueued ? "btn-light" : "btn-primary"
                      } shrink-0 px-3.5 py-1.5 text-[11px]`}
                    >
                      {queueBusyId === song.id
                        ? "Queuing..."
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
