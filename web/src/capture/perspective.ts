import type { Quad } from "./cardDetect.ts";

/**
 * 4-point perspective rectification. Solves the homography that maps the
 * detected quad onto a rectangle, then resamples with bilinear interpolation.
 * Pure array math — no canvas or OpenCV dependency.
 */

export type Homography = Float64Array; // row-major 3x3, h[8] normalized to 1

/** Solve the 8x8 linear system for the homography mapping src quad -> dst rect. */
export function computeHomography(src: [number, number][], dst: [number, number][]): Homography {
  // For each correspondence (x,y) -> (X,Y):
  //   x*h0 + y*h1 + h2 - x*X*h6 - y*X*h7 = X
  //   x*h3 + y*h4 + h5 - x*Y*h6 - y*Y*h7 = Y
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i] as [number, number];
    const [X, Y] = dst[i] as [number, number];
    a.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    a.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  const h = solve(a, b);
  return Float64Array.from([h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1]);
}

function solve(a: number[][], b: number[]): number[] {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i] as number]);
  const at = (r: number, c: number) => {
    const v = m[r]?.[c];
    if (v === undefined) throw new Error("solve: index out of bounds");
    return v;
  };
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(at(row, col)) > Math.abs(at(pivot, col))) pivot = row;
    }
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const d = at(col, col);
    if (Math.abs(d) < 1e-12) throw new Error("singular homography system");
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = at(row, col) / d;
      for (let k = col; k <= n; k++) {
        (m[row] as number[])[k] = at(row, k) - f * at(col, k);
      }
    }
  }
  return m.map((row, i) => (row[n] as number) / at(i, i));
}

export function applyHomography(h: Homography, x: number, y: number): [number, number] {
  const d = h[6]! * x + h[7]! * y + h[8]!;
  return [(h[0]! * x + h[1]! * y + h[2]!) / d, (h[3]! * x + h[4]! * y + h[5]!) / d];
}

export interface RgbaImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/**
 * Warp the card region of `src` into an axis-aligned rectangle.
 * Output width is capped at maxWidth; height follows the quad's aspect ratio.
 */
export function rectifyCard(src: RgbaImage, quad: Quad, maxWidth = 1100): RgbaImage {
  const c = quad.corners;
  const top = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y);
  const bottom = Math.hypot(c[2].x - c[3].x, c[2].y - c[3].y);
  const left = Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y);
  const right = Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y);
  const outW = Math.min(maxWidth, Math.round(Math.max(top, bottom)));
  const outH = Math.max(1, Math.round(outW * (Math.max(left, right) / Math.max(top, bottom))));

  // Map destination rect back to the source quad.
  const inv = computeHomography(
    [
      [0, 0],
      [outW - 1, 0],
      [outW - 1, outH - 1],
      [0, outH - 1],
    ],
    c.map((p) => [p.x, p.y] as [number, number]),
  );

  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const [sx, sy] = applyHomography(inv, x, y);
      const di = (y * outW + x) * 4;
      const px = bilinear(src, sx, sy);
      out[di] = px[0]!;
      out[di + 1] = px[1]!;
      out[di + 2] = px[2]!;
      out[di + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

function bilinear(src: RgbaImage, x: number, y: number): [number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const dx = x - x0;
  const dy = y - y0;
  const sample = (xx: number, yy: number): [number, number, number] => {
    const cx = Math.min(src.width - 1, Math.max(0, xx));
    const cy = Math.min(src.height - 1, Math.max(0, yy));
    const i = (cy * src.width + cx) * 4;
    return [src.data[i]!, src.data[i + 1]!, src.data[i + 2]!];
  };
  const p00 = sample(x0, y0);
  const p10 = sample(x0 + 1, y0);
  const p01 = sample(x0, y0 + 1);
  const p11 = sample(x0 + 1, y0 + 1);
  const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;
  const r = mix(mix(p00[0], p10[0], dx), mix(p01[0], p11[0], dx), dy);
  const g = mix(mix(p00[1], p10[1], dx), mix(p01[1], p11[1], dx), dy);
  const b = mix(mix(p00[2], p10[2], dx), mix(p01[2], p11[2], dx), dy);
  return [r, g, b];
}
