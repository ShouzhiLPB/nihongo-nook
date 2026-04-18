import { describe, expect, it } from "vitest";
import {
  buildGrammarPromptFromSelection,
  extractExampleSegmentForTerm,
  iterCalendarDaysInclusive,
  lessonAuthorDisplay,
  lessonAuthorForSave,
  lessonAuthorInputValue,
  normalizeJaTermForPractice,
  normalizePracticeWhitespace,
  normalizeZhMeaningForPractice,
  parseJsonObject,
  parseSrtToVideoCues,
  parseTimestampedTranscriptToVideoCues,
  tokenizeSentenceForDrag,
  splitLessonIntoSentenceSpans,
  splitLessonIntoSentences,
  zhHintForSentenceSpan,
} from "./utils";

describe("iterCalendarDaysInclusive", () => {
  it("lists every day including end", () => {
    expect(iterCalendarDaysInclusive("2026-04-01", "2026-04-03")).toEqual(["2026-04-01", "2026-04-02", "2026-04-03"]);
  });

  it("returns empty when start after end", () => {
    expect(iterCalendarDaysInclusive("2026-04-05", "2026-04-01")).toEqual([]);
  });

  it("handles single day", () => {
    expect(iterCalendarDaysInclusive("2026-02-28", "2026-02-28")).toEqual(["2026-02-28"]);
  });
});

describe("normalizePracticeWhitespace", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizePracticeWhitespace("  a  b\tc  ")).toBe("a b c");
  });

  it("returns empty for blank", () => {
    expect(normalizePracticeWhitespace("   \n  ")).toBe("");
  });
});

describe("tokenizeSentenceForDrag", () => {
  it("uses spaces when provided", () => {
    expect(tokenizeSentenceForDrag("私 は 学生 です")).toEqual(["私", "は", "学生", "です"]);
  });

  it("falls back to chunked tokens when no spaces", () => {
    expect(tokenizeSentenceForDrag("私は学生です")).toEqual(["私", "は", "学生", "です"]);
  });
});

describe("normalizeJaTermForPractice", () => {
  it("trims and collapses spaces", () => {
    expect(normalizeJaTermForPractice("  学生　だ  ")).toBe("学生 だ");
  });
});

describe("normalizeZhMeaningForPractice", () => {
  it("strips punctuation and casefolds", () => {
    expect(normalizeZhMeaningForPractice("  学习，。 ")).toBe("学习");
  });

  it("aligns variants for multi-义项 matching", () => {
    expect(normalizeZhMeaningForPractice("用功。")).toBe(normalizeZhMeaningForPractice("用功"));
  });
});

describe("extractExampleSegmentForTerm", () => {
  it("returns first segment containing term split by sentence boundary", () => {
    const s = extractExampleSegmentForTerm("私は学生です。彼も学生です。", "学生");
    expect(s).toContain("学生");
    expect(s).toContain("私は");
  });

  it("respects newlines as delimiters", () => {
    const s = extractExampleSegmentForTerm("一行目。\n私は学生です", "学生");
    expect(s).toContain("学生");
  });

  it("returns empty when term not found", () => {
    expect(extractExampleSegmentForTerm("今日はいい天気。", "学生")).toBe("");
  });

  it("truncates long segments", () => {
    const long = `${"あ".repeat(100)}学生${"い".repeat(100)}`;
    const s = extractExampleSegmentForTerm(long, "学生");
    expect(s.length).toBeLessThanOrEqual(82);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("lessonAuthor helpers", () => {
  it("lessonAuthorForSave maps blank to fallback", () => {
    expect(lessonAuthorForSave("")).toBe("著者不明");
    expect(lessonAuthorForSave("  ")).toBe("著者不明");
    expect(lessonAuthorForSave("夏目")).toBe("夏目");
  });

  it("lessonAuthorInputValue hides fallback for editing", () => {
    expect(lessonAuthorInputValue("著者不明")).toBe("");
    expect(lessonAuthorInputValue(undefined)).toBe("");
  });

  it("lessonAuthorDisplay always shows readable author", () => {
    expect(lessonAuthorDisplay("")).toBe("著者不明");
    expect(lessonAuthorDisplay("村上")).toBe("村上");
  });
});

describe("splitLessonIntoSentences", () => {
  it("splits on newline and period", () => {
    const s = splitLessonIntoSentences("A句。\nB句");
    expect(s).toEqual(["A句", "B句"]);
  });
});

describe("splitLessonIntoSentenceSpans + zhHintForSentenceSpan", () => {
  it("maps span to line translations", () => {
    const content = "今日はいい。\n明日もいい。";
    const spans = splitLessonIntoSentenceSpans(content);
    expect(spans.map((s) => s.jp)).toEqual(["今日はいい", "明日もいい"]);
    const lineZh = ["今天好", "明天也好"];
    expect(zhHintForSentenceSpan(content, lineZh, spans[0]!.start, spans[0]!.end)).toBe("今天好");
    expect(zhHintForSentenceSpan(content, lineZh, spans[1]!.start, spans[1]!.end)).toBe("明天也好");
  });
});

describe("parseJsonObject", () => {
  it("parses fenced json", () => {
    const o = parseJsonObject('```json\n{"a":1}\n```');
    expect(o).toEqual({ a: 1 });
  });
});

describe("buildGrammarPromptFromSelection", () => {
  it("replaces selected span with ___ in first matching clause", () => {
    expect(buildGrammarPromptFromSelection("私は学生です。彼は先生です。", "学生")).toBe("私は___です");
  });

  it("uses newline as clause boundary", () => {
    expect(buildGrammarPromptFromSelection("一行。\n私は学生です", "学生")).toBe("私は___です");
  });

  it("returns null when selection already has blank marker", () => {
    expect(buildGrammarPromptFromSelection("私は学生です。", "学生___")).toBe(null);
  });

  it("returns null when term not in any clause", () => {
    expect(buildGrammarPromptFromSelection("今日はいい天気。", "学生")).toBe(null);
  });
});

describe("parseSrtToVideoCues", () => {
  it("parses srt blocks into ordered cues", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,500
おはよう。

2
00:00:04,000 --> 00:00:05,000
こんにちは。`;
    const cues = parseSrtToVideoCues(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.startSec).toBe(1);
    expect(cues[0]?.endSec).toBe(3.5);
    expect(cues[1]?.text).toBe("こんにちは。");
  });

  it("skips malformed blocks", () => {
    const srt = `1
bad --> line
xxx`;
    expect(parseSrtToVideoCues(srt)).toEqual([]);
  });
});

describe("parseTimestampedTranscriptToVideoCues", () => {
  it("parses (m:ss) transcript blocks", () => {
    const raw = "(0:07) こんにちは。 (0:16) 次の文です。";
    const cues = parseTimestampedTranscriptToVideoCues(raw);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.startSec).toBe(7);
    expect(cues[0]?.endSec).toBe(16);
    expect(cues[0]?.text).toContain("こんにちは");
  });

  it("returns empty when no timestamp marker", () => {
    expect(parseTimestampedTranscriptToVideoCues("ただの文本")).toEqual([]);
  });
});
