import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { buildJoinUrl } from "@geet/shared";
import { fetchSongsPage } from "../lib/hostAgent";
import {
  createHostRoom,
  ensureAuthSession,
  fetchRoomSnapshot,
  getStoredHostCapability,
  publishRoomSongs,
  reconcileSnapshot,
  setHostRoomStatus,
  subscribeToRoom,
  type RoomSnapshot,
} from "../lib/rooms";
import { isSupabaseConfigured } from "../lib/supabase";

const ACTIVE_ROOM_KEY = "geet_active_host_room";

export function HostRoomPanel() {
  const [roomId, setRoomId] = useState<string | null>(() => sessionStorage.getItem(ACTIVE_ROOM_KEY));
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const [connState, setConnState] = useState<"idle" | "connecting" | "subscribed" | "disconnected">("idle");
  const [reactions, setReactions] = useState<Array<{ sender: string; label: string }>>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const appOrigin = (import.meta.env.VITE_APP_ORIGIN as string | undefined) || window.location.origin;
  const joinUrl = snapshot ? buildJoinUrl(appOrigin, snapshot.room.code) : null;

  useEffect(() => {
    if (!joinUrl) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(joinUrl, { width: 180, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [joinUrl]);

  useEffect(() => {
    if (!roomId || !isSupabaseConfigured) return;
    let active = true;
    let unsub: (() => void) | null = null;

    (async () => {
      try {
        const { userId } = await ensureAuthSession();
        const initial = await fetchRoomSnapshot(roomId);
        if (!active) return;
        setSnapshot((prev) => reconcileSnapshot(prev, initial, true));

        const sub = subscribeToRoom(roomId, userId, "Host", {
          onSnapshot: (snap) => setSnapshot((prev) => reconcileSnapshot(prev, snap)),
          onPresenceCount: setOnlineIds,
          onReaction: (r) => setReactions((prev) => [r, ...prev].slice(0, 8)),
          onConnectionState: setConnState,
        });
        unsub = sub.unsubscribe;
      } catch (err) {
        if (active) setMsg(err instanceof Error ? err.message : "Failed to restore room");
      }
    })();

    return () => {
      active = false;
      unsub?.();
    };
  }, [roomId]);

  if (!isSupabaseConfigured) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-semibold text-slate-300">Cloud Room</h2>
        <p className="mt-1 text-xs text-slate-400">
          Configure VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to enable rooms and QR join.
        </p>
      </section>
    );
  }

  async function handleCreateRoom() {
    setBusy(true);
    setMsg(null);
    try {
      const created = await createHostRoom();
      sessionStorage.setItem(ACTIVE_ROOM_KEY, created.roomId);
      setRoomId(created.roomId);
      setMsg(`Room ${created.code} created.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to create room");
    } finally {
      setBusy(false);
    }
  }

  async function handlePublishLibrary() {
    if (!roomId) return;
    setBusy(true);
    setMsg("Publishing catalogue metadata...");
    try {
      const allSongs = [];
      let cursor: string | null = null;
      do {
        const page = await fetchSongsPage("", cursor);
        allSongs.push(...page.songs);
        cursor = page.next_cursor;
      } while (cursor);

      const count = await publishRoomSongs(roomId, allSongs);
      setMsg(`Published ${count} song metadata record(s) to room.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleStatusChange(next: "open" | "host_disconnected" | "closed") {
    if (!roomId) return;
    const cap = getStoredHostCapability(roomId);
    if (!cap) {
      setMsg("Missing host capability in this browser session.");
      return;
    }
    setBusy(true);
    try {
      await setHostRoomStatus(roomId, next, cap);
      if (next === "closed") {
        sessionStorage.removeItem(ACTIVE_ROOM_KEY);
        setRoomId(null);
        setSnapshot(null);
        setConnState("idle");
      } else {
        const fresh = await fetchRoomSnapshot(roomId);
        setSnapshot(fresh);
      }
      setMsg(`Room status updated to ${next}.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Status update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-300">Cloud Room & QR Join</h2>
          <p className="text-xs text-slate-400">
            Realtime: {connState} {snapshot ? `• Rev ${snapshot.room.revision}` : ""}
          </p>
        </div>

        {!snapshot ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleCreateRoom()}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            Create Room
          </button>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handlePublishLibrary()}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              Publish Library
            </button>
            {snapshot.room.status === "open" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleStatusChange("host_disconnected")}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800"
              >
                Pause Room
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleStatusChange("open")}
                className="rounded-lg border border-emerald-700 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-950"
              >
                Resume Room
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleStatusChange("closed")}
              className="rounded-lg border border-rose-800 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-950"
            >
              Close Room
            </button>
          </div>
        )}
      </div>

      {snapshot && (
        <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
          {qrDataUrl && (
            <div className="rounded-lg bg-white p-2 w-fit">
              <img src={qrDataUrl} alt={`Join room ${snapshot.room.code}`} className="h-40 w-40" />
            </div>
          )}
          <div className="space-y-2 text-xs">
            <p>
              Room Code: <span className="font-mono text-base font-bold text-indigo-300">{snapshot.room.code}</span>
              <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 uppercase">{snapshot.room.status}</span>
            </p>
            {joinUrl && (
              <p className="break-all text-slate-400">
                Join URL: <span className="text-slate-200">{joinUrl}</span>
              </p>
            )}
            <p className="text-slate-400">
              Published songs: {snapshot.songs.length} • Participants: {snapshot.participants.length} ({onlineIds.length} online)
            </p>
            {snapshot.participants.length > 0 && (
              <p className="text-slate-300">
                Members: {snapshot.participants.map((p) => `${p.display_name} (${p.role})`).join(", ")}
              </p>
            )}
            {reactions.length > 0 && (
              <p className="text-indigo-300">
                Recent reactions: {reactions.map((r) => `${r.sender}: ${r.label}`).join(" | ")}
              </p>
            )}
          </div>
        </div>
      )}

      {msg && <p className="text-xs text-slate-300">{msg}</p>}
    </section>
  );
}
