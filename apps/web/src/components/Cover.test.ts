import { describe, expect, it } from "vitest";
import { extractFlowPalette } from "./Cover";

function parseHsl(css: string): { h: number; s: number; l: number } {
  const m = css.match(/hsl\((\d+)\s+(\d+)%\s+(\d+)%\)/);
  if (!m) throw new Error(`Unexpected HSL: ${css}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

describe("extractFlowPalette", () => {
  it("extracts distinct rich hues from a two-tone album cover without muddying to gray", () => {
    // Half vibrant crimson (220, 25, 45), half deep cobalt blue (25, 65, 215)
    const pixels = new Uint8ClampedArray(100 * 4);
    for (let i = 0; i < 100; i++) {
      const off = i * 4;
      if (i < 60) {
        pixels[off] = 220;
        pixels[off + 1] = 25;
        pixels[off + 2] = 45;
      } else {
        pixels[off] = 25;
        pixels[off + 1] = 65;
        pixels[off + 2] = 215;
      }
      pixels[off + 3] = 255;
    }

    const p = extractFlowPalette(pixels);
    const c1 = parseHsl(p.c1);
    const c2 = parseHsl(p.c2);
    const base = parseHsl(p.base);

    // Primary stays red/crimson, secondary stays blue, base stays faithful and readable
    expect(c1.h >= 340 || c1.h <= 15).toBe(true);
    expect(c2.h).toBeGreaterThanOrEqual(210);
    expect(c2.h).toBeLessThanOrEqual(250);
    expect(c1.s).toBeGreaterThanOrEqual(50);
    expect(base.l).toBeLessThanOrEqual(42);
    expect(p.scrimOpacity).toBeGreaterThan(0);
  });

  it("wraps circular hue midpoint cleanly between crimson (350deg) and orange (15deg)", () => {
    const pixels = new Uint8ClampedArray(80 * 4);
    for (let i = 0; i < 80; i++) {
      const off = i * 4;
      if (i < 45) {
        pixels[off] = 215;
        pixels[off + 1] = 20;
        pixels[off + 2] = 55;
      } else {
        pixels[off] = 230;
        pixels[off + 1] = 110;
        pixels[off + 2] = 25;
      }
      pixels[off + 3] = 255;
    }

    const p = extractFlowPalette(pixels);
    const c4 = parseHsl(p.c4);
    // Midpoint between ~349deg and ~25deg should be warm red/orange, NOT cyan (~180deg)
    expect(c4.h > 60 && c4.h < 300).toBe(false);
  });
});
