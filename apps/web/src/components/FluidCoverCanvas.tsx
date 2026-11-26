import { useEffect, useRef, useState } from "react";

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision mediump float;
varying vec2 vUv;

uniform sampler2D uTexPrev;
uniform sampler2D uTexCurr;
uniform float uTime;
uniform float uMix;
uniform float uLumaPrev;
uniform float uLumaCurr;
uniform vec2 uResolution;

vec2 rot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c) * p;
}

vec2 fluidUv(vec2 uv, float t, float phase) {
  vec2 p = uv * 2.0 - 1.0;
  float aspect = uResolution.x / max(1.0, uResolution.y);
  p.x *= mix(1.0, aspect, 0.35);

  p = rot(p, sin(t * 0.13 + phase) * 0.5 + t * 0.045 + phase);

  vec2 q = vec2(
    sin(p.y * 1.9 + t * 0.36 + phase) + cos(p.x * 1.5 - t * 0.28),
    cos(p.x * 2.0 + t * 0.31 - phase) - sin(p.y * 1.7 + t * 0.24)
  );
  vec2 r = vec2(
    sin((p.y + q.y * 0.32) * 1.65 - t * 0.22 + phase),
    cos((p.x + q.x * 0.32) * 1.75 + t * 0.27)
  );

  vec2 warped = p * 0.58 + q * 0.20 + r * 0.14;
  return warped * 0.5 + 0.5;
}

vec3 sampleSoft(sampler2D tex, vec2 uv) {
  vec2 d = vec2(0.055, 0.055);
  vec3 c = texture2D(tex, uv).rgb * 0.28;
  c += texture2D(tex, uv + vec2( d.x,  0.0)).rgb * 0.10;
  c += texture2D(tex, uv + vec2(-d.x,  0.0)).rgb * 0.10;
  c += texture2D(tex, uv + vec2( 0.0,  d.y)).rgb * 0.10;
  c += texture2D(tex, uv + vec2( 0.0, -d.y)).rgb * 0.10;
  c += texture2D(tex, uv + vec2( d.x,  d.y)).rgb * 0.08;
  c += texture2D(tex, uv + vec2(-d.x,  d.y)).rgb * 0.08;
  c += texture2D(tex, uv + vec2( d.x, -d.y)).rgb * 0.08;
  c += texture2D(tex, uv + vec2(-d.x, -d.y)).rgb * 0.08;
  return c;
}

vec3 sampleFluidCover(sampler2D tex, vec2 uv, float t, float coverLuma) {
  vec2 uv1 = fluidUv(uv, t, 0.0);
  vec2 uv2 = fluidUv(uv, t * 0.84 + 7.3, 2.1);
  vec2 uv3 = fluidUv(uv, t * 0.68 + 15.1, 4.2);

  vec3 c1 = sampleSoft(tex, uv1);
  vec3 c2 = sampleSoft(tex, uv2);
  vec3 c3 = sampleSoft(tex, uv3);

  float w1 = 0.50 + 0.22 * sin(uv.x * 2.4 + t * 0.28);
  float w2 = 0.50 + 0.22 * cos(uv.y * 2.3 - t * 0.24);
  vec3 col = mix(mix(c1, c2, clamp(w1, 0.18, 0.82)), c3, clamp(w2 * 0.48, 0.15, 0.55));

  // Apple Music style vibrancy lift
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 1.38);

  // Adaptive exposure: preserve warm bright covers (Fukrey/Dil Dhadakne Do) while keeping white lyrics crisp,
  // and gently lift deep moody covers (Kalank/Aalas Ka Pedh) so their colors glow instead of crushing to black.
  float targetGain = coverLuma > 0.60 ? 0.66
                   : coverLuma > 0.42 ? 0.78
                   : coverLuma > 0.22 ? 0.94
                   : 1.12;
  col *= targetGain;

  // Keep a soft ceiling so bright white lyrics remain legible over white poster zones
  col = col / (1.0 + col * 0.28);
  return clamp(col, 0.0, 1.0);
}

void main() {
  vec3 prevCol = sampleFluidCover(uTexPrev, vUv, uTime, uLumaPrev);
  vec3 currCol = sampleFluidCover(uTexCurr, vUv, uTime, uLumaCurr);
  vec3 col = mix(prevCol, currCol, smoothstep(0.0, 1.0, uMix));

  // Subtle ambient vignette
  vec2 centered = vUv - 0.5;
  float vig = 1.0 - dot(centered, centered) * 0.36;
  col *= clamp(vig, 0.72, 1.0);

  // Tiny dither to eliminate 8-bit gradient banding
  float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (noise - 0.5) / 255.0;

  gl_FragColor = vec4(col, 1.0);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function createCoverTexture(gl: WebGLRenderingContext): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const seed = new Uint8Array([14, 16, 24, 255]);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, seed);
  return tex;
}

/** Draw the cover onto a 128x128 canvas (lightly pre-softened to erase poster text while preserving all color regions). */
function prepareCoverSource(img: HTMLImageElement): { canvas: HTMLCanvasElement; avgLuma: number } {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let avgLuma = 0.35;

  if (ctx) {
    // Draw unblurred first to measure accurate cover luminance
    ctx.drawImage(img, 0, 0, size, size);
    try {
      const data = ctx.getImageData(0, 0, size, size).data;
      let sum = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 16) {
        sum += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
        count++;
      }
      if (count > 0) avgLuma = sum / count;
    } catch {
      // Ignore readback errors
    }

    // Light 4px blur keeps all distinct colors (red, blue, pink, gold) while smoothing sharp poster lines
    ctx.filter = "blur(4px)";
    ctx.drawImage(img, -8, -8, size + 16, size + 16);
  }

  return { canvas, avgLuma };
}

export interface FluidCoverCanvasProps {
  /** Loaded HTMLImageElement of the current album art (same-origin or CORS-safe blob). */
  image: HTMLImageElement | null;
  /** Unique key representing the current cover so crossfades trigger cleanly. */
  imageKey: string | null;
  /** When true, liquid flows at normal speed; when paused, glides gently in slow motion. */
  playing: boolean;
  /** Called if WebGL fails to initialize so parent can keep CSS fallback visible. */
  onFallback?: () => void;
}

/**
 * Apple Music Sing–style WebGL fluid-warp backdrop that melts and swirls the actual album art
 * on a lightweight 320x180 GPU surface (locked 60 FPS, zero CSS blur repaints).
 */
export function FluidCoverCanvas({
  image,
  imageKey,
  playing,
  onFallback,
}: FluidCoverCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const [ready, setReady] = useState(false);

  const glStateRef = useRef<{
    gl: WebGLRenderingContext;
    texPrev: WebGLTexture;
    texCurr: WebGLTexture;
    lumaPrev: number;
    lumaCurr: number;
    mix: number;
    hasFirstTexture: boolean;
    lastKey: string | null;
  } | null>(null);

  // Initialize WebGL program + 60 FPS render loop once
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      onFallback?.();
      return;
    }

    const prog = createProgram(gl);
    if (!prog) {
      onFallback?.();
      return;
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const texPrev = createCoverTexture(gl);
    const texCurr = createCoverTexture(gl);
    if (!texPrev || !texCurr) {
      onFallback?.();
      return;
    }

    gl.useProgram(prog);
    const uTexPrev = gl.getUniformLocation(prog, "uTexPrev");
    const uTexCurr = gl.getUniformLocation(prog, "uTexCurr");
    const uTime = gl.getUniformLocation(prog, "uTime");
    const uMix = gl.getUniformLocation(prog, "uMix");
    const uLumaPrev = gl.getUniformLocation(prog, "uLumaPrev");
    const uLumaCurr = gl.getUniformLocation(prog, "uLumaCurr");
    const uResolution = gl.getUniformLocation(prog, "uResolution");

    gl.uniform1i(uTexPrev, 0);
    gl.uniform1i(uTexCurr, 1);

    const state = {
      gl,
      texPrev,
      texCurr,
      lumaPrev: 0.35,
      lumaCurr: 0.35,
      mix: 1.0,
      hasFirstTexture: false,
      lastKey: null as string | null,
    };
    glStateRef.current = state;

    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let rafId = 0;
    let simTime = 0;
    let lastTs = performance.now();
    let contextLost = false;

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      contextLost = true;
      onFallback?.();
    };
    canvas.addEventListener("webglcontextlost", handleContextLost, false);

    const render = (now: number) => {
      if (contextLost) return;
      const dt = Math.min(0.05, Math.max(0, (now - lastTs) / 1000));
      lastTs = now;

      if (document.hidden) {
        rafId = requestAnimationFrame(render);
        return;
      }

      if (!reducedMotion) {
        // Flows organically when playing; drifts gently at 28% speed when paused so it still feels alive
        simTime += dt * (playingRef.current ? 1.0 : 0.28);
      }

      if (state.mix < 1.0) {
        state.mix = Math.min(1.0, state.mix + dt * 0.9);
      }

      if (state.hasFirstTexture) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, state.texPrev);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, state.texCurr);

        gl.uniform1f(uTime, simTime);
        gl.uniform1f(uMix, state.mix);
        gl.uniform1f(uLumaPrev, state.lumaPrev);
        gl.uniform1f(uLumaCurr, state.lumaCurr);
        gl.uniform2f(uResolution, canvas.width, canvas.height);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafId);
      canvas.removeEventListener("webglcontextlost", handleContextLost, false);
      glStateRef.current = null;
      gl.deleteTexture(texPrev);
      gl.deleteTexture(texCurr);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    };
  }, [onFallback]);

  // Upload new album art texture and start smooth GPU crossfade whenever cover changes
  useEffect(() => {
    const state = glStateRef.current;
    if (!state || !image || !imageKey || state.lastKey === imageKey) return;
    state.lastKey = imageKey;

    const { gl } = state;
    const { canvas: prepared, avgLuma } = prepareCoverSource(image);

    if (!state.hasFirstTexture) {
      // Seed both prev and curr so first frame appears immediately with no dark flash
      gl.bindTexture(gl.TEXTURE_2D, state.texPrev);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, prepared);
      gl.bindTexture(gl.TEXTURE_2D, state.texCurr);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, prepared);
      state.lumaPrev = avgLuma;
      state.lumaCurr = avgLuma;
      state.mix = 1.0;
      state.hasFirstTexture = true;
      setReady(true);
      return;
    }

    // Swap current texture into prev slot, upload new album art into curr slot, crossfade 0 -> 1
    const oldPrev = state.texPrev;
    state.texPrev = state.texCurr;
    state.texCurr = oldPrev;
    state.lumaPrev = state.lumaCurr;
    state.lumaCurr = avgLuma;

    gl.bindTexture(gl.TEXTURE_2D, state.texCurr);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, prepared);
    state.mix = 0.0;
    setReady(true);
  }, [image, imageKey]);

  return (
    <canvas
      ref={canvasRef}
      width={320}
      height={180}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full transition-opacity duration-700 ${
        ready && image ? "opacity-100" : "opacity-0"
      }`}
    />
  );
}
