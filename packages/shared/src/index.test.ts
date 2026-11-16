import { describe, expect, it } from "vitest";
import { HostHealthSchema, HostSongSchema } from "./index";

describe("shared schemas", () => {
  it("validates host health payload", () => {
    const parsed = HostHealthSchema.parse({
      status: "ok",
      sqlite: true,
      ffmpeg: false,
      ffprobe: false,
      approved_dirs: 1,
      song_count: 3,
    });
    expect(parsed.status).toBe("ok");
  });

  it("rejects unknown song readiness", () => {
    expect(() =>
      HostSongSchema.parse({
        id: "abc",
        title: "Test",
        artist: "Artist",
        duration_ms: 1000,
        format: "wav",
        readiness: "invalid",
        has_lyrics: false,
        has_instrumental: false,
      })
    ).toThrow();
  });
});
