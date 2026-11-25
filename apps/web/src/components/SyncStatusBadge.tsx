export type SyncConnectionState = "idle" | "connecting" | "subscribed" | "disconnected";
export type RoomTransportMode = "cloud" | "lan";

interface SyncStatusBadgeProps {
  state: SyncConnectionState;
  transport?: RoomTransportMode;
  compact?: boolean;
}

export function SyncStatusBadge({
  state,
  transport,
  compact = false,
}: SyncStatusBadgeProps) {
  const prefix = transport === "lan" ? "LAN " : transport === "cloud" ? "Cloud " : "";

  const config =
    state === "subscribed"
      ? {
          dot: "bg-sky shadow-[0_0_8px_rgba(5,147,198,0.85)]",
          text: compact ? "Live" : `${prefix}Live`,
          tone: "border-sky/30 bg-sky/10 text-sky",
        }
      : state === "connecting"
        ? {
            dot: "bg-amber-400 animate-pulse",
            text: "Connecting",
            tone: "border-amber-400/30 bg-amber-400/10 text-amber-300",
          }
        : state === "disconnected"
          ? {
              dot: "bg-pink",
              text: "Reconnecting",
              tone: "border-pink/35 bg-pink/10 text-pink",
            }
          : {
              dot: "bg-snow/35",
              text: compact ? "Standby" : `${prefix}Standby`,
              tone: "border-white/10 bg-white/[0.04] text-snow/55",
            };

  return (
    <span
      role="status"
      aria-label={`Sync status: ${config.text}`}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] ${config.tone}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot}`} />
      <span>{config.text}</span>
    </span>
  );
}
