import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AudioMode, HostHealth, HostSong, Job } from "@geet/shared";
import { Logo } from "../components/Brand";
import {
  Cover,
  StageBackdrop,
  displayTitle,
  formatAudioQuality,
} from "../components/Cover";
import {
  HostRoomPanel,
  type HostActiveLyrics,
  type HostStageRoomInfo,
  type PlaybackEventSignal,
  type StageReactionBurst,
  type UpNextItem,
} from "../components/HostRoomPanel";
import { LyricsPanel } from "../components/LyricsPanel";
import { TvStageOverlay } from "../components/TvStageOverlay";
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

function shuffleList<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Pick the first of the next 2 queued tracks that still needs stem separation. */
export function selectNextAutoPrepareCandidate(
  upNext: readonly UpNextItem[],
  songsById: ReadonlyMap<string, HostSong>,
  attemptedIds: ReadonlySet<string>,
  lookahead = 2
): UpNextItem | null {
  for (const item of upNext.slice(0, lookahead)) {
    if (!item.hostSongId || attemptedIds.has(item.hostSongId)) continue;
    const local = songsById.get(item.hostSongId);
    if (local) {
      if (!local.has_instrumental && local.readiness !== "preparing" && local.readiness !== "drm_rejected") {
        return item;
      }
    } else if (item.readiness === "raw") {
      return item;
    }
  }
  return null;
}

export function HostPage() {
  const [health, setHealth] = useState<HostHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState("");
  const [query, setQuery] = useState("");
  const [songs, setSongs] = useState<HostSong[]>([]);
  const [featuredSongs, setFeaturedSongs] = useState<HostSong[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeSong, setActiveSong] = useState<HostSong | null>(null);
  const [audioMode, setAudioMode] = useState<AudioMode>("original");
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [autoPrepTitle, setAutoPrepTitle] = useState<string | null>(null);
  const [autoPrepareEnabled, setAutoPrepareEnabled] = useState(true);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [playbackSignal, setPlaybackSignal] = useState<PlaybackEventSignal | null>(null);
  const [activeLyrics, setActiveLyrics] = useState<HostActiveLyrics | null>(null);
  const [tvMode, setTvMode] = useState(false);
  const [showTvOverlay, setShowTvOverlay] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<"library" | "party">("library");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lyricsEditorOpen, setLyricsEditorOpen] = useState(false);
  const [stemMenuOpen, setStemMenuOpen] = useState(false);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);

  const [stageRoom, setStageRoom] = useState<HostStageRoomInfo | null>(null);
  const [reactionBursts, setReactionBursts] = useState<StageReactionBurst[]>([]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [vocalMix, setVocalMix] = useState(0.15);
  const [showVocalSlider, setShowVocalSlider] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const vocalAudioRef = useRef<HTMLAudioElement | null>(null);
  const resumePosRef = useRef<number | null>(null);
  const shouldAutoPlayRef = useRef(false);
  const songsRef = useRef<HostSong[]>([]);
  const shufflePoolRef = useRef<HostSong[]>([]);
  const shuffleBagRef = useRef<HostSong[]>([]);
  const shuffleHistoryRef = useRef<HostSong[]>([]);
  const featuredHoveredRef = useRef(false);
  const autoPreparedIdsRef = useRef<Set<string>>(new Set());
  songsRef.current = songs;

  const songsById = useMemo(() => new Map(songs.map((s) => [s.id, s])), [songs]);

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

  const handleReactionBurst = useCallback((burst: StageReactionBurst) => {
    setReactionBursts((prev) => [...prev.slice(-10), burst]);
    setTimeout(() => {
      setReactionBursts((prev) => prev.filter((item) => item.id !== burst.id));
    }, 3400);
  }, []);

  const activeSongRef = useRef<HostSong | null>(null);
  activeSongRef.current = activeSong;

  function emitPlayback(type: PlaybackEventSignal["type"], songIdOverride?: string) {
    const posMs = Math.round((audioRef.current?.currentTime ?? 0) * 1000);
    setPlaybackSignal((prev) => ({
      type,
      positionMs: posMs,
      seq: (prev?.seq ?? 0) + 1,
      hostSongId: songIdOverride ?? activeSongRef.current?.id,
    }));
  }

  const getPlaybackClock = useCallback(() => {
    const audio = audioRef.current;
    const status: "idle" | "playing" | "paused" | "ended" = !audio
      ? "idle"
      : audio.ended
        ? "ended"
        : audio.paused
          ? "paused"
          : "playing";
    return {
      status,
      positionMs: Math.round((audio?.currentTime ?? 0) * 1000),
    };
  }, []);

  // Gentle periodic clock sync while playing so guest phones stay tightly aligned
  useEffect(() => {
    if (!isPlaying || !activeSong || !stageRoom?.active) return;
    const timer = setInterval(() => {
      emitPlayback("playing", activeSong.id);
    }, 8000);
    return () => clearInterval(timer);
  }, [isPlaying, activeSong?.id, stageRoom?.active]);

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

  const didMountQueryRef = useRef(false);

  useEffect(() => {
    void refresh("");
  }, []);

  // Live debounced search as you type (no redundant Search button needed)
  useEffect(() => {
    if (!didMountQueryRef.current) {
      didMountQueryRef.current = true;
      return;
    }
    const timer = setTimeout(() => {
      void refresh(query);
    }, 220);
    return () => clearTimeout(timer);
  }, [query]);

  // Keep primary + companion vocal stem audio volumes synced
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
      audioRef.current.muted = muted;
    }
    if (vocalAudioRef.current) {
      vocalAudioRef.current.volume = Math.max(0, Math.min(1, vocalMix * volume));
      vocalAudioRef.current.muted = muted || vocalMix <= 0.001;
    }
  }, [volume, muted, vocalMix, activeSong, audioMode]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space" && activeSong) {
        e.preventDefault();
        togglePlayPause();
      } else if (e.key === "t" || e.key === "T") {
        setTvMode((v) => !v);
      } else if (e.key === "Escape" && tvMode) {
        setTvMode(false);
      } else if (e.key === "o" || e.key === "O") {
        setShowTvOverlay((v) => !v);
      } else if (e.key === "m" || e.key === "M") {
        setMuted((v) => !v);
      } else if (e.key === "s" || e.key === "S") {
        setShuffleEnabled((v) => !v);
      } else if (e.key === "ArrowRight" && audioRef.current) {
        e.preventDefault();
        audioRef.current.currentTime = Math.min(
          audioRef.current.duration || Infinity,
          audioRef.current.currentTime + 5
        );
      } else if (e.key === "ArrowLeft" && audioRef.current) {
        e.preventDefault();
        audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 5);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSong, tvMode]);

  // Poll active separation job
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
            setAutoPrepTitle(null);
            if (updated.status === "failed") {
              setStatusMsg(updated.detail || "Instrumental separation failed.");
            } else if (updated.status === "completed") {
              setStatusMsg("Instrumental ready.");
            }
            await refresh();
            if (activeSong && updated.song_id === activeSong.id) {
              const refreshed = await fetchSong(activeSong.id);
              setActiveSong(refreshed);
              if (updated.status === "completed" && refreshed.has_instrumental) {
                if (audioRef.current) resumePosRef.current = audioRef.current.currentTime;
                setAudioMode("instrumental");
                setShowVocalSlider(true);
              }
            }
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [activeJob, activeSong]);

  // Auto-Prepare Next 1-2 Queued Tracks in background when Demucs is available
  useEffect(() => {
    if (!autoPrepareEnabled || !health?.demucs) return;
    if (activeJob && (activeJob.status === "queued" || activeJob.status === "running")) return;
    const upNext = stageRoom?.upNext ?? [];
    if (upNext.length === 0) return;

    const candidate = selectNextAutoPrepareCandidate(
      upNext,
      songsById,
      autoPreparedIdsRef.current,
      2
    );
    if (!candidate) return;

    autoPreparedIdsRef.current.add(candidate.hostSongId);
    let cancelled = false;
    void prepareSong(candidate.hostSongId, false)
      .then(async (res) => {
        if (cancelled) return;
        if (res.job_id) {
          setAutoPrepTitle(candidate.title);
          setActiveJob(await fetchJob(res.job_id));
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [autoPrepareEnabled, health?.demucs, stageRoom?.upNext, songsById, activeJob]);

  function startAudioElement(songId: string, mode: AudioMode, seekSec?: number) {
    const audio = audioRef.current;
    if (!audio) return;
    const nextUrl = mediaUrl(songId, mode);
    if (audio.src !== nextUrl) {
      audio.src = nextUrl;
      audio.load();
    }
    if (seekSec !== undefined && Number.isFinite(seekSec)) {
      resumePosRef.current = seekSec;
    }
    audio.volume = volume;
    audio.muted = muted;
    // Call play() synchronously inside the user's click/tap gesture so browsers unlock autoplay immediately
    void audio.play().catch(() => {});
  }

  function selectSongForPlayback(song: HostSong) {
    shouldAutoPlayRef.current = true;
    const nextMode: AudioMode = song.has_instrumental ? "instrumental" : "original";
    if (activeSongRef.current?.id === song.id && audioRef.current) {
      if (audioRef.current.paused) {
        void audioRef.current.play().catch(() => {});
      }
      return;
    }
    resumePosRef.current = null;
    setCurrentSec(0);
    setDurationSec(song.duration_ms ? song.duration_ms / 1000 : 0);
    setActiveSong(song);
    setAudioMode(nextMode);
    setLyricsEditorOpen(false);
    setStemMenuOpen(false);
    startAudioElement(song.id, nextMode, 0);
  }

  async function ensureShufflePool(): Promise<HostSong[]> {
    if (shufflePoolRef.current.length > 0) return shufflePoolRef.current;
    try {
      const all: HostSong[] = [];
      let cursor: string | null = null;
      do {
        const page = await fetchSongsPage("", cursor);
        all.push(...page.songs);
        cursor = page.next_cursor;
      } while (cursor);
      const playable = all.filter((s) => s.readiness !== "drm_rejected");
      shufflePoolRef.current = playable;
      return playable;
    } catch {
      return songsRef.current;
    }
  }

  function pickAndPlayFromPool(pool: HostSong[], recordHistory: boolean) {
    if (pool.length === 0) return;
    const currentId = activeSongRef.current?.id;
    if (shuffleBagRef.current.length === 0) {
      shuffleBagRef.current = shuffleList(
        pool.filter((s) => pool.length === 1 || s.id !== currentId)
      );
    }
    const next = shuffleBagRef.current.pop();
    if (!next) return;
    if (recordHistory && activeSongRef.current) {
      shuffleHistoryRef.current = [...shuffleHistoryRef.current.slice(-40), activeSongRef.current];
    }
    selectSongForPlayback(next);
  }

  async function playNextShuffled(recordHistory = true) {
    if (shufflePoolRef.current.length > 0) {
      pickAndPlayFromPool(shufflePoolRef.current, recordHistory);
      return;
    }
    const pool = await ensureShufflePool();
    pickAndPlayFromPool(pool, recordHistory);
  }

  function handleShufflePlay() {
    setShuffleEnabled(true);
    if (shufflePoolRef.current.length > 0) {
      pickAndPlayFromPool(shufflePoolRef.current, true);
    } else if (songsRef.current.length > 0) {
      // Start playing synchronously inside the user gesture while full pool loads in background
      pickAndPlayFromPool(songsRef.current, true);
      void ensureShufflePool();
    } else {
      void playNextShuffled(true);
    }
  }

  const rotateFeaturedSongs = useCallback(async () => {
    const pool = await ensureShufflePool();
    const source = pool.length > 0 ? pool : songsRef.current;
    if (source.length === 0) {
      setFeaturedSongs([]);
      return;
    }
    const withArt = source.filter((s) => s.has_cover !== false);
    const base = withArt.length >= 8 ? withArt : source;
    setFeaturedSongs((prev) => {
      const prevIds = new Set(prev.map((s) => s.id));
      const freshPool = base.filter((s) => !prevIds.has(s.id));
      const candidates = freshPool.length >= 8 ? freshPool : base;
      return shuffleList(candidates).slice(0, 8);
    });
  }, []);

  // Dynamically rotate the 8 spotlight tracks across the whole library while on the idle screen
  useEffect(() => {
    if (activeSong || !health || health.song_count === 0) return;
    void rotateFeaturedSongs();
    if (health.song_count <= 8) return;
    const timer = setInterval(() => {
      if (!featuredHoveredRef.current) {
        void rotateFeaturedSongs();
      }
    }, 12_000);
    return () => clearInterval(timer);
  }, [activeSong, health?.song_count, rotateFeaturedSongs]);

  function stepLibraryTrack(delta: -1 | 1) {
    if (!activeSong) return;
    if (delta === 1 && stageRoom?.playNext) {
      stageRoom.playNext();
      return;
    }
    if (delta === -1 && audioRef.current && audioRef.current.currentTime > 4) {
      audioRef.current.currentTime = 0;
      return;
    }
    if (shuffleEnabled) {
      if (delta === 1) {
        void playNextShuffled(true);
      } else {
        const prev = shuffleHistoryRef.current.pop();
        if (prev) {
          selectSongForPlayback(prev);
        } else if (audioRef.current) {
          audioRef.current.currentTime = 0;
        }
      }
      return;
    }
    if (songs.length === 0) return;
    const idx = songs.findIndex((s) => s.id === activeSong.id);
    if (idx === -1) {
      selectSongForPlayback(songs[0]);
      return;
    }
    const nextIdx = (idx + delta + songs.length) % songs.length;
    selectSongForPlayback(songs[nextIdx]);
  }

  function switchAudioMode(nextMode: AudioMode) {
    const curPos = audioRef.current?.currentTime ?? 0;
    const wasPlaying = audioRef.current ? !audioRef.current.paused : true;
    resumePosRef.current = curPos;
    shouldAutoPlayRef.current = wasPlaying;
    setAudioMode(nextMode);
    if (activeSongRef.current && wasPlaying) {
      startAudioElement(activeSongRef.current.id, nextMode, curPos);
    }
  }

  function togglePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      shouldAutoPlayRef.current = true;
      void audio.play().catch(() => {});
    } else {
      shouldAutoPlayRef.current = false;
      audio.pause();
    }
  }

  async function handlePrepare(songId: string, reprocess = false) {
    setStatusMsg(reprocess ? "Reprocessing instrumental..." : "Preparing instrumental...");
    try {
      const res = await prepareSong(songId, reprocess);
      if (res.job_id) {
        const song = songsById.get(songId);
        setAutoPrepTitle(song?.title ?? null);
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
      autoPreparedIdsRef.current.delete(songId);
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
      shufflePoolRef.current = [];
      shuffleBagRef.current = [];
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

  const remainingSec = Math.max(0, durationSec - currentSec);
  const progressPct = durationSec > 0 ? Math.min(100, (currentSec / durationSec) * 100) : 0;
  const jobIsActive = Boolean(
    activeJob && (activeJob.status === "queued" || activeJob.status === "running")
  );

  // Enrich stageRoom.upNext with real-time local readiness (e.g. while auto-preparing)
  const enrichedStageRoom = useMemo<HostStageRoomInfo | null>(() => {
    if (!stageRoom) return null;
    return {
      ...stageRoom,
      upNext: stageRoom.upNext.map((item) => {
        const local = songsById.get(item.hostSongId);
        if (!local) return item;
        const liveReadiness = local.has_instrumental
          ? "ready"
          : local.readiness === "preparing" || local.readiness === "failed"
            ? local.readiness
            : item.readiness;
        return { ...item, readiness: liveReadiness };
      }),
    };
  }, [stageRoom, songsById]);

  const qualityLabel = activeSong
    ? formatAudioQuality(activeSong.format, activeSong.codec)
    : null;
  const activeSubtitle = activeSong
    ? [activeSong.artist, activeSong.album].filter(Boolean).join(" — ") || activeSong.title
    : "";

  return (
    <div className="flex min-h-screen flex-col bg-ink-950 text-snow lg:h-screen lg:overflow-hidden">
      {/* Minimalist Top Bar (hidden in TV Stage Mode so the stage goes truly full-bleed) */}
      {!tvMode && (
        <header className="relative z-30 flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] bg-ink-950/90 px-4 py-2.5 backdrop-blur-xl sm:px-5">
          <Link to="/" className="shrink-0">
            <Logo size={25} />
          </Link>

          <div className="hidden items-center gap-2 text-xs sm:flex">
            {health ? (
              <span role="status" className="flex items-center gap-2 font-medium text-white/55">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.75)]" />
                Connected • {health.song_count} songs
              </span>
            ) : (
              <span role="alert" className="text-pink">
                {healthError ?? "Connecting..."}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs">
            <div className="relative">
              <button
                type="button"
                aria-label="Library & settings"
                aria-expanded={settingsOpen}
                title="Library & Settings"
                onClick={() => setSettingsOpen((v) => !v)}
                className={`flex h-8 w-8 items-center justify-center rounded-full border transition ${
                  settingsOpen
                    ? "border-white/25 bg-white/14 text-white"
                    : "border-white/10 bg-white/[0.05] text-white/70 hover:bg-white/10 hover:text-white"
                }`}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 0 1 0 4h-.09c-.66 0-1.25.4-1.51 1Z" />
                </svg>
              </button>

              {settingsOpen && (
                <div className="absolute right-0 top-10 z-50 w-80 space-y-3.5 rounded-2xl border border-white/14 bg-ink-900/96 p-4 shadow-[0_24px_60px_rgba(0,0,0,0.65)] backdrop-blur-2xl">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">Library & Settings</span>
                    <button
                      type="button"
                      aria-label="Close settings"
                      onClick={() => setSettingsOpen(false)}
                      className="text-xs text-white/45 hover:text-white"
                    >
                      ✕
                    </button>
                  </div>

                  <form onSubmit={handleAddAndScan} className="space-y-2">
                    <label className="block text-[11px] text-white/55">Music Folder</label>
                    <div className="flex gap-1.5">
                      <input
                        aria-label="Local music folder path"
                        value={folderPath}
                        onChange={(e) => setFolderPath(e.target.value)}
                        placeholder="D:\Music"
                        className="field py-1.5 text-xs"
                      />
                      <button
                        type="submit"
                        disabled={!health}
                        className="btn-light shrink-0 px-3.5 py-1.5 text-[11px]"
                      >
                        Add & Scan
                      </button>
                    </div>
                  </form>

                  <div className="flex items-center justify-between border-t border-white/8 pt-3">
                    <div>
                      <p className="text-xs font-medium text-white/85">Auto-Prepare Stems</p>
                      <p className="text-[11px] text-white/45">Pre-separate next 2 queued tracks</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setAutoPrepareEnabled((v) => !v)}
                      className={`rounded-full px-3 py-1 text-[11px] font-semibold transition ${
                        autoPrepareEnabled && health?.demucs
                          ? "bg-white text-ink-950"
                          : "bg-white/10 text-white/60 hover:text-white"
                      }`}
                    >
                      {autoPrepareEnabled ? "On" : "Off"}
                    </button>
                  </div>

                  <div className="flex items-center gap-2 border-t border-white/8 pt-3">
                    <button
                      type="button"
                      onClick={() => void refresh()}
                      className="btn-ghost flex-1 py-1.5 text-[11px]"
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      disabled={!health}
                      onClick={() =>
                        void backupMetadata()
                          .then((b) =>
                            setStatusMsg(`SQLite backup saved: ${b.filename} (${b.size_bytes} bytes).`)
                          )
                          .catch((err) =>
                            setStatusMsg(err instanceof Error ? err.message : "Backup failed")
                          )
                      }
                      className="btn-ghost flex-1 py-1.5 text-[11px]"
                    >
                      Backup DB
                    </button>
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                setSettingsOpen(false);
                setTvMode(true);
              }}
              className="btn-primary px-4 py-1.5 text-xs"
              title="Enter Full-Screen TV Stage Mode (T)"
            >
              TV Stage Mode
            </button>
          </div>
        </header>
      )}

      {/* Main App Workspace */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Left Clean Segmented Sidebar (Library | Party) — kept mounted in TV mode so room sync never disconnects */}
        <aside
          aria-hidden={tvMode}
          className={`${
            tvMode ? "hidden" : "flex"
          } w-full shrink-0 flex-col border-b border-white/[0.06] bg-ink-900/95 p-3.5 lg:h-full lg:w-[348px] lg:overflow-hidden lg:border-b-0 lg:border-r`}
        >
          {/* Segmented Library / Party Switch */}
          <div
            role="tablist"
            aria-label="Sidebar view"
            className="mb-3 grid shrink-0 grid-cols-2 rounded-full border border-white/[0.08] bg-white/[0.04] p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === "library"}
              onClick={() => setSidebarTab("library")}
              className={`rounded-full py-1.5 text-xs font-semibold transition ${
                sidebarTab === "library"
                  ? "bg-white text-ink-950 shadow-sm"
                  : "text-white/60 hover:text-white"
              }`}
            >
              Library
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === "party"}
              onClick={() => setSidebarTab("party")}
              className={`flex items-center justify-center gap-1.5 rounded-full py-1.5 text-xs font-semibold transition ${
                sidebarTab === "party"
                  ? "bg-white text-ink-950 shadow-sm"
                  : "text-white/60 hover:text-white"
              }`}
            >
              {stageRoom?.active && (
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              )}
              <span>Party</span>
              {stageRoom?.active && stageRoom.queueCount > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                    sidebarTab === "party"
                      ? "bg-ink-950/15 text-ink-950"
                      : "bg-pink/25 text-pink"
                  }`}
                >
                  {stageRoom.queueCount}
                </span>
              )}
            </button>
          </div>

          {statusMsg && (
            <div className="mb-2.5 flex shrink-0 items-center justify-between gap-2 rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2">
              <p role="status" className="text-[11px] font-medium text-white/85">
                {statusMsg}
              </p>
              <button
                type="button"
                aria-label="Dismiss status message"
                onClick={() => setStatusMsg(null)}
                className="text-[10px] text-white/45 hover:text-white"
              >
                ✕
              </button>
            </div>
          )}

          {/* Library Tab */}
          <div className={`${sidebarTab === "library" ? "flex" : "hidden"} min-h-0 flex-1 flex-col gap-2.5`}>
            {/* Clean Live Search + Shuffle */}
            <div className="flex shrink-0 items-center gap-1.5">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void refresh(query);
                }}
                className="relative min-w-0 flex-1"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white/38"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  aria-label="Search indexed songs"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search songs, artists, albums..."
                  className="field py-2 pl-9 pr-8 text-xs"
                />
                {query && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setQuery("")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-[10px] text-white/45 hover:text-white"
                  >
                    ✕
                  </button>
                )}
              </form>

              <button
                type="button"
                disabled={songs.length === 0}
                onClick={() => void handleShufflePlay()}
                aria-label="Shuffle play library"
                title="Shuffle play your library (S)"
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition disabled:opacity-35 ${
                  shuffleEnabled
                    ? "border-pink/40 bg-pink/15 text-pink"
                    : "border-white/12 bg-white/[0.05] text-white/70 hover:bg-white/10 hover:text-white"
                }`}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22" />
                  <path d="m18 2 4 4-4 4" />
                  <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
                  <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" />
                  <path d="m18 14 4 4-4 4" />
                </svg>
              </button>
            </div>

            {/* Full-Height Spacious Tracklist */}
            <div className="thin-scroll min-h-[200px] flex-1 overflow-y-auto pr-0.5">
              {songs.length === 0 ? (
                <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center">
                  <p className="text-xs font-semibold text-white/75">
                    {query ? "No matching songs" : "Add your music folder"}
                  </p>
                  {!query && (
                    <form onSubmit={handleAddAndScan} className="w-full space-y-2">
                      <input
                        aria-label="Local music folder path"
                        value={folderPath}
                        onChange={(e) => setFolderPath(e.target.value)}
                        placeholder="D:\Music"
                        className="field py-1.5 text-center text-xs"
                      />
                      <button
                        type="submit"
                        disabled={!health}
                        className="btn-light w-full py-2 text-xs"
                      >
                        Add & Scan
                      </button>
                    </form>
                  )}
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {songs.map((song) => {
                    const isActive = activeSong?.id === song.id;
                    const cleanTitle = displayTitle(song.title);
                    const subLabel = song.artist || song.album || "";
                    return (
                      <li
                        key={song.id}
                        className={`track-row group flex items-center justify-between gap-2 rounded-xl px-2 py-1.5 transition ${
                          isActive ? "bg-white/[0.11]" : "hover:bg-white/[0.05]"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => selectSongForPlayback(song)}
                          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                        >
                          <Cover
                            title={song.title}
                            songId={song.id}
                            hasCover={song.has_cover !== false}
                            size={40}
                            className="rounded-lg shadow-sm"
                          />
                          <div className="min-w-0 flex-1">
                            <p
                              className={`truncate text-[13px] font-medium ${
                                isActive ? "text-white font-semibold" : "text-white/90"
                              }`}
                            >
                              {cleanTitle}
                            </p>
                            {subLabel && (
                              <p className="truncate text-[11px] text-white/45">{subLabel}</p>
                            )}
                          </div>
                        </button>

                        <div className="flex shrink-0 items-center gap-1">
                          {song.has_instrumental && (
                            <span
                              title="Instrumental ready"
                              className="flex h-5 w-5 items-center justify-center rounded-full text-white/45"
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                              </svg>
                            </span>
                          )}
                          <button
                            type="button"
                            aria-label="Play"
                            title={isActive ? "Now Playing" : `Play ${cleanTitle}`}
                            onClick={() => selectSongForPlayback(song)}
                            className={`flex h-7 w-7 items-center justify-center rounded-full transition ${
                              isActive
                                ? "bg-white text-ink-950 shadow-sm"
                                : "text-white/50 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-white/12 hover:text-white"
                            }`}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                              <polygon points="7,4 20,12 7,20" />
                            </svg>
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
          </div>

          {/* Party Room Tab (kept mounted so LAN/Cloud sync never disconnects when browsing Library) */}
          <div className={`${sidebarTab === "party" ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}>
            <HostRoomPanel
              hostConnected={Boolean(health)}
              onPlayHostSong={handlePlayHostSong}
              playbackSignal={playbackSignal}
              activeLyrics={activeLyrics}
              getPlaybackClock={getPlaybackClock}
              onStageRoomChange={setStageRoom}
              onReactionBurst={handleReactionBurst}
            />
          </div>
        </aside>

        {/* Right Main Full-Bleed Atmospheric Karaoke Stage */}
        <main
          aria-label="Karaoke Stage"
          className="relative flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-6 py-8 sm:px-10 lg:overflow-hidden lg:px-14"
        >
          {/* Flowing GPU-Composited Album-Adapted Backdrop */}
          <StageBackdrop
            songId={activeSong?.id}
            hasCover={activeSong?.has_cover}
            title={activeSong?.title}
            playing={!activeSong || isPlaying}
          />

          {/* Ultra-Discreet Apple Music–style Top-Right Controls in Full-Screen TV Stage Mode */}
          {tvMode && (
            <div className="absolute right-5 top-5 z-30 flex items-center gap-2 opacity-65 transition-opacity hover:opacity-100">
              {stageRoom?.active && (
                <button
                  type="button"
                  onClick={() => setShowTvOverlay((v) => !v)}
                  aria-label={showTvOverlay ? "Hide TV overlay" : "Show TV overlay"}
                  title={showTvOverlay ? "Hide QR Overlay (O)" : "Show QR Overlay (O)"}
                  className={`flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur-xl transition ${
                    showTvOverlay
                      ? "border-white/25 bg-black/35 text-white"
                      : "border-white/12 bg-black/20 text-white/60 hover:bg-black/35 hover:text-white"
                  }`}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <path d="M14 14h3v3h-3zM19 14h2v2h-2zM14 19h2v2h-2zM19 19h2v2h-2z" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={() => setTvMode(false)}
                aria-label="Exit TV Stage Mode"
                title="Exit TV Stage Mode (Esc / T)"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/25 text-white/85 backdrop-blur-xl transition hover:bg-black/45 hover:text-white"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* Floating Reactions, Up Next Toast, Auto-Prepare Status & TV QR Overlay */}
          <TvStageOverlay
            tvMode={tvMode}
            showOverlay={showTvOverlay}
            roomInfo={enrichedStageRoom}
            reactions={reactionBursts}
            remainingSec={remainingSec}
            durationSec={durationSec}
            isPlaying={isPlaying}
            hasActiveSong={Boolean(activeSong)}
            autoPreparingTitle={jobIsActive ? autoPrepTitle : null}
            autoPrepareProgress={jobIsActive && activeJob ? Math.round(activeJob.progress) : null}
          />

          {activeSong ? (
            <div
              className={`relative z-10 mx-auto grid w-full items-center gap-10 xl:gap-16 ${
                tvMode
                  ? "max-w-[1320px] xl:grid-cols-[410px_1fr]"
                  : "max-w-6xl xl:grid-cols-[340px_1fr]"
              }`}
            >
              {/* Left Artwork & Refined Centered Transport Pod */}
              <div
                className={`mx-auto w-full space-y-5 ${
                  tvMode ? "max-w-[400px]" : "max-w-[330px]"
                }`}
              >
                {/* Clean, Unobstructed Real Album Artwork */}
                <Cover
                  title={activeSong.title}
                  songId={activeSong.id}
                  hasCover={activeSong.has_cover !== false}
                  className="aspect-square w-full rounded-2xl text-6xl shadow-[0_28px_72px_rgba(0,0,0,0.48)] ring-1 ring-white/12"
                />

                {/* Centered Track Title, Artist — Album, and Quality Pill */}
                <div className="space-y-1 text-center">
                  <h2 className="truncate text-lg font-bold tracking-tight text-white sm:text-[21px]">
                    {displayTitle(activeSong.title)}
                  </h2>
                  <p className="truncate text-sm text-white/65" title={activeSubtitle}>
                    {activeSubtitle}
                  </p>
                  <div className="flex items-center justify-center gap-2 pt-0.5">
                    {qualityLabel && (
                      <span className="inline-flex items-center gap-1 font-mono text-[10px] tracking-wider text-white/50">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                          <path d="M4 12h2m3-5v10m4-13v16m4-11v6m3-3h0" />
                        </svg>
                        {qualityLabel}
                      </span>
                    )}
                    {audioMode !== "original" && (
                      <span className="rounded-full bg-white/15 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-white">
                        {audioMode}
                      </span>
                    )}
                  </div>
                </div>

                {/* Single-Row Airy Timeline Scrub Bar */}
                <div className="flex items-center gap-3">
                  <span className="w-9 font-mono text-[11px] tabular-nums text-white/60">
                    {formatSec(currentSec)}
                  </span>
                  <div className="relative flex flex-1 items-center">
                    <div className="pointer-events-none absolute inset-x-0 h-1 overflow-hidden rounded-full bg-white/20">
                      <div
                        className="h-full rounded-full bg-white/85"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
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
                      className="range relative z-10 h-1 w-full cursor-pointer bg-transparent"
                    />
                  </div>
                  <span className="w-10 text-right font-mono text-[11px] tabular-nums text-white/60">
                    -{formatSec(remainingSec)}
                  </span>
                </div>

                {/* Clean Horizontal Transport & Stem Control Strip */}
                <div className="relative flex items-center justify-between pt-0.5 text-white/80">
                  {/* Left: Volume + Stem Menu */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label={muted ? "Unmute audio" : "Mute audio"}
                      onClick={() => setShowVolumeSlider((v) => !v)}
                      onDoubleClick={() => setMuted((m) => !m)}
                      className="flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-white/12 hover:text-white"
                      title="Volume (click to adjust, M to mute)"
                    >
                      {muted || volume === 0 ? (
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                          <line x1="23" y1="9" x2="17" y2="15" />
                          <line x1="17" y1="9" x2="23" y2="15" />
                        </svg>
                      ) : (
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        </svg>
                      )}
                    </button>

                    <button
                      type="button"
                      aria-label="Toggle shuffle"
                      aria-pressed={shuffleEnabled}
                      onClick={() => setShuffleEnabled((v) => !v)}
                      className={`flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-white/12 hover:text-white ${
                        shuffleEnabled ? "bg-white/22 text-white" : ""
                      }`}
                      title={shuffleEnabled ? "Shuffle On (S)" : "Shuffle Off (S)"}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22" />
                        <path d="m18 2 4 4-4 4" />
                        <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
                        <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" />
                        <path d="m18 14 4 4-4 4" />
                      </svg>
                    </button>

                    <button
                      type="button"
                      aria-label="Audio stem options"
                      onClick={() => setStemMenuOpen((v) => !v)}
                      className={`flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-white/12 hover:text-white ${
                        stemMenuOpen ? "bg-white/15 text-white" : ""
                      }`}
                      title="Vocal / Instrumental stem options"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="2" />
                        <circle cx="12" cy="12" r="2" />
                        <circle cx="19" cy="12" r="2" />
                      </svg>
                    </button>
                  </div>

                  {/* Center: Previous / Play-Pause / Next */}
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => stepLibraryTrack(-1)}
                      aria-label="Previous track or restart"
                      className="flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-white/12 hover:text-white"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <polygon points="11 19 2 12 11 5 11 19" />
                        <polygon points="22 19 13 12 22 5 22 19" />
                      </svg>
                    </button>

                    <button
                      type="button"
                      onClick={togglePlayPause}
                      aria-label={isPlaying ? "Pause playback" : "Resume playback"}
                      className="flex h-11 w-11 items-center justify-center rounded-full text-white transition hover:scale-105 hover:bg-white/15 active:scale-95"
                    >
                      {isPlaying ? (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <rect x="6" y="4" width="4.2" height="16" rx="1.2" />
                          <rect x="13.8" y="4" width="4.2" height="16" rx="1.2" />
                        </svg>
                      ) : (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <polygon points="6 4 20 12 6 20 6 4" />
                        </svg>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => stepLibraryTrack(1)}
                      aria-label="Next track"
                      className="flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-white/12 hover:text-white"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <polygon points="13 19 22 12 13 5 13 19" />
                        <polygon points="2 19 11 12 2 5 2 19" />
                      </svg>
                    </button>
                  </div>

                  {/* Right: Quick Vocal/Instrumental Toggle + Lyrics Sync/Editor Button */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        if (activeSong.has_instrumental) {
                          if (audioMode !== "instrumental") {
                            switchAudioMode("instrumental");
                            setShowVocalSlider(true);
                          } else {
                            setShowVocalSlider((v) => !v);
                          }
                        } else if (!jobIsActive) {
                          void handlePrepare(activeSong.id, false);
                        }
                      }}
                      aria-label="Toggle instrumental karaoke mode"
                      title={
                        activeSong.has_instrumental
                          ? "Karaoke Vocal Mix (0%–100%)"
                          : "Prepare Instrumental Stem with Demucs"
                      }
                      className={`flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-white/12 hover:text-white ${
                        audioMode === "instrumental"
                          ? "bg-white/22 text-white"
                          : jobIsActive && activeJob?.song_id === activeSong.id
                            ? "animate-pulse bg-sky/25 text-sky"
                            : ""
                      }`}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" y1="19" x2="12" y2="22" />
                      </svg>
                    </button>

                    <button
                      type="button"
                      onClick={() => setLyricsEditorOpen((v) => !v)}
                      aria-label="Toggle lyrics editor and timing"
                      title="Edit / Sync Lyrics"
                      className={`flex h-9 w-9 items-center justify-center rounded-lg transition hover:bg-white/12 hover:text-white ${
                        lyricsEditorOpen ? "bg-white/22 text-white" : "bg-white/10 text-white/90"
                      }`}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        <path d="M8 9h8M8 13h5" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Real-Time Apple Music Sing–style Vocal Mix Slider (when instrumental stem is active) */}
                {showVocalSlider && activeSong.has_instrumental && audioMode === "instrumental" && (
                  <div className="flex items-center gap-2.5 rounded-full border border-white/15 bg-black/45 px-3.5 py-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-white/75">
                      Vocals
                    </span>
                    <input
                      type="range"
                      aria-label="Guide vocal volume"
                      min={0}
                      max={1}
                      step={0.02}
                      value={vocalMix}
                      onChange={(e) => setVocalMix(Number(e.target.value))}
                      className="range h-1 flex-1 cursor-pointer"
                    />
                    <span className="w-9 text-right font-mono text-[10px] text-white/70">
                      {Math.round(vocalMix * 100)}%
                    </span>
                  </div>
                )}

                {/* Inline Expandable Volume Bar */}
                {showVolumeSlider && (
                  <div className="flex items-center gap-2.5 rounded-full border border-white/12 bg-black/35 px-3.5 py-2 backdrop-blur-xl">
                    <button
                      type="button"
                      onClick={() => setMuted((m) => !m)}
                      className="font-mono text-[10px] uppercase tracking-wider text-white/75 hover:text-white"
                    >
                      {muted ? "Muted" : "Vol"}
                    </button>
                    <input
                      type="range"
                      aria-label="Master volume"
                      min={0}
                      max={1}
                      step={0.02}
                      value={muted ? 0 : volume}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setVolume(v);
                        if (v > 0 && muted) setMuted(false);
                      }}
                      className="range h-1 flex-1 cursor-pointer"
                    />
                    <span className="w-8 text-right font-mono text-[10px] text-white/60">
                      {muted ? "0%" : `${Math.round(volume * 100)}%`}
                    </span>
                  </div>
                )}

                {/* Inline Expandable Audio Stem & Preparation Panel */}
                {stemMenuOpen && (
                  <div className="space-y-3 rounded-2xl border border-white/14 bg-black/45 p-3.5 backdrop-blur-xl">
                    <div
                      className="flex justify-between rounded-full border border-white/10 bg-black/35 p-1 text-[11px]"
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
                                ? "bg-white text-ink-950 font-semibold"
                                : "text-white/70 hover:text-white disabled:opacity-30"
                            }`}
                          >
                            {mode}
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex items-center justify-between text-xs">
                      {jobIsActive && activeJob ? (
                        <button
                          type="button"
                          onClick={() =>
                            void cancelJob(activeJob.id)
                              .then(() => fetchJob(activeJob.id))
                              .then((j) => {
                                setActiveJob(j);
                                setAutoPrepTitle(null);
                              })
                          }
                          className="text-pink hover:underline"
                        >
                          Cancel Separation ({activeJob.progress}%)
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            void handlePrepare(activeSong.id, activeSong.has_instrumental)
                          }
                          className="text-white/80 transition hover:text-white"
                        >
                          {activeSong.has_instrumental
                            ? "Reprocess Instrumental"
                            : "Prepare Instrumental Stem"}
                        </button>
                      )}

                      {activeSong.has_instrumental && (
                        <button
                          type="button"
                          onClick={() => void handleClearCache(activeSong.id)}
                          className="text-white/55 hover:text-pink"
                        >
                          Clear Cache
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Right Spacious Lyrics Stage */}
              <div className="min-w-0">
                <LyricsPanel
                  song={activeSong}
                  audioRef={audioRef}
                  tvMode={tvMode}
                  editorOpen={lyricsEditorOpen}
                  onToggleEditor={() => setLyricsEditorOpen((v) => !v)}
                  onLyricsSynced={(syncedSongId) => {
                    setSongs((prev) =>
                      prev.map((s) => (s.id === syncedSongId ? { ...s, has_lyrics: true } : s))
                    );
                    setActiveSong((prev) =>
                      prev && prev.id === syncedSongId ? { ...prev, has_lyrics: true } : prev
                    );
                  }}
                  onLyricsChange={(data) => {
                    setActiveLyrics({
                      songId: data.songId,
                      title: activeSong.title,
                      artist: activeSong.artist,
                      lrcText: data.lrcText,
                      offsetMs: data.offsetMs,
                    });
                  }}
                />
              </div>
            </div>
          ) : (
            /* Clean Real-Library Quick Launch Grid (No Placeholders) */
            <div className="relative z-10 mx-auto w-full max-w-4xl space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-2xl font-bold tracking-[-0.03em] text-white sm:text-3xl">
                  Your Library
                </h2>
                <div className="flex items-center gap-2">
                  {songs.length > 8 && (
                    <button
                      type="button"
                      onClick={() => void rotateFeaturedSongs()}
                      aria-label="Show different songs"
                      title="Show different songs"
                      className="btn-ghost h-9 w-9 p-0 text-white/75 hover:text-white"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
                        <path d="M21 3v5h-5" />
                      </svg>
                    </button>
                  )}
                  {songs.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleShufflePlay()}
                      className="btn-ghost px-4 py-2 text-xs font-semibold text-white"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22" />
                        <path d="m18 2 4 4-4 4" />
                        <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
                        <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" />
                        <path d="m18 14 4 4-4 4" />
                      </svg>
                      <span>Shuffle</span>
                    </button>
                  )}
                  {stageRoom?.playNext && (
                    <button
                      type="button"
                      onClick={stageRoom.playNext}
                      className="btn-primary px-5 py-2 text-xs"
                    >
                      Play Up Next ({displayTitle(stageRoom.upNext[0]?.title ?? "Track")})
                    </button>
                  )}
                </div>
              </div>

              {songs.length > 0 ? (
                <div
                  onMouseEnter={() => {
                    featuredHoveredRef.current = true;
                  }}
                  onMouseLeave={() => {
                    featuredHoveredRef.current = false;
                  }}
                  className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-4"
                >
                  {(featuredSongs.length > 0 ? featuredSongs : songs.slice(0, 8)).map((song) => (
                    <button
                      key={song.id}
                      type="button"
                      onClick={() => selectSongForPlayback(song)}
                      className="group rounded-2xl p-2 text-left transition hover:bg-white/[0.06]"
                    >
                      <div className="relative overflow-hidden rounded-xl shadow-[0_12px_32px_rgba(0,0,0,0.45)]">
                        <Cover
                          title={song.title}
                          songId={song.id}
                          hasCover={song.has_cover !== false}
                          className="aspect-square w-full transition duration-300 group-hover:scale-[1.03]"
                        />
                        <span className="absolute bottom-2.5 right-2.5 flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white opacity-0 shadow-lg backdrop-blur-md transition duration-200 group-hover:opacity-100">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <polygon points="7,4 20,12 7,20" />
                          </svg>
                        </span>
                      </div>
                      <p className="mt-2.5 truncate text-[13px] font-semibold text-snow">
                        {displayTitle(song.title)}
                      </p>
                      <p className="truncate text-xs text-snow/50">
                        {[song.artist, song.album].filter(Boolean).join(" — ") || formatSec(song.duration_ms / 1000)}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="surface p-8 text-center">
                  <p className="text-sm text-snow/65">
                    Add your local music folder in the left sidebar (e.g. <code className="font-mono text-sky">D:\Music</code>) to start singing.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Persistent audio elements stay mounted across idle/stage transitions so tap-to-play unlocks autoplay synchronously */}
          <audio
            ref={audioRef}
            autoPlay
            src={activeSong ? mediaUrl(activeSong.id, audioMode) : undefined}
            onLoadedMetadata={() => {
              if (audioRef.current) {
                audioRef.current.volume = volume;
                audioRef.current.muted = muted;
                setDurationSec(audioRef.current.duration || 0);
                if (resumePosRef.current !== null) {
                  audioRef.current.currentTime = resumePosRef.current;
                  if (vocalAudioRef.current) {
                    vocalAudioRef.current.currentTime = resumePosRef.current;
                  }
                  resumePosRef.current = null;
                }
                if (shouldAutoPlayRef.current && audioRef.current.paused) {
                  void audioRef.current.play().catch(() => {});
                }
              }
            }}
            onCanPlay={() => {
              if (shouldAutoPlayRef.current && audioRef.current?.paused) {
                void audioRef.current.play().catch(() => {});
              }
            }}
            onTimeUpdate={() => {
              const primary = audioRef.current;
              if (!primary) return;
              setCurrentSec(primary.currentTime);
              const voc = vocalAudioRef.current;
              if (voc && Math.abs(voc.currentTime - primary.currentTime) > 0.14) {
                voc.currentTime = primary.currentTime;
              }
            }}
            onSeeked={() => {
              if (audioRef.current && vocalAudioRef.current) {
                vocalAudioRef.current.currentTime = audioRef.current.currentTime;
              }
              emitPlayback(audioRef.current?.paused ? "paused" : "playing");
            }}
            onError={() => {
              if (!activeSong) return;
              if (audioMode !== "original") {
                setStatusMsg("Instrumental unavailable; playing original.");
                setAudioMode("original");
              } else {
                setStatusMsg(
                  `Browser could not decode ${activeSong.codec || activeSong.format}. Try Microsoft Edge for ALAC/Dolby Audio or convert to MP3/FLAC.`
                );
              }
            }}
            onPlay={() => {
              shouldAutoPlayRef.current = false;
              setIsPlaying(true);
              emitPlayback("playing");
              if (vocalAudioRef.current && audioRef.current) {
                vocalAudioRef.current.currentTime = audioRef.current.currentTime;
                void vocalAudioRef.current.play().catch(() => {});
              }
            }}
            onPause={() => {
              setIsPlaying(false);
              emitPlayback("paused");
              vocalAudioRef.current?.pause();
            }}
            onEnded={() => {
              setIsPlaying(false);
              emitPlayback("ended");
              vocalAudioRef.current?.pause();
              if (!stageRoom?.playNext && shuffleEnabled) {
                void playNextShuffled(true);
              }
            }}
            className="sr-only"
          />

          {activeSong && audioMode === "instrumental" && activeSong.has_instrumental && (
            <audio
              ref={vocalAudioRef}
              key={`${activeSong.id}-vocal-mix`}
              src={mediaUrl(activeSong.id, "vocal")}
              preload="auto"
              onLoadedMetadata={() => {
                const voc = vocalAudioRef.current;
                const primary = audioRef.current;
                if (!voc || !primary) return;
                voc.volume = Math.max(0, Math.min(1, vocalMix * volume));
                voc.muted = muted || vocalMix <= 0.001;
                voc.currentTime = primary.currentTime;
                if (!primary.paused) void voc.play().catch(() => {});
              }}
              className="sr-only"
            />
          )}
        </main>
      </div>
    </div>
  );
}
