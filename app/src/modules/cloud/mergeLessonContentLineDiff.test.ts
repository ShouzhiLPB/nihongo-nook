import { describe, expect, it } from "vitest";
import { tryLessonContentPairFromNormJson } from "./mergeLessonContentLineDiff";

describe("tryLessonContentPairFromNormJson", () => {
  it("extracts content from two normalized lesson JSON strings", () => {
    const local = JSON.stringify({ id: "a", name: "L", content: "い\nち", category: "未分类", author: "著者不明", createdAt: "t", updatedAt: "t" });
    const remote = JSON.stringify({ id: "a", name: "L", content: "い\nに", category: "未分类", author: "著者不明", createdAt: "t", updatedAt: "t" });
    expect(tryLessonContentPairFromNormJson(local, remote)).toEqual({ left: "い\nち", right: "い\nに" });
  });

  it("returns null on invalid JSON", () => {
    expect(tryLessonContentPairFromNormJson("{", "{}")).toBeNull();
  });
});
