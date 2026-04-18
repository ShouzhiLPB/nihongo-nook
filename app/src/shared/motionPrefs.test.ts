import { describe, expect, it } from "vitest";
import { readPrefersReducedMotion } from "./motionPrefs";

describe("readPrefersReducedMotion", () => {
  it("Vitest node 环境无 window 时为 false", () => {
    expect(readPrefersReducedMotion()).toBe(false);
  });
});
