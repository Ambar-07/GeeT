import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
  const [connState, setConnState] = useState<"idle" | "connecting" | "subscribed" | "disconnected">("idle");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [queueBusyId, setQueueBusyId] = useState<string | null>(null);

  const sendReactionRef = useRef<((label: string) => void) | null>(null);

  // Debounce search input to keep read/UI work minimal
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Attempt automatic session restore if user already authenticated and joined this room
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
        // User has not joined yet; wait for explicit join form submission
      }
    })();
    return () => {
      active = false;
    };
  }, [normalizedCode]);

  // Subscribe to Realtime while room is active; unsubscribe on exit
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
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 py-12">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-6">
          <h1 className="text-xl font-bold">Room {normalizedCode}</h1>
          <p className="mt-2 text-sm text-amber-400">
            Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.
          </p>
          <Link to="/" className="mt-4 inline-block text-sm text-indigo-400 hover:underline">
            Back to Home
          </Link>
        </div>
      </main>
    );
  }

  if (!roomId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-indigo-400">Join Room</p>
            <h1 className="mt-1 font-mono text-2xl font-bold">{normalizedCode}</h1>
          </div>
          <form onSubmit={handleJoin} className="space-y-3">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your display name"
              maxLength={40}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              disabled={joining || !displayName.trim()}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {joining ? "Joining..." : "Enter Room"}
            </button>
          </form>
          {error && <p className="text-xs text-rose-400">{error}</p>}
          <Link to="/" className="inline-block text-xs text-slate-400 hover:text-slate-200">
            Back to Home
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-6 py-8">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-indigo-400">
            Room {normalizedCode} • {connState} {snapshot ? `• Rev ${snapshot.room.revision}` : ""}
          </p>
          <h1 className="text-xl font-bold">
            {snapshot ? `${snapshot.participants.length} Joined (${onlineIds.length} Online)` : "Loading..."}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleManualSync()}
            className="text-xs text-indigo-400 hover:underline"
          >
            Sync
          </button>
          <Link to="/" className="text-sm text-slate-400 hover:text-slate-200">
            Leave
          </Link>
        </div>
      </header>

      {snapshot?.room.status === "host_disconnected" && (
        <div className="rounded-lg border border-amber-700 bg-amber-950/60 p-3 text-xs text-amber-200">
          Host is temporarily disconnected. Waiting for host to reconnect.
        </div>
      )}

      {snapshot?.room.status === "closed" && (
        <div className="rounded-lg border border-rose-800 bg-rose-950/60 p-3 text-xs text-rose-200">
          This room has been closed by the host.
        </div>
      )}

      {playingSong && (
        <section className="rounded-xl border border-indigo-500/40 bg-slate-900 p-4">
          <p className="text-xs uppercase tracking-wider text-indigo-400">
            Now Playing ({snapshot?.playback?.status ?? "playing"})
          </p>
          <p className="mt-1 text-base font-semibold">
            {playingSong.title} {playingSong.artist ? `— ${playingSong.artist}` : ""}
          </p>
        </section>
      )}

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-2">
        <h2 className="text-sm font-semibold text-slate-300">
          Up Next ({queuedEntries.length})
        </h2>
        {queuedEntries.length === 0 ? (
          <p className="text-xs text-slate-500">Queue is empty. Add a song from the catalogue below.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {queuedEntries.map((entry, idx) => {
              const s = songMap.get(entry.song_id);
              const requester = participantMap.get(entry.requested_by) ?? "Member";
              const isMine = entry.requested_by === userId;
              return (
                <li key={entry.id} className="flex items-center justify-between py-2 text-xs">
                  <div>
                    <span className="mr-2 text-slate-500">{idx + 1}.</span>
                    <span className="font-medium text-slate-200">{s?.title ?? "Song"}</span>
                    <span className="ml-2 text-slate-400">({requester})</span>
                  </div>
                  {isMine && (
                    <button
                      type="button"
                      disabled={queueBusyId === entry.id}
                      onClick={() => void handleRemoveOwnEntry(entry.id)}
                      className="rounded border border-rose-900 px-2 py-0.5 text-rose-300 hover:bg-rose-950 disabled:opacity-40"
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

      <section className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900 p-4">
        <span className="text-xs font-medium text-slate-400">Send Reaction (2s limit)</span>
        <div className="flex gap-2">
          {["Clap", "Encore", "Cheer"].map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => sendReactionRef.current?.(label)}
              className="rounded-lg border border-slate-700 px-3 py-1 text-xs hover:bg-indigo-600"
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-300">
            Room Catalogue ({filteredSongs.length})
          </h2>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search songs..."
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1 text-xs outline-none focus:border-indigo-500"
          />
        </div>

        {filteredSongs.length === 0 ? (
          <p className="text-xs text-slate-500">No songs published by the host yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {filteredSongs.map((song) => (
              <li key={song.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <span className="font-medium">{song.title}</span>
                  {song.artist && <span className="ml-2 text-xs text-slate-400">{song.artist}</span>}
                </div>
                <button
                  type="button"
                  disabled={snapshot?.room.status !== "open" || queueBusyId === song.id}
                  onClick={() => void handleQueueSong(song.id)}
                  className="rounded-md bg-slate-800 px-3 py-1 text-xs font-medium hover:bg-indigo-600 disabled:opacity-40"
                >
                  {queueBusyId === song.id ? "Queuing..." : "Queue"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="text-xs text-rose-400">{error}</p>}
    </main>
  );
}
