/**
 * 统计页：按日区间汇总、未来 SRS 到期分布（纯函数，可单测）。
 */
import type { AppStatsCounters, AppStatsDayBucket, GrammarTask, SentenceTask, VocabCard } from "@/shared/types";
import {
  addCalendarDaysLocal,
  calendarDayFromIso,
  calendarTodayLocal,
  iterCalendarDaysInclusive,
} from "@/shared/utils";

export type StatsPastRangePreset = "today" | "d7" | "d14" | "d30" | "d60" | "d90" | "allRecorded";

/** 「有记录以来」时限制图中/卡片最多展示尾部多少个日历日（仍可从全量按日键生成后再截断） */
export type StatsPastTailPreset = 30 | 60 | 90 | 180 | "all";

/** chart：柱+停留折线；barsOnly：与未来图相同的堆叠柱（无折线） */
export type StatsPastViewMode = "chart" | "barsOnly";

/** 区间内过往图：按日历日或按自然周（周一至周日）汇总 */
export type StatsPastGranularity = "day" | "week";

/** 未来刷题计划横轴长度（含今日）。最长 SRS 间隔 14 日，故提供 15 日窗口覆盖一整周期。 */
export type StatsFutureHorizonPreset = "d7" | "d15";

export const STATS_FUTURE_HORIZON_OPTIONS: readonly StatsFutureHorizonPreset[] = ["d7", "d15"];

const emptyBucket = (): AppStatsDayBucket => ({
  practiceMarkCorrect: 0,
  practiceMarkWrong: 0,
  practiceMarkEasy: 0,
  dwellLessonReaderSec: 0,
  dwellPracticeSec: 0,
});

export function resolvePastRangeLabel(preset: StatsPastRangePreset): string {
  const m: Record<StatsPastRangePreset, string> = {
    today: "今日",
    d7: "近7日",
    d14: "近14日",
    d30: "近30日",
    d60: "近60日",
    d90: "近90日",
    allRecorded: "有记录以来（按日）",
  };
  return m[preset];
}

/** 返回 [start, end] 日历闭区间（yyyy-MM-dd） */
export function resolvePastRangeBounds(preset: StatsPastRangePreset): { start: string; end: string } {
  const end = calendarTodayLocal();
  if (preset === "today") return { start: end, end };
  if (preset === "d7") return { start: addCalendarDaysLocal(end, -6), end };
  if (preset === "d14") return { start: addCalendarDaysLocal(end, -13), end };
  if (preset === "d30") return { start: addCalendarDaysLocal(end, -29), end };
  if (preset === "d60") return { start: addCalendarDaysLocal(end, -59), end };
  if (preset === "d90") return { start: addCalendarDaysLocal(end, -89), end };
  return { start: "0000-00-00", end };
}

/** 图表用：区间内逐日（含无记录日的零桶）；`allRecorded` 为从最早一条按日键到今日（若无键则空数组） */
export type PastRangeChartRow = {
  day: string;
  /** 用于 X 轴：`MM-DD` */
  dayShort: string;
  practiceMarkCorrect: number;
  practiceMarkWrong: number;
  practiceMarkEasy: number;
  dwellLessonReaderSec: number;
  dwellPracticeSec: number;
  marksTotal: number;
  /** 折线 Y 轴：课文阅读停留（分钟） */
  dwellLessonMin: number;
  /** 折线 Y 轴：练习页停留（分钟） */
  dwellPracticeMin: number;
};

export function buildPastRangeChartSeries(
  stats: AppStatsCounters | undefined,
  preset: StatsPastRangePreset,
): PastRangeChartRow[] {
  const daily = stats?.daily ?? {};
  const end = calendarTodayLocal();
  let days: string[];
  if (preset === "allRecorded") {
    const keys = Object.keys(daily).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && k <= end).sort();
    if (keys.length === 0) return [];
    const start = keys[0]!;
    days = iterCalendarDaysInclusive(start, end);
  } else {
    const { start } = resolvePastRangeBounds(preset);
    days = iterCalendarDaysInclusive(start, end);
  }
  return days.map((day) => {
    const b = daily[day] ?? emptyBucket();
    const marksTotal = b.practiceMarkCorrect + b.practiceMarkWrong + b.practiceMarkEasy;
    return {
      day,
      dayShort: day.slice(5),
      practiceMarkCorrect: b.practiceMarkCorrect,
      practiceMarkWrong: b.practiceMarkWrong,
      practiceMarkEasy: b.practiceMarkEasy,
      dwellLessonReaderSec: b.dwellLessonReaderSec,
      dwellPracticeSec: b.dwellPracticeSec,
      marksTotal,
      dwellLessonMin: b.dwellLessonReaderSec / 60,
      dwellPracticeMin: b.dwellPracticeSec / 60,
    };
  });
}

/** 「有记录以来」截断尾部 N 个日历日用于图表/卡片；其它 preset 原样返回 */
export function applyPastTailSlice(
  rows: PastRangeChartRow[],
  preset: StatsPastRangePreset,
  tail: StatsPastTailPreset,
): PastRangeChartRow[] {
  if (preset !== "allRecorded" || tail === "all") return rows;
  if (rows.length <= tail) return rows;
  return rows.slice(-tail);
}

/** 将图表行聚合为与 `AppStatsDayBucket` 同结构的区间合计（与当前图中数据一致） */
export function sumPastChartRows(rows: PastRangeChartRow[]): AppStatsDayBucket {
  return rows.reduce<AppStatsDayBucket>(
    (acc, r) => ({
      practiceMarkCorrect: acc.practiceMarkCorrect + r.practiceMarkCorrect,
      practiceMarkWrong: acc.practiceMarkWrong + r.practiceMarkWrong,
      practiceMarkEasy: acc.practiceMarkEasy + r.practiceMarkEasy,
      dwellLessonReaderSec: acc.dwellLessonReaderSec + r.dwellLessonReaderSec,
      dwellPracticeSec: acc.dwellPracticeSec + r.dwellPracticeSec,
    }),
    emptyBucket(),
  );
}

export function resolvePastTailLabel(tail: StatsPastTailPreset): string {
  if (tail === "all") return "全部日历日";
  return `图中最近${tail}天`;
}

/** 含 `day` 的日历周之周一（本地时区，`yyyy-MM-dd`） */
export function mondayOfCalendarWeek(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const wd = dt.getDay();
  const delta = wd === 0 ? -6 : 1 - wd;
  dt.setDate(dt.getDate() + delta);
  return calendarTodayLocal(dt);
}

/** 将按日行按「周一至周日」合并为周桶（横轴更疏，适合长区间） */
export function aggregatePastChartRowsByWeek(rows: PastRangeChartRow[]): PastRangeChartRow[] {
  if (rows.length === 0) return [];
  const byMon = new Map<string, PastRangeChartRow[]>();
  for (const r of rows) {
    const mon = mondayOfCalendarWeek(r.day);
    const arr = byMon.get(mon) ?? [];
    arr.push(r);
    byMon.set(mon, arr);
  }
  const mondays = [...byMon.keys()].sort();
  return mondays.map((mon) => {
    const chunk = byMon.get(mon)!;
    chunk.sort((a, b) => a.day.localeCompare(b.day));
    const first = chunk[0]!;
    const last = chunk[chunk.length - 1]!;
    const sum = sumPastChartRows(chunk);
    const marksTotal = sum.practiceMarkCorrect + sum.practiceMarkWrong + sum.practiceMarkEasy;
    return {
      day: `${first.day}~${last.day}`,
      dayShort: `${first.day.slice(5)}~${last.day.slice(5)}`,
      practiceMarkCorrect: sum.practiceMarkCorrect,
      practiceMarkWrong: sum.practiceMarkWrong,
      practiceMarkEasy: sum.practiceMarkEasy,
      dwellLessonReaderSec: sum.dwellLessonReaderSec,
      dwellPracticeSec: sum.dwellPracticeSec,
      marksTotal,
      dwellLessonMin: sum.dwellLessonReaderSec / 60,
      dwellPracticeMin: sum.dwellPracticeSec / 60,
    };
  });
}

/** 区间内按日桶求和；`allRecorded` 则对 `stats.daily` 中所有 ≤end 的键求和 */
export function sumDailyBucketsInRange(stats: AppStatsCounters | undefined, preset: StatsPastRangePreset): AppStatsDayBucket {
  const daily = stats?.daily ?? {};
  const { start, end } = resolvePastRangeBounds(preset);
  const days =
    preset === "allRecorded"
      ? Object.keys(daily)
          .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && k <= end)
          .sort()
      : iterCalendarDaysInclusive(start, end);
  return days.reduce<AppStatsDayBucket>((acc, day) => {
    const b = daily[day];
    if (!b) return acc;
    return {
      practiceMarkCorrect: acc.practiceMarkCorrect + b.practiceMarkCorrect,
      practiceMarkWrong: acc.practiceMarkWrong + b.practiceMarkWrong,
      practiceMarkEasy: acc.practiceMarkEasy + b.practiceMarkEasy,
      dwellLessonReaderSec: acc.dwellLessonReaderSec + b.dwellLessonReaderSec,
      dwellPracticeSec: acc.dwellPracticeSec + b.dwellPracticeSec,
    };
  }, emptyBucket());
}

function scheduledCalendarDay(x: { nextReviewDay?: string; reviewGraduated?: boolean; createdAt: string }): string {
  return x.nextReviewDay ?? calendarDayFromIso(x.createdAt);
}

/** 某一日历日「首次排期」到期的条目数（未毕业且排期日等于 day，不含更早的逾期未刷） */
export function countScheduledOnCalendarDay<
  T extends { nextReviewDay?: string; reviewGraduated?: boolean; createdAt: string },
>(items: T[], day: string): number {
  return items.filter((x) => !x.reviewGraduated && scheduledCalendarDay(x) === day).length;
}

/**
 * 截至日历日 `day` 结束时仍欠刷的条数（未毕业且排期日 ≤ day）。
 * 与 `filterDueReviewItems(..., day)` 计数一致；用于「未来计划」**今日**行，含已过期未毕业。
 */
export function countDueThroughCalendarDay<
  T extends { nextReviewDay?: string; reviewGraduated?: boolean; createdAt: string },
>(items: T[], day: string): number {
  return items.filter((x) => {
    if (x.reviewGraduated) return false;
    return scheduledCalendarDay(x) <= day;
  }).length;
}

export function resolveFutureHorizonLabel(preset: StatsFutureHorizonPreset): string {
  return preset === "d7" ? "近 7 天" : "近 15 天";
}

/**
 * 自今日起连续 horizon 个日历日（含今日）。
 * **今日**行：与练习「今日待刷」一致，计「排期日 ≤ 今日」的未毕业条数（含逾期未刷）。
 * **明日及以后**：仅计排期日**恰好**落在该日的条数（首次落在该日的到期）。
 */
export function aggregateFutureFirstDueByDay(
  vocab: VocabCard[],
  sentences: SentenceTask[],
  grammars: GrammarTask[],
  horizon: StatsFutureHorizonPreset,
): {
  rows: { day: string; vocab: number; sentence: number; grammar: number; total: number }[];
  sumVocab: number;
  sumSentence: number;
  sumGrammar: number;
  sumTotal: number;
} {
  const today = calendarTodayLocal();
  const n = horizon === "d7" ? 7 : 15;
  const rows: { day: string; vocab: number; sentence: number; grammar: number; total: number }[] = [];
  let sumVocab = 0;
  let sumSentence = 0;
  let sumGrammar = 0;
  for (let i = 0; i < n; i++) {
    const day = addCalendarDaysLocal(today, i);
    const isToday = day === today;
    const v = isToday ? countDueThroughCalendarDay(vocab, day) : countScheduledOnCalendarDay(vocab, day);
    const s = isToday ? countDueThroughCalendarDay(sentences, day) : countScheduledOnCalendarDay(sentences, day);
    const g = isToday ? countDueThroughCalendarDay(grammars, day) : countScheduledOnCalendarDay(grammars, day);
    const total = v + s + g;
    rows.push({ day, vocab: v, sentence: s, grammar: g, total });
    sumVocab += v;
    sumSentence += s;
    sumGrammar += g;
  }
  return {
    rows,
    sumVocab,
    sumSentence,
    sumGrammar,
    sumTotal: sumVocab + sumSentence + sumGrammar,
  };
}

export type FutureChartRow = {
  day: string;
  dayShort: string;
  vocab: number;
  sentence: number;
  grammar: number;
  total: number;
  /** 窗口内从首日起至当日的累计柱高（今日行含逾期未刷，与「仅首次排期日」的明日及以后不同） */
  cumulativeDue: number;
};

export function buildFutureChartRows(
  rows: { day: string; vocab: number; sentence: number; grammar: number; total: number }[],
): FutureChartRow[] {
  let cum = 0;
  return rows.map((r) => {
    cum += r.total;
    return {
      ...r,
      dayShort: r.day.slice(5),
      cumulativeDue: cum,
    };
  });
}
