import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { coverUrl } from "../lib/hostAgent";
import { FluidCoverCanvas } from "./FluidCoverCanvas";

export interface StagePalette {
  base: string;
  c1: string;
  c2: string;
  c3: string;
  c4: string;
  /** Pre-blurred 64x64 data URL baked once from the real album cover for zero-blur 60 FPS flow. */
  textureUrl?: string | null;
  /** Adaptive readability veil opacity (higher on bright covers like Fukrey/Dil Dhadakne Do). */
  scrimOpacity?: number;
}

const FALLBACK_THEMES = [
  { a: "#1b4353", b: "#112b3c", c: "#0c141c", d: "#28586b", orbX: 25, orbY: 28 },
  { a: "#5c1f38", b: "#2b132a", c: "#120a14", d: "#7a2c4a", orbX: 74, orbY: 26 },
  { a: "#4f4428", b: "#292316", c: "#14120c", d: "#685834", orbX: 30, orbY: 70 },
  { a: "#233459", b: "#141d36", c: "#0b0e18", d: "#32497a", orbX: 70, orbY: 68 },
  { a: "#4a2257", b: "#231233", c: "#100b16", d: "#663175", orbX: 50, orbY: 24 },
  { a: "#1d424a", b: "#11242d", c: "#0a1116", d: "#2b5c66", orbX: 22, orbY: 54 },
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

function fallbackPalette(rawTitle?: string | null): StagePalette {
  if (!rawTitle) {
    return {
      base: "#0a0c12",
      c1: "#162d3d",
      c2: "#2c1733",
      c3: "#142238",
      c4: "#21152b",
      textureUrl: null,
      scrimOpacity: 0.12,
    };
  }
  const t = trackTheme(rawTitle);
  return {
    base: t.c,
    c1: t.a,
    c2: t.b,
    c3: t.d,
    c4: t.a,
    textureUrl: null,
    scrimOpacity: 0.14,
  };
}

/** Fallback static atmospheric backdrop helper. */
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

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToCss(h: number, s: number, l: number): string {
  const hue = ((Math.round(h) % 360) + 360) % 360;
  const sat = Math.round(Math.max(0, Math.min(1, s)) * 100);
  const lig = Math.round(Math.max(0, Math.min(1, l)) * 100);
  return `hsl(${hue} ${sat}% ${lig}%)`;
}

/**
 * Extract 4 rich, distinct, white-text-safe colors + adaptive scrim opacity from RGBA image data
 * using hue-sector vibrancy bucketing (prevents muddy gray/brown averaging).
 */
export function extractFlowPalette(data: Uint8ClampedArray): StagePalette {
  const SECTORS = 12;
  const buckets = Array.from({ length: SECTORS }, () => ({
    weight: 0,
    r: 0,
    g: 0,
    b: 0,
  }));

  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let totalLuma = 0;
  let totalCount = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    totalR += r;
    totalG += g;
    totalB += b;
    totalLuma += (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    totalCount++;

    const [h, s, l] = rgbToHsl(r, g, b);
    const lumaWeight = 1 - Math.min(1, Math.abs(l - 0.46) * 1.9);
    const weight = (0.08 + s * s * 2.4) * Math.max(0.05, lumaWeight);
    const sector = Math.floor(((h % 360) / 360) * SECTORS) % SECTORS;
    buckets[sector].weight += weight;
    buckets[sector].r += r * weight;
    buckets[sector].g += g * weight;
    buckets[sector].b += b * weight;
  }

  if (totalCount === 0) {
    return fallbackPalette(null);
  }

  const avgLuma = totalLuma / totalCount;
  // Bright covers (e.g. Fukrey, Dil Dhadakne Do) get a gentle dark scrim so white lyrics stay crisp;
  // moody dark covers (e.g. Kalank, Aalas Ka Pedh) stay lush and un-crushed.
  const scrimOpacity =
    avgLuma > 0.62 ? 0.34 : avgLuma > 0.44 ? 0.25 : avgLuma > 0.26 ? 0.18 : 0.1;

  const ranked = buckets
    .map((bk, idx) => ({
      idx,
      weight: bk.weight,
      r: bk.weight > 0 ? bk.r / bk.weight : 0,
      g: bk.weight > 0 ? bk.g / bk.weight : 0,
      b: bk.weight > 0 ? bk.b / bk.weight : 0,
    }))
    .filter((bk) => bk.weight > 0.01)
    .sort((a, b) => b.weight - a.weight);

  const avgHsl = rgbToHsl(totalR / totalCount, totalG / totalCount, totalB / totalCount);

  if (ranked.length === 0) {
    const [h, s, l] = avgHsl;
    return {
      base: hslToCss(h, s * 0.7, Math.min(0.42, Math.max(0.12, l * 0.6))),
      c1: hslToCss(h, Math.min(0.6, s * 1.1), Math.min(0.48, Math.max(0.24, l * 0.78))),
      c2: hslToCss(h + 18, Math.min(0.55, s * 0.95), Math.min(0.42, Math.max(0.2, l * 0.68))),
      c3: hslToCss(h - 18, Math.min(0.55, s * 1.05), Math.min(0.44, Math.max(0.22, l * 0.72))),
      c4: hslToCss(h + 8, Math.min(0.5, s * 0.85), Math.min(0.36, Math.max(0.16, l * 0.58))),
      scrimOpacity,
    };
  }

  const sectorDist = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return Math.min(d, SECTORS - d);
  };

  const primary = ranked[0];
  const secondary =
    ranked.find((bk) => sectorDist(bk.idx, primary.idx) >= 2 && bk.weight >= primary.weight * 0.14) ??
    ranked[1] ??
    primary;
  const tertiary =
    ranked.find(
      (bk) =>
        sectorDist(bk.idx, primary.idx) >= 2 &&
        sectorDist(bk.idx, secondary.idx) >= 2 &&
        bk.weight >= primary.weight * 0.1
    ) ??
    ranked.find((bk) => bk.idx !== primary.idx && bk.idx !== secondary.idx) ??
    secondary;

  const [h1, s1, l1] = rgbToHsl(primary.r, primary.g, primary.b);
  const [h2, s2, l2] = rgbToHsl(secondary.r, secondary.g, secondary.b);
  const [h3, s3, l3] = rgbToHsl(tertiary.r, tertiary.g, tertiary.b);

  const shape = (h: number, s: number, l: number, minL: number, maxL: number, satBoost: number) => {
    const nextS = s < 0.08 ? s * 0.9 : Math.min(0.86, Math.max(0.22, s * satBoost));
    const nextL = Math.min(maxL, Math.max(minL, l * 0.84));
    return hslToCss(h, nextS, nextL);
  };

  const isMonochrome = secondary === primary;
  const baseH = avgHsl[1] > 0.12 ? avgHsl[0] : h1;
  const baseS = Math.min(0.58, Math.max(avgHsl[1], s1 * 0.75));
  // Preserve authentic bright/warm vs dark/moody base lightness of the album cover
  const baseL = Math.min(0.42, Math.max(0.1, avgHsl[2] * 0.58));
  const midHue = h1 + (((h2 - h1 + 540) % 360) - 180) / 2;

  return {
    base: hslToCss(baseH, baseS, baseL),
    c1: shape(h1, s1, l1, 0.28, 0.5, 1.24),
    c2: isMonochrome
      ? shape(h1 + 22, s1, l1 * 0.88, 0.24, 0.44, 1.12)
      : shape(h2, s2, l2, 0.24, 0.46, 1.2),
    c3: isMonochrome
      ? shape(h1 - 18, s1, l1 * 1.06, 0.26, 0.48, 1.18)
      : shape(h3, s3, l3, 0.24, 0.45, 1.18),
    c4: shape(midHue, Math.max(s1, s2), (l1 + l2) / 2, 0.22, 0.4, 1.1),
    scrimOpacity,
  };
}

/**
 * Bake a pre-blurred, slightly saturated 64x64 soft texture + palette ONCE from the real album art.
 * Keeps runtime rendering at locked 60 FPS with zero per-frame CSS blur cost while matching every
 * cover's exact colors, warmth, and spatial tonal balance.
 */
function bakeCoverBackdrop(img: HTMLImageElement): StagePalette | null {
  try {
    // 1. Sample true unblurred pixels on a 24x24 canvas
    const sampleSize = 24;
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = sampleSize;
    sampleCanvas.height = sampleSize;
    const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleCtx) return null;
    sampleCtx.drawImage(img, 0, 0, sampleSize, sampleSize);
    const palette = extractFlowPalette(sampleCtx.getImageData(0, 0, sampleSize, sampleSize).data);

    // 2. Bake a tiny pre-softened cover texture (overscanned to eliminate edge darkening)
    const texSize = 64;
    const texCanvas = document.createElement("canvas");
    texCanvas.width = texSize;
    texCanvas.height = texSize;
    const texCtx = texCanvas.getContext("2d");
    if (texCtx) {
      texCtx.fillStyle = palette.base;
      texCtx.fillRect(0, 0, texSize, texSize);
      texCtx.filter = "blur(10px) saturate(1.38) contrast(1.04)";
      texCtx.drawImage(img, -14, -14, texSize + 28, texSize + 28);
      palette.textureUrl = texCanvas.toDataURL("image/jpeg", 0.86);
    }

    return palette;
  } catch {
    return null;
  }
}

const paletteCache = new Map<string, StagePalette>();
const imageCache = new Map<string, HTMLImageElement>();

function AuraLayer({ palette, visible }: { palette: StagePalette; visible: boolean }) {
  const scrim = palette.scrimOpacity ?? 0.2;

  return (
    <div
      className="absolute inset-0 overflow-hidden transition-opacity duration-1000 ease-out"
      style={{
        opacity: visible ? 1 : 0,
        backgroundColor: palette.base,
      }}
    >
      {/* Fallback gradient orbs when a track has no embedded cover art or WebGL is unavailable */}
      <div
        className="aura-blob aura-blob-a -left-[22%] -top-[24%] h-[92%] w-[84%]"
        style={{
          background: `radial-gradient(closest-side, ${palette.c1} 0%, transparent 74%)`,
          opacity: 0.92,
        }}
      />
      <div
        className="aura-blob aura-blob-b -bottom-[26%] -right-[18%] h-[96%] w-[86%]"
        style={{
          background: `radial-gradient(closest-side, ${palette.c2} 0%, transparent 74%)`,
          opacity: 0.88,
        }}
      />
      <div
        className="aura-blob aura-blob-c left-[26%] top-[10%] h-[82%] w-[74%]"
        style={{
          background: `radial-gradient(closest-side, ${palette.c3} 0%, transparent 72%)`,
          opacity: 0.68,
        }}
      />
      <div
        className="aura-blob aura-blob-d -bottom-[18%] left-[4%] h-[76%] w-[72%]"
        style={{
          background: `radial-gradient(closest-side, ${palette.c4} 0%, transparent 74%)`,
          opacity: 0.7,
        }}
      />

      {/* Adaptive contrast veil calibrated to the cover's own brightness */}
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(ellipse 95% 90% at 50% 45%, rgba(0, 0, 0, ${scrim.toFixed(
            2
          )}) 0%, rgba(0, 0, 0, ${Math.min(0.52, scrim + 0.14).toFixed(2)}) 100%)`,
        }}
      />
    </div>
  );
}

/**
 * Apple Music Sing–style WebGL fluid-warp stage backdrop driven directly by each song's
 * real embedded album art, with graceful CSS aura fallback when a song has no artwork.
 */
export function StageBackdrop({
  songId,
  hasCover,
  coverSrc,
  title,
  playing = true,
}: {
  songId?: string | null;
  hasCover?: boolean;
  coverSrc?: string | null;
  title?: string | null;
  playing?: boolean;
}) {
  const src = coverSrc ?? (songId && hasCover !== false ? coverUrl(songId) : null);

  const [sampledPalette, setSampledPalette] = useState<StagePalette | null>(() =>
    src ? paletteCache.get(src) ?? null : null
  );
  const [loadedImage, setLoadedImage] = useState<{ src: string; img: HTMLImageElement } | null>(
    () => {
      if (!src) return null;
      const cached = imageCache.get(src);
      return cached ? { src, img: cached } : null;
    }
  );
  const [webglDisabled, setWebglDisabled] = useState(false);
  const handleWebglFallback = useCallback(() => setWebglDisabled(true), []);

  useEffect(() => {
    if (!src) {
      setSampledPalette(null);
      setLoadedImage(null);
      return;
    }
    const cachedImg = imageCache.get(src);
    const cachedPal = paletteCache.get(src);
    if (cachedImg && cachedPal) {
      setLoadedImage({ src, img: cachedImg });
      setSampledPalette(cachedPal);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    // Separate cache key (?bg=1) + CORS blob guarantees clean WebGL texture upload on every song
    const corsUrl = `${src}${src.includes("?") ? "&" : "?"}bg=1`;
    fetch(corsUrl, { mode: "cors" })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          if (cancelled) {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            return;
          }
          imageCache.set(src, img);
          setLoadedImage({ src, img });
          const baked = bakeCoverBackdrop(img);
          if (baked) {
            paletteCache.set(src, baked);
            setSampledPalette(baked);
          }
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
          }
        };
        img.onerror = () => {
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
          }
        };
        img.src = objectUrl;
      })
      .catch(() => {
        // Silently stay on fallback palette if cover is unavailable
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  const activePalette = useMemo(
    () => sampledPalette ?? fallbackPalette(title),
    [sampledPalette, title]
  );

  // Flash-free dual-slot crossfade for CSS fallback layer
  const [crossfade, setCrossfade] = useState<{
    slots: [StagePalette, StagePalette];
    activeSlot: 0 | 1;
    key: string;
  }>(() => ({
    slots: [activePalette, activePalette],
    activeSlot: 0,
    key: `${activePalette.base}|${activePalette.c1}|${activePalette.c2}`,
  }));

  useEffect(() => {
    const nextKey = `${activePalette.base}|${activePalette.c1}|${activePalette.c2}`;
    setCrossfade((prev) => {
      if (prev.key === nextKey) return prev;
      const nextSlot: 0 | 1 = prev.activeSlot === 0 ? 1 : 0;
      const nextSlots: [StagePalette, StagePalette] =
        nextSlot === 0 ? [activePalette, prev.slots[1]] : [prev.slots[0], activePalette];
      return { slots: nextSlots, activeSlot: nextSlot, key: nextKey };
    });
  }, [activePalette]);

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden ${
        playing ? "" : "aura-paused"
      }`}
    >
      <AuraLayer palette={crossfade.slots[0]} visible={crossfade.activeSlot === 0} />
      <AuraLayer palette={crossfade.slots[1]} visible={crossfade.activeSlot === 1} />
      {!webglDisabled && (
        <FluidCoverCanvas
          image={loadedImage?.img ?? null}
          imageKey={loadedImage?.src ?? null}
          playing={playing}
          onFallback={handleWebglFallback}
        />
      )}
    </div>
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
