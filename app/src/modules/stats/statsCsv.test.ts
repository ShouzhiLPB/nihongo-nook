import { describe, expect, it } from "vitest";
import { buildFutureDueCsv, buildPastRangeCsv, buildStatsSummaryCsv } from "./statsCsv";
import type { FutureChartRow, PastRangeChartRow } from "./statsAggregation";

describe("buildPastRangeCsv", () => {
  it("writes header and rows with CRLF", () => {
    const rows: PastRangeChartRow[] = [
      {
        day: "2026-04-01",
        dayShort: "04-01",
        practiceMarkCorrect: 1,
        practiceMarkWrong: 0,
        practiceMarkEasy: 0,
        dwellLessonReaderSec: 60,
        dwellPracticeSec: 0,
        marksTotal: 1,
        dwellLessonMin: 1,
        dwellPracticeMin: 0,
      },
    ];
    const csv = buildPastRangeCsv(rows);
    expect(csv.startsWith("date,")).toBe(true);
    expect(csv).toContain("2026-04-01,1,0,0,60,0,1,1,0");
    expect(csv.includes("\r\n")).toBe(true);
  });
});

describe("buildFutureDueCsv", () => {
  it("writes cumulative column", () => {
    const rows: FutureChartRow[] = [
      {
        day: "2026-05-01",
        dayShort: "05-01",
        vocab: 1,
        sentence: 0,
        grammar: 0,
        total: 1,
        cumulativeDue: 1,
      },
    ];
    expect(buildFutureDueCsv(rows)).toContain("2026-05-01,1,0,0,1,1");
  });
});

describe("buildStatsSummaryCsv", () => {
  it("writes summary then lessonDue block", () => {
    const csv = buildStatsSummaryCsv({
      exportedAt: "2026-04-17T12:00:00.000Z",
      practiceMarkCorrect: 3,
      practiceMarkWrong: 1,
      practiceMarkEasy: 0,
      dwellLessonReaderSec: 120,
      dwellPracticeSec: 60,
      globalDue: { vocab: 2, sentence: 1, grammar: 0 },
      inventory: {
        lessons: 1,
        vocabCards: 5,
        sentenceTasks: 2,
        grammarTasks: 1,
        lessonNotes: 0,
        favoriteSentences: 0,
      },
      lessonDue: [{ lessonName: "L1", category: "入门", vocab: 2, sentence: 0, grammar: 0, total: 2 }],
    });
    expect(csv).toContain("summary,exportedAt");
    expect(csv).toContain("summary,dueVocabGlobal,2");
    expect(csv).toContain("lessonDue,L1,入门,2,0,0,2");
    expect(csv.includes("\r\n")).toBe(true);
  });
});
