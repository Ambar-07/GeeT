export { hasDevanagari, transliterateDevanagari } from "./transliterate";

export interface LyricWord {
  startMs: number;
  endMs: number;
  text: string;
  trailingSpace: string;
}

export interface LyricLine {
  startMs: number;
  endMs: number;
  text: string;
  words?: LyricWord[];
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
const WORD_TAG_RE = /<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>/g;
const INSTRUMENTAL_MARKERS = new Set(["", "♪", "♫", "...", "…", "•", "•••"]);

export function isInstrumentalLine(text: string): boolean {
  return INSTRUMENTAL_MARKERS.has(text.trim());
}

function parseTimestampMs(minStr: string, secStr: string, fracStr?: string): number {
  const minutes = Number(minStr);
  const seconds = Number(secStr);
  const frac = fracStr ? Number(fracStr.padEnd(3, "0").slice(0, 3)) : 0;
  return minutes * 60_000 + seconds * 1_000 + frac;
}

function parseEnhancedWords(rawText: string, lineStartMs: number, lineEndMs: number): LyricWord[] | undefined {
  WORD_TAG_RE.lastIndex = 0;
  const matches = [...rawText.matchAll(WORD_TAG_RE)];
  if (matches.length === 0) return undefined;

  const segments: Array<{ startMs: number; raw: string }> = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const startMs = parseTimestampMs(m[1], m[2], m[3]);
    const contentStart = (m.index ?? 0) + m[0].length;
    const contentEnd = i + 1 < matches.length ? (matches[i + 1].index ?? rawText.length) : rawText.length;
    const raw = rawText.slice(contentStart, contentEnd);
    if (raw.trim()) {
      segments.push({ startMs: Math.max(lineStartMs, startMs), raw });
    }
  }
  if (segments.length === 0) return undefined;

  return segments.map((seg, idx) => {
    const nextStart = segments[idx + 1]?.startMs ?? lineEndMs;
    const trailingSpace = /\s+$/.test(seg.raw) ? " " : idx < segments.length - 1 ? " " : "";
    return {
      startMs: seg.startMs,
      endMs: Math.max(seg.startMs + 80, nextStart),
      text: seg.raw.trim(),
      trailingSpace,
    };
  });
}

/**
 * Return word-level timing intervals for a lyric line.
 * Uses enhanced LRC `<mm:ss.xx>` tags when available, or smooth character-weighted
 * interpolation across the line's natural vocal window for standard LRC files.
 */
export function getLineWords(line: LyricLine): LyricWord[] {
  if (line.words && line.words.length > 0) return line.words;
  const trimmed = line.text.trim();
  if (!trimmed) return [];

  const tokens = trimmed.split(/\s+/);
  const totalSpan = Math.max(240, line.endMs - line.startMs);
  // Estimate natural singing duration so long instrumental tails after a line don't stretch words unnaturally
  const singSpan = Math.min(totalSpan, Math.max(Math.min(totalSpan, 1800), trimmed.length * 105));
  const weights = tokens.map((t) => Math.max(1.5, t.length + 0.8));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let cursor = line.startMs;
  return tokens.map((token, idx) => {
    const dur = (weights[idx] / totalWeight) * singSpan;
    const startMs = cursor;
    const endMs = idx === tokens.length - 1 ? line.startMs + singSpan : cursor + dur;
    cursor = endMs;
    return {
      startMs,
      endMs: Math.max(startMs + 60, endMs),
      text: token,
      trailingSpace: idx < tokens.length - 1 ? " " : "",
    };
  });
}

/** Parse standard and enhanced LRC text into sorted, non-overlapping LyricLine intervals. */
export function parseLrc(lrc: string, trackDurationMs?: number): LyricLine[] {
  const entries: Array<{ startMs: number; rawText: string; text: string }> = [];

  for (const rawLine of lrc.split(/\r?\n/)) {
    TIMESTAMP_RE.lastIndex = 0;
    const matches = [...rawLine.matchAll(TIMESTAMP_RE)];
    if (matches.length === 0) continue;

    const rawText = rawLine.replace(TIMESTAMP_RE, "").trim();
    const cleanText = rawText.replace(WORD_TAG_RE, "").replace(/\s{2,}/g, " ").trim();
    for (const m of matches) {
      const startMs = parseTimestampMs(m[1], m[2], m[3]);
      entries.push({ startMs, rawText, text: cleanText });
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
    const words = parseEnhancedWords(entry.rawText, entry.startMs, endMs);
    return words
      ? { startMs: entry.startMs, endMs, text: entry.text, words }
      : { startMs: entry.startMs, endMs, text: entry.text };
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
