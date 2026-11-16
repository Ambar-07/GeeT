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
