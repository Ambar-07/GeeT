import { describe, expect, it } from "vitest";
import {
  computeEffectiveTimeMs,
  findActiveLineIndex,
  getInterludeState,
  hasDevanagari,
  parseLrc,
  transliterateDevanagari,
} from "./index";

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

  it("detects intro, explicit blank cue lines, and long mid-song instrumental breaks", () => {
    const lrc = [
      "[00:06.00]Verse one",
      "[00:10.00]",
      "[00:19.00]Chorus line",
      "[00:34.00]Verse two",
    ].join("\n");
    const lines = parseLrc(lrc, 45_000);

    // Intro before 6s
    const intro = getInterludeState(lines, 3000);
    expect(intro?.kind).toBe("intro");
    expect(intro?.anchorIndex).toBe(-1);
    expect(intro?.litDots).toBe(2);

    // Explicit blank cue line between 10s and 19s
    const blank = getInterludeState(lines, 16_000);
    expect(blank?.kind).toBe("interlude");
    expect(blank?.anchorIndex).toBe(1);
    expect(blank?.litDots).toBe(3);

    // Singing right after 19s -> no interlude yet
    expect(getInterludeState(lines, 20_500)).toBeNull();

    // Long 15s gap between 19s and 34s -> mid-song breather appears after singing window
    const midBreak = getInterludeState(lines, 28_000);
    expect(midBreak?.kind).toBe("interlude");
    expect(midBreak?.anchorIndex).toBe(2);
    expect(midBreak?.litDots).toBeGreaterThanOrEqual(1);
  });
});

describe("devanagari to hinglish transliteration", () => {
  it("detects Devanagari script and leaves Latin text untouched", () => {
    expect(hasDevanagari("Paas aane ko mere")).toBe(false);
    expect(hasDevanagari("क्यूँ आँख नम है?")).toBe(true);
    expect(transliterateDevanagari("Paas aane ko mere")).toBe("Paas aane ko mere");
  });

  it("transliterates Hindi lyrics with nukta, halant, and schwa deletion cleanly", () => {
    expect(transliterateDevanagari("दिल मेरा बोल उठा")).toBe("dil mera bol utha");
    expect(transliterateDevanagari("तू बेवफ़ा है, क़िस्मत है मेरी")).toBe(
      "tu bewafa hai, qismat hai meri"
    );
    expect(transliterateDevanagari("तुमसे थी सुबह")).toBe("tumse thi subah");
    expect(transliterateDevanagari("क्यूँ आज ग़म है?")).toBe("kyun aaj gham hai?");
    expect(transliterateDevanagari("बचपन का सफ़र")).toBe("bachpan ka safar");
  });
});
