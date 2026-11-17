import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AudioMode, HostHealth, HostSong, Job } from "@geet/shared";
import { HostRoomPanel, type PlaybackEventSignal } from "../components/HostRoomPanel";
import { LyricsPanel } from "../components/LyricsPanel";
import {
  cancelJob,
  clearSongCache,
  fetchHostHealth,
  fetchJob,
  fetchSong,
  fetchSongsPage,
  mediaUrl,
  prepareSong,
  scanLibrary,
  selectLibraryFolder,
} from "../lib/hostAgent";
import { isSupabaseConfigured } from "../lib/supabase";

export function HostPage() {
  const [health, setHealth] = useState<HostHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState("");
  const [query, setQuery] = useState("");
  const [songs, setSongs] = useState<HostSong[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeSong, setActiveSong] = useState<HostSong | null>(null);
  const [audioMode, setAudioMode] = useState<AudioMode>("original");
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [playbackSignal, setPlaybackSignal] = useState<PlaybackEventSignal | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resumePosRef = useRef<number | null>(null);
  const songsRef = useRef<HostSong[]>([]);
  songsRef.current = songs;

  const handlePlayHostSong = useCallback(async (hostSongId: string) => {
    const local = songsRef.current.find((s) => s.id === hostSongId);
    if (local) {
      selectSongForPlayback(local);
      return;
    }
    try {
      selectSongForPlayback(await fetchSong(hostSongId));
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "Failed to load queued song");
    }
  }, []);

  function emitPlayback(type: PlaybackEventSignal["type"]) {
    const posMs = Math.round((audioRef.current?.currentTime ?? 0) * 1000);
    setPlaybackSignal((prev) => ({ type, positionMs: posMs, seq: (prev?.seq ?? 0) + 1 }));
  }

  async function refresh(searchQuery = query) {
    try {
      const [h, page] = await Promise.all([fetchHostHealth(), fetchSongsPage(searchQuery)]);
      setHealth(h);
      setHealthError(null);
      setSongs(page.songs);
      setNextCursor(page.next_cursor);
    } catch (err) {
      setHealth(null);
      setHealthError(err instanceof Error ? err.message : "Host agent unreachable");
    }
  }

  useEffect(() => {
    void refresh("");
  }, []);

  // Poll active separation job until terminal state, then refresh active song & list
  useEffect(() => {
    if (!activeJob || (activeJob.status !== "queued" && activeJob.status !== "running")) return;
    const timer = setInterval(() => {
      void fetchJob(activeJob.id)
        .then(async (updated) => {
          setActiveJob(updated);
          if (updated.status === "completed" || updated.status === "failed" || updated.status === "cancelled") {
            await refresh();
            if (activeSong && updated.song_id === activeSong.id) {
              setActiveSong(await fetchSong(activeSong.id));
            }
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [activeJob, activeSong]);

  function selectSongForPlayback(song: HostSong) {
    resumePosRef.current = null;
    setActiveSong(song);
    setAudioMode(song.has_instrumental ? "instrumental" : "original");
  }

  function switchAudioMode(nextMode: AudioMode) {
    if (audioRef.current) {
      resumePosRef.current = audioRef.current.currentTime;
    }
    setAudioMode(nextMode);
  }

  async function handlePrepare(songId: string, reprocess = false) {
    setStatusMsg(reprocess ? "Reprocessing instrumental..." : "Queuing separation job...");
    try {
      const res = await prepareSong(songId, reprocess);
      if (res.job_id) {
        setActiveJob(await fetchJob(res.job_id));
      } else {
        setStatusMsg("Instrumental stem already cached.");
      }
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "Prepare failed");
    }
  }

  async function handleClearCache(songId: string) {
    try {
      await clearSongCache(songId);
      if (activeSong?.id === songId) {
        setAudioMode("original");
        setActiveSong(await fetchSong(songId));
      }
      await refresh();
      setStatusMsg("Cached stems cleared. Original file untouched.");
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "Clear cache failed");
    }
  }

  async function handleAddAndScan(e: React.FormEvent) {
    e.preventDefault();
    if (!folderPath.trim()) return;
    setStatusMsg("Adding folder and scanning...");
    try {
      await selectLibraryFolder(folderPath.trim());
      const res = await scanLibrary();
      setStatusMsg(
        `Scanned ${res.scanned} (${res.skipped_unchanged} unchanged, ${res.removed} removed, ${res.duplicates} dup, ${res.rejected_drm} DRM rejected).`
      );
      await refresh();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "Scan failed");
    }
  }

  async function handleLoadMore() {
    if (!nextCursor) return;
    const page = await fetchSongsPage(query, nextCursor);
    setSongs((prev) => [...prev, ...page.songs]);
    setNextCursor(page.next_cursor);
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Host Console</h1>
          <p className="text-xs text-slate-400">
            Local audio playback stays on this machine. Originals are never modified.
          </p>
        </div>
        <Link to="/" className="text-sm text-slate-400 hover:text-slate-200">
          Home
        </Link>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-300">Host Agent</h2>
            <button onClick={() => void refresh()} className="text-xs text-indigo-400 hover:underline">
              Refresh
            </button>
          </div>
          {health ? (
            <p className="mt-2 text-xs text-emerald-400">
              Connected • {health.song_count} songs • FFprobe:{" "}
              {health.ffprobe ? "yes" : "mutagen"} • Demucs:{" "}
              {health.demucs ? `yes (${health.compute_device ?? "cpu"})` : "not installed"}
            </p>
          ) : (
            <p className="mt-2 text-xs text-rose-400">{healthError ?? "Connecting..."}</p>
          )}
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm font-semibold text-slate-300">Supabase Cloud</h2>
          <p className={`mt-2 text-xs ${isSupabaseConfigured ? "text-emerald-400" : "text-amber-400"}`}>
            {isSupabaseConfigured
              ? "Configured (VITE_SUPABASE_URL set)"
              : "Not configured — local playback still works"}
          </p>
        </div>
      </section>

      <HostRoomPanel onPlayHostSong={handlePlayHostSong} playbackSignal={playbackSignal} />

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-semibold text-slate-300">Import Local Music Folder</h2>
        <form onSubmit={handleAddAndScan} className="mt-3 flex gap-3">
          <input
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            placeholder="e.g. D:\Music\Karaoke"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!health}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            Add & Scan
          </button>
        </form>
        {statusMsg && <p className="mt-2 text-xs text-slate-300">{statusMsg}</p>}
      </section>

      {activeSong && (
        <section className="rounded-xl border border-indigo-500/40 bg-slate-900 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs text-indigo-400">
                Now Playing ({audioMode})
              </p>
              <p className="text-base font-semibold">
                {activeSong.title} {activeSong.artist ? `— ${activeSong.artist}` : ""}
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5 text-xs">
              {(["original", "instrumental", "vocal"] as const).map((mode) => {
                const disabled = mode !== "original" && !activeSong.has_instrumental;
                return (
                  <button
                    key={mode}
                    type="button"
                    disabled={disabled}
                    onClick={() => switchAudioMode(mode)}
                    className={`rounded px-2.5 py-1 capitalize ${
                      audioMode === mode
                        ? "bg-indigo-600 text-white"
                        : "border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                    }`}
                  >
                    {mode === "vocal" ? "Vocal Preview" : mode}
                  </button>
                );
              })}

              {activeJob && (activeJob.status === "queued" || activeJob.status === "running") ? (
                <button
                  type="button"
                  onClick={() => void cancelJob(activeJob.id).then(() => fetchJob(activeJob.id)).then(setActiveJob)}
                  className="rounded border border-rose-800 px-2.5 py-1 text-rose-300 hover:bg-rose-950"
                >
                  Cancel ({activeJob.status})
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handlePrepare(activeSong.id, activeSong.has_instrumental)}
                  className="rounded border border-slate-700 px-2.5 py-1 text-indigo-300 hover:bg-slate-800"
                >
                  {activeSong.has_instrumental ? "Reprocess" : "Prepare Instrumental"}
                </button>
              )}

              {activeSong.has_instrumental && (
                <button
                  type="button"
                  onClick={() => void handleClearCache(activeSong.id)}
                  className="rounded border border-slate-700 px-2.5 py-1 text-slate-400 hover:bg-slate-800"
                >
                  Clear Cache
                </button>
              )}
            </div>
          </div>

          {activeJob && activeJob.song_id === activeSong.id && (
            <p className="text-xs text-slate-400">
              Separation job {activeJob.id}: {activeJob.status} ({activeJob.progress}%)
              {activeJob.detail ? ` — ${activeJob.detail}` : ""}
            </p>
          )}

          <audio
            ref={audioRef}
            key={`${activeSong.id}-${audioMode}`}
            controls
            autoPlay
            src={mediaUrl(activeSong.id, audioMode)}
            onLoadedMetadata={() => {
              if (resumePosRef.current !== null && audioRef.current) {
                audioRef.current.currentTime = resumePosRef.current;
                resumePosRef.current = null;
              }
            }}
            onError={() => {
              if (audioMode !== "original") {
                setStatusMsg("Cached stem unavailable; falling back to original audio.");
                setAudioMode("original");
              }
            }}
            onPlay={() => emitPlayback("playing")}
            onPause={() => emitPlayback("paused")}
            onEnded={() => emitPlayback("ended")}
            className="w-full"
          />
          <LyricsPanel song={activeSong} audioRef={audioRef} />
        </section>
      )}

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-300">
            Indexed Songs ({health?.song_count ?? songs.length})
          </h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void refresh(query);
            }}
            className="flex gap-2"
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title or artist"
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1 text-xs outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              className="rounded-lg border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800"
            >
              Search
            </button>
          </form>
        </div>

        {songs.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">No songs indexed yet.</p>
        ) : (
          <>
            <ul className="mt-3 divide-y divide-slate-800">
              {songs.map((song) => (
                <li key={song.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <span className="font-medium">{song.title}</span>
                    {song.artist && <span className="ml-2 text-xs text-slate-400">{song.artist}</span>}
                    <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
                      {song.format}
                    </span>
                    {song.duplicate_of && (
                      <span className="ml-2 rounded bg-amber-950 px-1.5 py-0.5 text-[10px] text-amber-300">
                        duplicate
                      </span>
                    )}
                    {song.readiness !== "raw" && (
                      <span
                        className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${
                          song.readiness === "ready"
                            ? "bg-emerald-950 text-emerald-300"
                            : song.readiness === "failed"
                              ? "bg-rose-950 text-rose-300"
                              : "bg-indigo-950 text-indigo-300"
                        }`}
                      >
                        {song.readiness}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {!song.has_instrumental && (
                      <button
                        onClick={() => void handlePrepare(song.id)}
                        className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
                      >
                        Prepare
                      </button>
                    )}
                    <button
                      onClick={() => selectSongForPlayback(song)}
                      className="rounded-md bg-slate-800 px-3 py-1 text-xs font-medium hover:bg-indigo-600"
                    >
                      Play
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {nextCursor && (
              <button
                onClick={() => void handleLoadMore()}
                className="mt-4 w-full rounded-lg border border-slate-700 py-2 text-xs text-slate-300 hover:bg-slate-800"
              >
                Load more
              </button>
            )}
          </>
        )}
      </section>
    </main>
  );
}
