import {
  HostHealthSchema,
  HostSongSchema,
  JobSchema,
  LyricsRecordSchema,
  SongPageSchema,
  type AudioMode,
  type HostHealth,
  type HostSong,
  type Job,
  type LyricsRecord,
  type SongPage,
} from "@geet/shared";

const BASE_URL = (import.meta.env.VITE_HOST_AGENT_URL as string | undefined) ?? "http://127.0.0.1:8765";

export function mediaUrl(songId: string, mode: AudioMode = "original"): string {
  const base = `${BASE_URL}/media/${encodeURIComponent(songId)}`;
  return mode === "original" ? base : `${base}?mode=${encodeURIComponent(mode)}`;
}

export async function fetchHostHealth(): Promise<HostHealth> {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Host agent health failed: ${res.status}`);
  return HostHealthSchema.parse(await res.json());
}

export async function selectLibraryFolder(path: string): Promise<{ approved_dirs: number }> {
  const res = await fetch(`${BASE_URL}/library/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Select folder failed: ${res.status}`);
  }
  return res.json();
}

export interface ScanResult {
  job_id: string;
  status: string;
  scanned: number;
  skipped_unchanged: number;
  removed: number;
  rejected_drm: number;
  duplicates: number;
}

export async function scanLibrary(): Promise<ScanResult> {
  const res = await fetch(`${BASE_URL}/library/scan`, { method: "POST" });
  if (!res.ok) throw new Error(`Scan failed: ${res.status}`);
  return res.json();
}

export async function fetchSongsPage(query = "", cursor?: string | null): Promise<SongPage> {
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`${BASE_URL}/library/songs?${params.toString()}`);
  if (!res.ok) throw new Error(`List songs failed: ${res.status}`);
  return SongPageSchema.parse(await res.json());
}

export async function fetchSong(songId: string): Promise<HostSong> {
  const res = await fetch(`${BASE_URL}/library/songs/${encodeURIComponent(songId)}`);
  if (!res.ok) throw new Error(`Fetch song failed: ${res.status}`);
  return HostSongSchema.parse(await res.json());
}

export async function fetchLyrics(songId: string): Promise<LyricsRecord> {
  const res = await fetch(`${BASE_URL}/songs/${encodeURIComponent(songId)}/lyrics`);
  if (!res.ok) throw new Error(`Fetch lyrics failed: ${res.status}`);
  return LyricsRecordSchema.parse(await res.json());
}

export async function saveLyrics(
  songId: string,
  payload: { lrc_text: string; offset_ms: number; source: "manual" | "lrclib" | "sidecar" }
): Promise<LyricsRecord> {
  const res = await fetch(`${BASE_URL}/songs/${encodeURIComponent(songId)}/lyrics`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Save lyrics failed: ${res.status}`);
  return LyricsRecordSchema.parse(await res.json());
}

export async function lookupLyrics(
  songId: string
): Promise<{ found: boolean; synced_lyrics?: string; reason?: string | null }> {
  const res = await fetch(`${BASE_URL}/songs/${encodeURIComponent(songId)}/lyrics/lookup`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`LRCLIB lookup failed: ${res.status}`);
  return res.json();
}

export async function prepareSong(
  songId: string,
  reprocess = false
): Promise<{ job_id: string | null; song_id: string; status: string; device: string }> {
  const res = await fetch(`${BASE_URL}/songs/${encodeURIComponent(songId)}/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reprocess }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Prepare failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchJob(jobId: string): Promise<Job> {
  const res = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(`Fetch job failed: ${res.status}`);
  return JobSchema.parse(await res.json());
}

export async function cancelJob(jobId: string): Promise<{ id: string; status: string }> {
  const res = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Cancel job failed: ${res.status}`);
  return res.json();
}

export async function clearSongCache(songId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/songs/${encodeURIComponent(songId)}/cache/clear`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Clear cache failed: ${res.status}`);
}

export async function backupMetadata(): Promise<{ ok: boolean; filename: string; size_bytes: number }> {
  const res = await fetch(`${BASE_URL}/backup`, { method: "POST" });
  if (!res.ok) throw new Error(`Backup failed: ${res.status}`);
  return res.json();
}
