import { describe, expect, it } from "vitest";
import { reconcileSnapshot, type RoomSnapshot } from "./rooms";

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
    playback: null,
  };
}

describe("room snapshot reconciliation", () => {
  it("ignores stale revisions unless forced on reconnect", () => {
    const rev5 = makeSnap(5, "open");
    const rev3 = makeSnap(3, "host_disconnected");
    const rev6 = makeSnap(6, "closed");

    expect(reconcileSnapshot(rev5, rev3)).toBe(rev5);
    expect(reconcileSnapshot(rev5, rev3, true)).toBe(rev3);
    expect(reconcileSnapshot(rev5, rev6)).toBe(rev6);
  });
});
