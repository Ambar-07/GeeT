import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Logo } from "../components/Brand";
import { ParticleSphere } from "../components/ParticleSphere";

export function HomePage() {
  const [code, setCode] = useState("");
  const navigate = useNavigate();

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const clean = code.trim().toUpperCase();
    if (clean) navigate(`/join/${encodeURIComponent(clean)}`);
  }

  return (
    <div className="min-h-screen bg-ink-950 text-snow">
      <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col justify-between px-6 py-7 sm:px-12">
        {/* Motion.dev Style Top Bar */}
        <header className="relative z-10 flex items-center justify-between">
          <Link to="/">
            <Logo size={26} />
          </Link>

          <nav
            aria-label="Primary navigation"
            className="hidden items-center gap-9 font-mono text-[11px] uppercase tracking-[0.18em] text-snow/80 md:flex"
          >
            <Link to="/host" className="transition hover:text-snow">
              Stage
            </Link>
            <a
              href="#join-bar"
              onClick={(e) => {
                e.preventDefault();
                document.querySelector<HTMLInputElement>('input[aria-label="Room code"]')?.focus();
              }}
              className="transition hover:text-snow"
            >
              Join Room
            </a>
            <Link to="/host" className="transition hover:text-snow">
              Lyrics Engine
            </Link>
          </nav>

          <div className="flex items-center gap-4">
            <Link
              to="/host"
              className="border border-white/25 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-snow transition hover:border-snow"
            >
              Host Console+
            </Link>
          </div>
        </header>

        {/* Center 3D Point-Cloud Particle Sphere + Bottom Split Hero */}
        <main className="relative my-auto flex flex-col justify-end py-6">
          <div className="pointer-events-none flex items-center justify-center py-2">
            <ParticleSphere size={440} />
          </div>

          <div className="relative z-10 mt-2 grid items-end gap-8 lg:grid-cols-[1.1fr_0.9fr]">
            {/* Bottom-Left Headline & Subcopy */}
            <section className="space-y-4">
              <h1 className="text-3xl font-bold leading-[1.08] tracking-[-0.035em] text-snow sm:text-[42px]">
                GeeT Karaoke.
                <br />
                The stage loved by living rooms and friends alike.
              </h1>
              <p className="max-w-md text-sm leading-relaxed text-snow/45">
                Synchronized LRC timing, local stem isolation, and instant QR phone queues for any TV or laptop.
              </p>
            </section>

            {/* Bottom-Right Command Bar + Primary CTA (Exact motion.dev composition) */}
            <section id="join-bar" className="flex flex-col items-stretch gap-3 lg:items-end">
              <p className="text-xs text-snow/45 lg:text-right">
                Private and local-first. Zero cloud audio streaming.
              </p>

              <div className="flex w-full max-w-[540px] flex-col gap-3 sm:flex-row">
                <form
                  onSubmit={handleJoin}
                  className="flex flex-1 items-center border border-white/18 bg-ink-900 px-3.5 py-2.5"
                >
                  <span className="mr-2 font-mono text-xs text-snow/40 select-none">room://</span>
                  <input
                    aria-label="Room code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="enter-room-code"
                    className="min-w-0 flex-1 bg-transparent font-mono text-xs uppercase tracking-wider text-snow placeholder:text-snow/35 outline-none"
                  />
                  <button
                    type="submit"
                    className="ml-2 border border-white/15 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-snow/80 transition hover:border-snow hover:text-snow"
                  >
                    Join
                  </button>
                </form>

                <Link
                  to="/host"
                  className="btn-primary shrink-0 px-6 py-3.5 text-xs"
                >
                  <span>Open Stage</span>
                  <span aria-hidden="true">&gt;</span>
                </Link>
              </div>
            </section>
          </div>
        </main>

        {/* Bottom Subtle Learn More / Status */}
        <footer className="flex flex-col items-center justify-center gap-1 pt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-snow/35">
          <span>Local Audio · 60 FPS Synced Lyrics · QR Queue</span>
        </footer>
      </div>
    </div>
  );
}
