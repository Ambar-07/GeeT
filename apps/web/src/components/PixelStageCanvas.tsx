import { useEffect, useRef } from "react";

export interface StageAudioFrame {
  bass: number;
  mid: number;
  high: number;
  energy: number;
  bins: Uint8Array | null;
  waveform: Uint8Array | null;
  live: boolean;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  kind: "spark" | "note" | "heart";
  color: string;
}

interface CrowdPerson {
  x: number;
  height: number;
  shoulderW: number;
  hairStyle: 0 | 1 | 2 | 3; // 0: rounded, 1: fluffy/curly, 2: ponytail, 3: cap/headphones
  phase: number;
  hasPhone: boolean;
  hasArmUp: boolean;
  phoneColor: string;
  cheer: number;
}

interface DustMote {
  x: number;
  y: number;
  vy: number;
  drift: number;
  phase: number;
  warm: boolean;
}

interface PixelStageCanvasProps {
  /** Optional getter returning real-time Web Audio FFT + waveform metrics. */
  getAudioFrame?: () => StageAudioFrame;
}

const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const NOTE_SPRITE = [
  "  ###",
  "  # #",
  "  #  ",
  "###  ",
  "###  ",
];

const DOUBLE_NOTE_SPRITE = [
  " #####",
  " #   #",
  " #   #",
  "##  ##",
  "##  ##",
];

const HEART_SPRITE = [
  " # # ",
  "#####",
  "#####",
  " ### ",
  "  #  ",
];

function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: readonly string[],
  x: number,
  y: number,
  color: string
) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  ctx.fillStyle = color;
  for (let r = 0; r < sprite.length; r++) {
    const row = sprite[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === "#") {
        ctx.fillRect(ix + c, iy + r, 1, 1);
      }
    }
  }
}

function drawPixelDisc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string
) {
  const ix = Math.round(cx);
  const iy = Math.round(cy);
  const r2 = radius * radius;
  ctx.fillStyle = color;
  for (let dy = -radius; dy <= radius; dy++) {
    const span = Math.floor(Math.sqrt(Math.max(0, r2 - dy * dy)));
    ctx.fillRect(ix - span, iy + dy, span * 2 + 1, 1);
  }
}

/**
 * Handcrafted multi-layer parallax pixel-art late-night karaoke lounge backdrop.
 * Features atmospheric depth mist (bright misty midground framed by deep velvet curtains
 * and silhouetted crowd), smooth translucent pixel spotlight beams, live FFT stage wall,
 * thumping acoustic monitors, vintage mic stand, and interactive follow-spot + click cheers.
 */
export function PixelStageCanvas({ getAudioFrame }: PixelStageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const getAudioRef = useRef(getAudioFrame);
  getAudioRef.current = getAudioFrame;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const displayCtx = canvas.getContext("2d", { alpha: false });
    if (!displayCtx) return;

    const buf = document.createElement("canvas");
    const ctx = buf.getContext("2d", { alpha: false });
    if (!ctx) return;

    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let viewW = window.innerWidth;
    let viewH = window.innerHeight;
    let pxScale = 3;
    let W = 380;
    let H = 220;

    let crowdBack: CrowdPerson[] = [];
    let crowdFront: CrowdPerson[] = [];
    let motes: DustMote[] = [];
    let bokeh: Array<{ x: number; y: number; r: number; phase: number; color: string }> = [];
    let archPillars: number[] = [];

    const buildScene = () => {
      // Distant hazy club pillars / silhouettes (creates lush atmospheric depth like misty forest trunks)
      archPillars = [];
      const pillarCount = Math.max(4, Math.floor(W / 68));
      for (let i = 0; i < pillarCount; i++) {
        archPillars.push(((i + 0.5) / pillarCount) * W + (Math.random() - 0.5) * 18);
      }

      // Soft atmospheric stage bokeh lights in the hazy midground
      const bokehColors = [
        "rgba(255, 130, 165, 0.14)",
        "rgba(255, 200, 150, 0.12)",
        "rgba(196, 155, 255, 0.12)",
      ];
      bokeh = Array.from({ length: 18 }, () => ({
        x: Math.random() * W,
        y: H * (0.28 + Math.random() * 0.44),
        r: 3 + Math.floor(Math.random() * 6),
        phase: Math.random() * Math.PI * 2,
        color: bokehColors[Math.floor(Math.random() * bokehColors.length)],
      }));

      // Organic two-layer foreground karaoke crowd silhouettes
      const phoneColors = ["#ff85a2", "#bae6fd", "#fde68a", "#e9d5ff", "#ffffff"];
      crowdBack = [];
      for (let x = -18; x < W + 24; x += 15 + Math.floor(Math.random() * 7)) {
        crowdBack.push({
          x,
          height: 17 + Math.floor(Math.random() * 7),
          shoulderW: 11 + Math.floor(Math.random() * 4),
          hairStyle: (Math.floor(Math.random() * 4) as 0 | 1 | 2 | 3),
          phase: Math.random() * Math.PI * 2,
          hasPhone: Math.random() < 0.18,
          hasArmUp: Math.random() < 0.2,
          phoneColor: phoneColors[Math.floor(Math.random() * phoneColors.length)],
          cheer: 0,
        });
      }

      crowdFront = [];
      for (let x = -24; x < W + 30; x += 22 + Math.floor(Math.random() * 10)) {
        crowdFront.push({
          x,
          height: 23 + Math.floor(Math.random() * 9),
          shoulderW: 16 + Math.floor(Math.random() * 5),
          hairStyle: (Math.floor(Math.random() * 4) as 0 | 1 | 2 | 3),
          phase: Math.random() * Math.PI * 2,
          hasPhone: Math.random() < 0.16,
          hasArmUp: Math.random() < 0.22,
          phoneColor: phoneColors[Math.floor(Math.random() * phoneColors.length)],
          cheer: 0,
        });
      }

      // Warm stage dust motes drifting through the light
      motes = Array.from({ length: 48 }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        vy: 3.5 + Math.random() * 7.5,
        drift: 0.4 + Math.random() * 0.9,
        phase: Math.random() * Math.PI * 2,
        warm: Math.random() < 0.55,
      }));
    };

    const resize = () => {
      viewW = window.innerWidth;
      viewH = window.innerHeight;
      // Richer 16-bit pixel resolution (3px crisp pixels -> lush organic curves!)
      pxScale = viewW < 640 ? 2.5 : 3;
      W = Math.max(150, Math.ceil(viewW / pxScale));
      H = Math.max(150, Math.ceil(viewH / pxScale));
      buf.width = W;
      buf.height = H;
      canvas.width = viewW;
      canvas.height = viewH;
      displayCtx.imageSmoothingEnabled = false;
      buildScene();
    };

    resize();

    const sparks: Spark[] = [];
    const spawnBurst = (lx: number, ly: number, count = 14) => {
      const colors = ["#ff527b", "#ffa3b8", "#fde68a", "#d8b4fe", "#ffffff"];
      for (let i = 0; i < count; i++) {
        const angle = -Math.PI * 0.5 + (Math.random() - 0.5) * Math.PI * 1.4;
        const speed = 16 + Math.random() * 38;
        const r = Math.random();
        sparks.push({
          x: lx,
          y: ly,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 12,
          life: 0,
          maxLife: 0.85 + Math.random() * 0.95,
          kind: r < 0.3 ? "note" : r < 0.46 ? "heart" : "spark",
          color: colors[Math.floor(Math.random() * colors.length)],
        });
      }
      if (sparks.length > 96) sparks.splice(0, sparks.length - 96);
    };

    const ptr = { nx: 0, ny: 0, tx: 0, ty: 0, lx: W * 0.5, ly: H * 0.45, active: false };

    const onPointerMove = (e: PointerEvent) => {
      ptr.tx = (e.clientX / Math.max(1, viewW)) * 2 - 1;
      ptr.ty = (e.clientY / Math.max(1, viewH)) * 2 - 1;
      ptr.lx = e.clientX / pxScale;
      ptr.ly = e.clientY / pxScale;
      ptr.active = true;
    };

    const onPointerLeave = () => {
      ptr.tx = 0;
      ptr.ty = 0;
      ptr.active = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, a, input, form")) return;
      const lx = e.clientX / pxScale;
      const ly = e.clientY / pxScale;
      spawnBurst(lx, ly, 16);
      for (const person of [...crowdBack, ...crowdFront]) {
        const dist = Math.abs(person.x - lx);
        if (dist < 62) {
          person.cheer = Math.min(1, person.cheer + (1 - dist / 62) * 1.25);
        }
      }
    };

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerleave", onPointerLeave, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });

    let rafId = 0;
    let lastTs = performance.now();
    let t = 0;
    let smoothBass = 0.16;
    let smoothMid = 0.16;
    let prevBass = 0;
    let lastAutoNote = 0;

    // Smooth translucent pixel-art volumetric spotlight cone (zero harsh dot noise over text!)
    const drawSoftBeam = (
      ox: number,
      oy: number,
      tx: number,
      ty: number,
      topW: number,
      botW: number,
      rgb: string,
      alpha: number
    ) => {
      const yStart = Math.max(0, Math.floor(oy));
      const yEnd = Math.min(H - 1, Math.floor(ty));
      const spanY = Math.max(1, ty - oy);

      // Outer hazy cone
      ctx.fillStyle = `rgba(${rgb}, ${(alpha * 0.42).toFixed(3)})`;
      for (let y = yStart; y <= yEnd; y++) {
        const p = (y - oy) / spanY;
        const cx = ox + (tx - ox) * p;
        const w = topW + (botW - topW) * p;
        ctx.fillRect(Math.round(cx - w * 0.5), y, Math.max(1, Math.round(w)), 1);
      }
      // Inner luminous core
      ctx.fillStyle = `rgba(${rgb}, ${(alpha * 0.55).toFixed(3)})`;
      for (let y = yStart; y <= yEnd; y++) {
        const p = (y - oy) / spanY;
        const cx = ox + (tx - ox) * p;
        const w = (topW + (botW - topW) * p) * 0.48;
        ctx.fillRect(Math.round(cx - w * 0.5), y, Math.max(1, Math.round(w)), 1);
      }
    };

    // Handcrafted pixel-art velvet theater curtains framing left, right & top valance
    const drawCurtains = (parallaxX: number, parallaxY: number) => {
      const sideW = Math.max(18, Math.round(W * 0.085));

      // Draped side curtains with scalloped inward gather + shaded vertical folds
      for (let side = 0; side < 2; side++) {
        const isRight = side === 1;
        for (let y = 0; y < H; y++) {
          const ny = y / H;
          // Graceful inward theater tie-back curve (wider at top, cinched mid-way, flaring slightly down)
          const curve =
            1.15 -
            Math.sin(ny * Math.PI * 0.85) * 0.52 +
            Math.sin(ny * 8 + t * 0.35 + side) * 0.04;
          const rowW = Math.max(6, Math.round(sideW * curve));
          const xStart = isRight
            ? Math.round(W - rowW + parallaxX)
            : Math.round(-6 + parallaxX);
          const drawW = rowW + 8;

          // Deep plum base
          ctx.fillStyle = "#190b1d";
          ctx.fillRect(xStart, y, drawW, 1);

          // Highlighted vertical velvet folds
          for (let f = 0; f < 3; f++) {
            const foldOffset = Math.round(((f + 0.5) / 3.4) * rowW);
            const fx = isRight ? W - rowW + foldOffset + Math.round(parallaxX) : foldOffset + Math.round(parallaxX);
            ctx.fillStyle = f === 0 ? "#381635" : "#281028";
            ctx.fillRect(fx, y, 2, 1);
          }

          // Warm rose rim highlight along the inner curtain edge catching stage light
          const edgeX = isRight ? Math.round(W - rowW + parallaxX) : Math.round(rowW + parallaxX - 1);
          ctx.fillStyle = "#5c2248";
          ctx.fillRect(edgeX, y, 2, 1);
        }
      }

      // Scalloped top velvet valance + warm fairy bulb string
      const swags = Math.max(5, Math.round(W / 66));
      const swagW = W / swags;
      const topBase = Math.round(10 + parallaxY);
      for (let x = 0; x < W; x++) {
        const local = ((x - parallaxX * 0.5) % swagW + swagW) % swagW;
        const u = local / swagW; // 0..1
        const droop = Math.round(Math.sin(u * Math.PI) * 8);
        const h = Math.max(4, topBase + droop);
        ctx.fillStyle = "#120816";
        ctx.fillRect(x, 0, 1, h);
        // Subtle fold highlights inside valance
        if (Math.floor(u * 6) % 2 === 0) {
          ctx.fillStyle = "#220f26";
          ctx.fillRect(x, Math.max(0, h - 5), 1, 3);
        }
        // Soft burgundy hem
        ctx.fillStyle = "#481c3e";
        ctx.fillRect(x, h - 1, 1, 1);
      }

      // Cozy warm glowing string bulbs draping along the top valance
      for (let i = 0; i < swags; i++) {
        const cx = (i + 0.5) * swagW + parallaxX * 0.5;
        for (const offset of [-0.28, 0, 0.28]) {
          const bx = Math.round(cx + offset * swagW);
          const u = 0.5 + offset;
          const by = Math.round(topBase + Math.sin(u * Math.PI) * 8 + 1);
          const glow = 0.65 + 0.35 * Math.sin(t * 2.1 + bx * 0.1);
          ctx.fillStyle = `rgba(255, 196, 150, ${(glow * 0.28).toFixed(2)})`;
          ctx.fillRect(bx - 1, by - 1, 3, 3);
          ctx.fillStyle = glow > 0.72 ? "#fff1d6" : "#f9a8b8";
          ctx.fillRect(bx, by, 1, 1);
        }
      }
    };

    // Sculpted pixel-art concert speaker cabinet with metallic grille & thumping round woofers
    const drawSpeaker = (x: number, floorY: number, bassKick: number, mirror: boolean) => {
      const ix = Math.round(x);
      const iy = Math.round(floorY);
      const w = 26;
      const h = 44;
      const topY = iy - h;

      // Beveled cabinet body
      ctx.fillStyle = "#140d1c";
      ctx.fillRect(ix + 1, topY, w - 2, h);
      ctx.fillRect(ix, topY + 1, w, h - 2);
      // Warm rim light facing center stage
      ctx.fillStyle = "#4a2448";
      ctx.fillRect(ix + (mirror ? 0 : w - 1), topY + 2, 1, h - 4);
      ctx.fillStyle = "#331b38";
      ctx.fillRect(ix + 2, topY, w - 4, 1);

      // Subtle dithered speaker fabric texture
      ctx.fillStyle = "#1d1328";
      for (let sy = topY + 3; sy < iy - 3; sy += 2) {
        for (let sx = ix + 3; sx < ix + w - 3; sx += 2) {
          ctx.fillRect(sx, sy, 1, 1);
        }
      }

      // Thumping circular woofers
      const thump = bassKick > 0.3 ? 1 : 0;
      const cx = ix + Math.floor(w / 2);
      // Upper mid-driver
      drawPixelDisc(ctx, cx, topY + 13, 6 + thump, "#0b0711");
      drawPixelDisc(ctx, cx, topY + 13, 5 + thump, "#22162e");
      drawPixelDisc(ctx, cx, topY + 13, 2, bassKick > 0.34 ? "#fb4870" : "#5e2f52");
      // Lower subwoofer
      drawPixelDisc(ctx, cx, topY + 31, 8 + thump, "#0b0711");
      drawPixelDisc(ctx, cx, topY + 31, 7 + thump, "#22162e");
      drawPixelDisc(ctx, cx, topY + 31, 3, bassKick > 0.34 ? "#fb4870" : "#5e2f52");

      // Tiny rose status LED
      ctx.fillStyle = "#ff5c82";
      ctx.fillRect(ix + (mirror ? w - 4 : 3), topY + 3, 2, 1);
    };

    // Classic glowing karaoke mic on a chrome stand
    const drawMicStand = (cx: number, floorY: number, midEnergy: number, live: boolean) => {
      const ix = Math.round(cx);
      const iy = Math.round(floorY);

      // Floor spotlight pool right beneath the mic stand
      ctx.fillStyle = "rgba(255, 160, 190, 0.14)";
      ctx.fillRect(ix - 22, iy, 44, 3);
      ctx.fillStyle = "rgba(255, 210, 226, 0.18)";
      ctx.fillRect(ix - 12, iy, 24, 2);

      // Weighted round base
      ctx.fillStyle = "#1a1124";
      ctx.fillRect(ix - 7, iy - 1, 15, 2);
      ctx.fillStyle = "#52325c";
      ctx.fillRect(ix - 5, iy - 2, 11, 1);

      // Stand pole + chrome highlight
      ctx.fillStyle = "#2b1d38";
      ctx.fillRect(ix, iy - 34, 2, 33);
      ctx.fillStyle = "#7a5b8c";
      ctx.fillRect(ix, iy - 34, 1, 18);

      // Classic rounded Shure-55 style karaoke mic head
      ctx.fillStyle = "#d4d0e0";
      ctx.fillRect(ix - 2, iy - 41, 6, 7);
      ctx.fillRect(ix - 1, iy - 42, 4, 9);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(ix - 1, iy - 41, 2, 3);
      // Signature GeeT rose-pink capsule band
      ctx.fillStyle = "#fa2d48";
      ctx.fillRect(ix - 2, iy - 38, 6, 2);

      // Live sound wave arcs radiating subtly from mic when music plays
      if (live && midEnergy > 0.1) {
        const r = Math.round(7 + midEnergy * 11);
        ctx.fillStyle = "rgba(255, 165, 195, 0.55)";
        ctx.fillRect(ix - r, iy - 39, 1, 3);
        ctx.fillRect(ix + r + 1, iy - 39, 1, 3);
        ctx.fillRect(ix - r + 1, iy - 41, 1, 1);
        ctx.fillRect(ix + r, iy - 41, 1, 1);
        ctx.fillRect(ix - r + 1, iy - 35, 1, 1);
        ctx.fillRect(ix + r, iy - 35, 1, 1);
      }
    };

    // Organic silhouetted guest with curved head, hairstyles, sloped shoulders & glowing phone
    const drawGuest = (
      p: CrowdPerson,
      offsetX: number,
      baseY: number,
      bob: number,
      bodyCol: string,
      rimCol: string
    ) => {
      const x = Math.round(p.x + offsetX);
      const jump = Math.round(p.cheer * 6 + bob);
      const headY = Math.round(baseY - p.height - jump);
      const halfS = Math.floor(p.shoulderW / 2);

      // Sloped organic shoulders & torso
      ctx.fillStyle = bodyCol;
      ctx.fillRect(x - halfS + 3, headY + 6, p.shoulderW - 6, 2);
      ctx.fillRect(x - halfS + 1, headY + 8, p.shoulderW - 2, 3);
      ctx.fillRect(x - halfS, headY + 11, p.shoulderW, p.height + jump + 8);

      // Neck
      ctx.fillRect(x - 1, headY + 4, 3, 3);

      // Curved head + distinct hairstyle silhouettes
      drawPixelDisc(ctx, x, headY + 1, 4, bodyCol);
      if (p.hairStyle === 1) {
        // Fluffy curly crown
        drawPixelDisc(ctx, x - 2, headY - 1, 3, bodyCol);
        drawPixelDisc(ctx, x + 2, headY - 1, 3, bodyCol);
      } else if (p.hairStyle === 2) {
        // High ponytail
        drawPixelDisc(ctx, x + 4, headY - 2, 2, bodyCol);
        ctx.fillRect(x + 5, headY, 2, 4);
      } else if (p.hairStyle === 3) {
        // Headphones / beanie rim
        ctx.fillRect(x - 5, headY, 2, 3);
        ctx.fillRect(x + 4, headY, 2, 3);
      }

      // Soft warm rose rim light catching crown & upper shoulders
      ctx.fillStyle = rimCol;
      ctx.fillRect(x - 2, headY - 3, 5, 1);
      ctx.fillRect(x - halfS + 3, headY + 6, Math.max(2, p.shoulderW - 6), 1);

      // Raised swaying arm / glowing phone screen
      if (p.hasPhone || p.hasArmUp || p.cheer > 0.25) {
        const sway = Math.round(Math.sin(t * 2.3 + p.phase) * 2);
        const armX = x + halfS - 2 + sway;
        const armY = headY - 5 - (p.cheer > 0.25 ? 3 : 0);
        ctx.fillStyle = bodyCol;
        ctx.fillRect(armX, armY + 3, 2, 11);
        ctx.fillRect(armX - 1, armY + 10, 2, 4);
        if (p.hasPhone) {
          // Soft ambient phone screen glow + crisp tiny screen
          ctx.fillStyle = `${p.phoneColor}44`;
          ctx.fillRect(armX - 2, armY - 2, 6, 7);
          ctx.fillStyle = p.phoneColor;
          ctx.fillRect(armX - 1, armY - 1, 4, 5);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(armX, armY, 2, 3);
        } else {
          // Open cheering hand silhouette
          ctx.fillRect(armX - 1, armY + 1, 3, 2);
        }
      }
    };

    const renderFrame = (now: number, isStatic = false) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;

      ptr.nx += (ptr.tx - ptr.nx) * Math.min(1, dt * 5.5);
      ptr.ny += (ptr.ty - ptr.ny) * Math.min(1, dt * 5.5);

      const audio = getAudioRef.current?.();
      let targetBass = 0;
      let targetMid = 0;
      let bins: Uint8Array | null = null;
      let live = false;

      if (audio && audio.live) {
        live = true;
        targetBass = audio.bass;
        targetMid = audio.mid;
        bins = audio.bins;
      } else {
        const sec = now * 0.001;
        const beat = sec * 1.72;
        const kick = Math.pow(Math.max(0, Math.sin(beat * Math.PI)), 7);
        targetBass = 0.14 + kick * 0.22;
        targetMid = 0.16 + 0.09 * Math.sin(sec * 1.05);
      }

      smoothBass += (targetBass - smoothBass) * Math.min(1, dt * 13);
      smoothMid += (targetMid - smoothMid) * Math.min(1, dt * 9);

      if (!isStatic) {
        t += dt * (0.85 + smoothBass * 0.85);
      }

      if (!isStatic && live && targetBass - prevBass > 0.12 && now - lastAutoNote > 720) {
        lastAutoNote = now;
        spawnBurst(W * 0.5 + (Math.random() - 0.5) * 44, H * 0.66, 4);
      }
      prevBass = targetBass;

      const stageY = Math.floor(H * 0.84);

      // ── LAYER 0: Lush atmospheric club gradient with Bayer pixel dithering ──
      // Calm deep velvet upper sky keeps hero typography razor-clean; glowing haze sits low behind stage
      const stops: Array<[number, [number, number, number]]> = [
        [0.0, [9, 6, 15]],       // deep obsidian-plum ceiling
        [0.44, [18, 10, 27]],    // calm dark upper lounge behind hero text
        [0.64, [44, 18, 44]],    // atmospheric rose transition
        [0.78, [78, 30, 58]],    // warm glowing horizon mist low behind stage
        [0.86, [26, 12, 28]],    // wooden stage shadow
        [1.0, [9, 6, 13]],       // deep crowd foreground
      ];

      for (let y = 0; y < H; y++) {
        const ny = y / H;
        let seg = 0;
        while (seg < stops.length - 2 && ny > stops[seg + 1][0]) seg++;
        const [p0, c0] = stops[seg];
        const [p1, c1] = stops[seg + 1];
        const frac = Math.max(0, Math.min(1, (ny - p0) / Math.max(0.001, p1 - p0)));
        const bassGlow = ny > 0.45 && ny < 0.78 ? smoothBass * 24 : 0;

        for (let x = 0; x < W; x++) {
          const thresh = BAYER_4[y & 3][x & 3] / 16;
          const c = frac > thresh ? c1 : c0;
          ctx.fillStyle = `rgb(${Math.min(255, Math.round(c[0] + bassGlow))},${Math.min(255, Math.round(c[1] + bassGlow * 0.35))},${Math.min(255, Math.round(c[2] + bassGlow * 0.55))})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }

      // ── LAYER 1: Distant hazy club pillars & dreamy bokeh depth lights (parallax: 4px) ──
      const p1x = -ptr.nx * 4;
      for (const px of archPillars) {
        const x = Math.round(px + p1x);
        ctx.fillStyle = "rgba(38, 16, 42, 0.55)";
        ctx.fillRect(x - 6, 12, 12, stageY - 12);
        // Arch flare near top
        ctx.fillRect(x - 10, 12, 20, 12);
      }

      for (const b of bokeh) {
        const pulse = 0.7 + 0.3 * Math.sin(t * 1.1 + b.phase);
        if (pulse < 0.45) continue;
        drawPixelDisc(ctx, b.x + p1x * 1.2, b.y, b.r, b.color);
      }

      // ── LAYER 1.5: Soft atmospheric LED equalizer backdrop on back wall ──
      const eqCols = Math.max(20, Math.floor(W / 12));
      const eqTotalW = eqCols * 8;
      const eqStartX = Math.floor((W - eqTotalW) * 0.5 + p1x * 1.4);
      const eqBaseY = stageY - 6;

      for (let i = 0; i < eqCols; i++) {
        const nx = i / Math.max(1, eqCols - 1);
        const sym = Math.abs(nx - 0.5) * 2;
        let level = 0;
        if (live && bins && bins.length > 0) {
          const bIdx = Math.min(bins.length - 1, Math.floor(sym * bins.length * 0.45));
          level = bins[bIdx] / 255;
        } else {
          level =
            (0.2 + 0.35 * Math.pow(Math.sin(t * 1.3 + i * 0.5) * 0.5 + 0.5, 2)) *
            (1 - sym * 0.4) *
            (0.75 + smoothBass * 0.75);
        }
        const blocks = Math.max(1, Math.min(13, Math.round(level * 13)));
        const bx = eqStartX + i * 8;
        for (let b = 0; b < blocks; b++) {
          const by = eqBaseY - b * 3;
          ctx.fillStyle =
            b >= 10
              ? "rgba(255, 232, 240, 0.46)"
              : b >= 5
                ? "rgba(255, 118, 152, 0.34)"
                : "rgba(205, 62, 114, 0.28)";
          ctx.fillRect(bx, by, 5, 2);
        }
      }

      // ── LAYER 2: Smooth sweeping volumetric stage spotlight shafts framing left & right (parallax: 7px) ──
      const p2x = -ptr.nx * 7;
      const p2y = -ptr.ny * 2;
      const beamStrength = 0.12 + smoothBass * 0.1;
      const cursorTilt = ptr.nx * 14;

      drawSoftBeam(
        W * 0.18 + p2x,
        10,
        W * 0.28 + Math.sin(t * 0.5) * 20 + p2x + cursorTilt,
        stageY + 10,
        5,
        54,
        "255, 92, 138",
        beamStrength
      );
      drawSoftBeam(
        W * 0.82 + p2x,
        10,
        W * 0.72 + Math.cos(t * 0.44) * 20 + p2x + cursorTilt,
        stageY + 10,
        5,
        54,
        "174, 128, 255",
        beamStrength * 0.9
      );

      // ── LAYER 3: Illuminated Karaoke Stage Deck, Speakers & Vintage Mic (parallax: 10px) ──
      const p3x = -ptr.nx * 10;
      const floorTop = Math.round(stageY + p2y);

      // Warm stage wood planks & soft specular stage reflection
      ctx.fillStyle = "#1c1024";
      ctx.fillRect(0, floorTop, W, H - floorTop);
      ctx.fillStyle = "#4d2349";
      ctx.fillRect(0, floorTop, W, 1);
      ctx.fillStyle = "#2b1633";
      ctx.fillRect(0, floorTop + 1, W, 4);

      // Warm stage footlights along front edge
      for (let fx = 16; fx < W - 16; fx += 24) {
        const gx = Math.round(fx + p3x);
        const glow = Math.sin(t * 2 + fx * 0.15) * 0.5 + 0.5;
        ctx.fillStyle = glow > 0.4 ? "#ff7a9c" : "#ad3a64";
        ctx.fillRect(gx, floorTop + 1, 4, 1);
        ctx.fillStyle = "rgba(255, 130, 165, 0.18)";
        ctx.fillRect(gx - 2, floorTop + 2, 8, 3);
      }

      // Left & right thumping pixel speaker monitors (tucked neatly inside curtains)
      drawSpeaker(W * 0.11 + p3x, floorTop + 3, smoothBass, false);
      drawSpeaker(W * 0.89 - 26 + p3x, floorTop + 3, smoothBass, true);

      // Centered classic karaoke microphone stand
      drawMicStand(W * 0.5 + p3x, floorTop + 2, smoothMid, live);

      // ── LAYER 4: Velvet Theater Curtains & Warm Fairy Bulbs (parallax: 12px) ──
      drawCurtains(-ptr.nx * 12, -ptr.ny * 3);

      // ── LAYER 4.5: Floating warm dust motes & click-to-cheer pixel notes/hearts ──
      for (const m of motes) {
        if (!isStatic) {
          m.y -= m.vy * dt * (1 + smoothBass * 0.85);
          m.x += Math.sin(t * m.drift + m.phase) * 4 * dt;
          if (m.y < 14) {
            m.y = stageY + 4;
            m.x = Math.random() * W;
          }
        }
        ctx.fillStyle = m.warm
          ? "rgba(255, 224, 198, 0.55)"
          : "rgba(230, 210, 255, 0.35)";
        ctx.fillRect(Math.round(m.x + p3x * 0.6), Math.round(m.y), 1, 1);
      }

      for (let i = sparks.length - 1; i >= 0; i--) {
        const sp = sparks[i];
        if (!isStatic) {
          sp.life += dt;
          sp.x += sp.vx * dt;
          sp.y += sp.vy * dt;
          sp.vy += 20 * dt;
          sp.vx *= Math.exp(-1.5 * dt);
        }
        if (sp.life >= sp.maxLife) {
          sparks.splice(i, 1);
          continue;
        }
        const alpha = 1 - sp.life / sp.maxLife;
        if (sp.kind === "note") {
          drawSprite(ctx, i % 2 === 0 ? NOTE_SPRITE : DOUBLE_NOTE_SPRITE, sp.x, sp.y, sp.color);
        } else if (sp.kind === "heart") {
          drawSprite(ctx, HEART_SPRITE, sp.x, sp.y, sp.color);
        } else if (alpha > 0.2) {
          ctx.fillStyle = sp.color;
          ctx.fillRect(Math.round(sp.x), Math.round(sp.y), alpha > 0.55 ? 2 : 1, 1);
        }
      }

      // ── LAYER 5: Lush organic foreground crowd silhouettes framing bottom (parallax: 16px / 24px) ──
      const p4x = -ptr.nx * 16;
      const p5x = -ptr.nx * 24;

      for (const person of crowdBack) {
        if (!isStatic && person.cheer > 0) {
          person.cheer = Math.max(0, person.cheer - dt * 1.85);
        }
        const bob = Math.sin(t * 3.2 + person.phase) * (0.8 + smoothBass * 2.4);
        drawGuest(person, p4x, H + 3, bob, "#190e24", "#4d274c");
      }

      for (const person of crowdFront) {
        if (!isStatic && person.cheer > 0) {
          person.cheer = Math.max(0, person.cheer - dt * 1.85);
        }
        const bob = Math.sin(t * 3.5 + person.phase + 1.2) * (1.0 + smoothBass * 3.0);
        drawGuest(person, p5x, H + 7, bob, "#0c0712", "#2e1836");
      }

      // Razor-sharp nearest-neighbor upscale to viewport
      displayCtx.imageSmoothingEnabled = false;
      displayCtx.drawImage(buf, 0, 0, W, H, 0, 0, viewW, viewH);
    };

    if (reducedMotion) {
      renderFrame(performance.now(), true);
    } else {
      const tick = (now: number) => {
        if (!document.hidden) {
          renderFrame(now);
        } else {
          lastTs = now;
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 h-full w-full select-none [image-rendering:pixelated]"
    />
  );
}
