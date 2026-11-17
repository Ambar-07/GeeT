import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AudioMode, HostHealth, HostSong, Job } from "@geet/shared";
import { Logo } from "../components/Brand";
import { Cover, displayTitle, stageBacklightStyle } from "../components/Cover";
import { HostRoomPanel, type PlaybackEventSignal } from "../components/HostRoomPanel";
import { LyricsPanel } from "../components/LyricsPanel";
import { ParticleSphere } from "../components/ParticleSphere";
import {
  backupMetadata,
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

function formatSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

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
  const [tvMode, setTvMode] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);

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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space" && activeSong) {
        e.preventDefault();
        togglePlayPause();
      } else if (e.key === "t" || e.key === "T") {
        setTvMode((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSong]);

  useEffect(() => {
    if (!activeJob || (activeJob.status !== "queued" && activeJob.status !== "running")) return;
    const timer = setInterval(() => {
      void fetchJob(activeJob.id)
        .then(async (updated) => {
          setActiveJob(updated);
          if (
            updated.status === "completed" ||
            updated.status === "failed" ||
            updated.status === "cancelled"
          ) {
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
    setCurrentSec(0);
    setDurationSec(song.duration_ms ? song.duration_ms / 1000 : 0);
    setActiveSong(song);
    setAudioMode(song.has_instrumental ? "instrumental" : "original");
  }

  function switchAudioMode(nextMode: AudioMode) {
    if (audioRef.current) {
      resumePosRef.current = audioRef.current.currentTime;
    }
    setAudioMode(nextMode);
  }

  function togglePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }

  async function handlePrepare(songId: string, reprocess = false) {
    setStatusMsg(reprocess ? "Reprocessing instrumental..." : "Preparing instrumental...");
    try {
      const res = await prepareSong(songId, reprocess);
      if (res.job_id) {
        setActiveJob(await fetchJob(res.job_id));
      } else {
        setStatusMsg("Instrumental ready.");
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
      setStatusMsg("Instrumental cache cleared.");
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "Clear cache failed");
    }
  }

  async function handleAddAndScan(e: React.FormEvent) {
    e.preventDefault();
    if (!folderPath.trim()) return;
    setStatusMsg("Scanning folder...");
    try {
      await selectLibraryFolder(folderPath.trim());
      const res = await scanLibrary();
      setStatusMsg(`Imported ${res.scanned + res.skipped_unchanged} tracks.`);
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
    <div className="flex min-h-screen flex-col bg-ink-950 text-snow">
      {/* Top App Bar */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.07] bg-ink-900 px-5 py-3">
        <div className="flex items-center gap-3">
          <Link to="/">
            <Logo size={26} />
          </Link>
          <span className="text-white/15">/</span>
          <h1 className="text-sm font-semibold text-snow/85">Host Console</h1>
        </div>

        <div className="flex items-center gap-2 rounded-full border border-white/8 bg-ink-850 px-3.5 py-1 text-xs">
          {health ? (
            <span role="status" className="flex items-center gap-2 font-medium text-snow/85">
              <span className="h-2 w-2 rounded-full bg-sky" />
              Connected • {health.song_count} songs
            </span>
          ) : (
            <span role="alert" className="text-pink">
              {healthError ?? "Connecting..."}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            disabled={!health}
            onClick={() =>
              void backupMetadata()
                .then((b) =>
                  setStatusMsg(`SQLite backup saved: ${b.filename} (${b.size_bytes} bytes).`)
                )
                .catch((err) => setStatusMsg(err instanceof Error ? err.message : "Backup failed"))
            }
            className="btn-ghost px-3 py-1.5 text-xs"
          >
            Backup DB
          </button>
          <button type="button" onClick={() => void refresh()} className="btn-ghost px-3 py-1.5 text-xs">
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setTvMode((v) => !v)}
            className="btn-primary px-4 py-1.5 text-xs"
          >
            {tvMode ? "Split View" : "TV Stage Mode"}
          </button>
          <Link to="/" className="btn-ghost px-3 py-1.5 text-xs">
            Home
          </Link>
        </div>
      </header>

      {/* Main App Workspace */}
      <div className="flex flex-1 flex-col lg:flex-row">
        {/* Left Library Sidebar */}
        {!tvMode && (
          <aside className="flex w-full shrink-0 flex-col justify-between border-b border-white/[0.07] bg-ink-900 p-4 lg:w-[370px] lg:border-b-0 lg:border-r">
            <div className="space-y-4">
              {/* Search Library */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void refresh(query);
                }}
                className="flex gap-1.5"
              >
                <input
                  aria-label="Search indexed songs"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search songs or artists..."
                  className="field py-1.5 text-xs"
                />
                <button type="submit" className="btn-ghost shrink-0 px-3 py-1.5 text-xs">
                  Search
                </button>
              </form>

              {/* Folder Import */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="eyebrow">Your Library</span>
                  <span className="text-[11px] text-snow/45">
                    {health?.song_count ?? songs.length} tracks
                  </span>
                </div>
                <form onSubmit={handleAddAndScan} className="flex gap-1.5">
                  <input
                    aria-label="Local music folder path"
                    value={folderPath}
                    onChange={(e) => setFolderPath(e.target.value)}
                    placeholder="Add music folder path..."
                    className="field py-1.5 text-xs"
                  />
                  <button
                    type="submit"
                    disabled={!health}
                    className="btn-light shrink-0 px-3.5 py-1.5 text-xs"
                  >
                    Add & Scan
                  </button>
                </form>
                {statusMsg && (
                  <p role="status" className="text-[11px] font-medium text-sky">
                    {statusMsg}
                  </p>
                )}
              </div>

              {/* Tracklist */}
              <div className="thin-scroll max-h-[380px] overflow-y-auto pr-1">
                {songs.length === 0 ? (
                  <p className="py-10 text-center text-xs text-snow/40">
                    Import a local music folder above to start singing.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {songs.map((song) => {
                      const isActive = activeSong?.id === song.id;
                      const cleanTitle = displayTitle(song.title);
                      const subLabel = song.artist || song.title;
                      return (
                        <li
                          key={song.id}
                          className={`group flex items-center justify-between gap-2.5 rounded-xl p-2 transition ${
                            isActive ? "bg-white/10" : "hover:bg-white/[0.04]"
                          }`}
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-3">
                            <Cover title={song.title} size={36} className="rounded-lg" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-semibold text-snow">
                                {cleanTitle}
                              </p>
                              <p className="truncate text-[11px] text-snow/45">{subLabel}</p>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            {!song.has_instrumental && (
                              <button
                                type="button"
                                onClick={() => void handlePrepare(song.id)}
                                className="rounded-full px-2 py-0.5 text-[10px] font-medium text-snow/45 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-snow"
                              >
                                Prepare
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => selectSongForPlayback(song)}
                              className={
                                isActive
                                  ? "btn-primary px-3 py-1 text-[11px]"
                                  : "btn-ghost px-3 py-1 text-[11px]"
                              }
                            >
                              Play
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {nextCursor && (
                  <button
                    type="button"
                    onClick={() => void handleLoadMore()}
                    className="btn-ghost mt-2 w-full py-1.5 text-xs"
                  >
                    Load more
                  </button>
                )}
              </div>

              <HostRoomPanel onPlayHostSong={handlePlayHostSong} playbackSignal={playbackSignal} />
            </div>
          </aside>
        )}

        {/* Right Main Karaoke Stage */}
        <main
          aria-label="Karaoke Stage"
          style={stageBacklightStyle(activeSong?.title)}
          className="stage-ambient flex flex-1 flex-col justify-center p-6 transition-colors duration-700 sm:p-10 lg:p-14"
        >
          {activeSong ? (
            <div className="mx-auto grid w-full max-w-6xl items-center gap-10 xl:grid-cols-[310px_1fr] xl:gap-16">
              {/* Left Cover & Transport Pod */}
              <div className="mx-auto w-full max-w-[310px] space-y-5">
                <div className="relative">
                  <Cover
                    title={activeSong.title}
                    className="aspect-square w-full rounded-3xl border border-white/12 text-6xl shadow-2xl"
                  />
                  <span className="absolute left-3.5 top-3.5 rounded-full border border-white/15 bg-ink-950/75 px-3 py-1 text-[11px] font-medium text-snow backdrop-blur-md">
                    Now Playing ({audioMode})
                  </span>
                </div>

                <div className="space-y-0.5">
                  <h2 className="truncate text-xl font-bold tracking-tight text-snow">
                    {displayTitle(activeSong.title)}
                  </h2>
                  <p className="truncate text-sm text-snow/55">
                    {activeSong.artist || activeSong.title}
                  </p>
                </div>

                {/* Scrub Bar */}
                <div className="space-y-1.5">
                  <input
                    type="range"
                    aria-label="Seek playback position"
                    min={0}
                    max={durationSec || 1}
                    step={0.1}
                    value={Math.min(currentSec, durationSec || 1)}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setCurrentSec(next);
                      if (audioRef.current) audioRef.current.currentTime = next;
                    }}
                    className="range h-1 w-full cursor-pointer"
                  />
                  <div className="flex justify-between font-mono text-[11px] text-snow/45">
                    <span>{formatSec(currentSec)}</span>
                    <span>-{formatSec(Math.max(0, durationSec - currentSec))}</span>
                  </div>
                </div>

                {/* Transport & Stem Controls */}
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={togglePlayPause}
                    aria-label={isPlaying ? "Pause playback" : "Resume playback"}
                    className="btn-light h-12 w-12 shrink-0 rounded-full shadow-lg"
                  >
                    {isPlaying ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="6" y="4" width="4" height="16" rx="1" />
                        <rect x="14" y="4" width="4" height="16" rx="1" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <polygon points="6 4 20 12 6 20 6 4" />
                      </svg>
                    )}
                  </button>

                  <div
                    className="flex flex-1 justify-between rounded-full border border-white/10 bg-ink-900/80 p-1 text-[11px]"
                    role="group"
                    aria-label="Audio stem mode"
                  >
                    {(["original", "instrumental", "vocal"] as const).map((mode) => {
                      const disabled = mode !== "original" && !activeSong.has_instrumental;
                      return (
                        <button
                          key={mode}
                          type="button"
                          disabled={disabled}
                          onClick={() => switchAudioMode(mode)}
                          className={`flex-1 rounded-full py-1 font-medium capitalize transition ${
                            audioMode === mode
                              ? "bg-snow text-ink-950 font-semibold"
                              : "text-snow/65 hover:text-snow disabled:opacity-30"
                          }`}
                        >
                          {mode === "vocal" ? "Vocal" : mode}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Secondary Stem Actions */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                  {activeJob && (activeJob.status === "queued" || activeJob.status === "running") ? (
                    <button
                      type="button"
                      onClick={() =>
                        void cancelJob(activeJob.id)
                          .then(() => fetchJob(activeJob.id))
                          .then(setActiveJob)
                      }
                      className="text-pink hover:underline"
                    >
                      Cancel Separation ({activeJob.progress}%)
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handlePrepare(activeSong.id, activeSong.has_instrumental)}
                      className="text-snow/55 transition hover:text-snow"
                    >
                      {activeSong.has_instrumental ? "Reprocess Instrumental" : "Prepare Instrumental"}
                    </button>
                  )}

                  {activeSong.has_instrumental && (
                    <button
                      type="button"
                      onClick={() => void handleClearCache(activeSong.id)}
                      className="text-snow/45 hover:text-pink"
                    >
                      Clear Cache
                    </button>
                  )}
                </div>

                <audio
                  ref={audioRef}
                  key={`${activeSong.id}-${audioMode}`}
                  autoPlay
                  src={mediaUrl(activeSong.id, audioMode)}
                  onLoadedMetadata={() => {
                    if (audioRef.current) {
                      setDurationSec(audioRef.current.duration || 0);
                      if (resumePosRef.current !== null) {
                        audioRef.current.currentTime = resumePosRef.current;
                        resumePosRef.current = null;
                      }
                    }
                  }}
                  onTimeUpdate={() => {
                    if (audioRef.current) setCurrentSec(audioRef.current.currentTime);
                  }}
                  onError={() => {
                    if (audioMode !== "original") {
                      setStatusMsg("Instrumental unavailable; playing original.");
                      setAudioMode("original");
                    }
                  }}
                  onPlay={() => {
                    setIsPlaying(true);
                    emitPlayback("playing");
                  }}
                  onPause={() => {
                    setIsPlaying(false);
                    emitPlayback("paused");
                  }}
                  onEnded={() => {
                    setIsPlaying(false);
                    emitPlayback("ended");
                  }}
                  className="sr-only"
                />
              </div>

              {/* Right Full-Height Lyrics Stage */}
              <div className="min-w-0">
                <LyricsPanel song={activeSong} audioRef={audioRef} />
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-10 text-center">
              <ParticleSphere size={300} />
              <div className="space-y-1.5">
                <h2 className="text-2xl font-bold tracking-[-0.03em] text-snow">
                  Ready for the Stage
                </h2>
                <p className="text-xs leading-relaxed text-snow/50">
                  Select a track from your library on the left to launch synchronized big-screen lyrics.
                </p>
              </div>
              {songs.length > 0 && (
                <button
                  type="button"
                  onClick={() => selectSongForPlayback(songs[0])}
                  className="btn-primary mt-2 px-6 py-2.5 text-xs"
                >
                  Play {displayTitle(songs[0].title)}
                </button>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
