/**
 * Business-card detection on a downscaled grayscale frame — pure functions so
 * the whole pipeline is unit-testable without a DOM/canvas.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Quad {
  /** Ordered: top-left, top-right, bottom-right, bottom-left. */
  corners: [Point, Point, Point, Point];
  area: number;
}

export interface CaptureAssessment {
  ok: boolean;
  quad: Quad | null;
  blur: number;
  reasons: string[];
}

export interface CaptureThresholds {
  /** Minimum quad area as a fraction of the frame. */
  minAreaFraction: number;
  maxAreaFraction: number;
  /** Accepted long/short side ratio range (名刺 ~1.65). */
  minAspect: number;
  maxAspect: number;
  /** Max allowed corner deviation from 90 degrees. */
  maxAngleDeviationDeg: number;
  /** Minimum Laplacian variance (focus check). */
  minBlur: number;
  /** Border margin the quad must keep inside the frame (fraction). */
  frameMargin: number;
}

export const DEFAULT_THRESHOLDS: CaptureThresholds = {
  minAreaFraction: 0.12,
  maxAreaFraction: 0.92,
  minAspect: 1.2,
  maxAspect: 2.4,
  maxAngleDeviationDeg: 40,
  minBlur: 30,
  frameMargin: 0.01,
};

/** Largest 4-connected component of `mask` (1 = foreground). Returns label ids. */
export function largestComponent(mask: Uint8Array, w: number, h: number): Uint8Array {
  const labels = new Int32Array(w * h).fill(-1);
  let bestLabel = -1;
  let bestSize = 0;
  let label = 0;
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== 1 || labels[i] !== -1) continue;
    let size = 0;
    let top = 0;
    stack[top++] = i;
    labels[i] = label;
    while (top > 0) {
      const p = stack[--top] as number;
      size += 1;
      const x = p % w;
      const y = (p / w) | 0;
      const neighbors = [
        x > 0 ? p - 1 : -1,
        x < w - 1 ? p + 1 : -1,
        y > 0 ? p - w : -1,
        y < h - 1 ? p + w : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && mask[n] === 1 && labels[n] === -1) {
          labels[n] = label;
          stack[top++] = n;
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = label;
    }
    label += 1;
  }
  if (bestLabel === -1) return new Uint8Array(0);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = labels[i] === bestLabel ? 1 : 0;
  return out;
}

/**
 * Segment a card candidate: the card is assumed to contrast with the background
 * sampled along the frame border (works for light card on dark desk and vice
 * versa). Returns the binary mask of the largest blob.
 */
export function cardMask(gray: Uint8Array, w: number, h: number): Uint8Array {
  // Border luminance median.
  const border: number[] = [];
  for (let x = 0; x < w; x++) {
    border.push(gray[x] as number, gray[(h - 1) * w + x] as number);
  }
  for (let y = 0; y < h; y++) {
    border.push(gray[y * w] as number, gray[y * w + w - 1] as number);
  }
  border.sort((a, b) => a - b);
  const bg = border[border.length >> 1] as number;

  const mask = new Uint8Array(w * h);
  // Adaptive threshold: at least 24 levels of contrast.
  for (let i = 0; i < w * h; i++) {
    mask[i] = Math.abs((gray[i] as number) - bg) > 24 ? 1 : 0;
  }
  return largestComponent(mask, w, h);
}

/**
 * Approximate the mask's quadrilateral via the extremes of x+y and x-y —
 * the convex hull corners of a roughly rectangular blob.
 */
export function maskToQuad(mask: Uint8Array, w: number, h: number): Quad | null {
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;
  const tl = { x: 0, y: 0 };
  const br = { x: 0, y: 0 };
  const tr = { x: 0, y: 0 };
  const bl = { x: 0, y: 0 };
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 1) continue;
      count += 1;
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) {
        minSum = sum;
        tl.x = x;
        tl.y = y;
      }
      if (sum > maxSum) {
        maxSum = sum;
        br.x = x;
        br.y = y;
      }
      if (diff < minDiff) {
        minDiff = diff;
        bl.x = x;
        bl.y = y;
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        tr.x = x;
        tr.y = y;
      }
    }
  }
  if (count === 0) return null;
  const corners: [Point, Point, Point, Point] = [tl, tr, br, bl];
  return { corners, area: quadArea(corners) };
}

export function quadArea(corners: [Point, Point, Point, Point]): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i] as Point;
    const b = corners[(i + 1) % 4] as Point;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function sideLengths(corners: [Point, Point, Point, Point]): [number, number] {
  const len = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const a = (len(corners[0], corners[1]) + len(corners[3], corners[2])) / 2;
  const b = (len(corners[1], corners[2]) + len(corners[0], corners[3])) / 2;
  return a >= b ? [a, b] : [b, a];
}

export function quadAspect(quad: Quad): number {
  const [long, short] = sideLengths(quad.corners);
  return short === 0 ? Infinity : long / short;
}

/** Max deviation of the four interior angles from 90 degrees, in degrees. */
export function quadAngleDeviation(quad: Quad): number {
  const c = quad.corners;
  let maxDev = 0;
  for (let i = 0; i < 4; i++) {
    const p = c[(i + 3) % 4] as Point;
    const q = c[i] as Point;
    const r = c[(i + 1) % 4] as Point;
    const v1x = p.x - q.x;
    const v1y = p.y - q.y;
    const v2x = r.x - q.x;
    const v2y = r.y - q.y;
    const dot = v1x * v2x + v1y * v2y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 === 0 || l2 === 0) return 90;
    const angle = (Math.acos(Math.min(1, Math.max(-1, dot / (l1 * l2)))) * 180) / Math.PI;
    maxDev = Math.max(maxDev, Math.abs(angle - 90));
  }
  return maxDev;
}

/** Variance of the discrete Laplacian over the whole frame — focus metric. */
export function laplacianVariance(gray: Uint8Array, w: number, h: number): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        4 * (gray[i] as number) -
        (gray[i - 1] as number) -
        (gray[i + 1] as number) -
        (gray[i - w] as number) -
        (gray[i + w] as number);
      sum += lap;
      sumSq += lap * lap;
      n += 1;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Mean absolute corner displacement between two quads, in pixels. */
export function quadDisplacement(a: Quad, b: Quad): number {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    total += Math.hypot(
      (a.corners[i] as Point).x - (b.corners[i] as Point).x,
      (a.corners[i] as Point).y - (b.corners[i] as Point).y,
    );
  }
  return total / 4;
}

/**
 * Evaluate one frame against the spec's auto-capture conditions:
 * whole card in frame, four corners recognizable, sufficient display area,
 * no extreme tilt, no strong shake (handled by caller via stability), not
 * severely out of focus.
 */
export function assessFrame(
  gray: Uint8Array,
  w: number,
  h: number,
  thresholds: CaptureThresholds = DEFAULT_THRESHOLDS,
): CaptureAssessment {
  const reasons: string[] = [];
  const mask = cardMask(gray, w, h);
  const quad = maskToQuad(mask, w, h);
  const blur = laplacianVariance(gray, w, h);

  if (!quad) {
    return { ok: false, quad: null, blur, reasons: ["名刺らしい領域が見つかりません"] };
  }

  const areaFraction = quad.area / (w * h);
  if (areaFraction < thresholds.minAreaFraction) reasons.push("名刺を近づけてください");
  if (areaFraction > thresholds.maxAreaFraction) reasons.push("名刺が近すぎます");

  const mx = Math.ceil(w * thresholds.frameMargin);
  const my = Math.ceil(h * thresholds.frameMargin);
  const inside = quad.corners.every(
    (p) => p.x >= mx && p.x <= w - 1 - mx && p.y >= my && p.y <= h - 1 - my,
  );
  if (!inside) reasons.push("名刺全体をフレームに入れてください");

  const aspect = quadAspect(quad);
  if (aspect < thresholds.minAspect || aspect > thresholds.maxAspect) {
    reasons.push("名刺の向き・形を確認してください");
  }

  if (quadAngleDeviation(quad) > thresholds.maxAngleDeviationDeg) {
    reasons.push("名刺が大きく傾いています");
  }

  if (blur < thresholds.minBlur) reasons.push("ピントを合わせています…");

  return { ok: reasons.length === 0, quad, blur, reasons };
}
