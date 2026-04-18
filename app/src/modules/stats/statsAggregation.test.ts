import { afterEach, describe, expect, it, vi } from "vitest";
import type { GrammarTask, SentenceTask, VocabCard } from "@/shared/types";
import { calendarTodayLocal } from "@/shared/utils";
import { filterDueReviewItems } from "@/modules/srs/scheduler";
import {
  aggregateFutureFirstDueByDay,
  aggregatePastChartRowsByWeek,
  applyPastTailSlice,
  buildFutureChartRows,
  buildPastRangeChartSeries,
  countDueThroughCalendarDay,
  countScheduledOnCalendarDay,
  mondayOfCalendarWeek,
  sumDailyBucketsInRange,
  sumPastChartRows,
  type PastRangeChartRow,
} from "./statsAggregation";

describe("sumDailyBucketsInRange", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sums inclusive calendar range", () => {
    const stats = {
      practiceMarkCorrect: 99,
      practiceMarkWrong: 0,
      practiceMarkEasy: 0,
      dwellLessonReaderSec: 0,
      dwellPracticeSec: 0,
      daily: {
        "2026-04-10": {
          practiceMarkCorrect: 1,
          practiceMarkWrong: 2,
          practiceMarkEasy: 0,
          dwellLessonReaderSec: 10,
          dwellPracticeSec: 5,
        },
        "2026-04-11": {
          practiceMarkCorrect: 3,
          practiceMarkWrong: 0,
          practiceMarkEasy: 1,
          dwellLessonReaderSec: 0,
          dwellPracticeSec: 0,
        },
      },
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 11, 12, 0, 0));
    expect(sumDailyBucketsInRange(stats, "d7")).toEqual({
      practiceMarkCorrect: 4,
      practiceMarkWrong: 2,
      practiceMarkEasy: 1,
      dwellLessonReaderSec: 10,
      dwellPracticeSec: 5,
    });
  });
});

describe("aggregateFutureFirstDueByDay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts items whose scheduled calendar day matches each future day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 10, 12, 0, 0));
    const created = "2026-01-01T00:00:00.000Z";
    const v: VocabCard[] = [
      {
        id: "v1",
        lessonId: "l",
        term: "a",
        kana: "a",
        meanings: [{ zh: "a", example: "" }],
        etymology: "",
        vocabDistractors: ["x", "y", "z"],
        vocabZhDistractors: ["x", "y", "z"],
        latestExample: "",
        mastery: 0,
        nextReviewDay: "2026-04-11",
        createdAt: created,
        updatedAt: created,
      },
    ];
    const s: SentenceTask[] = [];
    const g: GrammarTask[] = [];
    const agg = aggregateFutureFirstDueByDay(v, s, g, "d7");
    expect(agg.rows).toHaveLength(7);
    expect(agg.rows[0]?.day).toBe(calendarTodayLocal());
    expect(agg.rows[0]?.vocab).toBe(0);
    expect(agg.rows.find((r) => r.day === "2026-04-11")?.vocab).toBe(1);
    expect(agg.sumTotal).toBeGreaterThanOrEqual(1);
  });

  it("d15 horizon returns 15 calendar rows including today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 10, 12, 0, 0));
    const today = calendarTodayLocal();
    const agg = aggregateFutureFirstDueByDay([], [], [], "d15");
    expect(agg.rows).toHaveLength(15);
    expect(agg.rows[0]?.day).toBe(today);
    expect(agg.rows[14]?.day).toBe("2026-04-24");
  });

  it("today row includes overdue not-yet-graduated items (same count as filterDueReviewItems)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 10, 12, 0, 0));
    const today = calendarTodayLocal();
    const created = "2026-01-01T00:00:00.000Z";
    const baseVocab = (nextReviewDay: string): VocabCard => ({
      id: `v-${nextReviewDay}`,
      lessonId: "l",
      term: "a",
      kana: "a",
      meanings: [{ zh: "a", example: "" }],
      etymology: "",
      vocabDistractors: ["x", "y", "z"],
      vocabZhDistractors: ["x", "y", "z"],
      latestExample: "",
      mastery: 0,
      nextReviewDay,
      createdAt: created,
      updatedAt: created,
    });
    const overdue = baseVocab("2026-04-05");
    const dueTomorrow = baseVocab("2026-04-11");
    dueTomorrow.id = "v-tomorrow";
    const v: VocabCard[] = [overdue, dueTomorrow];
    const agg = aggregateFutureFirstDueByDay(v, [], [], "d7");
    expect(agg.rows[0]?.day).toBe(today);
    expect(agg.rows[0]?.vocab).toBe(filterDueReviewItems(v, today).length);
    expect(agg.rows[0]?.vocab).toBe(1);
    expect(agg.rows.find((r) => r.day === "2026-04-11")?.vocab).toBe(1);
  });
});

describe("countDueThroughCalendarDay", () => {
  it("matches filterDueReviewItems length for same calendar day", () => {
    const created = "2026-01-01T00:00:00.000Z";
    const items: Pick<VocabCard, "nextReviewDay" | "reviewGraduated" | "createdAt">[] = [
      { nextReviewDay: "2026-04-01", reviewGraduated: false, createdAt: created },
      { nextReviewDay: "2026-04-10", reviewGraduated: false, createdAt: created },
      { nextReviewDay: "2026-04-11", reviewGraduated: false, createdAt: created },
      { nextReviewDay: "2026-04-05", reviewGraduated: true, createdAt: created },
    ];
    const day = "2026-04-10";
    expect(countDueThroughCalendarDay(items, day)).toBe(filterDueReviewItems(items as VocabCard[], day).length);
    expect(countDueThroughCalendarDay(items, day)).toBe(2);
  });
});

describe("mondayOfCalendarWeek + aggregatePastChartRowsByWeek", () => {
  it("maps days to Monday buckets and sums", () => {
    expect(mondayOfCalendarWeek("2026-04-08")).toBe("2026-04-06");
    expect(mondayOfCalendarWeek("2026-04-06")).toBe("2026-04-06");
    expect(mondayOfCalendarWeek("2026-04-12")).toBe("2026-04-06");
    const rows: PastRangeChartRow[] = [
      {
        day: "2026-04-07",
        dayShort: "04-07",
        practiceMarkCorrect: 1,
        practiceMarkWrong: 0,
        practiceMarkEasy: 0,
        dwellLessonReaderSec: 60,
        dwellPracticeSec: 60,
        marksTotal: 1,
        dwellLessonMin: 1,
        dwellPracticeMin: 1,
      },
      {
        day: "2026-04-08",
        dayShort: "04-08",
        practiceMarkCorrect: 2,
        practiceMarkWrong: 1,
        practiceMarkEasy: 0,
        dwellLessonReaderSec: 0,
        dwellPracticeSec: 0,
        marksTotal: 3,
        dwellLessonMin: 0,
        dwellPracticeMin: 0,
      },
      {
        day: "2026-04-14",
        dayShort: "04-14",
        practiceMarkCorrect: 0,
        practiceMarkWrong: 0,
        practiceMarkEasy: 1,
        dwellLessonReaderSec: 0,
        dwellPracticeSec: 0,
        marksTotal: 1,
        dwellLessonMin: 0,
        dwellPracticeMin: 0,
      },
    ];
    const w = aggregatePastChartRowsByWeek(rows);
    expect(w).toHaveLength(2);
    expect(w[0]?.practiceMarkCorrect).toBe(3);
    expect(w[0]?.practiceMarkWrong).toBe(1);
    expect(w[0]?.day).toBe("2026-04-07~2026-04-08");
    expect(w[1]?.practiceMarkEasy).toBe(1);
  });
});

describe("buildPastRangeChartSeries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fills missing days with zeros for fixed presets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 3, 12, 0, 0));
    const stats = {
      daily: {
        "2026-04-01": {
          practiceMarkCorrect: 1,
          practiceMarkWrong: 0,
          practiceMarkEasy: 0,
          dwellLessonReaderSec: 60,
          dwellPracticeSec: 120,
        },
      },
    };
    const rows = buildPastRangeChartSeries(stats, "d7");
    expect(rows.length).toBe(7);
    expect(rows[0]?.day).toBe("2026-03-28");
    expect(rows[rows.length - 1]?.day).toBe("2026-04-03");
    const apr1 = rows.find((r) => r.day === "2026-04-01");
    expect(apr1?.practiceMarkCorrect).toBe(1);
    expect(apr1?.dwellLessonMin).toBe(1);
    expect(apr1?.dwellPracticeMin).toBe(2);
    const gap = rows.find((r) => r.day === "2026-04-02");
    expect(gap?.marksTotal).toBe(0);
  });
});

describe("applyPastTailSlice + sumPastChartRows", () => {
  it("slices allRecorded tail and sums visible rows", () => {
    const rows: PastRangeChartRow[] = [
      {
        day: "2026-01-01",
        dayShort: "01-01",
        practiceMarkCorrect: 1,
        practiceMarkWrong: 0,
        practiceMarkEasy: 0,
        dwellLessonReaderSec: 0,
        dwellPracticeSec: 0,
        marksTotal: 1,
        dwellLessonMin: 0,
        dwellPracticeMin: 0,
      },
      {
        day: "2026-01-02",
        dayShort: "01-02",
        practiceMarkCorrect: 2,
        practiceMarkWrong: 1,
        practiceMarkEasy: 0,
        dwellLessonReaderSec: 60,
        dwellPracticeSec: 0,
        marksTotal: 3,
        dwellLessonMin: 1,
        dwellPracticeMin: 0,
      },
    ];
    const sliced = applyPastTailSlice(rows, "allRecorded", 1);
    expect(sliced).toHaveLength(1);
    expect(sliced[0]?.day).toBe("2026-01-02");
    expect(sumPastChartRows(sliced).practiceMarkCorrect).toBe(2);
    expect(applyPastTailSlice(rows, "d7", 1)).toHaveLength(2);
  });
});

describe("buildFutureChartRows", () => {
  it("adds running cumulativeDue", () => {
    const rows = buildFutureChartRows([
      { day: "2026-01-02", vocab: 1, sentence: 0, grammar: 0, total: 1 },
      { day: "2026-01-03", vocab: 2, sentence: 0, grammar: 1, total: 3 },
    ]);
    expect(rows[0]?.cumulativeDue).toBe(1);
    expect(rows[1]?.cumulativeDue).toBe(4);
  });
});

describe("countScheduledOnCalendarDay", () => {
  it("uses nextReviewDay when present", () => {
    const items: Pick<SentenceTask, "nextReviewDay" | "reviewGraduated" | "createdAt">[] = [
      { nextReviewDay: "2026-05-01", reviewGraduated: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(countScheduledOnCalendarDay(items, "2026-05-01")).toBe(1);
    expect(countScheduledOnCalendarDay(items, "2026-05-02")).toBe(0);
  });

  it("excludes graduated", () => {
    const items: Pick<VocabCard, "nextReviewDay" | "reviewGraduated" | "createdAt">[] = [
      { nextReviewDay: "2026-05-01", reviewGraduated: true, createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(countScheduledOnCalendarDay(items, "2026-05-01")).toBe(0);
  });
});
