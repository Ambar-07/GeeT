import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Logo } from "../components/Brand";

export function HomePage() {
  const [code, setCode] = useState("");
  const navigate = useNavigate();

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const clean = code.trim().toUpperCase();
    if (clean) navigate(`/join/${encodeURIComponent(clean)}`);
  }

  return (
    <div className="home-shell relative flex min-h-dvh flex-col overflow-hidden text-snow">
      {/* Soft ambient stage glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div
          className="aura-blob aura-blob-a left-1/2 top-[38%] h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-25 blur-[130px]"
          style={{ background: "radial-gradient(circle, #fa2d48 0%, transparent 70%)" }}
        />
        <div
          className="aura-blob aura-blob-b left-[58%] top-[56%] h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-20 blur-[120px]"
          style={{ background: "radial-gradient(circle, #4f46e5 0%, transparent 72%)" }}
        />
      </div>

      <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-6 sm:px-10">
        <header className="flex items-center justify-between py-6">
          <Link to="/" aria-label="GeeT home">
            <Logo size={30} />
          </Link>
          <Link to="/host" className="btn-ghost px-4 py-2 text-xs">
            Open Stage
          </Link>
        </header>

        <main className="my-auto flex flex-col items-center py-16 text-center">
          <h1 className="max-w-3xl text-[clamp(2.75rem,6.5vw,5rem)] font-bold leading-[1.03] tracking-[-0.045em] text-white">
            <span className="sr-only">GeeT Karaoke — </span>
            Sing your library.
          </h1>

          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-white/55 sm:text-base">
            Synced lyrics, live vocals, and instant party rooms.
          </p>

          <div className="mt-9 flex w-full max-w-md flex-col items-stretch justify-center gap-3 sm:max-w-lg sm:flex-row sm:items-center">
            <Link to="/host" className="btn-primary shrink-0 px-7 py-3 text-sm">
              Host a Party
            </Link>

            <form
              onSubmit={handleJoin}
              className="flex min-w-0 flex-1 items-center rounded-full border border-white/12 bg-white/[0.05] p-1 pl-4 backdrop-blur-xl transition focus-within:border-white/30 focus-within:bg-white/[0.08]"
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
                className="min-w-0 flex-1 bg-transparent text-xs font-medium uppercase tracking-[0.16em] text-white outline-none placeholder:normal-case placeholder:tracking-normal placeholder:text-white/40"
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
    </div>
  );
}
