import { describe, expect, it } from "vitest";
import { toYoutubeEmbedBaseUrl, toYoutubeIframeSrc } from "./youtubeEmbed";

describe("youtubeEmbed", () => {
  it("maps watch URL to embed base", () => {
    expect(toYoutubeEmbedBaseUrl("https://www.youtube.com/watch?v=CpyumMoe9Hc")).toBe(
      "https://www.youtube.com/embed/CpyumMoe9Hc",
    );
  });

  it("maps youtu.be to embed base", () => {
    expect(toYoutubeEmbedBaseUrl("https://youtu.be/CpyumMoe9Hc")).toBe("https://www.youtube.com/embed/CpyumMoe9Hc");
  });

  it("toYoutubeIframeSrc adds enablejsapi", () => {
    expect(toYoutubeIframeSrc("https://www.youtube.com/watch?v=abc") ?? "").toMatch(/enablejsapi=1/);
  });
});
