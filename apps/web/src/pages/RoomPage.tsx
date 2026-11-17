import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Logo } from "../components/Brand";
import { Cover, displayTitle } from "../components/Cover";
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

export function RoomPage() {
  const { code = "" } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const normalizedCode = code.trim().toUpperCase();

  const [displayName, setDisplayName] = useState(() => sessionStorage.getItem(NAME_KEY) ?? "");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const [, setConnState] = useState<"idle" | "connecting" | "subscribed" | "disconnected">("idle");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [queueBusyId, setQueueBusyId] = useState<string | null>(null);

  const sendReactionRef = useRef<((label: string) => void) | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!isSupabaseConfigured || !normalizedCode) return;
    let active = true;
    (async () => {
      try {
        const { userId: uid } = await ensureAuthSession();
        const existingId = await fetchRoomIdByCode(normalizedCode);
        if (active && existingId) {
          setUserId(uid);
          setRoomId(existingId);
        }
      } catch {
        // Wait for explicit join form submission
      }
    })();
    return () => {
      active = false;
    };
  }, [normalizedCode]);

  useEffect(() => {
    if (!roomId || !userId || !isSupabaseConfigured) return;
    let active = true;

    const sub = subscribeToRoom(roomId, userId, displayName || "Guest", {
      onSnapshot: (snap) => {
        if (active) setSnapshot((prev) => reconcileSnapshot(prev, snap));
      },
      onPresenceCount: (ids) => {
        if (active) setOnlineIds(ids);
      },
      onReaction: () => {},
      onConnectionState: (state) => {
        if (active) setConnState(state);
      },
    });
    sendReactionRef.current = sub.sendReaction;

    fetchRoomSnapshot(roomId)
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
  }, [roomId, userId, displayName]);

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

  async function handleManualSync() {
    if (!roomId) return;
    try {
      const fresh = await fetchRoomSnapshot(roomId);
      setSnapshot((prev) => reconcileSnapshot(prev, fresh, true));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    }
  }

  async function handleQueueSong(songId: string) {
    if (!roomId || queueBusyId) return;
    setQueueBusyId(songId);
    setError(null);
    try {
      await addSongToQueue(roomId, songId);
      await handleManualSync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to queue song");
    } finally {
      setQueueBusyId(null);
    }
  }

  async function handleRemoveOwnEntry(entryId: string) {
    if (!roomId || queueBusyId) return;
    setQueueBusyId(entryId);
    setError(null);
    try {
      await removeSongFromQueue(roomId, entryId);
      await handleManualSync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove song");
    } finally {
      setQueueBusyId(null);
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!displayName.trim() || !normalizedCode) return;
    setJoining(true);
    setError(null);
    try {
      const { userId: uid } = await ensureAuthSession();
      const joinedId = await joinRoomAsParticipant(normalizedCode, displayName.trim());
      sessionStorage.setItem(NAME_KEY, displayName.trim());
      setUserId(uid);
      setRoomId(joinedId);
      navigate(`/room/${encodeURIComponent(normalizedCode)}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to join room");
    } finally {
      setJoining(false);
    }
  }

  if (!isSupabaseConfigured) {
    return (
      <div className="stage-ambient min-h-screen text-snow">
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
          <div className="surface p-7 space-y-5">
            <Logo size={26} suffix="Room" />
            <div>
              <p className="eyebrow">Room Code</p>
              <h1 className="mt-1 font-mono text-2xl font-bold tracking-wider text-snow">
                {normalizedCode}
              </h1>
            </div>
            <p role="status" className="text-xs leading-relaxed text-snow/60">
              Cloud room sync is offline on this host. Open the Host Console to play and sing locally.
            </p>
            <div className="flex gap-2.5 pt-1">
              <Link to="/host" className="btn-primary px-5 py-2 text-xs">
                Open Host Console
              </Link>
              <Link to="/" className="btn-ghost px-5 py-2 text-xs">
                Back to Home
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!roomId) {
    return (
      <div className="stage-ambient min-h-screen text-snow">
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
          <div className="surface p-7 space-y-5">
            <Logo size={26} suffix="Join" />
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
            <Link to="/" className="inline-block text-xs text-snow/50 hover:text-snow">
              Back to Home
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950 text-snow">
      <main className="mx-auto max-w-2xl space-y-5 px-5 py-7">
        <header className="surface flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="flex items-center gap-3">
            <Logo size={26} />
            <div>
              <p className="eyebrow text-sky">Room {normalizedCode}</p>
              <h1 className="text-base font-semibold text-snow">
                {snapshot ? `${snapshot.participants.length} Joined (${onlineIds.length} Online)` : "Loading..."}
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void handleManualSync()} className="btn-ghost px-3.5 py-1.5 text-xs">
              Sync
            </button>
            <Link to="/" className="btn-ghost px-3.5 py-1.5 text-xs">
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

        {playingSong && (
          <section className="surface stage-ambient flex items-center gap-4 p-5">
            <Cover title={playingSong.title} size={48} className="rounded-xl" />
            <div>
              <p className="eyebrow text-sky">
                Now Playing ({snapshot?.playback?.status ?? "playing"})
              </p>
              <p className="mt-0.5 text-base font-bold text-snow">
                {displayTitle(playingSong.title)}{" "}
                {playingSong.artist ? `— ${playingSong.artist}` : ""}
              </p>
            </div>
          </section>
        )}

        <section className="surface p-5 space-y-3">
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
                  <li key={entry.id} className="flex items-center justify-between py-2.5 text-xs">
                    <div>
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
                        className="text-xs font-medium text-pink hover:underline disabled:opacity-40"
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

        <section className="surface flex flex-wrap items-center justify-between gap-3 p-5">
          <span className="text-xs font-medium text-snow/60">Send Reaction</span>
          <div className="flex gap-2">
            {["Clap", "Encore", "Cheer"].map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => sendReactionRef.current?.(label)}
                className="btn-ghost px-4 py-1.5 text-xs"
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="surface p-5 space-y-4">
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
              {filteredSongs.map((song) => (
                <li key={song.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="flex min-w-0 items-center gap-3">
                    <Cover title={song.title} size={36} className="rounded-lg" />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-snow">{displayTitle(song.title)}</p>
                      {song.artist && (
                        <p className="truncate text-xs text-snow/50">{song.artist}</p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={snapshot?.room.status !== "open" || queueBusyId === song.id}
                    onClick={() => void handleQueueSong(song.id)}
                    className="btn-primary shrink-0 px-4 py-1 text-xs"
                  >
                    {queueBusyId === song.id ? "Queuing..." : "Queue"}
                  </button>
                </li>
              ))}
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
