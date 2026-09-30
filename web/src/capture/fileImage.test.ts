import { describe, expect, it } from "vitest";
import { scaleForMaxDim } from "./fileImage.ts";

describe("scaleForMaxDim", () => {
  it("caps the longest side without upscaling", () => {
    expect(scaleForMaxDim(4000, 3000, 2048)).toBeCloseTo(0.512);
    expect(scaleForMaxDim(1000, 500, 2048)).toBe(1);
    expect(scaleForMaxDim(3000, 6000, 2048)).toBeCloseTo(2048 / 6000);
  });
});
