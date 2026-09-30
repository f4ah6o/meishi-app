import { describe, expect, it } from "vitest";
import {
  assessFrame,
  cardMask,
  laplacianVariance,
  maskToQuad,
  quadAspect,
  quadDisplacement,
} from "./cardDetect.ts";

const W = 192;
const H = 144;

function frame(fill = 30): Uint8Array {
  return new Uint8Array(W * H).fill(fill);
}

function drawRect(gray: Uint8Array, x0: number, y0: number, x1: number, y1: number, v = 200) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      gray[y * W + x] = v;
    }
  }
}

/** Rect with slight perspective skew: shifted top edge. */
function drawSkewedRect(
  gray: Uint8Array,
  tl: [number, number],
  tr: [number, number],
  br: [number, number],
  bl: [number, number],
  v = 200,
) {
  const inside = (x: number, y: number) => {
    // Point-in-quad via edge cross products.
    const sign = (a: number[], b: number[]) =>
      (b[0]! - a[0]!) * (y - a[1]!) - (x - a[0]!) * (b[1]! - a[1]!);
    const e = [sign(tl, tr), sign(tr, br), sign(br, bl), sign(bl, tl)];
    return e.every((s) => s >= 0) || e.every((s) => s <= 0);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (inside(x, y)) gray[y * W + x] = v;
    }
  }
}

describe("cardMask + maskToQuad", () => {
  it("finds a bright card on a dark background", () => {
    const g = frame(30);
    drawRect(g, 40, 40, 150, 100);
    const quad = maskToQuad(cardMask(g, W, H), W, H);
    if (!quad) throw new Error("quad not detected");
    const [tl, _tr, br, _bl] = quad.corners;
    expect(tl.x).toBeCloseTo(40, 0);
    expect(tl.y).toBeCloseTo(40, 0);
    expect(br.x).toBeCloseTo(150, 0);
    expect(br.y).toBeCloseTo(100, 0);
    expect(quadAspect(quad!)).toBeCloseTo(110 / 60, 1);
  });

  it("finds a dark card on a light background", () => {
    const g = frame(220);
    drawRect(g, 30, 30, 140, 90, 40);
    const quad = maskToQuad(cardMask(g, W, H), W, H);
    expect(quad).not.toBeNull();
    expect(quad?.corners[0].x).toBeCloseTo(30, 0);
  });

  it("returns null for a uniform frame", () => {
    const g = frame(120);
    expect(maskToQuad(cardMask(g, W, H), W, H)).toBeNull();
  });
});

describe("assessFrame", () => {
  it("accepts a well-framed card", () => {
    const g = frame(30);
    drawRect(g, 40, 40, 150, 105);
    const res = assessFrame(g, W, H);
    expect(res.ok).toBe(true);
    expect(res.reasons).toHaveLength(0);
  });

  it("rejects a card touching the frame edge", () => {
    const g = frame(30);
    drawRect(g, 0, 30, 150, 100);
    const res = assessFrame(g, W, H);
    expect(res.ok).toBe(false);
    expect(res.reasons.join()).toContain("フレーム");
  });

  it("rejects a too-small card", () => {
    const g = frame(30);
    drawRect(g, 80, 60, 100, 75);
    const res = assessFrame(g, W, H);
    expect(res.ok).toBe(false);
    expect(res.reasons.join()).toContain("近づけて");
  });

  it("rejects a heavily skewed quad", () => {
    const g = frame(30);
    drawSkewedRect(g, [50, 50], [170, 20], [150, 120], [20, 90]);
    const res = assessFrame(g, W, H);
    expect(res.ok).toBe(false);
  });

  it("flags a blurry uniform card", () => {
    // A flat card has near-zero Laplacian variance -> treated as out of focus.
    const g = frame(30);
    drawRect(g, 40, 40, 150, 105);
    expect(laplacianVariance(g, W, H)).toBeGreaterThan(0);
  });
});

describe("quadDisplacement", () => {
  it("measures corner drift", () => {
    const g1 = frame(30);
    drawRect(g1, 40, 40, 150, 100);
    const q1 = maskToQuad(cardMask(g1, W, H), W, H)!;
    const g2 = frame(30);
    drawRect(g2, 42, 41, 152, 101);
    const q2 = maskToQuad(cardMask(g2, W, H), W, H)!;
    expect(quadDisplacement(q1, q2)).toBeLessThan(3);
  });
});
