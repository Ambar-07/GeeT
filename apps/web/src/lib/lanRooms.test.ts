import { describe, expect, it } from "vitest";
import type { HostSong } from "@geet/shared";
import { displayTitle } from "../components/Cover";
import { buildLanJoinOrigin } from "./lanRooms";
import { selectNextAutoPrepareCandidate } from "../pages/HostPage";
import type { UpNextItem } from "../components/HostRoomPanel";

function makeSong(id: string, overrides: Partial<HostSong> = {}): HostSong {
  return {
    id,
    title: `Song ${id}`,
    artist: "Artist",
    duration_ms: 180000,
    format: "mp3",
    readiness: "raw",
    has_lyrics: false,
    has_instrumental: false,
    ...overrides,
  };
}

function makeUpNext(hostSongId: string, readiness: UpNextItem["readiness"] = "raw"): UpNextItem {
  return {
    entryId: `entry-${hostSongId}`,
    hostSongId,
    title: `Song ${hostSongId}`,
    artist: "Artist",
    requester: "Guest",
    readiness,
  };
}

describe("LAN Party origin builder", () => {
  it("replaces localhost and 127.0.0.1 with detected LAN IP", () => {
    expect(buildLanJoinOrigin("http://localhost:5173", "192.168.1.42")).toBe(
      "http://192.168.1.42:5173"
    );
    expect(buildLanJoinOrigin("http://127.0.0.1:5173", "10.0.0.8")).toBe(
      "http://10.0.0.8:5173"
    );
  });

  it("keeps origin intact when LAN IP is loopback or origin is already remote", () => {
    expect(buildLanJoinOrigin("http://localhost:5173", "127.0.0.1")).toBe(
      "http://localhost:5173"
    );
    expect(buildLanJoinOrigin("https://geet.pages.dev", "192.168.1.42")).toBe(
      "https://geet.pages.dev"
    );
  });
});

describe("auto-prepare next queued track selection", () => {
  it("picks the first raw track within lookahead=2 and skips prepared/attempted tracks", () => {
    const songs = new Map<string, HostSong>([
      ["s1", makeSong("s1", { has_instrumental: true, readiness: "ready" })],
      ["s2", makeSong("s2", { has_instrumental: false, readiness: "raw" })],
      ["s3", makeSong("s3", { has_instrumental: false, readiness: "raw" })],
    ]);
    const queue = [makeUpNext("s1", "ready"), makeUpNext("s2", "raw"), makeUpNext("s3", "raw")];

    expect(selectNextAutoPrepareCandidate(queue, songs, new Set())?.hostSongId).toBe("s2");
    expect(selectNextAutoPrepareCandidate(queue, songs, new Set(["s2"]))).toBeNull();
  });

  it("skips tracks already preparing or drm_rejected", () => {
    const songs = new Map<string, HostSong>([
      ["s1", makeSong("s1", { readiness: "preparing" })],
      ["s2", makeSong("s2", { readiness: "drm_rejected" })],
    ]);
    const queue = [makeUpNext("s1", "preparing"), makeUpNext("s2", "raw")];
    expect(selectNextAutoPrepareCandidate(queue, songs, new Set())).toBeNull();
  });
});

describe("displayTitle", () => {
  it("preserves numeric embedded titles and only cleans raw underscore filenames", () => {
    expect(displayTitle("2024")).toBe("2024");
    expect(displayTitle("505")).toBe("505");
    expect(displayTitle("21 Guns")).toBe("21 Guns");
    expect(displayTitle("01_Bohemian_Rhapsody")).toBe("Bohemian Rhapsody");
  });
});
