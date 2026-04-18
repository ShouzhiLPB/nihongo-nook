/**
 * 学习数据规范化与导入导出。
 * 持久化读写请用 `localDeviceStore.ts`（IndexedDB + localStorage）。
 */
import { finalizeVocabDistractors, finalizeVocabZhDistractors } from "@/modules/learning/lessonService";
import { inferSrsDefaults } from "@/modules/srs/scheduler";
import type { AppData, AppStatsCounters, AppStatsDayBucket, GrammarTask, Lesson, SentenceTask, VocabCard } from "@/shared/types";
import { addCalendarDaysLocal, alignLineTranslations, calendarTodayLocal } from "@/shared/utils";
import { dedupeMediaInAppData } from "@/modules/storage/mediaDedupe";

/** 按日桶最多保留的日历跨度（避免备份无限膨胀） */
const STATS_DAILY_RETENTION_DAYS = 400;

function hasSrsCalendar(c: { nextReviewDay?: string }): boolean {
  return typeof c.nextReviewDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.nextReviewDay);
}

function ensureVocabSrs(c: VocabCard): VocabCard {
  if (hasSrsCalendar(c)) return c;
  return { ...c, ...inferSrsDefaults(c) };
}

function ensureSentenceSrs(t: SentenceTask): SentenceTask {
  if (hasSrsCalendar(t)) return t;
  return { ...t, ...inferSrsDefaults(t) };
}

function ensureGrammarSrs(g: GrammarTask): GrammarTask {
  if (hasSrsCalendar(g)) return g;
  return { ...g, ...inferSrsDefaults(g) };
}

function normalizeVocabCards(cards: VocabCard[]): VocabCard[] {
  const base = (cards ?? []).map((c) => ({
    ...c,
    vocabDistractors: Array.isArray(c.vocabDistractors) ? c.vocabDistractors : [],
    vocabZhDistractors: Array.isArray(c.vocabZhDistractors) ? c.vocabZhDistractors : [],
  }));
  const termsByLesson = new Map<string, string[]>();
  for (const c of base) {
    const t = c.term.trim();
    if (!t) continue;
    const arr = termsByLesson.get(c.lessonId) ?? [];
    if (!arr.includes(t)) arr.push(t);
    termsByLesson.set(c.lessonId, arr);
  }
  const jpFilled = base.map((c) => {
    const siblings = (termsByLesson.get(c.lessonId) ?? []).filter((t) => t !== c.term.trim());
    const triple = finalizeVocabDistractors(c.term, c.vocabDistractors.length ? c.vocabDistractors : undefined, siblings);
    return { ...c, vocabDistractors: [...triple] };
  });

  const zhsByLesson = new Map<string, string[]>();
  for (const c of jpFilled) {
    const z = c.meanings[0]?.zh?.trim() ?? "";
    if (!z) continue;
    const arr = zhsByLesson.get(c.lessonId) ?? [];
    if (!arr.includes(z)) arr.push(z);
    zhsByLesson.set(c.lessonId, arr);
  }
  return jpFilled.map((c) => {
    const correctZh = c.meanings[0]?.zh?.trim() || "—";
    const pool = (zhsByLesson.get(c.lessonId) ?? []).filter((z) => z !== correctZh);
    const tripleZh = finalizeVocabZhDistractors(
      correctZh,
      c.vocabZhDistractors.length ? c.vocabZhDistractors : undefined,
      pool,
    );
    return ensureVocabSrs({ ...c, vocabZhDistractors: [...tripleZh] });
  });
}

const defaultStats: AppStatsCounters = {
  practiceMarkCorrect: 0,
  practiceMarkWrong: 0,
  practiceMarkEasy: 0,
  dwellLessonReaderSec: 0,
  dwellPracticeSec: 0,
  daily: {},
};

const defaultData: AppData = {
  lessons: [],
  vocabCards: [],
  sentenceTasks: [],
  grammarTasks: [],
  chatSessions: [],
  lessonNotes: [],
  favoriteSentences: [],
  stats: { ...defaultStats },
};

function safeNonNegativeInt(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

function emptyDayBucket(): AppStatsDayBucket {
  return {
    practiceMarkCorrect: 0,
    practiceMarkWrong: 0,
    practiceMarkEasy: 0,
    dwellLessonReaderSec: 0,
    dwellPracticeSec: 0,
  };
}

function normalizeDayBucket(raw: unknown): AppStatsDayBucket {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyDayBucket();
  const o = raw as Record<string, unknown>;
  return {
    practiceMarkCorrect: safeNonNegativeInt(o.practiceMarkCorrect),
    practiceMarkWrong: safeNonNegativeInt(o.practiceMarkWrong),
    practiceMarkEasy: safeNonNegativeInt(o.practiceMarkEasy),
    dwellLessonReaderSec: safeNonNegativeInt(o.dwellLessonReaderSec),
    dwellPracticeSec: safeNonNegativeInt(o.dwellPracticeSec),
  };
}

function pruneDailyMap(daily: Record<string, AppStatsDayBucket>, today: string): Record<string, AppStatsDayBucket> {
  const cutoff = addCalendarDaysLocal(today, -STATS_DAILY_RETENTION_DAYS);
  const out: Record<string, AppStatsDayBucket> = {};
  for (const [k, v] of Object.entries(daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    if (k < cutoff || k > today) continue;
    out[k] = v;
  }
  return out;
}

function normalizeStats(s: AppStatsCounters | undefined, today: string = calendarTodayLocal()): AppStatsCounters {
  const dailyIn =
    s?.daily && typeof s.daily === "object" && !Array.isArray(s.daily) ? (s.daily as Record<string, unknown>) : {};
  const daily: Record<string, AppStatsDayBucket> = {};
  for (const [k, v] of Object.entries(dailyIn)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    if (k > today) continue;
    daily[k] = normalizeDayBucket(v);
  }
  return {
    practiceMarkCorrect: safeNonNegativeInt(s?.practiceMarkCorrect),
    practiceMarkWrong: safeNonNegativeInt(s?.practiceMarkWrong),
    practiceMarkEasy: safeNonNegativeInt(s?.practiceMarkEasy),
    dwellLessonReaderSec: safeNonNegativeInt(s?.dwellLessonReaderSec),
    dwellPracticeSec: safeNonNegativeInt(s?.dwellPracticeSec),
    daily: pruneDailyMap(daily, today),
  };
}

/** 练习记一次对/错/太简单时累加计数 */
export function bumpPracticeMarkStats(prev: AppStatsCounters | undefined, review: "correct" | "wrong" | "easy"): AppStatsCounters {
  const today = calendarTodayLocal();
  const s = normalizeStats(prev, today);
  const d0 = normalizeDayBucket(s.daily?.[today]);
  const dInc: AppStatsDayBucket =
    review === "correct"
      ? { practiceMarkCorrect: 1, practiceMarkWrong: 0, practiceMarkEasy: 0, dwellLessonReaderSec: 0, dwellPracticeSec: 0 }
      : review === "wrong"
        ? { practiceMarkCorrect: 0, practiceMarkWrong: 1, practiceMarkEasy: 0, dwellLessonReaderSec: 0, dwellPracticeSec: 0 }
        : { practiceMarkCorrect: 0, practiceMarkWrong: 0, practiceMarkEasy: 1, dwellLessonReaderSec: 0, dwellPracticeSec: 0 };
  const daily = pruneDailyMap(
    {
      ...s.daily,
      [today]: {
        practiceMarkCorrect: d0.practiceMarkCorrect + dInc.practiceMarkCorrect,
        practiceMarkWrong: d0.practiceMarkWrong + dInc.practiceMarkWrong,
        practiceMarkEasy: d0.practiceMarkEasy + dInc.practiceMarkEasy,
        dwellLessonReaderSec: d0.dwellLessonReaderSec,
        dwellPracticeSec: d0.dwellPracticeSec,
      },
    },
    today,
  );
  if (review === "correct") return { ...s, practiceMarkCorrect: s.practiceMarkCorrect + 1, daily };
  if (review === "wrong") return { ...s, practiceMarkWrong: s.practiceMarkWrong + 1, daily };
  return { ...s, practiceMarkEasy: s.practiceMarkEasy + 1, daily };
}

/** 将前台停留秒数合并进 stats（与 bump 独立调用） */
export function mergeDwellSecondsIntoStats(
  prev: AppStatsCounters | undefined,
  delta: { lessonReaderSec?: number; practiceSec?: number },
): AppStatsCounters {
  const today = calendarTodayLocal();
  const s = normalizeStats(prev, today);
  const lr = safeNonNegativeInt(delta.lessonReaderSec ?? 0);
  const pr = safeNonNegativeInt(delta.practiceSec ?? 0);
  const d0 = normalizeDayBucket(s.daily?.[today]);
  const daily = pruneDailyMap(
    {
      ...s.daily,
      [today]: {
        ...d0,
        dwellLessonReaderSec: d0.dwellLessonReaderSec + lr,
        dwellPracticeSec: d0.dwellPracticeSec + pr,
      },
    },
    today,
  );
  return {
    ...s,
    dwellLessonReaderSec: safeNonNegativeInt((s.dwellLessonReaderSec ?? 0) + lr),
    dwellPracticeSec: safeNonNegativeInt((s.dwellPracticeSec ?? 0) + pr),
    daily,
  };
}

/**
 * 早期唯一「内嵌 data / mediaLibrary 大视频」示例：若全库仅一条视频课文仍为非 http 源，则回落为固定 YouTube 观看链（用户确认），并去掉对应 mediaLibrary 条目以减轻云同步体积。
 */
export const LEGACY_SINGLE_VIDEO_LESSON_FALLBACK_URL =
  "https://www.youtube.com/watch?v=CpyumMoe9Hc";

function lessonUsesNonHttpVideoSource(l: Lesson): boolean {
  if (l.lessonKind !== "video" || l.trashedAt) return false;
  const url = (l.videoSourceUrl ?? "").trim();
  if (/^https?:\/\//i.test(url)) return false;
  if (url.startsWith("data:")) return true;
  if (l.videoSourceMediaKey) return true;
  return false;
}

/** @internal 由 normalizeAppData 调用；导出便于单测 */
/**
 * 删除「课文 id 已不存在」的附属数据（词卡/题/聊天/笔记/收藏句），避免删课后仍留孤儿、合并后 payload 膨胀。
 * 与 §17.6 云轮次 2「防删课误留孤儿」对齐（客户端规范化口径；仍随整包 / RPC 子树上云）。
 */
export function pruneOrphanLessonScopedEntries(data: AppData): AppData {
  const lessonIds = new Set(data.lessons.map((l) => l.id));
  return {
    ...data,
    vocabCards: data.vocabCards.filter((c) => lessonIds.has(c.lessonId)),
    sentenceTasks: data.sentenceTasks.filter((t) => lessonIds.has(t.lessonId)),
    grammarTasks: data.grammarTasks.filter((g) => lessonIds.has(g.lessonId)),
    chatSessions: (data.chatSessions ?? []).filter((s) => lessonIds.has(s.lessonId)),
    lessonNotes: (data.lessonNotes ?? []).filter((n) => lessonIds.has(n.lessonId)),
    favoriteSentences: (data.favoriteSentences ?? []).filter((f) => lessonIds.has(f.lessonId)),
  };
}

export function migrateLegacySingleEmbeddedVideoLesson(
  lessons: Lesson[],
  mediaLibrary: AppData["mediaLibrary"] | undefined,
): { lessons: Lesson[]; mediaLibrary: AppData["mediaLibrary"] | undefined } {
  const badIdx = lessons.map((l, i) => (lessonUsesNonHttpVideoSource(l) ? i : -1)).filter((i) => i >= 0);
  if (badIdx.length !== 1) {
    return { lessons, mediaLibrary };
  }
  const i = badIdx[0]!;
  const l = lessons[i]!;
  const next = [...lessons];
  const key = l.videoSourceMediaKey;
  let ml = mediaLibrary;
  if (key && ml?.[key]) {
    ml = { ...ml };
    delete ml[key];
    if (Object.keys(ml).length === 0) ml = undefined;
  }
  next[i] = {
    ...l,
    videoSourceUrl: LEGACY_SINGLE_VIDEO_LESSON_FALLBACK_URL,
    videoSourceMediaKey: undefined,
  };
  return { lessons: next, mediaLibrary: ml };
}

export function normalizeAppData(raw: AppData): AppData {
  const core: AppData = {
    ...defaultData,
    ...raw,
    stats: normalizeStats(raw.stats),
    favoriteSentences: Array.isArray(raw.favoriteSentences) ? raw.favoriteSentences : [],
    vocabCards: normalizeVocabCards(raw.vocabCards ?? []),
    sentenceTasks: (raw.sentenceTasks ?? []).map((t) =>
      ensureSentenceSrs({
        ...t,
        sourceType: t.sourceType === "listening" ? "listening" : "translation",
        teachingNote: typeof t.teachingNote === "string" ? t.teachingNote : undefined,
      }),
    ),
    grammarTasks: (raw.grammarTasks ?? []).map(ensureGrammarSrs),
    lessons: (raw.lessons ?? []).map((lesson) => {
      const { skipAutoCoverAfterFullTranslate: _legacySkipCover, ...lessonRest } = lesson as Lesson & {
        skipAutoCoverAfterFullTranslate?: unknown;
      };
      const trashRaw = lessonRest.trashedAt;
      const trashedAt =
        typeof trashRaw === "string" && trashRaw.trim().length > 0 ? trashRaw.trim() : undefined;
      const base = {
        ...lessonRest,
        category: lessonRest.category?.trim() || "未分类",
        updatedAt: lessonRest.updatedAt?.trim() || lessonRest.createdAt,
        lessonKind: (lessonRest.lessonKind === "video" ? "video" : "text") as "text" | "video",
        trashedAt,
      };
      if (!base.lineTranslations?.length) {
        return base;
      }
      return {
        ...base,
        lineTranslations: alignLineTranslations(base.content, base.lineTranslations),
      };
    }),
    lessonNotes: (Array.isArray(raw.lessonNotes) ? raw.lessonNotes : []).map((n) => ({
      ...n,
      title: typeof n.title === "string" ? n.title : undefined,
      lineIndex: Number.isFinite(n.lineIndex as number) ? (n.lineIndex as number) : undefined,
    })),
  };
  const migrated = migrateLegacySingleEmbeddedVideoLesson(core.lessons, core.mediaLibrary);
  core.lessons = migrated.lessons;
  core.mediaLibrary = migrated.mediaLibrary;
  return dedupeMediaInAppData(pruneOrphanLessonScopedEntries(core));
}

export function exportData(data: AppData): string {
  return JSON.stringify(data, null, 2);
}

export function importData(raw: string): AppData {
  const parsed = JSON.parse(raw) as AppData;
  return normalizeAppData(parsed);
}

