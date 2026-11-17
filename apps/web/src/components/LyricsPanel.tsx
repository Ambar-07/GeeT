import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { computeEffectiveTimeMs, findActiveLineIndex, parseLrc } from "@geet/lyrics";
import type { HostSong } from "@geet/shared";
import { fetchLyrics, lookupLyrics, saveLyrics } from "../lib/hostAgent";

interface LyricsPanelProps {
  song: HostSong;
  audioRef: RefObject<HTMLAudioElement | null>;
}

const OFFSET_STEPS = [-1000, -500, -100, 100, 500, 1000] as const;

export function LyricsPanel({ song, audioRef }: LyricsPanelProps) {
  const [lrcText, setLrcText] = useState("");
  const [offsetMs, setOffsetMs] = useState(0);
  const [source, setSource] = useState<"none" | "sidecar" | "manual" | "lrclib">("none");
  const [syncReady, setSyncReady] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [lineProgress, setLineProgress] = useState(0);
  const [introCueProgress, setIntroCueProgress] = useState(0);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const activeLineRef = useRef<HTMLButtonElement | null>(null);

  const lines = useMemo(
    () => parseLrc(lrcText, song.duration_ms || undefined),
    [lrcText, song.duration_ms]
  );

  useEffect(() => {
    let cancelled = false;
    setMsg(null);
    setActiveIdx(-1);
    setLineProgress(0);
    setIntroCueProgress(0);
    fetchLyrics(song.id)
      .then((rec) => {
        if (cancelled) return;
        setLrcText(rec.lrc_text);
        setOffsetMs(rec.offset_ms);
        setSource(rec.source);
        setSyncReady(rec.synchronized_ready);
        setEditing(!rec.synchronized_ready);
      })
      .catch((err) => {
        if (!cancelled) setMsg(err instanceof Error ? err.message : "Failed to load lyrics");
      });
    return () => {
      cancelled = true;
    };
  }, [song.id]);

  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio && lines.length > 0) {
        const effMs = computeEffectiveTimeMs(audio.currentTime, offsetMs);
        const nextIdx = findActiveLineIndex(lines, effMs);
        setActiveIdx((prev) => (prev === nextIdx ? prev : nextIdx));

        if (nextIdx >= 0) {
          const cur = lines[nextIdx];
          const span = Math.max(250, cur.endMs - cur.startMs);
          const pct = Math.min(1, Math.max(0, (effMs - cur.startMs) / span));
          setLineProgress(pct);
          setIntroCueProgress(0);
        } else {
          setLineProgress(0);
          const firstStart = lines[0].startMs;
          if (firstStart > 0 && effMs >= 0 && effMs < firstStart) {
            setIntroCueProgress(Math.min(1, Math.max(0, effMs / firstStart)));
          } else {
            setIntroCueProgress(0);
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [audioRef, lines, offsetMs]);

  useEffect(() => {
    const container = stageRef.current;
    const lineEl = activeLineRef.current;
    if (!container || !lineEl) return;
    const targetTop = lineEl.offsetTop - container.clientHeight * 0.42 + lineEl.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  }, [activeIdx]);

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

  const focusIdx = activeIdx >= 0 ? activeIdx : 0;
  const sweepPct = Math.round(Math.max(18, lineProgress * 100));

  return (
    <div className="flex h-full flex-col justify-between gap-4">
      {/* Unobstructed Apple Music Sing Lyrics Stage */}
      {lines.length > 0 ? (
        <div
          ref={stageRef}
          aria-live="polite"
          className="lyrics-mask thin-scroll relative h-[420px] overflow-y-auto px-2 py-20 lg:h-[500px] lg:px-6"
        >
          {/* Apple Music Sing 3-dot vocal cue before first lyric line */}
          {activeIdx === -1 && (
            <div
              aria-hidden="true"
              className="mb-5 flex items-center gap-2.5 pl-0.5 transition-opacity duration-300"
            >
              {[0, 1, 2].map((dotIdx) => {
                const lit = introCueProgress >= (dotIdx + 1) / 4;
                return (
                  <span
                    key={dotIdx}
                    className={`h-2.5 w-2.5 rounded-full transition-all duration-300 ${
                      lit
                        ? "scale-110 bg-snow shadow-[0_0_12px_rgba(252,255,255,0.85)]"
                        : "bg-snow/25"
                    }`}
                  />
                );
              })}
            </div>
          )}

          <div className="space-y-7">
            {lines.map((line, i) => {
              const isActive = i === activeIdx;
              const dist = Math.abs(i - focusIdx);
              const isPast = activeIdx >= 0 && i < activeIdx;

              const sizeAndTone = isActive
                ? "text-3xl sm:text-4xl lg:text-[44px] font-extrabold tracking-[-0.03em] scale-100"
                : dist === 0
                  ? "text-2xl sm:text-3xl lg:text-[36px] font-bold tracking-[-0.025em] text-snow/70 hover:text-snow"
                  : dist === 1
                    ? "text-2xl sm:text-3xl lg:text-[32px] font-bold tracking-[-0.02em] text-snow/42 blur-[0.6px] hover:blur-0 hover:text-snow/85"
                    : dist === 2
                      ? "text-xl sm:text-2xl lg:text-[28px] font-semibold tracking-[-0.015em] text-snow/24 blur-[1.4px] hover:blur-0 hover:text-snow/75"
                      : "text-lg sm:text-xl lg:text-[24px] font-semibold text-snow/14 blur-[2.2px] hover:blur-0 hover:text-snow/65";

              const activeFillStyle = isActive
                ? {
                    backgroundImage: `linear-gradient(90deg, #FCFFFF 0%, #FCFFFF ${sweepPct}%, rgba(252, 255, 255, 0.42) ${Math.min(100, sweepPct + 10)}%, rgba(252, 255, 255, 0.42) 100%)`,
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    filter: "drop-shadow(0 4px 24px rgba(5, 147, 198, 0.22))",
                  }
                : undefined;

              return (
                <button
                  key={`${line.startMs}-${i}`}
                  ref={isActive ? activeLineRef : undefined}
                  type="button"
                  onClick={() => seekToLine(line.startMs)}
                  style={activeFillStyle}
                  className={`block w-full origin-left text-left leading-[1.14] transition-all duration-500 ease-out ${sizeAndTone} ${
                    isPast ? "opacity-60" : ""
                  }`}
                >
                  {line.text || "♪"}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="surface flex h-[320px] items-center justify-center px-6 text-center">
          <p className="max-w-md text-sm text-snow/55">
            No timed lyrics loaded yet. Paste an LRC file or run an LRCLIB lookup below to start singing.
          </p>
        </div>
      )}

      {/* Subtle Bottom-Docked Studio Sync & Editor Dock */}
      <div className="space-y-3 pt-1 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] pt-3 opacity-65 transition-opacity hover:opacity-100 focus-within:opacity-100">
          <div className="flex flex-wrap items-center gap-2.5 text-[11px]">
            <span className="sr-only">Lyrics</span>
            <span className="inline-flex items-center gap-1.5 font-mono uppercase tracking-[0.12em] text-snow/70">
              <span
                className={`h-1.5 w-1.5 rounded-full ${syncReady ? "bg-sky" : "bg-pink"}`}
              />
              {syncReady ? `Synced (${source})` : "Not synchronized"}
            </span>
            <span className="text-white/15">•</span>
            <span className="font-mono text-[11px] text-snow/50">Offset: {offsetMs} ms</span>
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
                onClick={() => void adjustOffset(step)}
                className="rounded-sm px-2 py-0.5 font-mono text-[10px] text-snow/60 transition hover:bg-white/10 hover:text-snow"
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
              className="rounded-sm px-2 py-0.5 font-mono text-[10px] text-snow/60 transition hover:bg-white/10 hover:text-snow"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="btn-ghost ml-1.5 px-2.5 py-1 text-[10px]"
            >
              {editing ? "Close Editor" : "Edit / Import"}
            </button>
          </div>
        </div>

        {editing && (
          <div className="surface space-y-3 p-4">
            <textarea
              aria-label="Timed LRC lyrics editor"
              value={lrcText}
              onChange={(e) => setLrcText(e.target.value)}
              rows={5}
              placeholder="[00:12.34] Paste timed LRC lyrics here..."
              className="field font-mono text-xs"
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
          <p role="status" className="text-xs text-snow/70">
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
