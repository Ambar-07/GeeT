import { useEffect, useMemo, useState, type RefObject } from "react";
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
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const lines = useMemo(() => parseLrc(lrcText, song.duration_ms || undefined), [lrcText, song.duration_ms]);

  useEffect(() => {
    let cancelled = false;
    setMsg(null);
    setActiveIdx(-1);
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

  // Drive lyric highlight from local HTMLAudioElement via requestAnimationFrame
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio && lines.length > 0) {
        const effMs = computeEffectiveTimeMs(audio.currentTime, offsetMs);
        const nextIdx = findActiveLineIndex(lines, effMs);
        setActiveIdx((prev) => (prev === nextIdx ? prev : nextIdx));
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [audioRef, lines, offsetMs]);

  async function persist(nextText: string, nextOffset: number, nextSource: "manual" | "lrclib" | "sidecar") {
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

  return (
    <div className="mt-4 space-y-3 border-t border-slate-800 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-slate-300">Lyrics</span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              syncReady ? "bg-emerald-950 text-emerald-300" : "bg-amber-950 text-amber-300"
            }`}
          >
            {syncReady ? `Synced (${source})` : "Not synchronized"}
          </span>
          <span className="text-slate-400">Offset: {offsetMs} ms</span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {OFFSET_STEPS.map((step) => (
            <button
              key={step}
              type="button"
              onClick={() => void adjustOffset(step)}
              className="rounded border border-slate-700 px-2 py-0.5 text-[11px] hover:bg-slate-800"
            >
              {step > 0 ? `+${step === 1000 ? "1s" : `${step}ms`}` : step === -1000 ? "-1s" : `${step}ms`}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void adjustOffset(0)}
            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] hover:bg-slate-800"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-indigo-300 hover:bg-slate-800"
          >
            {editing ? "Close Editor" : "Edit / Import"}
          </button>
        </div>
      </div>

      {lines.length > 0 && (
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg bg-slate-950 p-3 text-sm">
          {lines.map((line, i) => (
            <p
              key={`${line.startMs}-${i}`}
              className={i === activeIdx ? "font-semibold text-indigo-300" : "text-slate-500"}
            >
              {line.text || "♪"}
            </p>
          ))}
        </div>
      )}

      {editing && (
        <div className="space-y-2">
          <textarea
            value={lrcText}
            onChange={(e) => setLrcText(e.target.value)}
            rows={5}
            placeholder="[00:12.34] Paste timed LRC lyrics here..."
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-xs outline-none focus:border-indigo-500"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void persist(lrcText, offsetMs, "manual").then(() => setEditing(false))}
              className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium hover:bg-indigo-500"
            >
              Save LRC
            </button>
            <button
              type="button"
              onClick={() => void handleLookup()}
              className="rounded border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800"
            >
              Lookup LRCLIB
            </button>
          </div>
        </div>
      )}

      {msg && <p className="text-xs text-slate-400">{msg}</p>}
    </div>
  );
}
