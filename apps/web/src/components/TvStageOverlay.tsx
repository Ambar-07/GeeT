import { useState } from "react";
import { displayTitle } from "./Cover";
import { SyncStatusBadge } from "./SyncStatusBadge";
import type { HostStageRoomInfo, StageReactionBurst } from "./HostRoomPanel";

const REACTION_GLYPHS: Record<string, string> = {
  Clap: "👏",
  Encore: "🔥",
  Cheer: "🎉",
  Fire: "⚡",
  Sing: "🎤",
  Love: "💖",
};

interface TvStageOverlayProps {
  tvMode: boolean;
  showOverlay: boolean;
  roomInfo: HostStageRoomInfo | null;
  reactions: StageReactionBurst[];
  remainingSec: number;
  durationSec: number;
  isPlaying: boolean;
  hasActiveSong: boolean;
  autoPreparingTitle: string | null;
  autoPrepareProgress: number | null;
}

export function TvStageOverlay({
  tvMode,
  showOverlay,
  roomInfo,
  reactions,
  remainingSec,
  durationSec,
  isPlaying,
  hasActiveSong,
  autoPreparingTitle,
  autoPrepareProgress,
}: TvStageOverlayProps) {
  const [qrMinimized, setQrMinimized] = useState(false);

  const nextUp = roomInfo?.upNext[0] ?? null;
  const isNearingEnd =
    hasActiveSong && durationSec > 10 && remainingSec > 0 && remainingSec <= 25;
  const showProminentUpNext = Boolean(
    nextUp && (isNearingEnd || (!isPlaying && hasActiveSong))
  );
  const showCompactUpNext = Boolean(
    tvMode && showOverlay && nextUp && !showProminentUpNext
  );

  return (
    <div
      aria-label="Stage overlays"
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      {/* Floating Animated Reaction Bursts (active in both Split View and TV Stage Mode) */}
      <div
        aria-live="polite"
        className="pointer-events-none absolute bottom-20 right-6 flex flex-col items-end gap-2 sm:right-10"
      >
        {reactions.map((r) => (
          <div
            key={r.id}
            style={{ marginRight: `${r.offsetX}px` }}
            className="animate-reaction-float inline-flex items-center gap-2 rounded-full border border-white/18 bg-black/45 px-3.5 py-1.5 text-xs shadow-[0_8px_28px_rgba(0,0,0,0.35)] backdrop-blur-xl"
          >
            <span aria-hidden="true" className="text-base leading-none">
              {REACTION_GLYPHS[r.label] ?? "✨"}
            </span>
            <span className="font-semibold text-snow">{r.label}</span>
            <span className="font-mono text-[10px] text-snow/60">· {r.sender}</span>
          </div>
        ))}
      </div>

      {/* Subtle Auto-Prepare Pill */}
      {autoPreparingTitle && (
        <div
          role="status"
          className="pointer-events-auto absolute left-5 top-5 inline-flex items-center gap-2 rounded-full border border-sky/30 bg-ink-900/85 px-3.5 py-1.5 font-mono text-[11px] text-sky shadow-lg backdrop-blur-md"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-sky" />
          <span className="max-w-[240px] truncate">
            Auto-preparing: {displayTitle(autoPreparingTitle)}
            {autoPrepareProgress !== null ? ` (${autoPrepareProgress}%)` : ""}
          </span>
        </div>
      )}

      {/* Prominent "Up Next" Toast when current song nears the end or pauses */}
      {showProminentUpNext && nextUp && (
        <div
          role="status"
          className="animate-toast-up pointer-events-auto absolute bottom-6 left-6 z-30 flex max-w-md items-center gap-3.5 rounded-2xl border border-white/18 bg-black/45 px-4 py-3 shadow-[0_16px_48px_rgba(0,0,0,0.45)] backdrop-blur-2xl"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky/15 font-mono text-xs font-bold text-sky">
            NEXT
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="eyebrow text-sky">
                {isNearingEnd ? `Up Next in ${Math.ceil(remainingSec)}s` : "Up Next"}
              </span>
              {nextUp.readiness === "ready" && (
                <span className="rounded bg-sky/15 px-1.5 py-0.5 font-mono text-[9px] uppercase text-sky">
                  Inst Ready
                </span>
              )}
              {nextUp.readiness === "preparing" && (
                <span className="rounded bg-amber-400/15 px-1.5 py-0.5 font-mono text-[9px] uppercase text-amber-300">
                  Preparing
                </span>
              )}
            </div>
            <p className="truncate text-sm font-bold text-snow">
              {displayTitle(nextUp.title)}
            </p>
            <p className="truncate text-xs text-snow/60">
              Singer: <span className="font-medium text-snow/90">{nextUp.requester}</span>
            </p>
          </div>
          {roomInfo?.playNext && (
            <button
              type="button"
              onClick={roomInfo.playNext}
              className="btn-primary shrink-0 px-3 py-1.5 text-[10px]"
            >
              Play Now
            </button>
          )}
        </div>
      )}

      {/* Subtle TV Mode Up Next Chip when not near end */}
      {showCompactUpNext && nextUp && (
        <div className="pointer-events-auto absolute bottom-5 left-6 inline-flex max-w-sm items-center gap-2.5 rounded-full border border-white/15 bg-black/35 px-3.5 py-1.5 text-xs backdrop-blur-xl">
          <span className="font-mono text-[10px] uppercase tracking-wider text-sky">Next</span>
          <span className="truncate font-semibold text-snow">
            {displayTitle(nextUp.title)}
          </span>
          <span className="shrink-0 text-snow/60">({nextUp.requester})</span>
        </div>
      )}

      {/* TV Stage Mode Corner QR & Room Code Pill */}
      {tvMode && showOverlay && roomInfo?.active && roomInfo.roomCode && (
        <div className="pointer-events-auto absolute bottom-5 right-6 z-30">
          {qrMinimized ? (
            <button
              type="button"
              onClick={() => setQrMinimized(false)}
              className="flex items-center gap-2.5 rounded-full border border-white/18 bg-black/40 px-3.5 py-2 text-xs shadow-xl backdrop-blur-2xl transition hover:bg-black/55"
            >
              <span className="font-mono text-xs font-bold tracking-wider text-snow">
                {roomInfo.roomCode}
              </span>
              <SyncStatusBadge
                state={roomInfo.connState}
                transport={roomInfo.transport}
                compact
              />
              <span className="text-[11px] text-snow/65">QR</span>
            </button>
          ) : (
            <div className="flex items-center gap-3.5 rounded-2xl border border-white/16 bg-black/42 p-3 shadow-[0_16px_48px_rgba(0,0,0,0.42)] backdrop-blur-2xl">
              {roomInfo.qrDataUrl && (
                <div className="shrink-0 rounded-xl bg-snow p-1.5 shadow-inner">
                  <img
                    src={roomInfo.qrDataUrl}
                    alt={`Scan to join room ${roomInfo.roomCode}`}
                    className="h-[74px] w-[74px]"
                  />
                </div>
              )}
              <div className="min-w-0 space-y-1 pr-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-snow/50">
                    Scan to Queue
                  </span>
                  <button
                    type="button"
                    aria-label="Minimize QR overlay"
                    onClick={() => setQrMinimized(true)}
                    className="rounded px-1.5 py-0.5 font-mono text-[10px] text-snow/45 transition hover:bg-white/10 hover:text-snow"
                  >
                    –
                  </button>
                </div>
                <div className="font-mono text-lg font-bold tracking-wider text-snow">
                  {roomInfo.roomCode}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <SyncStatusBadge
                    state={roomInfo.connState}
                    transport={roomInfo.transport}
                    compact
                  />
                  <span className="text-[11px] text-snow/55">
                    {roomInfo.onlineCount} online · {roomInfo.queueCount} queued
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
