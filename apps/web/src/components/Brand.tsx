/** Motion.dev-inspired geometric slanted bars + dot emblem paired with tight-tracked mixed-case wordmark. */
export function BrandMark({ size = 26, className = "" }: { size?: number; className?: string }) {
  const h = Math.round(size * 0.62);
  return (
    <svg
      width={size}
      height={h}
      viewBox="0 0 36 22"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <polygon points="0,20 6,2 11,2 5,20" fill="#FCFFFF" />
      <polygon points="8,20 14,2 19,2 13,20" fill="#FCFFFF" />
      <polygon points="16,20 22,2 27,2 21,20" fill="#0593C6" />
      <circle cx="31.5" cy="6.5" r="3.5" fill="#D83996" />
    </svg>
  );
}

export function Logo({ size = 26, suffix }: { size?: number; suffix?: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <BrandMark size={size} />
      <span className="text-[18px] font-bold tracking-[-0.035em] text-snow">GeeT</span>
      {suffix && (
        <span className="border border-white/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-snow/60">
          {suffix}
        </span>
      )}
    </span>
  );
}
