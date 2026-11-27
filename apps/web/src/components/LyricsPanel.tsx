import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  computeEffectiveTimeMs,
  findActiveLineIndex,
  getInterludeState,
  getLineWords,
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
  const [saving, setSaving] = useState(false);
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
  const manualScrollUntilRef = useRef<number>(0);
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

  const lineWordsMap = useMemo(
    () => lines.map((line) => (isInstrumentalLine(line.text) ? [] : getLineWords(line))),
    [lines]
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
    manualScrollUntilRef.current = 0;

    fetchLyrics(song.id)
      .then(async (rec) => {
        if (cancelled) return;
        setLrcText(rec.lrc_text);
        setOffsetMs(rec.offset_ms);
        setSource(rec.source);
        setSyncReady(rec.synchronized_ready);
        setLoadedSongId(song.id);

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

  // 60 FPS word-by-word illumination + critically-damped spring scroll glide (zero React re-renders per frame)
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || lines.length === 0) return;

    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let rafId = 0;
    let lastTs = performance.now();

    const syncFrame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;

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

      // Update per-word progressive glow directly on DOM spans
      const lineBtn = activeLineRef.current;
      if (lineBtn && nextIdx >= 0 && !isInstrumentalLine(lines[nextIdx].text)) {
        const words = lineWordsMap[nextIdx];
        if (words && words.length > 0) {
          const wordEls = lineBtn.querySelectorAll<HTMLElement>("[data-word-idx]");
          for (let i = 0; i < wordEls.length && i < words.length; i++) {
            const w = words[i];
            const el = wordEls[i];
            const span = Math.max(60, w.endMs - w.startMs);
            if (effMs < w.startMs) {
              el.style.setProperty("--wf", "0%");
              if (el.dataset.state !== "upcoming") el.dataset.state = "upcoming";
            } else if (effMs >= w.endMs) {
              el.style.setProperty("--wf", "100%");
              if (el.dataset.state !== "past") el.dataset.state = "past";
            } else {
              const pct = ((effMs - w.startMs) / span) * 100;
              el.style.setProperty("--wf", `${pct.toFixed(1)}%`);
              if (el.dataset.state !== "singing") el.dataset.state = "singing";
            }
          }
        }
      }

      // Critically-damped glide scroll toward active focal line (yields if user manually scrolls)
      const container = stageRef.current;
      const targetEl =
        nextInterlude && nextInterlude.kind === "interlude" && interludeRef.current
          ? interludeRef.current
          : activeLineRef.current;

      if (container && targetEl && now > manualScrollUntilRef.current) {
        const targetTop = Math.max(
          0,
          targetEl.offsetTop - container.clientHeight * 0.34 + targetEl.clientHeight / 2
        );
        const diff = targetTop - container.scrollTop;
        if (reducedMotion || Math.abs(diff) < 0.6) {
          if (Math.abs(diff) >= 0.5) container.scrollTop = targetTop;
        } else {
          // Smooth Apple Music exponential glide
          container.scrollTop += diff * (1 - Math.exp(-7.2 * dt));
        }
      }
    };

    const tick = (now: number) => {
      syncFrame(now);
      const container = stageRef.current;
      const targetEl = interludeRef.current ?? activeLineRef.current;
      const stillGliding =
        Boolean(container && targetEl && now > manualScrollUntilRef.current) &&
        Math.abs(
          Math.max(0, targetEl!.offsetTop - container!.clientHeight * 0.34 + targetEl!.clientHeight / 2) -
            container!.scrollTop
        ) > 1.2;

      if ((!audio.paused && !audio.ended) || stillGliding) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = 0;
      }
    };

    const startLoop = () => {
      lastTs = performance.now();
      if (!rafId) rafId = requestAnimationFrame(tick);
    };

    const onInstantSync = () => {
      manualScrollUntilRef.current = 0;
      syncFrame(performance.now());
      startLoop();
    };

    const onPauseOrEnd = () => {
      syncFrame(performance.now());
    };

    audio.addEventListener("play", startLoop);
    audio.addEventListener("pause", onPauseOrEnd);
    audio.addEventListener("ended", onPauseOrEnd);
    audio.addEventListener("seeked", onInstantSync);
    audio.addEventListener("loadedmetadata", onInstantSync);

    syncFrame(performance.now());
    if (!audio.paused && !audio.ended) startLoop();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      audio.removeEventListener("play", startLoop);
      audio.removeEventListener("pause", onPauseOrEnd);
      audio.removeEventListener("ended", onPauseOrEnd);
      audio.removeEventListener("seeked", onInstantSync);
      audio.removeEventListener("loadedmetadata", onInstantSync);
    };
  }, [audioRef, lines, lineWordsMap, offsetMs, song.id]);

  // Pause auto-glide gently for 3.5s whenever user manually scrolls with mouse/touch
  useEffect(() => {
    const container = stageRef.current;
    if (!container) return;
    const pauseAutoGlide = () => {
      manualScrollUntilRef.current = performance.now() + 3500;
    };
    container.addEventListener("wheel", pauseAutoGlide, { passive: true });
    container.addEventListener("touchstart", pauseAutoGlide, { passive: true });
    return () => {
      container.removeEventListener("wheel", pauseAutoGlide);
      container.removeEventListener("touchstart", pauseAutoGlide);
    };
  }, [lines.length]);

  async function persist(
    nextText: string,
    nextOffset: number,
    nextSource: "manual" | "lrclib" | "sidecar"
  ) {
    setSaving(true);
    try {
      const saved = await saveLyrics(song.id, {
        lrc_text: nextText,
        offset_ms: nextOffset,
        source: nextSource,
      });
      setLrcText(saved.lrc_text);
      setOffsetMs(saved.offset_ms);
      setSource(saved.source);
      setSyncReady(saved.synchronized_ready);
      setMsg("Lyrics saved.");
      if (saved.synchronized_ready) onLyricsSyncedRef.current?.(song.id);
      return true;
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not save lyrics. Please try again.");
      return false;
    } finally {
      setSaving(false);
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
        if (!(await persist(res.synced_lyrics, offsetMs, "lrclib"))) return;
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
    manualScrollUntilRef.current = 0;
    audio.currentTime = Math.max(0, (startMs + offsetMs) / 1000);
  }

  const sizeClass = tvMode
    ? "text-[28px] sm:text-[34px] lg:text-[42px]"
    : "text-[24px] sm:text-[29px] lg:text-[35px]";

  const romanSizeClass = tvMode
    ? "text-[16px] sm:text-[19px] lg:text-[22px]"
    : "text-[14px] sm:text-[17px] lg:text-[19px]";

  return (
    <div className="group/lyrics relative flex h-full flex-col justify-center">
      {lines.length > 0 ? (
        <div
          ref={stageRef}
          aria-live="polite"
          className={`lyrics-mask thin-scroll relative overflow-y-auto px-2 py-28 sm:px-4 lg:px-8 ${
            tvMode ? "h-[64dvh] lg:h-[78dvh]" : "h-[380px] lg:h-[62dvh]"
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
              const dist = activeIdx >= 0 ? i - activeIdx : i;

              // Apple Music depth cascade: active crisp & 1.0x, upcoming softens gently with distance
              const depthStyle: React.CSSProperties = isActive
                ? { transform: "scale(1)", opacity: 1, filter: "none" }
                : isPast
                  ? { transform: "scale(0.965)", opacity: 0.24, filter: "blur(0.6px)" }
                  : dist === 1
                    ? { transform: "scale(0.975)", opacity: 0.48, filter: "none" }
                    : dist === 2
                      ? { transform: "scale(0.962)", opacity: 0.34, filter: "blur(0.4px)" }
                      : { transform: "scale(0.95)", opacity: 0.22, filter: "blur(0.85px)" };

              const romanLine = romanizedSyncLines?.[i];
              const words = lineWordsMap[i];

              return (
                <div key={`${line.startMs}-${i}`} className="space-y-5">
                  <button
                    ref={isActive ? activeLineRef : undefined}
                    type="button"
                    onClick={() => seekToLine(line.startMs)}
                    style={depthStyle}
                    className={`lyric-line block w-full text-left leading-[1.26] tracking-[-0.018em] ${sizeClass} ${
                      isActive ? "font-bold text-white" : "font-semibold text-white"
                    }`}
                  >
                    <span className="block">
                      {isActive && words && words.length > 0
                        ? words.map((w, wIdx) => (
                            <span key={wIdx}>
                              <span data-word-idx={wIdx} data-state="upcoming" className="lyric-word">
                                {w.text}
                              </span>
                              {w.trailingSpace}
                            </span>
                          ))
                        : line.text}
                    </span>
                    {romanLine && romanLine !== line.text && (
                      <span
                        className={`mt-1 block font-medium leading-[1.35] tracking-normal transition-colors duration-200 ${romanSizeClass} ${
                          isActive ? "text-white/85" : "text-white/55"
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
            tvMode ? "h-[64dvh] lg:h-[78dvh]" : "h-[380px] lg:h-[62dvh]"
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

      {/* Discreet Hover-Revealed Sync, Transliteration & Editor Pill */}
      <div
        className={`lyrics-dock mt-2 space-y-2.5 transition-opacity duration-200 lg:px-8 ${
          editing || showSyncDock || msg || autoFetching
            ? "opacity-100"
            : "opacity-0 group-hover/lyrics:opacity-100 focus-within:opacity-100"
        }`}
      >
        <div className="inline-flex items-center gap-1 rounded-full border border-white/[0.14] bg-black/50 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.45)] backdrop-blur-xl">
          <div
            className="flex items-center gap-0.5"
            role="group"
            aria-label="Lyrics offset calibration"
          >
            <button
              type="button"
              disabled={saving}
              aria-label="Shift lyrics earlier"
              title="Earlier (-0.25s · Shift for -1s)"
              onClick={(e) => {
                setShowSyncDock(true);
                void adjustOffset(e.shiftKey ? -1000 : -250);
              }}
              className="flex h-7 w-7 items-center justify-center rounded-full text-sm font-medium text-white/75 transition hover:bg-white/14 hover:text-white disabled:opacity-40"
            >
              −
            </button>

            <button
              type="button"
              disabled={saving || offsetMs === 0}
              title={offsetMs === 0 ? `Lyrics source: ${source}` : "Click to reset timing offset"}
              onClick={() => void adjustOffset(0)}
              className="flex h-7 min-w-[66px] items-center justify-center gap-1.5 rounded-full px-2 font-mono text-[11px] text-white/80 transition hover:bg-white/10 disabled:cursor-default disabled:hover:bg-transparent"
            >
              <span>
                {autoFetching
                  ? "Syncing"
                  : offsetMs === 0
                    ? "Sync"
                    : `${offsetMs > 0 ? "+" : ""}${(offsetMs / 1000).toFixed(2).replace(/\.?0+$/, "")}s`}
              </span>
            </button>

            <button
              type="button"
              disabled={saving}
              aria-label="Shift lyrics later"
              title="Later (+0.25s · Shift for +1s)"
              onClick={(e) => {
                setShowSyncDock(true);
                void adjustOffset(e.shiftKey ? 1000 : 250);
              }}
              className="flex h-7 w-7 items-center justify-center rounded-full text-sm font-medium text-white/75 transition hover:bg-white/14 hover:text-white disabled:opacity-40"
            >
              +
            </button>
          </div>

          {hasNonLatin && (
            <>
              <span className="mx-0.5 h-3.5 w-px bg-white/14" aria-hidden="true" />
              <button
                type="button"
                onClick={toggleRomanize}
                aria-pressed={romanize}
                aria-label="Toggle Hinglish transliteration"
                title={romanize ? "Hide Hinglish pronunciation" : "Show Hinglish pronunciation"}
                className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold transition ${
                  romanize
                    ? "bg-white text-ink-950"
                    : "text-white/80 hover:bg-white/14 hover:text-white"
                }`}
              >
                <span className="leading-none">अ</span>
                <span className="opacity-45">/</span>
                <span className="font-mono text-[10px] leading-none">A</span>
              </button>
            </>
          )}

          <span className="mx-0.5 h-3.5 w-px bg-white/14" aria-hidden="true" />

          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className={`inline-flex h-7 items-center rounded-full px-3 text-[11px] font-medium transition ${
              editing
                ? "bg-white text-ink-950"
                : "bg-white/[0.1] text-white/90 hover:bg-white/[0.18] hover:text-white"
            }`}
          >
            {editing ? "Done" : "Edit"}
          </button>
        </div>

        {editing && (
          <div className="space-y-3 rounded-2xl border border-white/15 bg-black/75 p-4 backdrop-blur-xl">
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
                disabled={saving}
                onClick={() =>
                  void persist(lrcText, offsetMs, "manual").then((ok) => {
                    if (ok) setEditing(false);
                  })
                }
                className="btn-light px-4 py-1.5 text-xs"
              >
                {saving ? "Saving…" : "Save LRC"}
              </button>
              <button
                type="button"
                disabled={saving}
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
