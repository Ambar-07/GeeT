import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { HostHealth, HostSong } from "@geet/shared";
import { HostRoomPanel } from "../components/HostRoomPanel";
import { LyricsPanel } from "../components/LyricsPanel";
import {
  fetchHostHealth,
  fetchSongsPage,
  mediaUrl,
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
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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
              {health.ffprobe ? "yes" : "fallback (mutagen)"}
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

      <HostRoomPanel />

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
        <section className="rounded-xl border border-indigo-500/40 bg-slate-900 p-4">
          <p className="text-xs text-indigo-400">Now Playing (Local)</p>
          <p className="text-base font-semibold">
            {activeSong.title} {activeSong.artist ? `— ${activeSong.artist}` : ""}
          </p>
          <audio
            ref={audioRef}
            key={activeSong.id}
            controls
            autoPlay
            src={mediaUrl(activeSong.id)}
            className="mt-3 w-full"
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
                  </div>
                  <button
                    onClick={() => setActiveSong(song)}
                    className="rounded-md bg-slate-800 px-3 py-1 text-xs font-medium hover:bg-indigo-600"
                  >
                    Play
                  </button>
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
