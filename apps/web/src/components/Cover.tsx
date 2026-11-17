import type { CSSProperties } from "react";

const THEMES = [
  { a: "#0593C6", b: "#D83996", c: "#16112E", orbX: 22, orbY: 24 },
  { a: "#D83996", b: "#0593C6", c: "#0B1E36", orbX: 78, orbY: 22 },
  { a: "#0593C6", b: "#38BDF8", c: "#2E1035", orbX: 28, orbY: 76 },
  { a: "#EC4899", b: "#6366F1", c: "#071B2F", orbX: 74, orbY: 72 },
  { a: "#0EA5E9", b: "#D83996", c: "#1D1128", orbX: 50, orbY: 20 },
  { a: "#D83996", b: "#F472B6", c: "#062338", orbX: 20, orbY: 55 },
] as const;

/** Turn file-derived titles like "01_Bohemian_Rhapsody" into "Bohemian Rhapsody". */
export function displayTitle(raw: string): string {
  const clean = raw
    .replace(/_/g, " ")
    .replace(/^\d{1,3}[\s.\-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean || raw;
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
  const t = THEMES[h % THEMES.length];
  const angle = 115 + (h % 130);
  const catNo = `GT-${String((h % 89) + 10)}`;
  return { ...t, angle, catNo, h };
}

/** Full-stage ambient mesh backlight derived from the active song's palette (Apple Music Sing style). */
export function stageBacklightStyle(rawTitle?: string | null): CSSProperties | undefined {
  if (!rawTitle) return undefined;
  const { a, b, c, orbX, orbY } = trackTheme(rawTitle);
  return {
    background: `
      radial-gradient(62% 68% at ${Math.min(42, orbX)}% ${orbY}%, ${a}38 0%, transparent 72%),
      radial-gradient(58% 64% at ${Math.max(58, 100 - orbX)}% ${100 - orbY}%, ${b}33 0%, transparent 74%),
      radial-gradient(80% 80% at 50% 50%, ${c}66 0%, #050505 88%),
      #050505
    `,
  };
}

/** Deterministic mesh + vinyl groove artwork generated per track. */
export function Cover({
  title,
  size,
  className = "",
}: {
  title: string;
  size?: number;
  className?: string;
}) {
  const name = displayTitle(title);
  const { a, b, c, orbX, orbY, angle, catNo } = trackTheme(title);
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  const isLarge = !size || size >= 120;

  return (
    <div
      aria-hidden="true"
      className={`relative flex shrink-0 items-center justify-center overflow-hidden font-bold text-snow select-none ${className}`}
      style={{
        width: size,
        height: size,
        background: `
          radial-gradient(circle at 50% 50%, transparent 26%, rgba(252,255,255,0.08) 26.6%, transparent 27.3%),
          radial-gradient(circle at 50% 50%, transparent 44%, rgba(252,255,255,0.06) 44.6%, transparent 45.2%),
          radial-gradient(circle at 50% 50%, transparent 64%, rgba(252,255,255,0.06) 64.6%, transparent 65.2%),
          radial-gradient(68% 68% at ${orbX}% ${orbY}%, ${a} 0%, transparent 66%),
          radial-gradient(65% 65% at ${100 - orbX}% ${100 - orbY}%, ${b} 0%, transparent 68%),
          linear-gradient(${angle}deg, ${a} 0%, ${c} 52%, ${b} 100%)
        `,
        fontSize: size ? Math.max(11, size * 0.3) : undefined,
      }}
    >
      {/* Subtle dither grain overlay on large stage covers */}
      {isLarge && (
        <div
          className="pointer-events-none absolute inset-0 opacity-20 mix-blend-overlay"
          style={{
            backgroundImage: "radial-gradient(rgba(252,255,255,0.7) 1px, transparent 0)",
            backgroundSize: "4px 4px",
          }}
        />
      )}

      <span className="relative z-10 tracking-[-0.04em] drop-shadow-[0_4px_16px_rgba(0,0,0,0.5)]">
        {initials}
      </span>

      {isLarge && (
        <div className="pointer-events-none absolute inset-x-4 bottom-3.5 flex items-center justify-between font-mono text-[10px] tracking-[0.18em] text-snow/65 uppercase">
          <span>///• STEREO</span>
          <span>{catNo}</span>
        </div>
      )}
    </div>
  );
}
