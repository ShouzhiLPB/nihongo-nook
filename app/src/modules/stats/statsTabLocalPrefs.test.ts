import { describe, expect, it } from "vitest";
import {
  parseStatsFutureShowCumulative,
  parseStatsPastGranularity,
  parseStatsPastRange,
  parseStatsPastTail,
  parseStatsPastViewMode,
} from "./statsTabLocalPrefs";

describe("statsTabLocalPrefs parsers", () => {
  it("parseStatsPastRange", () => {
    expect(parseStatsPastRange(null)).toBeNull();
    expect(parseStatsPastRange("d30")).toBe("d30");
    expect(parseStatsPastRange("invalid")).toBeNull();
  });

  it("parseStatsPastTail", () => {
    expect(parseStatsPastTail("all")).toBe("all");
    expect(parseStatsPastTail("90")).toBe(90);
    expect(parseStatsPastTail("99")).toBeNull();
  });

  it("parseStatsPastGranularity", () => {
    expect(parseStatsPastGranularity("week")).toBe("week");
    expect(parseStatsPastGranularity("month")).toBeNull();
  });

  it("parseStatsPastViewMode", () => {
    expect(parseStatsPastViewMode("barsOnly")).toBe("barsOnly");
  });

  it("parseStatsFutureShowCumulative", () => {
    expect(parseStatsFutureShowCumulative("1")).toBe(true);
    expect(parseStatsFutureShowCumulative("0")).toBe(false);
    expect(parseStatsFutureShowCumulative("")).toBeNull();
  });
});
