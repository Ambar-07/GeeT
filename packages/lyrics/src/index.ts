export interface LyricLine {
  startMs: number;
  endMs: number;
  text: string;
}

const TIMESTAMP_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

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
