import { describe, expect, it } from "vitest";
import type { QueueEntry } from "@geet/shared";
import { moveQueueEntry, reconcileSnapshot, type RoomSnapshot } from "./rooms";

function makeSnap(revision: number, status: "open" | "host_disconnected" | "closed" = "open"): RoomSnapshot {
  return {
    room: {
      id: "11111111-1111-4111-8111-111111111111",
      code: "AB12CD34",
      host_user_id: "22222222-2222-4222-8222-222222222222",
      status,
      revision,
      created_at: "2026-11-16T00:00:00Z",
      expires_at: "2026-11-16T12:00:00Z",
    },
    participants: [],
    songs: [],
    queue: [],
    playback: null,
  };
}

function makeEntry(id: string, position: number, status: "queued" | "playing" = "queued"): QueueEntry {
  return {
    id,
    room_id: "11111111-1111-4111-8111-111111111111",
    song_id: "33333333-3333-4333-8333-333333333333",
    requested_by: "22222222-2222-4222-8222-222222222222",
    position,
    status,
    idempotency_key: `key-${id}`,
    created_at: "2026-11-16T00:00:00Z",
  };
}

describe("room snapshot reconciliation and queue ordering", () => {
  it("ignores stale revisions unless forced on reconnect", () => {
    const rev5 = makeSnap(5, "open");
    const rev3 = makeSnap(3, "host_disconnected");
    const rev6 = makeSnap(6, "closed");

    expect(reconcileSnapshot(rev5, rev3)).toBe(rev5);
    expect(reconcileSnapshot(rev5, rev3, true)).toBe(rev3);
    expect(reconcileSnapshot(rev5, rev6)).toBe(rev6);
  });

  it("reorders only queued entries without moving playing entry", () => {
    const entries = [
      makeEntry("a", 1, "playing"),
      makeEntry("b", 2, "queued"),
      makeEntry("c", 3, "queued"),
      makeEntry("d", 4, "queued"),
    ];

    expect(moveQueueEntry(entries, "c", "up")).toEqual(["c", "b", "d"]);
    expect(moveQueueEntry(entries, "c", "down")).toEqual(["b", "d", "c"]);
    expect(moveQueueEntry(entries, "b", "up")).toEqual(["b", "c", "d"]);
  });
});
