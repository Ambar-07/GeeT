import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

export function HomePage() {
  const [code, setCode] = useState("");
  const navigate = useNavigate();

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const clean = code.trim().toUpperCase();
    if (clean) navigate(`/join/${encodeURIComponent(clean)}`);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-8 px-6 py-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">GeeT Karaoke</h1>
        <p className="mt-2 text-sm text-slate-400">
          Private room karaoke. Host plays local music; phones join to browse and queue.
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="text-lg font-semibold">Join a Room</h2>
        <form onSubmit={handleJoin} className="mt-4 flex gap-3">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Room code (e.g. A1B2C3D4)"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm uppercase outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500"
          >
            Join
          </button>
        </form>
      </div>

      <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900 p-6">
        <div>
          <h2 className="text-lg font-semibold">Host a Session</h2>
          <p className="text-xs text-slate-400">Requires local host agent on 127.0.0.1:8765</p>
        </div>
        <Link
          to="/host"
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium hover:bg-slate-800"
        >
          Open Host Console
        </Link>
      </div>
    </main>
  );
}
