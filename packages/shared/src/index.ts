import { z } from "zod";

export const SongReadinessSchema = z.enum([
  "raw",
  "preparing",
  "ready",
  "failed",
  "drm_rejected",
]);
export type SongReadiness = z.infer<typeof SongReadinessSchema>;

export const HostHealthSchema = z.object({
  status: z.literal("ok"),
  sqlite: z.boolean(),
  ffmpeg: z.boolean(),
  ffprobe: z.boolean(),
  approved_dirs: z.number().int().nonnegative(),
  song_count: z.number().int().nonnegative(),
});
export type HostHealth = z.infer<typeof HostHealthSchema>;

export const HostSongSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string().nullable().optional(),
  duration_ms: z.number().int().nonnegative(),
  format: z.string(),
  readiness: SongReadinessSchema,
  has_lyrics: z.boolean(),
  has_instrumental: z.boolean(),
  duplicate_of: z.string().nullable().optional(),
});
export type HostSong = z.infer<typeof HostSongSchema>;

export const SongPageSchema = z.object({
  songs: z.array(HostSongSchema),
  next_cursor: z.string().nullable(),
});
export type SongPage = z.infer<typeof SongPageSchema>;

export const JobStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: JobStatusSchema,
  progress: z.number().min(0).max(100),
  detail: z.string().nullable().optional(),
});
export type Job = z.infer<typeof JobSchema>;

export const LyricsRecordSchema = z.object({
  song_id: z.string(),
  lrc_text: z.string(),
  offset_ms: z.number().int(),
  source: z.enum(["none", "sidecar", "manual", "lrclib"]),
  synchronized_ready: z.boolean(),
});
export type LyricsRecord = z.infer<typeof LyricsRecordSchema>;

export const RoomStatusSchema = z.enum(["open", "host_disconnected", "closed"]);
export type RoomStatus = z.infer<typeof RoomStatusSchema>;

export const QueueEntryStatusSchema = z.enum(["queued", "playing", "played", "skipped"]);
export type QueueEntryStatus = z.infer<typeof QueueEntryStatusSchema>;

export const RoomSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  host_user_id: z.string().uuid(),
  status: RoomStatusSchema,
  revision: z.number().int(),
  created_at: z.string(),
  expires_at: z.string(),
});
export type Room = z.infer<typeof RoomSchema>;

export const RoomParticipantSchema = z.object({
  room_id: z.string().uuid(),
  user_id: z.string().uuid(),
  display_name: z.string(),
  role: z.enum(["host", "participant"]),
  joined_at: z.string(),
  last_seen: z.string(),
  revoked_at: z.string().nullable().optional(),
});
export type RoomParticipant = z.infer<typeof RoomParticipantSchema>;

export const RoomSongSchema = z.object({
  id: z.string().uuid(),
  room_id: z.string().uuid(),
  host_song_id: z.string(),
  title: z.string(),
  artist: z.string(),
  duration_ms: z.number().int().nonnegative(),
  readiness: z.enum(["raw", "preparing", "ready", "failed"]),
});
export type RoomSong = z.infer<typeof RoomSongSchema>;

export const PlaybackStateSchema = z.object({
  room_id: z.string().uuid(),
  song_id: z.string().uuid().nullable(),
  status: z.enum(["idle", "playing", "paused", "ended"]),
  position_ms: z.number().int().nonnegative(),
  revision: z.number().int(),
  updated_at: z.string(),
});
export type PlaybackState = z.infer<typeof PlaybackStateSchema>;

export const QueueEntrySchema = z.object({
  id: z.string().uuid(),
  room_id: z.string().uuid(),
  song_id: z.string().uuid(),
  requested_by: z.string().uuid(),
  position: z.number().int().nonnegative(),
  status: QueueEntryStatusSchema,
  idempotency_key: z.string(),
  created_at: z.string(),
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;

/** Build QR/join URL containing only the origin and room code (never session tokens). */
export function buildJoinUrl(origin: string, code: string): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  return `${cleanOrigin}/join/${encodeURIComponent(code.trim().toUpperCase())}`;
}
