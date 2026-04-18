import { describe, expect, it } from "vitest";
import { formatUnknownError } from "./formatUnknownError";

describe("formatUnknownError", () => {
  it("reads .message from plain object (non-Error)", () => {
    expect(formatUnknownError({ message: "RLS policy violation" })).toBe("RLS policy violation");
  });

  it("uses Error.message when instanceof Error", () => {
    expect(formatUnknownError(new Error("boom"))).toBe("boom");
  });

  it("falls back to JSON for opaque objects", () => {
    expect(formatUnknownError({ code: "42P01" })).toContain("42P01");
  });
});
