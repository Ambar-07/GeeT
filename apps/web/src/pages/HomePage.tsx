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
    <div className="stage-ambient min-h-screen text-snow">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col justify-between px-6 py-8 sm:px-10">
        <header className="flex items-center justify-between">
          <Link to="/">
            <Logo size={26} />
          </Link>
          <Link to="/host" className="btn-ghost px-4 py-2 text-xs">
            Host Console
          </Link>
        </header>

        <main className="my-auto py-12">
          <div className="max-w-2xl space-y-6">
            <h1 className="text-4xl font-bold leading-[1.08] tracking-[-0.035em] text-snow sm:text-5xl">
              GeeT Karaoke.
              <br />
              Your local library on the big screen.
            </h1>
            <p className="max-w-lg text-sm leading-relaxed text-snow/60 sm:text-base">
              Synced lyrics from your local files, real embedded artwork, and a Wi-Fi QR queue for everyone in the room.
            </p>

            <div className="flex flex-col gap-3 pt-2 sm:flex-row">
              <form
                onSubmit={handleJoin}
                className="flex flex-1 items-center rounded-sm border border-white/18 bg-ink-900 px-3.5 py-2"
              >
                <input
                  aria-label="Room code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Room code"
                  className="min-w-0 flex-1 bg-transparent font-mono text-xs uppercase tracking-wider text-snow placeholder:text-snow/40 outline-none"
                />
                <button
                  type="submit"
                  className="ml-2 border border-white/15 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-snow/85 transition hover:border-snow hover:text-snow"
                >
                  Join
                </button>
              </form>

              <Link to="/host" className="btn-primary shrink-0 px-7 py-3 text-xs">
                Open Stage
              </Link>
            </div>
          </div>
        </main>

        <footer className="font-mono text-[10px] uppercase tracking-[0.2em] text-snow/35">
          Local Audio · Synced Lyrics · LAN & Cloud Party Queue
        </footer>
      </div>
    </div>
  );
}
