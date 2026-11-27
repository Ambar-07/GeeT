import { useEffect, useState } from "react";
import { Cover, displayTitle } from "./Cover";
import { SyncStatusBadge } from "./SyncStatusBadge";
import type { HostStageRoomInfo, StageReactionBurst, UpNextItem } from "./HostRoomPanel";

export interface EncoreTransitionState {
  finishedTitle: string;
  finishedSinger: string | null;
  reactionCount: number;
  nextItem: UpNextItem;
  secondsLeft: number;
  onPlayNow: () => void;
  onCancel: () => void;
}

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
  encoreTransition?: EncoreTransitionState | null;
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
  encoreTransition = null,
}: TvStageOverlayProps) {
  const [qrMinimized, setQrMinimized] = useState(false);
  const [announcedEntryId, setAnnouncedEntryId] = useState<string | null>(null);

  const currentSinger = roomInfo?.currentSinger ?? null;
  const nextUp = roomInfo?.upNext[0] ?? null;
  const isNearingEnd =
    hasActiveSong && durationSec > 10 && remainingSec > 0 && remainingSec <= 25;
  const showProminentUpNext = Boolean(
    nextUp && (isNearingEnd || (!isPlaying && hasActiveSong))
  );
  const showCompactUpNext = Boolean(
    tvMode && showOverlay && nextUp && !showProminentUpNext
  );

  // Brief celebratory "Now on Stage" banner whenever a queued guest singer starts
  useEffect(() => {
    if (!currentSinger?.entryId) {
      setAnnouncedEntryId(null);
      return;
    }
    setAnnouncedEntryId(currentSinger.entryId);
    const timer = window.setTimeout(() => setAnnouncedEntryId(null), 5500);
    return () => window.clearTimeout(timer);
  }, [currentSinger?.entryId]);

  const showSingerSpotlight = Boolean(
    currentSinger && announcedEntryId === currentSinger.entryId && hasActiveSong
  );
  const showCompactSinger = Boolean(
    tvMode && showOverlay && currentSinger && hasActiveSong && !showSingerSpotlight
  );

  return (
    <div
      aria-label="Stage overlays"
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      {/* Celebratory "Now on Stage" Singer Announcement Banner */}
      {showSingerSpotlight && currentSinger && (
        <div
          role="status"
          className="animate-toast-up pointer-events-none absolute left-1/2 top-5 z-30 flex max-w-md -translate-x-1/2 items-center gap-3 rounded-full border border-white/18 bg-black/55 py-2 pl-2.5 pr-5 shadow-[0_16px_48px_rgba(0,0,0,0.5)] backdrop-blur-2xl"
        >
          <Cover
            title={currentSinger.title}
            songId={currentSinger.hostSongId || undefined}
            size={34}
            className="rounded-full ring-1 ring-white/20"
          />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#ff6b8b]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#fa2d48]" />
              Now on Stage · {currentSinger.singer}
            </p>
            <p className="truncate text-xs font-bold text-white">
              {displayTitle(currentSinger.title)}
            </p>
          </div>
        </div>
      )}

      {/* Subtle persistent singer chip in TV Stage Mode */}
      {showCompactSinger && currentSinger && (
        <div className="pointer-events-none absolute left-6 top-5 inline-flex max-w-[240px] items-center gap-2 rounded-full border border-white/14 bg-black/38 px-3.5 py-1.5 text-xs backdrop-blur-xl">
          <span className="h-1.5 w-1.5 rounded-full bg-[#fa2d48]" />
          <span className="truncate font-semibold text-white/90">{currentSinger.singer}</span>
          <span className="text-[10px] text-white/50">on stage</span>
        </div>
      )}

      {/* Floating Animated Reaction Bursts (active in both Split View and TV Stage Mode) */}
      <div
        aria-live="polite"
        className="pointer-events-none absolute bottom-20 right-6 flex flex-col items-end gap-2 sm:right-10"
      >
        {reactions.map((r) => (
          <div
            key={r.id}
            style={{ marginRight: `${r.offsetX}px` }}
            className="animate-reaction-float inline-flex items-center gap-2 rounded-full border border-white/18 bg-black/48 px-3.5 py-1.5 text-xs shadow-[0_8px_28px_rgba(0,0,0,0.35)] backdrop-blur-xl"
          >
            <span aria-hidden="true" className="text-base leading-none">
              {REACTION_GLYPHS[r.label] ?? "✨"}
            </span>
            <span className="font-semibold text-snow">{r.label}</span>
            <span className="font-mono text-[10px] text-snow/60">· {r.sender}</span>
          </div>
        ))}
      </div>

      {/* Subtle Preparing Pill (pinned to top-right clear of album artwork and TV controls) */}
      {autoPreparingTitle && (
        <div
          role="status"
          className={`pointer-events-auto absolute z-30 inline-flex items-center gap-2 rounded-full border border-white/14 bg-black/55 px-3.5 py-1.5 font-mono text-[11px] text-white/85 shadow-lg backdrop-blur-xl ${
            tvMode ? "right-28 top-5" : "right-5 top-4"
          }`}
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#fa2d48]" />
          <span className="max-w-[240px] truncate">
            Preparing: {displayTitle(autoPreparingTitle)}
            {autoPrepareProgress !== null ? ` (${autoPrepareProgress}%)` : ""}
          </span>
        </div>
      )}

      {/* Prominent "Up Next" Toast when current song nears the end or pauses */}
      {!encoreTransition && showProminentUpNext && nextUp && (
        <div
          role="status"
          className="animate-toast-up pointer-events-auto absolute bottom-6 left-6 z-30 flex max-w-md items-center gap-3.5 rounded-2xl border border-white/18 bg-black/55 px-4 py-3 shadow-[0_16px_48px_rgba(0,0,0,0.5)] backdrop-blur-2xl"
        >
          <Cover
            title={nextUp.title}
            songId={nextUp.hostSongId || undefined}
            size={42}
            className="rounded-xl ring-1 ring-white/15"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#ff6b8b]">
                {isNearingEnd ? `Up Next in ${Math.ceil(remainingSec)}s` : "Up Next"}
              </span>
              {nextUp.readiness === "ready" && (
                <span className="rounded-full bg-white/12 px-1.5 py-0.5 font-mono text-[9px] uppercase text-white/85">
                  Inst Ready
                </span>
              )}
              {nextUp.readiness === "preparing" && (
                <span className="rounded-full bg-amber-400/15 px-1.5 py-0.5 font-mono text-[9px] uppercase text-amber-300">
                  Preparing
                </span>
              )}
            </div>
            <p className="truncate text-sm font-bold text-snow">
              {displayTitle(nextUp.title)}
            </p>
            <p className="truncate text-xs text-snow/65">
              Sung by <span className="font-semibold text-snow">{nextUp.requester}</span>
            </p>
          </div>
          {roomInfo?.playNext && (
            <button
              type="button"
              onClick={roomInfo.playNext}
              className="btn-primary shrink-0 px-3.5 py-1.5 text-[11px]"
            >
              Play Now
            </button>
          )}
        </div>
      )}

      {/* Encore Transition Countdown Card between party songs */}
      {encoreTransition && (
        <div
          role="status"
          aria-live="polite"
          className="animate-toast-up pointer-events-auto absolute inset-x-4 top-1/2 z-40 mx-auto max-w-md -translate-y-1/2 rounded-3xl border border-white/18 bg-[#0b0812]/82 p-6 text-center shadow-[0_28px_80px_rgba(0,0,0,0.68)] backdrop-blur-2xl"
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#ff7a98]">
            Encore{encoreTransition.finishedSinger ? ` · ${encoreTransition.finishedSinger}` : ""}
          </p>
          <p className="mt-1 truncate text-sm text-white/65">
            {displayTitle(encoreTransition.finishedTitle)}
            {encoreTransition.reactionCount > 0
              ? ` · 🔥 ${encoreTransition.reactionCount} ${encoreTransition.reactionCount === 1 ? "cheer" : "cheers"}`
              : ""}
          </p>

          <div className="my-5 flex items-center gap-3.5 rounded-2xl border border-white/12 bg-white/[0.06] p-3 text-left">
            <Cover
              title={encoreTransition.nextItem.title}
              songId={encoreTransition.nextItem.hostSongId || undefined}
              size={52}
              className="rounded-xl ring-1 ring-white/15"
            />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/55">
                Up Next in {encoreTransition.secondsLeft}s
              </p>
              <p className="mt-0.5 truncate text-base font-bold text-white">
                {displayTitle(encoreTransition.nextItem.title)}
              </p>
              <p className="truncate text-xs text-white/65">
                Sung by <span className="font-semibold text-white">{encoreTransition.nextItem.requester}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2.5">
            <button
              type="button"
              onClick={encoreTransition.onPlayNow}
              className="btn-primary px-6 py-2.5 text-xs"
            >
              Play Now
            </button>
            <button
              type="button"
              onClick={encoreTransition.onCancel}
              className="btn-ghost px-5 py-2.5 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Subtle TV Mode Up Next Chip when not near end */}
      {showCompactUpNext && nextUp && (
        <div className="pointer-events-auto absolute bottom-5 left-6 inline-flex max-w-sm items-center gap-2.5 rounded-full border border-white/15 bg-black/42 px-3.5 py-1.5 text-xs backdrop-blur-xl">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#ff6b8b]">
            Up Next
          </span>
          <span className="truncate font-semibold text-snow">
            {displayTitle(nextUp.title)}
          </span>
          <span className="shrink-0 text-snow/65">({nextUp.requester})</span>
        </div>
      )}

      {/* TV Stage Mode Corner QR & Room Code Pill */}
      {tvMode && showOverlay && roomInfo?.active && roomInfo.roomCode && (
        <div className="pointer-events-auto absolute bottom-5 right-6 z-30">
          {qrMinimized ? (
            <button
              type="button"
              onClick={() => setQrMinimized(false)}
              className="flex items-center gap-2.5 rounded-full border border-white/18 bg-black/45 px-3.5 py-2 text-xs shadow-xl backdrop-blur-2xl transition hover:bg-black/60"
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
            <div className="flex items-center gap-3.5 rounded-2xl border border-white/16 bg-black/48 p-3 shadow-[0_16px_48px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
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
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-snow/55">
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
