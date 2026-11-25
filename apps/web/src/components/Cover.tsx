import { useEffect, useState, type CSSProperties } from "react";
import { coverUrl } from "../lib/hostAgent";

const FALLBACK_THEMES = [
  { a: "#1b3a4b", b: "#0f2027", c: "#101820", orbX: 25, orbY: 28 },
  { a: "#4a192c", b: "#1f1120", c: "#120c14", orbX: 74, orbY: 26 },
  { a: "#3e3623", b: "#1e1b13", c: "#14130f", orbX: 30, orbY: 70 },
  { a: "#1f2a44", b: "#111625", c: "#0c0f19", orbX: 70, orbY: 68 },
  { a: "#3a1c42", b: "#1b1024", c: "#110c16", orbX: 50, orbY: 24 },
  { a: "#1c333a", b: "#101b22", c: "#0b1116", orbX: 22, orbY: 54 },
] as const;

/** Preserve embedded metadata titles verbatim; only clean raw underscore filenames. */
export function displayTitle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (trimmed.includes("_") && !trimmed.includes(" ")) {
    const clean = trimmed
      .replace(/_/g, " ")
      .replace(/^\d{1,3}[\s.\-]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    return clean || trimmed;
  }
  return trimmed;
}

/** Human-friendly audio quality label derived from format and codec metadata. */
export function formatAudioQuality(format?: string, codec?: string | null): string | null {
  const c = (codec ?? "").toLowerCase();
  const f = (format ?? "").toLowerCase();
  if (c === "ec-3" || c === "ac-3" || c.includes("atmos")) return "Dolby Audio";
  if (c === "alac" || f === "flac" || f === "wav") return "Lossless";
  if (c.startsWith("mp4a") || f === "m4a") return "AAC";
  if (f === "mp3") return "MP3";
  return f ? f.toUpperCase() : null;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function trackTheme(rawTitle: string) {
  const name = displayTitle(rawTitle);
  const h = hash(name);
  const t = FALLBACK_THEMES[h % FALLBACK_THEMES.length];
  const angle = 120 + (h % 110);
  return { ...t, angle, h };
}

/** Fallback atmospheric backdrop when a song has no embedded cover art. */
export function stageBacklightStyle(rawTitle?: string | null): CSSProperties | undefined {
  if (!rawTitle) return undefined;
  const { a, b, c, orbX, orbY } = trackTheme(rawTitle);
  return {
    background: `
      radial-gradient(68% 72% at ${Math.min(44, orbX)}% ${orbY}%, ${a} 0%, transparent 74%),
      radial-gradient(64% 68% at ${Math.max(56, 100 - orbX)}% ${100 - orbY}%, ${b} 0%, transparent 76%),
      linear-gradient(145deg, ${c} 0%, #09090c 100%)
    `,
  };
}

function clampStageRgb(r: number, g: number, b: number, maxLuma: number): string {
  // Keep atmospheric color rich while capping brightness so white lyrics remain high-contrast
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const scale = luma > maxLuma && luma > 0 ? maxLuma / luma : luma < 28 ? 1.35 : 1;
  const cr = Math.min(255, Math.round(r * scale));
  const cg = Math.min(255, Math.round(g * scale));
  const cb = Math.min(255, Math.round(b * scale));
  return `rgb(${cr}, ${cg}, ${cb})`;
}

function samplePaletteFromImage(img: HTMLImageElement): { a: string; b: string; base: string } | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;

    let r1 = 0, g1 = 0, b1 = 0, n1 = 0;
    let r2 = 0, g2 = 0, b2 = 0, n2 = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const idx = (y * 16 + x) * 4;
        if (x + y < 16) {
          r1 += data[idx];
          g1 += data[idx + 1];
          b1 += data[idx + 2];
          n1++;
        } else {
          r2 += data[idx];
          g2 += data[idx + 1];
          b2 += data[idx + 2];
          n2++;
        }
      }
    }
    const ar = r1 / n1, ag = g1 / n1, ab = b1 / n1;
    const br = r2 / n2, bg = g2 / n2, bb = b2 / n2;
    return {
      a: clampStageRgb(ar, ag, ab, 118),
      b: clampStageRgb(br, bg, bb, 96),
      base: clampStageRgb((ar + br) * 0.35, (ag + bg) * 0.35, (ab + bb) * 0.35, 58),
    };
  } catch {
    return null;
  }
}

const paletteCache = new Map<string, { a: string; b: string; base: string }>();

/** Zero-blur 60 FPS atmospheric stage gradient sampled once from the active album's real cover art. */
export function StageBackdrop({
  songId,
  hasCover,
  title,
}: {
  songId?: string | null;
  hasCover?: boolean;
  title?: string | null;
}) {
  const src = songId && hasCover !== false ? coverUrl(songId) : null;
  const [palette, setPalette] = useState<{ a: string; b: string; base: string } | null>(() =>
    src ? paletteCache.get(src) ?? null : null
  );

  useEffect(() => {
    if (!src) {
      setPalette(null);
      return;
    }
    const cached = paletteCache.get(src);
    if (cached) {
      setPalette(cached);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      const sampled = samplePaletteFromImage(img);
      if (sampled) {
        paletteCache.set(src, sampled);
        setPalette(sampled);
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  const style: CSSProperties | undefined = palette
    ? {
        background: `
          radial-gradient(75% 85% at 24% 38%, ${palette.a} 0%, transparent 72%),
          radial-gradient(75% 85% at 82% 72%, ${palette.b} 0%, transparent 76%),
          linear-gradient(155deg, ${palette.a} 0%, ${palette.base} 58%, #0b0b0f 100%)
        `,
      }
    : stageBacklightStyle(title);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 transition-[background] duration-500"
      style={style}
    />
  );
}

/** Real embedded album artwork with clean minimal fallback when a track has no cover image. */
export function Cover({
  title,
  songId,
  coverSrc,
  hasCover = true,
  size,
  className = "",
}: {
  title: string;
  songId?: string;
  coverSrc?: string;
  hasCover?: boolean;
  size?: number;
  className?: string;
}) {
  const resolvedSrc = coverSrc ?? (songId && hasCover ? coverUrl(songId) : undefined);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [resolvedSrc]);

  const name = displayTitle(title);
  const { a, b, c, angle } = trackTheme(title);
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

  const showImage = Boolean(resolvedSrc && !imgFailed);

  return (
    <div
      aria-hidden="true"
      className={`relative flex shrink-0 items-center justify-center overflow-hidden font-bold text-white/90 select-none ${className}`}
      style={{
        width: size,
        height: size,
        background: showImage
          ? "#121216"
          : `linear-gradient(${angle}deg, ${a} 0%, ${c} 55%, ${b} 100%)`,
        fontSize: size ? Math.max(11, size * 0.3) : undefined,
      }}
    >
      {showImage ? (
        <img
          src={resolvedSrc}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImgFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="relative z-10 tracking-[-0.03em] opacity-85">{initials}</span>
      )}
    </div>
  );
}
