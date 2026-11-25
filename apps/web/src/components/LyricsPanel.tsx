import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { computeEffectiveTimeMs, findActiveLineIndex, parseLrc } from "@geet/lyrics";
import type { HostSong } from "@geet/shared";
import { fetchLyrics, lookupLyrics, saveLyrics } from "../lib/hostAgent";

interface LyricsPanelProps {
  song: HostSong;
  audioRef: RefObject<HTMLAudioElement | null>;
  tvMode?: boolean;
  editorOpen?: boolean;
  onToggleEditor?: () => void;
}

const OFFSET_STEPS = [-1000, -500, -100, 100, 500, 1000] as const;

export function LyricsPanel({
  song,
  audioRef,
  tvMode = false,
  editorOpen,
  onToggleEditor,
}: LyricsPanelProps) {
  const [lrcText, setLrcText] = useState("");
  const [offsetMs, setOffsetMs] = useState(0);
  const [source, setSource] = useState<"none" | "sidecar" | "manual" | "lrclib">("none");
  const [syncReady, setSyncReady] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [introCueProgress, setIntroCueProgress] = useState(0);
  const [internalEditing, setInternalEditing] = useState(false);
  const [showSyncDock, setShowSyncDock] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    setMsg(null);
    setActiveIdx(-1);
    setIntroCueProgress(0);
    fetchLyrics(song.id)
      .then((rec) => {
        if (cancelled) return;
        setLrcText(rec.lrc_text);
        setOffsetMs(rec.offset_ms);
        setSource(rec.source);
        setSyncReady(rec.synchronized_ready);
        if (!rec.synchronized_ready && !rec.lrc_text.trim() && !onToggleEditor) {
          setInternalEditing(true);
        }
      })
      .catch((err) => {
        if (!cancelled) setMsg(err instanceof Error ? err.message : "Failed to load lyrics");
      });
    return () => {
      cancelled = true;
    };
  }, [song.id]);

  // Run RAF only while audio is actively playing; sync immediately on seek/timeupdate
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || lines.length === 0) return;

    let rafId = 0;

    const syncOnce = () => {
      const effMs = computeEffectiveTimeMs(audio.currentTime, offsetMs);
      const nextIdx = findActiveLineIndex(lines, effMs);
      setActiveIdx((prev) => (prev === nextIdx ? prev : nextIdx));

      if (nextIdx >= 0) {
        const cur = lines[nextIdx];
        const span = Math.max(250, cur.endMs - cur.startMs);
        const pct = Math.round(Math.min(100, Math.max(12, ((effMs - cur.startMs) / span) * 100)));
        if (activeLineRef.current) {
          activeLineRef.current.style.setProperty("--sweep", `${pct}%`);
        }
        setIntroCueProgress((prev) => (prev === 0 ? prev : 0));
      } else {
        const firstStart = lines[0].startMs;
        if (firstStart > 0 && effMs >= 0 && effMs < firstStart) {
          const stepped = Math.floor((effMs / firstStart) * 4);
          setIntroCueProgress((prev) => (prev === stepped ? prev : stepped));
        } else {
          setIntroCueProgress((prev) => (prev === 0 ? prev : 0));
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

  useEffect(() => {
    const container = stageRef.current;
    const lineEl = activeLineRef.current;
    if (!container || !lineEl) return;
    const targetTop = lineEl.offsetTop - container.clientHeight * 0.36 + lineEl.clientHeight / 2;
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

  const showIntroDots = lines.length > 0 && activeIdx === -1;
  const sizeClass = tvMode
    ? "text-[26px] sm:text-[32px] lg:text-[38px]"
    : "text-[23px] sm:text-[28px] lg:text-[34px]";

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
          {showIntroDots && (
            <div aria-hidden="true" className="mb-7 flex items-center gap-3 pl-0.5">
              {[0, 1, 2].map((dotIdx) => {
                const lit = introCueProgress >= dotIdx + 1 || (dotIdx === 0 && introCueProgress === 0);
                return (
                  <span
                    key={dotIdx}
                    className={`h-3 w-3 rounded-full transition-opacity duration-200 ${
                      lit ? "bg-white/95" : "bg-white/25"
                    }`}
                  />
                );
              })}
            </div>
          )}

          <div className="space-y-6 sm:space-y-7">
            {lines.map((line, i) => {
              const isActive = i === activeIdx;
              const isPast = activeIdx >= 0 && i < activeIdx;

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

              return (
                <button
                  key={`${line.startMs}-${i}`}
                  ref={isActive ? activeLineRef : undefined}
                  type="button"
                  onClick={() => seekToLine(line.startMs)}
                  style={activeSweepStyle}
                  className={`block w-full text-left leading-[1.28] tracking-[-0.015em] transition-colors duration-150 ${sizeClass} ${toneClass}`}
                >
                  {line.text || "♪"}
                </button>
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
          <div className="space-y-4">
            {plainLines.map((line, i) => (
              <p
                key={i}
                className="text-xl font-semibold leading-relaxed text-white/75 sm:text-2xl"
              >
                {line}
              </p>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex h-[320px] flex-col items-center justify-center gap-4 rounded-2xl border border-white/10 bg-black/25 px-6 text-center">
          <p className="max-w-md text-sm text-white/70">
            No lyrics embedded or sidecar .lrc found for this track.
          </p>
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
        </div>
      )}

      {/* Discreet Hover-Revealed Calibration & Editor Bar */}
      <div
        className={`mt-2 space-y-2.5 lg:px-8 transition-opacity duration-200 ${
          editing || showSyncDock || msg
            ? "opacity-100"
            : "opacity-0 group-hover/lyrics:opacity-100 focus-within:opacity-100"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-full border border-white/12 bg-black/45 px-3.5 py-1.5">
          <div className="flex items-center gap-2 text-[11px] text-white/70">
            <span className="sr-only">Lyrics</span>
            <span className={`h-1.5 w-1.5 rounded-full ${syncReady ? "bg-sky" : "bg-pink"}`} />
            <span className="font-mono text-[10px] uppercase tracking-wider">
              {syncReady ? `${source}` : plainLines.length > 0 ? "embedded" : "unsynced"} ·{" "}
              {offsetMs >= 0 ? `+${offsetMs}` : offsetMs}ms
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
