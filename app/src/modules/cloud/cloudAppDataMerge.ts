import { normalizeAppData } from "@/modules/storage/dataStore";
import type { MergeSliceKey } from "@/modules/cloud/cloudMergePreview";
import type {
  AppData,
  AppMediaResource,
  AppStatsCounters,
  AppStatsDayBucket,
  ChatSession,
  GrammarTask,
  Lesson,
  LessonFavoriteSentence,
  LessonNote,
  SentenceTask,
  VocabCard,
} from "@/shared/types";

/** 同 id 冲突时强制保留一侧；未声明的 id 仍按时间戳较新保留整条。 */
export type MergeConflictPicks = Partial<Record<MergeSliceKey, Record<string, "local" | "remote">>>;

function revisionMs(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** 用于「较新者保留」：优先 `updatedAt`，否则 `createdAt`。 */
function entityRevisionMs(x: { createdAt?: string; updatedAt?: string }): number {
  return Math.max(revisionMs(x.updatedAt), revisionMs(x.createdAt));
}

function mergeIdentifiedByNewer<T extends { id: string }>(
  local: T[],
  remote: T[],
  revision: (x: T) => number,
  picks: Record<string, "local" | "remote"> | undefined,
): T[] {
  const map = new Map<string, T>();
  for (const r of remote) map.set(r.id, r);
  for (const l of local) {
    const r = map.get(l.id);
    if (!r) {
      map.set(l.id, l);
      continue;
    }
    const side = picks?.[l.id];
    if (side === "local") {
      map.set(l.id, l);
      continue;
    }
    if (side === "remote") {
      map.set(l.id, r);
      continue;
    }
    const tl = revision(l);
    const tr = revision(r);
    map.set(l.id, tl >= tr ? l : r);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);
}

function mergeStats(local: AppStatsCounters | undefined, remote: AppStatsCounters | undefined): AppStatsCounters {
  const l = local ?? { practiceMarkCorrect: 0, practiceMarkWrong: 0, practiceMarkEasy: 0 };
  const r = remote ?? { practiceMarkCorrect: 0, practiceMarkWrong: 0, practiceMarkEasy: 0 };
  const ld = l.daily ?? {};
  const rd = r.daily ?? {};
  const dayKeys = new Set([...Object.keys(ld), ...Object.keys(rd)]);
  let daily: Record<string, AppStatsDayBucket> | undefined;
  if (dayKeys.size > 0) {
    daily = {};
    for (const k of dayKeys) {
      const a = ld[k];
      const b = rd[k];
      daily[k] = {
        practiceMarkCorrect: (a?.practiceMarkCorrect ?? 0) + (b?.practiceMarkCorrect ?? 0),
        practiceMarkWrong: (a?.practiceMarkWrong ?? 0) + (b?.practiceMarkWrong ?? 0),
        practiceMarkEasy: (a?.practiceMarkEasy ?? 0) + (b?.practiceMarkEasy ?? 0),
        dwellLessonReaderSec: (a?.dwellLessonReaderSec ?? 0) + (b?.dwellLessonReaderSec ?? 0),
        dwellPracticeSec: (a?.dwellPracticeSec ?? 0) + (b?.dwellPracticeSec ?? 0),
      };
    }
  }
  return {
    practiceMarkCorrect: (l.practiceMarkCorrect ?? 0) + (r.practiceMarkCorrect ?? 0),
    practiceMarkWrong: (l.practiceMarkWrong ?? 0) + (r.practiceMarkWrong ?? 0),
    practiceMarkEasy: (l.practiceMarkEasy ?? 0) + (r.practiceMarkEasy ?? 0),
    dwellLessonReaderSec: (l.dwellLessonReaderSec ?? 0) + (r.dwellLessonReaderSec ?? 0),
    dwellPracticeSec: (l.dwellPracticeSec ?? 0) + (r.dwellPracticeSec ?? 0),
    ...(daily ? { daily } : {}),
  };
}

function mergeMediaLibrary(
  local: Record<string, AppMediaResource> | undefined,
  remote: Record<string, AppMediaResource> | undefined,
): Record<string, AppMediaResource> | undefined {
  const merged = { ...(remote ?? {}), ...(local ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * 将本机与云端快照合并为一份 `AppData`（再经 `normalizeAppData`）。
 * 规则：带 `id` 的数组按 **时间戳较新** 的整条记录保留；`stats` 计数与按日桶 **相加**；`mediaLibrary` **本机键覆盖** 同键。
 * @param conflictPicks 可选：对「同 id 且规范化后内容不同」的条目强制保留本机或云端整行；未列出的 id 仍按时间戳。
 */
export function mergeAppDataLocalAndRemote(local: AppData, remote: AppData, conflictPicks?: MergeConflictPicks): AppData {
  const l = normalizeAppData(local);
  const r = normalizeAppData(remote);

  const lessonRev = (x: Lesson) => Math.max(revisionMs(x.updatedAt), revisionMs(x.createdAt));

  const merged: AppData = {
    lessons: mergeIdentifiedByNewer<Lesson>(l.lessons, r.lessons, lessonRev, conflictPicks?.lessons),
    vocabCards: mergeIdentifiedByNewer<VocabCard>(l.vocabCards, r.vocabCards, entityRevisionMs, conflictPicks?.vocabCards),
    sentenceTasks: mergeIdentifiedByNewer<SentenceTask>(
      l.sentenceTasks,
      r.sentenceTasks,
      entityRevisionMs,
      conflictPicks?.sentenceTasks,
    ),
    grammarTasks: mergeIdentifiedByNewer<GrammarTask>(
      l.grammarTasks,
      r.grammarTasks,
      entityRevisionMs,
      conflictPicks?.grammarTasks,
    ),
    chatSessions: mergeIdentifiedByNewer<ChatSession>(
      l.chatSessions ?? [],
      r.chatSessions ?? [],
      entityRevisionMs,
      conflictPicks?.chatSessions,
    ),
    lessonNotes: mergeIdentifiedByNewer<LessonNote>(
      l.lessonNotes ?? [],
      r.lessonNotes ?? [],
      entityRevisionMs,
      conflictPicks?.lessonNotes,
    ),
    favoriteSentences: mergeIdentifiedByNewer<LessonFavoriteSentence>(
      l.favoriteSentences ?? [],
      r.favoriteSentences ?? [],
      (x) => revisionMs(x.createdAt),
      conflictPicks?.favoriteSentences,
    ),
    stats: mergeStats(l.stats, r.stats),
    ...(() => {
      const ml = mergeMediaLibrary(l.mediaLibrary, r.mediaLibrary);
      return ml ? { mediaLibrary: ml } : {};
    })(),
  };
  return normalizeAppData(merged);
}
