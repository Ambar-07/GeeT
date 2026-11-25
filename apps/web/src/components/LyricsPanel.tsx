import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  computeEffectiveTimeMs,
  findActiveLineIndex,
  getInterludeState,
  hasDevanagari,
  isInstrumentalLine,
  parseLrc,
  transliterateDevanagari,
  type InterludeState,
} from "@geet/lyrics";
import type { HostSong } from "@geet/shared";
import { fetchLyrics, lookupLyrics, saveLyrics } from "../lib/hostAgent";

interface LyricsPanelProps {
  song: HostSong;
  audioRef: RefObject<HTMLAudioElement | null>;
  tvMode?: boolean;
  editorOpen?: boolean;
  onToggleEditor?: () => void;
  onLyricsSynced?: (songId: string) => void;
  onLyricsChange?: (data: { songId: string; lrcText: string; offsetMs: number }) => void;
}

const OFFSET_STEPS = [-1000, -500, -100, 100, 500, 1000] as const;
const ROMANIZE_STORAGE_KEY = "geet_romanize_lyrics";

// Avoid repeating automatic LRCLIB network lookups for the same song in one session
const autoLookedUpSongIds = new Set<string>();

function BreatherDots({ litDots, large = false }: { litDots: number; large?: boolean }) {
  const dotSize = large ? "h-3.5 w-3.5" : "h-3 w-3";
  return (
    <div
      aria-label="Instrumental interlude"
      className="flex items-center gap-3 py-2 pl-0.5 transition-opacity duration-300"
    >
      {[1, 2, 3].map((dotNum) => {
        const lit = litDots >= dotNum;
        return (
          <span
            key={dotNum}
            className={`${dotSize} rounded-full transition-all duration-300 ${
              lit
                ? "scale-110 bg-white/95 shadow-[0_0_12px_rgba(255,255,255,0.45)]"
                : "scale-95 bg-white/25"
            }`}
          />
        );
      })}
    </div>
  );
}

export function LyricsPanel({
  song,
  audioRef,
  tvMode = false,
  editorOpen,
  onToggleEditor,
  onLyricsSynced,
  onLyricsChange,
}: LyricsPanelProps) {
  const [loadedSongId, setLoadedSongId] = useState<string | null>(null);
  const [lrcText, setLrcText] = useState("");
  const [offsetMs, setOffsetMs] = useState(0);
  const [source, setSource] = useState<"none" | "sidecar" | "manual" | "lrclib">("none");
  const [syncReady, setSyncReady] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [interlude, setInterlude] = useState<InterludeState | null>(null);
  const [internalEditing, setInternalEditing] = useState(false);
  const [showSyncDock, setShowSyncDock] = useState(false);
  const [autoFetching, setAutoFetching] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [romanize, setRomanize] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ROMANIZE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const editing = editorOpen ?? internalEditing;
  const setEditing = (next: boolean | ((v: boolean) => boolean)) => {
    if (onToggleEditor) {
      const target = typeof next === "function" ? next(editing) : next;
      if (target !== editing) onToggleEditor();
    } else {
      setInternalEditing(next);
    }
  };

  const stageRef = useRef<HTMLDivElement | null>(null);
  const activeLineRef = useRef<HTMLButtonElement | null>(null);
  const interludeRef = useRef<HTMLDivElement | null>(null);
  const onLyricsSyncedRef = useRef(onLyricsSynced);
  onLyricsSyncedRef.current = onLyricsSynced;
  const onLyricsChangeRef = useRef(onLyricsChange);
  onLyricsChangeRef.current = onLyricsChange;

  useEffect(() => {
    if (loadedSongId !== song.id) return;
    onLyricsChangeRef.current?.({ songId: song.id, lrcText, offsetMs });
  }, [song.id, loadedSongId, lrcText, offsetMs]);

  const lines = useMemo(
    () => parseLrc(lrcText, song.duration_ms || undefined),
    [lrcText, song.duration_ms]
  );

  // Fallback for tracks with embedded plain (unsynced) lyrics in ©lyr / USLT tags
  const plainLines = useMemo(() => {
    if (lines.length > 0 || !lrcText.trim()) return [];
    return lrcText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }, [lines.length, lrcText]);

  const hasNonLatin = useMemo(() => hasDevanagari(lrcText), [lrcText]);

  const romanizedSyncLines = useMemo(() => {
    if (!romanize || !hasNonLatin) return null;
    return lines.map((line) =>
      isInstrumentalLine(line.text) ? "" : transliterateDevanagari(line.text)
    );
  }, [lines, romanize, hasNonLatin]);

  const romanizedPlainLines = useMemo(() => {
    if (!romanize || !hasNonLatin) return null;
    return plainLines.map((line) => transliterateDevanagari(line));
  }, [plainLines, romanize, hasNonLatin]);

  function toggleRomanize() {
    setRomanize((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(ROMANIZE_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Ignore storage quota errors
      }
      return next;
    });
  }

  // Load lyrics for current track and auto-fetch from LRCLIB when unsynced
  useEffect(() => {
    let cancelled = false;
    setLoadedSongId(null);
    setLrcText("");
    setMsg(null);
    setActiveIdx(-1);
    setInterlude(null);
    setAutoFetching(false);

    fetchLyrics(song.id)
      .then(async (rec) => {
        if (cancelled) return;
        setLrcText(rec.lrc_text);
        setOffsetMs(rec.offset_ms);
        setSource(rec.source);
        setSyncReady(rec.synchronized_ready);
        setLoadedSongId(song.id);

        // Automatically query LRCLIB once per song when synced lyrics aren't cached yet
        if (
          !rec.synchronized_ready &&
          song.title.trim() &&
          song.artist.trim() &&
          !autoLookedUpSongIds.has(song.id)
        ) {
          autoLookedUpSongIds.add(song.id);
          setAutoFetching(true);
          try {
            const res = await lookupLyrics(song.id);
            if (cancelled) return;
            if (res.found && res.synced_lyrics) {
              const saved = await saveLyrics(song.id, {
                lrc_text: res.synced_lyrics,
                offset_ms: rec.offset_ms,
                source: "lrclib",
              });
              if (cancelled) return;
              setLrcText(saved.lrc_text);
              setOffsetMs(saved.offset_ms);
              setSource(saved.source);
              setSyncReady(saved.synchronized_ready);
              onLyricsSyncedRef.current?.(song.id);
            }
          } catch {
            // Silently keep embedded/empty state when offline or LRCLIB misses
          } finally {
            if (!cancelled) setAutoFetching(false);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setMsg(err instanceof Error ? err.message : "Failed to load lyrics");
      });

    return () => {
      cancelled = true;
    };
  }, [song.id, song.title, song.artist]);

  // Run RAF only while audio is actively playing; sync immediately on seek/timeupdate
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || lines.length === 0) return;

    let rafId = 0;

    const syncOnce = () => {
      const effMs = computeEffectiveTimeMs(audio.currentTime, offsetMs);
      const nextIdx = findActiveLineIndex(lines, effMs);
      setActiveIdx((prev) => (prev === nextIdx ? prev : nextIdx));

      const nextInterlude = getInterludeState(lines, effMs);
      setInterlude((prev) => {
        if (!prev && !nextInterlude) return prev;
        if (
          prev &&
          nextInterlude &&
          prev.kind === nextInterlude.kind &&
          prev.anchorIndex === nextInterlude.anchorIndex &&
          prev.litDots === nextInterlude.litDots
        ) {
          return prev;
        }
        return nextInterlude;
      });

      if (nextIdx >= 0 && !isInstrumentalLine(lines[nextIdx].text)) {
        const cur = lines[nextIdx];
        const span = Math.max(250, cur.endMs - cur.startMs);
        const pct = Math.round(Math.min(100, Math.max(12, ((effMs - cur.startMs) / span) * 100)));
        if (activeLineRef.current) {
          activeLineRef.current.style.setProperty("--sweep", `${pct}%`);
        }
      }
    };

    const tick = () => {
      syncOnce();
      if (!audio.paused && !audio.ended) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = 0;
      }
    };

    const startLoop = () => {
      if (!rafId) rafId = requestAnimationFrame(tick);
    };

    const stopLoop = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      syncOnce();
    };

    audio.addEventListener("play", startLoop);
    audio.addEventListener("pause", stopLoop);
    audio.addEventListener("ended", stopLoop);
    audio.addEventListener("seeked", syncOnce);
    audio.addEventListener("loadedmetadata", syncOnce);

    syncOnce();
    if (!audio.paused && !audio.ended) startLoop();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      audio.removeEventListener("play", startLoop);
      audio.removeEventListener("pause", stopLoop);
      audio.removeEventListener("ended", stopLoop);
      audio.removeEventListener("seeked", syncOnce);
      audio.removeEventListener("loadedmetadata", syncOnce);
    };
  }, [audioRef, lines, offsetMs, song.id]);

  // Smooth auto-scroll to active line or active mid-song interlude
  useEffect(() => {
    const container = stageRef.current;
    const targetEl =
      interlude && interlude.kind === "interlude" && interludeRef.current
        ? interludeRef.current
        : activeLineRef.current;
    if (!container || !targetEl) return;
    const targetTop = targetEl.offsetTop - container.clientHeight * 0.36 + targetEl.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  }, [activeIdx, interlude?.kind, interlude?.anchorIndex]);

  async function persist(
    nextText: string,
    nextOffset: number,
    nextSource: "manual" | "lrclib" | "sidecar"
  ) {
    const saved = await saveLyrics(song.id, {
      lrc_text: nextText,
      offset_ms: nextOffset,
      source: nextSource,
    });
    setLrcText(saved.lrc_text);
    setOffsetMs(saved.offset_ms);
    setSource(saved.source);
    setSyncReady(saved.synchronized_ready);
    if (saved.synchronized_ready) {
      onLyricsSyncedRef.current?.(song.id);
    }
  }

  async function adjustOffset(delta: number) {
    const next = delta === 0 ? 0 : offsetMs + delta;
    setOffsetMs(next);
    if (lrcText.trim()) {
      await persist(lrcText, next, source === "none" ? "manual" : source);
    }
  }

  async function handleLookup() {
    setMsg("Looking up LRCLIB...");
    try {
      const res = await lookupLyrics(song.id);
      if (res.found && res.synced_lyrics) {
        await persist(res.synced_lyrics, offsetMs, "lrclib");
        setEditing(false);
        setMsg("Synced lyrics loaded from LRCLIB.");
      } else {
        setMsg(res.reason ?? "No synced lyrics found.");
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "LRCLIB lookup failed");
    }
  }

  function seekToLine(startMs: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, (startMs + offsetMs) / 1000);
  }

  const sizeClass = tvMode
    ? "text-[26px] sm:text-[32px] lg:text-[38px]"
    : "text-[23px] sm:text-[28px] lg:text-[34px]";

  const romanSizeClass = tvMode
    ? "text-[16px] sm:text-[19px] lg:text-[22px]"
    : "text-[14px] sm:text-[17px] lg:text-[19px]";

  return (
    <div className="group/lyrics relative flex h-full flex-col justify-center">
      {lines.length > 0 ? (
        <div
          ref={stageRef}
          aria-live="polite"
          className={`lyrics-mask thin-scroll relative overflow-y-auto px-2 py-24 sm:px-4 lg:px-8 ${
            tvMode ? "h-[62vh] lg:h-[82vh]" : "h-[440px] lg:h-[72vh]"
          }`}
        >
          {/* Intro Countdown Dots */}
          {interlude?.kind === "intro" && (
            <div className="mb-7">
              <BreatherDots litDots={interlude.litDots} large={tvMode} />
            </div>
          )}

          <div className="space-y-6 sm:space-y-7">
            {lines.map((line, i) => {
              const blankCue = isInstrumentalLine(line.text);
              const isExplicitInterlude =
                blankCue && interlude?.kind === "interlude" && interlude.anchorIndex === i;

              // Explicit blank LRC cue line only expands into breather dots when active
              if (blankCue) {
                if (!isExplicitInterlude) return null;
                return (
                  <div key={`${line.startMs}-${i}-break`} ref={interludeRef}>
                    <BreatherDots litDots={interlude.litDots} large={tvMode} />
                  </div>
                );
              }

              const showTrailingInterlude =
                interlude?.kind === "interlude" && interlude.anchorIndex === i;
              const isActive = i === activeIdx && !showTrailingInterlude;
              const isPast = activeIdx >= 0 && (i < activeIdx || showTrailingInterlude);

              const toneClass = isActive
                ? "text-white font-bold"
                : isPast
                  ? "text-white/30 font-semibold hover:text-white/75"
                  : "text-white/44 font-semibold hover:text-white/85";

              const activeSweepStyle = isActive
                ? ({
                    "--sweep": "100%",
                    backgroundImage:
                      "linear-gradient(90deg, #FFFFFF 0%, #FFFFFF var(--sweep, 100%), rgba(255, 255, 255, 0.56) calc(var(--sweep, 100%) + 12%), rgba(255, 255, 255, 0.56) 100%)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                  } as React.CSSProperties)
                : undefined;

              const romanLine = romanizedSyncLines?.[i];

              return (
                <div key={`${line.startMs}-${i}`} className="space-y-5">
                  <button
                    ref={isActive ? activeLineRef : undefined}
                    type="button"
                    onClick={() => seekToLine(line.startMs)}
                    className={`block w-full text-left leading-[1.28] tracking-[-0.015em] transition-colors duration-150 ${sizeClass} ${toneClass}`}
                  >
                    <span style={activeSweepStyle} className="block">
                      {line.text}
                    </span>
                    {romanLine && romanLine !== line.text && (
                      <span
                        className={`mt-1 block font-medium leading-[1.35] tracking-normal transition-colors duration-150 ${romanSizeClass} ${
                          isActive
                            ? "text-white/85"
                            : isPast
                              ? "text-white/22"
                              : "text-white/35"
                        }`}
                      >
                        {romanLine}
                      </span>
                    )}
                  </button>

                  {showTrailingInterlude && (
                    <div ref={interludeRef}>
                      <BreatherDots litDots={interlude.litDots} large={tvMode} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : plainLines.length > 0 ? (
        <div
          className={`lyrics-mask thin-scroll relative overflow-y-auto px-2 py-16 sm:px-4 lg:px-8 ${
            tvMode ? "h-[62vh] lg:h-[82vh]" : "h-[440px] lg:h-[72vh]"
          }`}
        >
          {autoFetching && (
            <p className="mb-4 font-mono text-[11px] uppercase tracking-wider text-white/60">
              Checking LRCLIB for synced timing...
            </p>
          )}
          <div className="space-y-4">
            {plainLines.map((line, i) => {
              const romanLine = romanizedPlainLines?.[i];
              return (
                <div key={i}>
                  <p className="text-xl font-semibold leading-relaxed text-white/78 sm:text-2xl">
                    {line}
                  </p>
                  {romanLine && romanLine !== line && (
                    <p className="mt-0.5 text-sm font-medium text-white/48 sm:text-base">
                      {romanLine}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex h-[320px] flex-col items-center justify-center gap-4 rounded-2xl border border-white/10 bg-black/25 px-6 text-center">
          <p className="max-w-md text-sm text-white/70">
            {autoFetching
              ? "Searching LRCLIB for synced lyrics..."
              : "No lyrics embedded or sidecar .lrc found for this track."}
          </p>
          {!autoFetching && (
            <div className="flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => void handleLookup()}
                className="rounded-full bg-white/90 px-4 py-1.5 font-mono text-xs font-semibold text-ink-950 transition hover:bg-white"
              >
                Fetch from LRCLIB
              </button>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-full border border-white/20 bg-white/5 px-4 py-1.5 font-mono text-xs text-white/85 transition hover:bg-white/15"
              >
                Paste LRC
              </button>
            </div>
          )}
        </div>
      )}

      {/* Apple Music–style Bottom-Right Transliteration Toggle (visible when Devanagari lyrics are present) */}
      {hasNonLatin && (
        <button
          type="button"
          onClick={toggleRomanize}
          aria-pressed={romanize}
          aria-label="Toggle Hinglish transliteration"
          title={romanize ? "Hide Hinglish pronunciation" : "Show Hinglish pronunciation"}
          className={`absolute bottom-14 right-3 z-20 flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold backdrop-blur-md transition lg:right-8 ${
            romanize
              ? "border-white/40 bg-white text-ink-950 shadow-lg"
              : "border-white/18 bg-black/40 text-white/80 hover:bg-black/60 hover:text-white"
          }`}
        >
          <span className="leading-none">अ</span>
          <span className="opacity-50">/</span>
          <span className="font-mono text-[11px] leading-none">A</span>
        </button>
      )}

      {/* Discreet Hover-Revealed Calibration & Editor Bar */}
      <div
        className={`mt-2 space-y-2.5 lg:px-8 transition-opacity duration-200 ${
          editing || showSyncDock || msg || autoFetching
            ? "opacity-100"
            : "opacity-0 group-hover/lyrics:opacity-100 focus-within:opacity-100"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-full border border-white/12 bg-black/45 px-3.5 py-1.5">
          <div className="flex items-center gap-2 text-[11px] text-white/70">
            <span className="sr-only">Lyrics</span>
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                autoFetching ? "animate-pulse bg-sky" : syncReady ? "bg-sky" : "bg-pink"
              }`}
            />
            <span className="font-mono text-[10px] uppercase tracking-wider">
              {autoFetching
                ? "syncing lrclib..."
                : syncReady
                  ? `${source}`
                  : plainLines.length > 0
                    ? "embedded"
                    : "unsynced"}{" "}
              · {offsetMs >= 0 ? `+${offsetMs}` : offsetMs}ms
            </span>
          </div>

          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Lyrics offset calibration"
          >
            {OFFSET_STEPS.map((step) => (
              <button
                key={step}
                type="button"
                onClick={() => {
                  setShowSyncDock(true);
                  void adjustOffset(step);
                }}
                className="rounded-full px-2 py-0.5 font-mono text-[10px] text-white/65 transition hover:bg-white/15 hover:text-white"
              >
                {step > 0
                  ? `+${step === 1000 ? "1s" : `${step}ms`}`
                  : step === -1000
                    ? "-1s"
                    : `${step}ms`}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void adjustOffset(0)}
              className="rounded-full px-2 py-0.5 font-mono text-[10px] text-white/65 transition hover:bg-white/15 hover:text-white"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="ml-1 rounded-full border border-white/18 bg-white/10 px-2.5 py-0.5 font-mono text-[10px] text-white transition hover:bg-white/20"
            >
              {editing ? "Close" : "Edit LRC"}
            </button>
          </div>
        </div>

        {editing && (
          <div className="space-y-3 rounded-2xl border border-white/15 bg-black/70 p-4">
            <textarea
              aria-label="Timed LRC lyrics editor"
              value={lrcText}
              onChange={(e) => setLrcText(e.target.value)}
              rows={5}
              placeholder="[00:12.34] Paste timed LRC lyrics here..."
              className="field bg-black/40 font-mono text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void persist(lrcText, offsetMs, "manual").then(() => setEditing(false))}
                className="btn-light px-4 py-1.5 text-xs"
              >
                Save LRC
              </button>
              <button
                type="button"
                onClick={() => void handleLookup()}
                className="btn-ghost px-4 py-1.5 text-xs"
              >
                Lookup LRCLIB
              </button>
            </div>
          </div>
        )}

        {msg && (
          <p role="status" className="px-2 text-xs text-white/80">
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
