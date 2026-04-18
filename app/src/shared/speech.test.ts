import { describe, expect, it } from "vitest";
import { firstJapaneseLineFromLesson } from "./speech";

describe("firstJapaneseLineFromLesson", () => {
  it("skips blank lines and returns first line with Japanese", () => {
    expect(firstJapaneseLineFromLesson("\n\nhello\n今日はいい天気。\n次行")).toBe("今日はいい天気。");
  });

  it("returns empty when no Japanese", () => {
    expect(firstJapaneseLineFromLesson("only ascii\n123")).toBe("");
  });
});
