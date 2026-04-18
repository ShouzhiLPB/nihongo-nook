import { describe, expect, it } from "vitest";
import {
  I2_CLOUD_WEAKNET_ACCEPTANCE,
  I2_DEVICE_SWITCH_ACCEPTANCE,
  I2_LAYOUT_ACCEPTANCE,
  I2_PHONE_VIEWPORT_MATRIX_ACCEPTANCE,
} from "./i2AcceptanceChecklists";

describe("i2AcceptanceChecklists", () => {
  it("has non-empty layout and cloud blocks for /qa display", () => {
    expect(I2_LAYOUT_ACCEPTANCE.length).toBeGreaterThan(0);
    expect(I2_CLOUD_WEAKNET_ACCEPTANCE.length).toBeGreaterThan(0);
    for (const b of [...I2_LAYOUT_ACCEPTANCE, ...I2_CLOUD_WEAKNET_ACCEPTANCE]) {
      expect(b.title.length).toBeGreaterThan(0);
      expect(b.steps.length).toBeGreaterThan(0);
    }
  });

  it("has device switch and phone viewport matrix blocks", () => {
    expect(I2_DEVICE_SWITCH_ACCEPTANCE.length).toBeGreaterThan(0);
    expect(I2_PHONE_VIEWPORT_MATRIX_ACCEPTANCE.length).toBeGreaterThan(0);
    for (const b of [...I2_DEVICE_SWITCH_ACCEPTANCE, ...I2_PHONE_VIEWPORT_MATRIX_ACCEPTANCE]) {
      expect(b.title.length).toBeGreaterThan(0);
      expect(b.steps.length).toBeGreaterThan(0);
    }
  });
});
