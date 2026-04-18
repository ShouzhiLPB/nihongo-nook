/**
 * 「统计」页 UI 偏好：与练习数据无关，写入 localStorage 以便下次打开保留。
 */
import type { StatsPastGranularity, StatsPastRangePreset, StatsPastTailPreset, StatsPastViewMode } from "./statsAggregation";

export const LS_STATS_PAST_RANGE = "jpLearn_statsPastRange";
export const LS_STATS_PAST_TAIL = "jpLearn_statsPastTail";
export const LS_STATS_PAST_GRANULARITY = "jpLearn_statsPastGranularity";
export const LS_STATS_PAST_VIEW_MODE = "jpLearn_statsPastViewMode";
export const LS_STATS_FUTURE_CUMULATIVE = "jpLearn_statsFutureShowCumulative";

export type StatsTabPrefsParsed = {
  pastRange?: StatsPastRangePreset;
  pastTail?: StatsPastTailPreset;
  pastGranularity?: StatsPastGranularity;
  pastViewMode?: StatsPastViewMode;
  futureShowCumulative?: boolean;
};

const PAST_RANGES: readonly StatsPastRangePreset[] = [
  "today",
  "d7",
  "d14",
  "d30",
  "d60",
  "d90",
  "allRecorded",
];

export function parseStatsPastRange(raw: string | null): StatsPastRangePreset | null {
  const v = raw?.trim();
  return v && (PAST_RANGES as readonly string[]).includes(v) ? (v as StatsPastRangePreset) : null;
}

export function parseStatsPastTail(raw: string | null): StatsPastTailPreset | null {
  const v = raw?.trim();
  if (v === "all") return "all";
  const n = Number(v);
  if (n === 30 || n === 60 || n === 90 || n === 180) return n;
  return null;
}

export function parseStatsPastGranularity(raw: string | null): StatsPastGranularity | null {
  const v = raw?.trim();
  return v === "day" || v === "week" ? v : null;
}

export function parseStatsPastViewMode(raw: string | null): StatsPastViewMode | null {
  const v = raw?.trim();
  return v === "chart" || v === "barsOnly" ? v : null;
}

export function parseStatsFutureShowCumulative(raw: string | null): boolean | null {
  const v = raw?.trim();
  if (v === "1") return true;
  if (v === "0") return false;
  return null;
}

export function readStatsTabPrefsFromStorage(): StatsTabPrefsParsed {
  if (typeof window === "undefined") return {};
  const out: StatsTabPrefsParsed = {};
  const pr = parseStatsPastRange(localStorage.getItem(LS_STATS_PAST_RANGE));
  if (pr) out.pastRange = pr;
  const pt = parseStatsPastTail(localStorage.getItem(LS_STATS_PAST_TAIL));
  if (pt) out.pastTail = pt;
  const pg = parseStatsPastGranularity(localStorage.getItem(LS_STATS_PAST_GRANULARITY));
  if (pg) out.pastGranularity = pg;
  const pv = parseStatsPastViewMode(localStorage.getItem(LS_STATS_PAST_VIEW_MODE));
  if (pv) out.pastViewMode = pv;
  const fc = parseStatsFutureShowCumulative(localStorage.getItem(LS_STATS_FUTURE_CUMULATIVE));
  if (fc !== null) out.futureShowCumulative = fc;
  return out;
}
