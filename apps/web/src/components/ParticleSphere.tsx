import { useEffect, useRef } from "react";

interface ParticleSphereProps {
  size?: number;
  className?: string;
}

interface Pt {
  x: number;
  y: number;
  z: number;
  isCore: boolean;
  part: 0 | 1 | 2 | 3;
}

function classifyCoreGlyph(nx: number, ny: number): 0 | 1 | 2 | 3 | null {
  // Three slanted parallelogram bars + circular dot (///•) in normalized coordinates
  if (Math.abs(ny) <= 0.25) {
    const skew = nx + ny * 0.42;
    if (skew >= -0.46 && skew <= -0.31) return 0; // Bar 1 (#FCFFFF)
    if (skew >= -0.22 && skew <= -0.07) return 1; // Bar 2 (#0593C6)
    if (skew >= 0.02 && skew <= 0.17) return 2; // Bar 3 (#FCFFFF)
  }
  const dx = nx - 0.35;
  const dy = ny + 0.12;
  if (dx * dx + dy * dy <= 0.014) return 3; // Dot (#D83996)
  return null;
}

export function ParticleSphere({ size = 460, className = "" }: ParticleSphereProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const points: Pt[] = [];
    const shellCount = 2800;
    const golden = Math.PI * (3 - Math.sqrt(5));

    // Outer Fibonacci point-cloud shell
    for (let i = 0; i < shellCount; i++) {
      const y = 1 - (i / (shellCount - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      const jitter = 0.96 + ((i * 73) % 100) * 0.0008;
      points.push({
        x: Math.cos(theta) * r * jitter,
        y: y * jitter,
        z: Math.sin(theta) * r * jitter,
        isCore: false,
        part: (i % 4) as 0 | 1 | 2 | 3,
      });
    }

    // Dense 3D volumetric lattice for the suspended ///• core mark
    const stepsX = 64;
    const stepsY = 36;
    const layersZ = 5;
    for (let ix = 0; ix <= stepsX; ix++) {
      const nx = (ix / stepsX - 0.5) * 1.15;
      for (let iy = 0; iy <= stepsY; iy++) {
        const ny = (iy / stepsY - 0.5) * 0.65;
        const part = classifyCoreGlyph(nx, ny);
        if (part !== null) {
          for (let iz = 0; iz < layersZ; iz++) {
            const nz = (iz / (layersZ - 1) - 0.5) * 0.14;
            points.push({ x: nx, y: ny, z: nz, isCore: true, part });
          }
        }
      }
    }

    let angle = 0.35;
    let targetYaw = 0;
    let targetPitch = 0;
    let curYaw = 0;
    let curPitch = 0;
    let raf = 0;

    const onMove = (e: MouseEvent) => {
      const nx = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
      const ny = (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
      targetYaw = nx * 0.38;
      targetPitch = ny * 0.25;
    };
    window.addEventListener("mousemove", onMove, { passive: true });

    const render = () => {
      ctx.clearRect(0, 0, size, size);
      const cx = size / 2;
      const cy = size / 2;
      const radius = size * 0.37;

      curYaw += (targetYaw - curYaw) * 0.06;
      curPitch += (targetPitch - curPitch) * 0.06;

      // Outer shell rotates continuously; inner ///• core gently oscillates toward viewer like motion.dev
      const shellAngle = angle + curYaw;
      const cosS = Math.cos(shellAngle);
      const sinS = Math.sin(shellAngle);
      const shellTilt = 0.22 + curPitch;
      const cosST = Math.cos(shellTilt);
      const sinST = Math.sin(shellTilt);

      const coreAngle = Math.sin(angle * 0.85) * 0.28 + curYaw * 0.7;
      const cosC = Math.cos(coreAngle);
      const sinC = Math.sin(coreAngle);
      const coreTilt = Math.cos(angle * 0.65) * 0.12 + curPitch * 0.6;
      const cosCT = Math.cos(coreTilt);
      const sinCT = Math.sin(coreTilt);

      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p.isCore) {
          const rx = p.x * cosC - p.z * sinC;
          const rz0 = p.x * sinC + p.z * cosC;
          const ry = p.y * cosCT - rz0 * sinCT;
          const rz = p.y * sinCT + rz0 * cosCT;

          const sx = cx + rx * radius;
          const sy = cy + ry * radius;
          const depthBoost = 0.72 + (rz + 0.1) * 1.4;

          ctx.fillStyle =
            p.part === 1
              ? `rgba(5, 147, 198, ${Math.min(1, depthBoost)})`
              : p.part === 3
                ? `rgba(216, 57, 150, ${Math.min(1, depthBoost)})`
                : `rgba(252, 255, 255, ${Math.min(1, depthBoost)})`;
          ctx.fillRect(sx, sy, 1.85, 1.85);
        } else {
          const rx = p.x * cosS - p.z * sinS;
          const rz0 = p.x * sinS + p.z * cosS;
          const ry = p.y * cosST - rz0 * sinST;
          const rz = p.y * sinST + rz0 * cosST;

          const rim = Math.min(1, Math.sqrt(rx * rx + ry * ry));
          const depthAlpha = (rz + 1.2) / 2.2;
          if (depthAlpha <= 0.08) continue;

          const alpha = Math.pow(rim, 1.35) * depthAlpha * 0.88;
          if (alpha < 0.06) continue;

          const sx = cx + rx * radius;
          const sy = cy + ry * radius;

          ctx.fillStyle =
            rx < -0.15
              ? `rgba(252, 255, 255, ${alpha})`
              : ry > 0.18
                ? `rgba(216, 57, 150, ${alpha})`
                : `rgba(5, 147, 198, ${alpha})`;
          ctx.fillRect(sx, sy, 1.35, 1.35);
        }
      }

      angle += 0.005;
      raf = requestAnimationFrame(render);
    };

    render();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      aria-hidden="true"
      className={`pointer-events-none select-none ${className}`}
    />
  );
}
