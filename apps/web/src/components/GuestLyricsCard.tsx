import { useEffect, useMemo, useRef, useState } from "react";
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
import { Cover, StageBackdrop, displayTitle } from "./Cover";

const ROMANIZE_STORAGE_KEY = "geet_romanize_lyrics";

const FULLSCREEN_REACTIONS = [
  { label: "Clap", icon: "👏" },
  { label: "Encore", icon: "🔥" },
  { label: "Cheer", icon: "🎉" },
  { label: "Sing", icon: "🎤" },
] as const;

export interface GuestLyricsCardProps {
  songTitle: string;
  songArtist?: string;
  durationMs?: number;
  coverSrc?: string;
  lrcText: string;
  offsetMs: number;
  playbackStatus: "idle" | "playing" | "paused" | "ended";
  anchorPositionMs: number;
  anchorLocalMs: number;
  loading?: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onSendReaction?: (label: string) => void;
  reactionCooldown?: boolean;
}

function GuestBreatherDots({ litDots }: { litDots: number }) {
  return (
    <div aria-label="Instrumental interlude" className="flex items-center gap-2.5 py-1.5">
      {[1, 2, 3].map((dotNum) => {
        const lit = litDots >= dotNum;
        return (
          <span
            key={dotNum}
            className={`h-2.5 w-2.5 rounded-full transition-all duration-300 ${lit
                ? "scale-110 bg-white/95 shadow-[0_0_10px_rgba(255,255,255,0.45)]"
                : "scale-95 bg-white/25"
              }`}
          />
        );
      })}
    </div>
  );
}

export function GuestLyricsCard({
  songTitle,
  songArtist,
  durationMs,
  coverSrc,
  lrcText,
  offsetMs,
  playbackStatus,
  anchorPositionMs,
  anchorLocalMs,
  loading = false,
  fullscreen,
  onToggleFullscreen,
  onSendReaction,
  reactionCooldown = false,
}: GuestLyricsCardProps) {
  const [activeIdx, setActiveIdx] = useState(-1);
  const [interlude, setInterlude] = useState<InterludeState | null>(null);
  const [romanize, setRomanize] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ROMANIZE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeLineRef = useRef<HTMLDivElement | null>(null);
  const interludeRef = useRef<HTMLDivElement | null>(null);

  const lines = useMemo(
    () => parseLrc(lrcText, durationMs && durationMs > 0 ? durationMs : undefined),
    [lrcText, durationMs]
  );

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
        // Ignore storage errors
      }
      return next;
    });
  }

  // Smooth interpolated clock driven by host playback checkpoint
  useEffect(() => {
    if (lines.length === 0) {
      setActiveIdx(-1);
      setInterlude(null);
      return;
    }

    let rafId = 0;

    const syncOnce = () => {
      const elapsedMs =
        playbackStatus === "playing" ? Math.max(0, performance.now() - anchorLocalMs) : 0;
      const estimatedSec = (anchorPositionMs + elapsedMs) / 1000;
      const effMs = computeEffectiveTimeMs(estimatedSec, offsetMs);
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
    };

    const tick = () => {
      syncOnce();
      if (playbackStatus === "playing") {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = 0;
      }
    };

    syncOnce();
    if (playbackStatus === "playing") {
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [lines, offsetMs, playbackStatus, anchorPositionMs, anchorLocalMs]);

  // Smooth auto-scroll to active line or active mid-song interlude
  useEffect(() => {
    const container = scrollerRef.current;
    const targetEl =
      interlude && interlude.kind === "interlude" && interludeRef.current
        ? interludeRef.current
        : activeLineRef.current;
    if (!container || !targetEl) return;
    const targetTop = targetEl.offsetTop - container.clientHeight * 0.36 + targetEl.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  }, [activeIdx, interlude?.kind, interlude?.anchorIndex, fullscreen]);

  // Close full-screen view with Escape
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, onToggleFullscreen]);

  const lyricsBody = (
    <div className="relative">
      {loading && lines.length === 0 && plainLines.length === 0 ? (
        <p className="py-8 text-center text-xs text-snow/50">Syncing live lyrics...</p>
      ) : lines.length > 0 ? (
        <div
          ref={scrollerRef}
          aria-live="polite"
          className={`lyrics-mask thin-scroll relative overflow-y-auto px-1 ${fullscreen ? "h-[calc(100dvh-188px)] py-20" : "h-[220px] py-12"
            }`}
        >
          {interlude?.kind === "intro" && (
            <div className="mb-4">
              <GuestBreatherDots litDots={interlude.litDots} />
            </div>
          )}

          <div className={fullscreen ? "space-y-6" : "space-y-3.5"}>
            {lines.map((line, i) => {
              const blankCue = isInstrumentalLine(line.text);
              const isExplicitInterlude =
                blankCue && interlude?.kind === "interlude" && interlude.anchorIndex === i;

              if (blankCue) {
                if (!isExplicitInterlude) return null;
                return (
                  <div key={`${line.startMs}-${i}-break`} ref={interludeRef}>
                    <GuestBreatherDots litDots={interlude.litDots} />
                  </div>
                );
              }

              const showTrailingInterlude =
                interlude?.kind === "interlude" && interlude.anchorIndex === i;
              const isActive = i === activeIdx && !showTrailingInterlude;
              const isPast = activeIdx >= 0 && (i < activeIdx || showTrailingInterlude);
              const romanLine = romanizedSyncLines?.[i];

              return (
                <div key={`${line.startMs}-${i}`} className="space-y-3">
                  <div
                    ref={isActive ? activeLineRef : undefined}
                    className={`transition-colors duration-200 ${fullscreen ? "text-2xl sm:text-3xl leading-[1.3]" : "text-lg leading-[1.32]"
                      } ${isActive
                        ? "font-bold text-white"
                        : isPast
                          ? "font-semibold text-white/30"
                          : "font-semibold text-white/48"
                      }`}
                  >
                    <p>{line.text}</p>
                    {romanLine && romanLine !== line.text && (
                      <p
                        className={`mt-1 font-medium ${fullscreen ? "text-base sm:text-lg" : "text-xs sm:text-sm"
                          } ${isActive
                            ? "text-white/85"
                            : isPast
                              ? "text-white/22"
                              : "text-white/36"
                          }`}
                      >
                        {romanLine}
                      </p>
                    )}
                  </div>
                  {showTrailingInterlude && (
                    <div ref={interludeRef}>
                      <GuestBreatherDots litDots={interlude.litDots} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : plainLines.length > 0 ? (
        <div
          className={`lyrics-mask thin-scroll overflow-y-auto px-1 ${fullscreen ? "h-[calc(100dvh-188px)] py-12" : "h-[200px] py-8"
            }`}
        >
          <div className="space-y-3">
            {plainLines.map((line, i) => {
              const romanLine = romanizedPlainLines?.[i];
              return (
                <div key={i}>
                  <p
                    className={`font-semibold text-white/80 ${fullscreen ? "text-xl leading-relaxed" : "text-sm leading-relaxed"
                      }`}
                  >
                    {line}
                  </p>
                  {romanLine && romanLine !== line && (
                    <p className="mt-0.5 text-xs font-medium text-white/48 sm:text-sm">
                      {romanLine}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="py-6 text-center text-xs text-snow/45">
          No lyrics loaded for this track yet.
        </p>
      )}
    </div>
  );

  if (fullscreen) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Live Sing-Along Lyrics"
        className="fixed inset-0 z-50 flex flex-col bg-ink-950 px-5 py-4 text-snow"
      >
        <StageBackdrop
          coverSrc={coverSrc}
          title={songTitle}
          playing={playbackStatus === "playing"}
        />
        <div className="relative z-10 mx-auto flex w-full max-w-2xl items-center justify-between gap-3 border-b border-white/12 pb-3">
          <div className="flex min-w-0 items-center gap-3">
            <Cover
              title={songTitle}
              coverSrc={coverSrc}
              size={42}
              className="rounded-lg shadow-md"
            />
            <div className="min-w-0">
              <p className="eyebrow text-sky">
                Live Lyrics · {playbackStatus === "paused" ? "Paused" : "Synced"}
              </p>
              <p className="truncate text-sm font-bold text-white">
                {displayTitle(songTitle)}
                {songArtist ? ` — ${songArtist}` : ""}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {hasNonLatin && (
              <button
                type="button"
                onClick={toggleRomanize}
                aria-pressed={romanize}
                aria-label="Toggle Hinglish transliteration"
                className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${romanize
                    ? "border-white/40 bg-white text-ink-950"
                    : "border-white/18 bg-white/10 text-white/85 hover:bg-white/20"
                  }`}
              >
                <span>अ</span>
                <span className="opacity-50">/</span>
                <span className="font-mono text-[11px]">A</span>
              </button>
            )}
            <button
              type="button"
              onClick={onToggleFullscreen}
              className="btn-ghost px-3 py-1.5 text-xs"
            >
              Done
            </button>
          </div>
        </div>

        <div className="relative z-10 mx-auto w-full max-w-2xl flex-1">{lyricsBody}</div>

        {onSendReaction && (
          <div className="relative z-10 mx-auto flex w-full max-w-2xl items-center justify-center gap-2 border-t border-white/12 pt-3">
            {FULLSCREEN_REACTIONS.map(({ label, icon }) => (
              <button
                key={label}
                type="button"
                disabled={reactionCooldown}
                onClick={() => onSendReaction(label)}
                className="btn-ghost px-3 py-1.5 text-xs"
              >
                <span aria-hidden="true">{icon}</span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${lines.length > 0 && playbackStatus === "playing"
                ? "animate-pulse bg-sky"
                : "bg-white/35"
              }`}
          />
          <span className="text-xs font-medium text-white/65">
            {lines.length > 0 ? "Live Lyrics" : "Lyrics"}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {hasNonLatin && (
            <button
              type="button"
              onClick={toggleRomanize}
              aria-pressed={romanize}
              aria-label="Toggle Hinglish transliteration"
              title={romanize ? "Hide Hinglish pronunciation" : "Show Hinglish pronunciation"}
              className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${romanize
                  ? "border-white/40 bg-white text-ink-950"
                  : "border-white/15 bg-white/8 text-white/80 hover:bg-white/15"
                }`}
            >
              <span>अ</span>
              <span className="opacity-50">/</span>
              <span className="font-mono text-[10px]">A</span>
            </button>
          )}
          {(lines.length > 0 || plainLines.length > 0) && (
            <button
              type="button"
              onClick={onToggleFullscreen}
              className="btn-ghost px-3 py-1 text-[11px]"
            >
              Expand
            </button>
          )}
        </div>
      </div>

      {lyricsBody}
    </div>
  );
}
