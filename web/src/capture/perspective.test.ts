import { describe, expect, it } from "vitest";
import type { Quad } from "./cardDetect.ts";
import { applyHomography, computeHomography, type RgbaImage, rectifyCard } from "./perspective.ts";

describe("computeHomography", () => {
  it("maps source points to destinations", () => {
    const h = computeHomography(
      [
        [0, 0],
        [10, 0],
        [10, 6],
        [0, 6],
      ],
      [
        [0, 0],
        [100, 0],
        [100, 60],
        [0, 60],
      ],
    );
    const [x, y] = applyHomography(h, 5, 3);
    expect(x).toBeCloseTo(50, 5);
    expect(y).toBeCloseTo(30, 5);
  });

  it("handles perspective distortion", () => {
    const src: [number, number][] = [
      [10, 20],
      [90, 10],
      [85, 50],
      [15, 55],
    ];
    const dst: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 60],
      [0, 60],
    ];
    const h = computeHomography(src, dst);
    for (let i = 0; i < 4; i++) {
      const [x, y] = applyHomography(h, ...(src[i] as [number, number]));
      const [dx, dy] = dst[i] as [number, number];
      expect(x).toBeCloseTo(dx, 4);
      expect(y).toBeCloseTo(dy, 4);
    }
  });
});

describe("rectifyCard", () => {
  it("produces an axis-aligned image of the card region", () => {
    const w = 200;
    const h = 150;
    const src: RgbaImage = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    // Fill: dark background, red card interior.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inCard = x >= 40 && x <= 160 && y >= 40 && y <= 100;
        src.data[i] = inCard ? 255 : 20;
        src.data[i + 1] = 0;
        src.data[i + 2] = 0;
        src.data[i + 3] = 255;
      }
    }
    const quad: Quad = {
      corners: [
        { x: 40, y: 40 },
        { x: 160, y: 40 },
        { x: 160, y: 100 },
        { x: 160 - 120, y: 100 },
      ],
      area: 120 * 60,
    };
    const out = rectifyCard(src, quad, 300);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
    expect(out.width / out.height).toBeCloseTo(120 / 60, 1);
    // Center pixel should be the card's red.
    const center = (((out.height / 2) | 0) * out.width + ((out.width / 2) | 0)) * 4;
    expect(out.data[center]).toBeGreaterThan(200);
  });
});
