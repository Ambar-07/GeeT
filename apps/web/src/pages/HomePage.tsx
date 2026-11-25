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
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-8 sm:px-10">
        <header className="flex items-center justify-between">
          <Link to="/">
            <Logo size={28} />
          </Link>
          <Link to="/host" className="btn-ghost px-4 py-2 text-xs">
            Open Stage
          </Link>
        </header>

        <main className="my-auto py-16">
          <div className="max-w-xl space-y-6">
            <h1 className="text-4xl font-bold leading-[1.08] tracking-[-0.035em] text-white sm:text-6xl">
              GeeT Karaoke.
              <br />
              <span className="text-white/55">Your music, on the big screen.</span>
            </h1>
            <p className="max-w-md text-sm leading-relaxed text-white/55 sm:text-base">
              Live synced lyrics, instant instrumentals, and a phone QR queue for the whole room.
            </p>

            <div className="flex flex-col gap-3 pt-2 sm:flex-row">
              <form
                onSubmit={handleJoin}
                className="flex flex-1 items-center rounded-full border border-white/14 bg-white/[0.06] p-1.5 pl-4 backdrop-blur-xl transition focus-within:border-white/30 focus-within:bg-white/[0.09]"
              >
                <input
                  aria-label="Room code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Room code"
                  className="min-w-0 flex-1 bg-transparent text-xs font-medium uppercase tracking-wider text-white placeholder:normal-case placeholder:tracking-normal placeholder:text-white/40 outline-none"
                />
                <button type="submit" className="btn-light ml-2 px-4 py-1.5 text-xs">
                  Join
                </button>
              </form>

              <Link to="/host" className="btn-primary shrink-0 px-7 py-3 text-xs">
                Host a Party
              </Link>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
