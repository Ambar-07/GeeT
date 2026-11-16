import { Link, useParams } from "react-router-dom";
import { isSupabaseConfigured } from "../lib/supabase";

export function RoomPage() {
  const { code } = useParams<{ code: string }>();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 py-12">
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <p className="text-xs uppercase tracking-wider text-indigo-400">Room</p>
        <h1 className="mt-1 text-2xl font-bold">{code ?? "Unknown"}</h1>
        <p className="mt-3 text-sm text-slate-400">
          {isSupabaseConfigured
            ? "Room authentication and live queue arrive in Phase 4–5."
            : "Supabase is not configured yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY."}
        </p>
        <Link to="/" className="mt-6 inline-block text-sm text-indigo-400 hover:underline">
          Back to Home
        </Link>
      </div>
    </main>
  );
}
