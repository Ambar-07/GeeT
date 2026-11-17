import { describe, expect, it } from "vitest";
import { mediaUrl } from "./hostAgent";

describe("hostAgent client", () => {
  it("encodes song id and audio mode in mediaUrl", () => {
    expect(mediaUrl("abc123")).toBe("http://127.0.0.1:8765/media/abc123");
    expect(mediaUrl("abc123", "instrumental")).toBe(
      "http://127.0.0.1:8765/media/abc123?mode=instrumental"
    );
    expect(mediaUrl("a/b", "vocal")).toBe("http://127.0.0.1:8765/media/a%2Fb?mode=vocal");
  });
});
