export { hasDevanagari, transliterateDevanagari } from "./transliterate";

export interface LyricLine {
  startMs: number;
  endMs: number;
  text: string;
}

export interface InterludeState {
  kind: "intro" | "interlude";
  /** -1 for intro before line 0, or the line index whose slot/trailing gap holds the breather dots. */
  anchorIndex: number;
  /** Normalized progress from 0 to 1 across the instrumental break. */
  progress: number;
  /** Number of lit dots (1..3) for Apple Music Sing countdown. */
  litDots: number;
}

const TIMESTAMP_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const INSTRUMENTAL_MARKERS = new Set(["", "♪", "♫", "...", "…", "•", "•••"]);

export function isInstrumentalLine(text: string): boolean {
  return INSTRUMENTAL_MARKERS.has(text.trim());
}

/** Parse standard LRC text into sorted, non-overlapping LyricLine intervals. */
export function parseLrc(lrc: string, trackDurationMs?: number): LyricLine[] {
  const entries: Array<{ startMs: number; text: string }> = [];

  for (const rawLine of lrc.split(/\r?\n/)) {
    TIMESTAMP_RE.lastIndex = 0;
    const matches = [...rawLine.matchAll(TIMESTAMP_RE)];
    if (matches.length === 0) continue;

    const text = rawLine.replace(TIMESTAMP_RE, "").trim();
    for (const m of matches) {
      const minutes = Number(m[1]);
      const seconds = Number(m[2]);
      const frac = m[3] ? Number(m[3].padEnd(3, "0").slice(0, 3)) : 0;
      const startMs = minutes * 60_000 + seconds * 1_000 + frac;
      entries.push({ startMs, text });
    }
  }

  entries.sort((a, b) => a.startMs - b.startMs);

  return entries.map((entry, idx) => {
    const nextStart = entries[idx + 1]?.startMs;
    const endMs =
      nextStart !== undefined
        ? Math.max(entry.startMs, nextStart)
        : trackDurationMs !== undefined
          ? Math.max(entry.startMs, trackDurationMs)
          : entry.startMs + 5_000;
    return { startMs: entry.startMs, endMs, text: entry.text };
  });
}

/** Compute effective playback time in ms for lyric alignment. */
export function computeEffectiveTimeMs(currentTimeSec: number, offsetMs: number): number {
  return currentTimeSec * 1000 - offsetMs;
}

/** Binary search for the active lyric line index at effectiveTimeMs, or -1 before the first line. */
export function findActiveLineIndex(lines: readonly LyricLine[], effectiveTimeMs: number): number {
  if (lines.length === 0 || effectiveTimeMs < lines[0].startMs) return -1;

  let lo = 0;
  let hi = lines.length - 1;
  let ans = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= effectiveTimeMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Determine whether playback is currently inside an intro countdown or mid-song
 * instrumental interlude so the stage can display the 3 Apple Music Sing breather dots.
 */
export function getInterludeState(
  lines: readonly LyricLine[],
  effectiveTimeMs: number
): InterludeState | null {
  if (lines.length === 0 || effectiveTimeMs < 0) return null;

  // 1. Intro before first sung line
  const first = lines[0];
  if (effectiveTimeMs < first.startMs) {
    if (first.startMs < 1500) return null;
    const progress = Math.min(1, Math.max(0, effectiveTimeMs / first.startMs));
    const litDots = Math.min(3, Math.max(1, Math.floor(progress * 3) + 1));
    return { kind: "intro", anchorIndex: -1, progress, litDots };
  }

  const activeIdx = findActiveLineIndex(lines, effectiveTimeMs);
  if (activeIdx < 0) return null;
  const cur = lines[activeIdx];
  const span = cur.endMs - cur.startMs;

  // 2. Explicit blank/instrumental cue line in LRC
  if (isInstrumentalLine(cur.text)) {
    if (span < 1500) return null;
    const progress = Math.min(1, Math.max(0, (effectiveTimeMs - cur.startMs) / span));
    const litDots = Math.min(3, Math.max(1, Math.floor(progress * 3) + 1));
    return { kind: "interlude", anchorIndex: activeIdx, progress, litDots };
  }

  // 3. Long gap after a sung line before the next verse begins
  const hasNext = activeIdx + 1 < lines.length;
  if (hasNext && span >= 9500) {
    const estimatedSingMs = Math.min(5500, Math.max(2600, cur.text.length * 95));
    const gapStartMs = cur.startMs + estimatedSingMs;
    const gapSpan = cur.endMs - gapStartMs;
    if (gapSpan >= 3500 && effectiveTimeMs >= gapStartMs && effectiveTimeMs < cur.endMs) {
      const progress = Math.min(1, Math.max(0, (effectiveTimeMs - gapStartMs) / gapSpan));
      const litDots = Math.min(3, Math.max(1, Math.floor(progress * 3) + 1));
      return { kind: "interlude", anchorIndex: activeIdx, progress, litDots };
    }
  }

  return null;
}
