/** GeeT karaoke microphone + speech-bubble mark in brand rose-pink. */
export function BrandMark({ size = 26, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      {/* Microphone capsule */}
      <rect x="33" y="10" width="34" height="50" rx="17" fill="#FB1E53" />
      {/* Speech-bubble U-cradle */}
      <path
        d="M21 44C21 60.5 34 73.5 50 73.5C66 73.5 79 60.5 79 44"
        stroke="#FB1E53"
        strokeWidth="12"
        strokeLinecap="round"
      />
      {/* Speech-bubble tail at bottom-left */}
      <path
        d="M35.5 69.5L28.5 85.5C27.6 87.6 29.8 89.6 31.8 88.5L50 78.2L35.5 69.5Z"
        fill="#FB1E53"
      />
    </svg>
  );
}

export function Logo({ size = 26, suffix }: { size?: number; suffix?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <BrandMark size={size} />
      <span className="text-[19px] font-bold tracking-[-0.03em] text-white">GeeT</span>
      {suffix && (
        <span className="rounded-full border border-white/15 bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-snow/65">
          {suffix}
        </span>
      )}
    </span>
  );
}
