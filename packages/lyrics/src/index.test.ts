import { describe, expect, it } from "vitest";
import { computeEffectiveTimeMs, findActiveLineIndex, parseLrc } from "./index";

describe("lrc parser and lookup", () => {
  it("parses multi-timestamp lines and resolves active index via binary search", () => {
    const lrc = `
[ti:Sample]
[00:01.50]First line
[00:05.00][00:10.00]Repeated chorus
`;
    const lines = parseLrc(lrc, 15_000);
    expect(lines).toEqual([
      { startMs: 1500, endMs: 5000, text: "First line" },
      { startMs: 5000, endMs: 10000, text: "Repeated chorus" },
      { startMs: 10000, endMs: 15000, text: "Repeated chorus" },
    ]);

    expect(findActiveLineIndex(lines, 1000)).toBe(-1);
    expect(findActiveLineIndex(lines, 1500)).toBe(0);
    expect(findActiveLineIndex(lines, 7500)).toBe(1);
    expect(findActiveLineIndex(lines, 12000)).toBe(2);
  });

  it("validates 10 timed songs and stays aligned across seek and offset calibration", () => {
    for (let i = 0; i < 10; i++) {
      const lrc = `[00:02.00]Song ${i} line 1\n[00:06.00]Song ${i} line 2\n[00:10.00]Song ${i} line 3`;
      const lines = parseLrc(lrc, 14_000);
      expect(lines).toHaveLength(3);

      // Simulate seek forward, pause, resume, and +500ms / -1000ms offset calibration
      expect(findActiveLineIndex(lines, computeEffectiveTimeMs(6.2, 0))).toBe(1);
      expect(findActiveLineIndex(lines, computeEffectiveTimeMs(6.2, 500))).toBe(0);
      expect(findActiveLineIndex(lines, computeEffectiveTimeMs(9.2, -1000))).toBe(2);
      expect(findActiveLineIndex(lines, computeEffectiveTimeMs(2.0, 0))).toBe(0);
    }
  });
});
