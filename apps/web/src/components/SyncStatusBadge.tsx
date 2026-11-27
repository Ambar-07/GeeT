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
          text: compact ? "Live" : `${prefix}Live`,
          tone: "border-white/14 bg-white/[0.06] text-white/80",
        }
      : state === "connecting"
        ? {
            text: "Connecting",
            tone: "border-white/12 bg-white/[0.04] text-white/55",
          }
        : state === "disconnected"
          ? {
              text: "Reconnecting",
              tone: "border-pink/35 bg-pink/10 text-pink",
            }
          : {
              text: compact ? "Standby" : `${prefix}Standby`,
              tone: "border-white/10 bg-white/[0.04] text-snow/55",
            };

  return (
    <span
      role="status"
      aria-label={`Sync status: ${config.text}`}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] ${config.tone}`}
    >
      <span>{config.text}</span>
    </span>
  );
}
