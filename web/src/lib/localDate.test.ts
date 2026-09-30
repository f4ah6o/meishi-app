import { describe, expect, it } from "vitest";
import { localDateString } from "./localDate.ts";

describe("localDateString", () => {
  it("uses the device's local calendar date", () => {
    // 00:30 local on Oct 1 must stay Oct 1 (a UTC slice could roll back).
    expect(localDateString(new Date(2026, 9, 1, 0, 30))).toBe("2026-10-01");
    expect(localDateString(new Date(2026, 8, 30, 23, 59))).toBe("2026-09-30");
  });

  it("zero-pads month and day", () => {
    expect(localDateString(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
