import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { HostSong } from "@geet/shared";
import { Logo } from "../components/Brand";
import { Cover, displayTitle } from "../components/Cover";
import { PixelStageCanvas, type StageAudioFrame } from "../components/PixelStageCanvas";
import { fetchSongsPage, mediaUrl } from "../lib/hostAgent";

function shuffleList<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function HomePage() {
  const [code, setCode] = useState("");
  const navigate = useNavigate();

  // Full-library shuffled soundtrack driving the live pixel-art karaoke club
  const [hasTracks, setHasTracks] = useState(false);
  const [trackCount, setTrackCount] = useState(0);
  const [currentTrack, setCurrentTrack] = useState<HostSong | null>(null);
  const [soundOn, setSoundOn] = useState(false);

  const allTracksRef = useRef<HostSong[]>([]);
  const shuffleBagRef = useRef<HostSong[]>([]);
  const currentTrackRef = useRef<HostSong | null>(null);
  currentTrackRef.current = currentTrack;

  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const freqBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const waveBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const playSeqRef = useRef(0);
  const soundOnRef = useRef(false);
  soundOnRef.current = soundOn;

  useEffect(() => {
    let cancelled = false;

    async function loadFullLibraryPool() {
      try {
        const byId = new Map<string, HostSong>();
        let cursor: string | null = null;
        let firstPage = true;
        do {
          const page = await fetchSongsPage("", cursor);
          if (cancelled) return;
          for (const song of page.songs) {
            if (song.readiness !== "drm_rejected" && !byId.has(song.id)) {
              byId.set(song.id, song);
            }
          }
          if (firstPage && byId.size > 0) {
            firstPage = false;
            const initial = Array.from(byId.values());
            allTracksRef.current = initial;
            shuffleBagRef.current = shuffleList(initial);
            setHasTracks(true);
            setTrackCount(initial.length);
          }
          cursor = page.next_cursor;
        } while (cursor);

        if (cancelled) return;
        const fullPool = Array.from(byId.values());
        if (fullPool.length > 0) {
          allTracksRef.current = fullPool;
          const activeId = currentTrackRef.current?.id;
          shuffleBagRef.current = shuffleList(
            fullPool.filter((s) => fullPool.length === 1 || s.id !== activeId)
          );
          setHasTracks(true);
          setTrackCount(fullPool.length);
        }
      } catch {
        // Host agent offline — pixel-art club stage still grooves smoothly and reacts to mouse/clicks
      }
    }

    void loadFullLibraryPool();

    return () => {
      cancelled = true;
      if (audioElRef.current) {
        audioElRef.current.pause();
        audioElRef.current.removeAttribute("src");
        audioElRef.current.load();
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        void audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  const ensureAnalyser = useCallback((el: HTMLAudioElement) => {
    if (analyserRef.current && audioCtxRef.current) {
      if (audioCtxRef.current.state === "suspended") {
        void audioCtxRef.current.resume().catch(() => {});
      }
      return;
    }
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.82;
    const source = ctx.createMediaElementSource(el);
    source.connect(analyser);
    analyser.connect(ctx.destination);
    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
    freqBufRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    waveBufRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  }, []);

  const drawNextShuffled = useCallback((): HostSong | null => {
    const pool = allTracksRef.current;
    if (pool.length === 0) return null;
    if (shuffleBagRef.current.length === 0) {
      const activeId = currentTrackRef.current?.id;
      shuffleBagRef.current = shuffleList(
        pool.filter((s) => pool.length === 1 || s.id !== activeId)
      );
    }
    return shuffleBagRef.current.pop() ?? pool[0] ?? null;
  }, []);

  const playTrack = useCallback(
    (song: HostSong, retriesLeft = 2) => {
      let el = audioElRef.current;
      if (!el) {
        el = new Audio();
        el.crossOrigin = "anonymous";
        el.volume = 0.45;
        el.addEventListener("ended", () => {
          const next = drawNextShuffled();
          if (next) playTrack(next);
        });
        audioElRef.current = el;
      }
      try {
        ensureAnalyser(el);
      } catch {
        // Fall back to audio playback without analyser if browser blocks AudioContext
      }
      const seq = ++playSeqRef.current;
      const url = mediaUrl(song.id, "original");
      if (el.src !== url) {
        el.src = url;
      }
      setCurrentTrack(song);
      setSoundOn(true);
      void el.play().catch((err) => {
        if (seq !== playSeqRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          setSoundOn(false);
          return;
        }
        if (retriesLeft > 0) {
          const next = drawNextShuffled();
          if (next && next.id !== song.id) {
            playTrack(next, retriesLeft - 1);
            return;
          }
        }
        setSoundOn(false);
      });
    },
    [drawNextShuffled, ensureAnalyser]
  );

  function toggleSound() {
    if (allTracksRef.current.length === 0) return;
    const el = audioElRef.current;
    if (soundOn && el) {
      el.pause();
      setSoundOn(false);
      return;
    }
    if (currentTrack && el && el.src) {
      if (audioCtxRef.current?.state === "suspended") {
        void audioCtxRef.current.resume().catch(() => {});
      }
      setSoundOn(true);
      void el.play().catch(() => setSoundOn(false));
      return;
    }
    const pick = drawNextShuffled();
    if (pick) playTrack(pick);
  }

  function skipTrack() {
    const pick = drawNextShuffled();
    if (pick) playTrack(pick);
  }

  const getAudioFrame = useCallback((): StageAudioFrame => {
    const analyser = analyserRef.current;
    const buf = freqBufRef.current;
    const wave = waveBufRef.current;
    const el = audioElRef.current;
    if (!soundOnRef.current || !analyser || !buf || !wave || !el || el.paused) {
      return { bass: 0, mid: 0, high: 0, energy: 0, bins: null, waveform: null, live: false };
    }
    analyser.getByteFrequencyData(buf);
    analyser.getByteTimeDomainData(wave);
    let bassSum = 0;
    let midSum = 0;
    let highSum = 0;
    for (let i = 0; i < 7; i++) bassSum += buf[i];
    for (let i = 7; i < 29; i++) midSum += buf[i];
    for (let i = 29; i < 72; i++) highSum += buf[i];
    const bass = bassSum / (7 * 255);
    const mid = midSum / (22 * 255);
    const high = highSum / (43 * 255);
    return {
      bass,
      mid,
      high,
      energy: bass * 0.5 + mid * 0.35 + high * 0.15,
      bins: buf,
      waveform: wave,
      live: true,
    };
  }, []);

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const clean = code.trim().toUpperCase();
    if (clean) navigate(`/join/${encodeURIComponent(clean)}`);
  }

  return (
    <div className="home-shell relative flex min-h-dvh flex-col overflow-hidden text-snow">
      {/* Interactive 5-layer parallax pixel-art karaoke club stage */}
      <PixelStageCanvas getAudioFrame={getAudioFrame} />

      {/* Soft atmospheric radial cushion behind hero text so typography reads effortlessly */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-[1]"
        style={{
          background:
            "radial-gradient(ellipse 52% 40% at 50% 38%, rgba(8, 6, 14, 0.84) 0%, rgba(8, 6, 14, 0.56) 46%, rgba(8, 6, 14, 0.14) 82%, rgba(8, 6, 14, 0.05) 100%)",
        }}
      />

      <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 pt-5 sm:px-8 sm:pt-6">
        {/* Floating frosted-glass pill navbar (concentric Apple-style geometry) */}
        <header className="mx-auto flex w-full max-w-[340px] items-center justify-between gap-8 rounded-full border border-white/[0.14] bg-[#100b18]/72 py-1.5 pl-4 pr-1.5 shadow-[0_14px_40px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-2xl sm:w-auto sm:max-w-none sm:min-w-[360px] sm:gap-16">
          <Link to="/" aria-label="GeeT home" className="shrink-0 transition hover:opacity-90">
            <Logo size={24} />
          </Link>
          <Link
            to="/host"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white/[0.11] px-4 text-xs font-semibold text-white ring-1 ring-inset ring-white/[0.12] transition hover:bg-white/[0.18] active:scale-[0.97]"
          >
            <span>Open Stage</span>
            <span aria-hidden="true" className="text-white/65">↗</span>
          </Link>
        </header>

        <main className="my-auto flex flex-col items-center px-2 pb-40 pt-8 text-center sm:pb-48">
          <h1 className="max-w-3xl text-[clamp(2.75rem,6.5vw,5rem)] font-bold leading-[1.03] tracking-[-0.045em] text-white [text-shadow:0_4px_24px_rgba(0,0,0,0.85)]">
            <span className="sr-only">GeeT Karaoke — </span>
            Sing your library.
          </h1>

          <p className="mt-4 max-w-md text-[15px] font-medium leading-relaxed text-white/90 [text-shadow:0_2px_16px_rgba(0,0,0,0.9)] sm:text-base">
            Synced lyrics, live vocals, and instant party rooms.
          </p>

          <div className="mt-8 flex w-full max-w-md flex-col items-stretch justify-center gap-3 sm:max-w-lg sm:flex-row sm:items-center">
            <Link to="/host" className="btn-primary shrink-0 px-7 py-3 text-sm shadow-[0_10px_30px_rgba(250,45,72,0.38)]">
              Host a Party
            </Link>

            <form
              onSubmit={handleJoin}
              className="flex min-w-0 flex-1 items-center rounded-full border border-white/20 bg-[#0a0712]/88 p-1 pl-4 shadow-[0_10px_30px_rgba(0,0,0,0.55)] backdrop-blur-xl transition focus-within:border-white/40 focus-within:bg-[#0e0a18]/95"
            >
              <input
                id="room-code"
                aria-label="Room code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^a-zA-Z0-9]/g, ""))}
                placeholder="Room code"
                maxLength={8}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-xs font-medium uppercase tracking-[0.16em] text-white outline-none placeholder:normal-case placeholder:tracking-normal placeholder:text-white/55"
                required
              />
              <button
                type="submit"
                disabled={!code.trim()}
                className="btn-light ml-2 min-h-[34px] shrink-0 px-5 py-1.5 text-xs"
              >
                Join
              </button>
            </form>
          </div>
        </main>
      </div>

      {/* Minimal frosted-glass shuffled sound pill with mini cover art */}
      {hasTracks && (
        <div className="fixed bottom-5 right-5 z-20 flex items-center gap-1 rounded-full border border-white/14 bg-[#0b0812]/72 p-1 shadow-[0_12px_36px_rgba(0,0,0,0.5)] backdrop-blur-xl">
          <button
            type="button"
            onClick={toggleSound}
            aria-label={soundOn ? "Mute background music" : "Play shuffled library preview"}
            className="flex min-h-[32px] items-center gap-2 rounded-full pl-1.5 pr-3 py-1 text-[11px] font-medium text-white/85 transition hover:bg-white/10 hover:text-white"
          >
            {soundOn && currentTrack ? (
              <Cover
                title={currentTrack.title}
                songId={currentTrack.id}
                hasCover={currentTrack.has_cover !== false}
                size={22}
                className="rounded-full ring-1 ring-white/20"
              />
            ) : (
              <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-white/10 text-white/75" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              </span>
            )}

            {soundOn && (
              <span className="flex h-3 items-end gap-[2px]" aria-hidden="true">
                <span className="h-2.5 w-[2px] animate-pulse rounded-full bg-white" />
                <span className="h-3 w-[2px] animate-pulse rounded-full bg-white [animation-delay:150ms]" />
                <span className="h-1.5 w-[2px] animate-pulse rounded-full bg-white [animation-delay:300ms]" />
              </span>
            )}

            <span className="max-w-[140px] truncate">
              {soundOn && currentTrack ? displayTitle(currentTrack.title) : "Sound"}
            </span>
          </button>

          {soundOn && trackCount > 1 && (
            <button
              type="button"
              onClick={skipTrack}
              aria-label="Next shuffled preview track"
              title="Next shuffled track"
              className="flex h-7 w-7 items-center justify-center rounded-full text-white/65 transition hover:bg-white/12 hover:text-white"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <polygon points="5,4 15,12 5,20" />
                <rect x="17" y="4" width="2.5" height="16" rx="1" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
