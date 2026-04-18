import { normalizeAppData } from "@/modules/storage/dataStore";
import type {
  AppData,
  ChatSession,
  GrammarTask,
  Lesson,
  LessonFavoriteSentence,
  LessonNote,
  SentenceTask,
  VocabCard,
} from "@/shared/types";

const EMPTY: AppData = {
  lessons: [],
  vocabCards: [],
  sentenceTasks: [],
  grammarTasks: [],
  chatSessions: [],
  lessonNotes: [],
  favoriteSentences: [],
};

export type MergeSliceKey =
  | "lessons"
  | "vocabCards"
  | "sentenceTasks"
  | "grammarTasks"
  | "chatSessions"
  | "lessonNotes"
  | "favoriteSentences";

function normRowJson(sliceKey: MergeSliceKey, row: unknown): string {
  switch (sliceKey) {
    case "lessons":
      return JSON.stringify(normalizeAppData({ ...EMPTY, lessons: [row as Lesson] }).lessons[0] ?? {});
    case "vocabCards":
      return JSON.stringify(normalizeAppData({ ...EMPTY, vocabCards: [row as VocabCard] }).vocabCards[0] ?? {});
    case "sentenceTasks":
      return JSON.stringify(normalizeAppData({ ...EMPTY, sentenceTasks: [row as SentenceTask] }).sentenceTasks[0] ?? {});
    case "grammarTasks":
      return JSON.stringify(normalizeAppData({ ...EMPTY, grammarTasks: [row as GrammarTask] }).grammarTasks[0] ?? {});
    case "chatSessions":
      return JSON.stringify(normalizeAppData({ ...EMPTY, chatSessions: [row as ChatSession] }).chatSessions[0] ?? {});
    case "lessonNotes":
      return JSON.stringify(normalizeAppData({ ...EMPTY, lessonNotes: [row as LessonNote] }).lessonNotes[0] ?? {});
    case "favoriteSentences":
      return JSON.stringify(
        normalizeAppData({ ...EMPTY, favoriteSentences: [row as LessonFavoriteSentence] }).favoriteSentences[0] ?? {},
      );
  }
}

function summarizeKeyed<T extends { id: string }>(
  label: string,
  sliceKey: MergeSliceKey,
  localRows: T[],
  remoteRows: T[],
): MergeCollectionPreview {
  const lm = new Map(localRows.map((x) => [x.id, x]));
  const rm = new Map(remoteRows.map((x) => [x.id, x]));
  const localOnly: string[] = [];
  const remoteOnly: string[] = [];
  const conflicting: string[] = [];
  for (const id of lm.keys()) {
    if (!rm.has(id)) localOnly.push(id);
  }
  for (const id of rm.keys()) {
    if (!lm.has(id)) remoteOnly.push(id);
  }
  for (const id of lm.keys()) {
    if (!rm.has(id)) continue;
    const a = lm.get(id)!;
    const b = rm.get(id)!;
    if (normRowJson(sliceKey, a) !== normRowJson(sliceKey, b)) {
      conflicting.push(id);
    }
  }
  localOnly.sort((x, y) => x.localeCompare(y));
  remoteOnly.sort((x, y) => x.localeCompare(y));
  conflicting.sort((x, y) => x.localeCompare(y));
  return { label, sliceKey, localOnly, remoteOnly, conflicting };
}

export type MergeCollectionPreview = {
  label: string;
  sliceKey: MergeSliceKey;
  localOnly: string[];
  remoteOnly: string[];
  conflicting: string[];
};

export type AppDataMergePreview = {
  collections: MergeCollectionPreview[];
  /** 全局 stats 在合并时会做相加，非「二选一整条」；单独提示 */
  statsWillSum: boolean;
};

/**
 * 合并前摘要：各带 id 集合的「仅本机 / 仅云端 / 同 id 内容不同」条目 id 列表（用于弹层展示，非逐字段 diff）。
 */
export function summarizeAppDataMerge(local: AppData, remote: AppData): AppDataMergePreview {
  const l = normalizeAppData(local);
  const r = normalizeAppData(remote);
  const collections: MergeCollectionPreview[] = [
    summarizeKeyed<Lesson>("课文", "lessons", l.lessons, r.lessons),
    summarizeKeyed<VocabCard>("词卡", "vocabCards", l.vocabCards, r.vocabCards),
    summarizeKeyed<SentenceTask>("句子题", "sentenceTasks", l.sentenceTasks, r.sentenceTasks),
    summarizeKeyed<GrammarTask>("语法题", "grammarTasks", l.grammarTasks, r.grammarTasks),
    summarizeKeyed<ChatSession>("聊天会话", "chatSessions", l.chatSessions ?? [], r.chatSessions ?? []),
    summarizeKeyed<LessonNote>("书签笔记", "lessonNotes", l.lessonNotes ?? [], r.lessonNotes ?? []),
    summarizeKeyed<LessonFavoriteSentence>("收藏句", "favoriteSentences", l.favoriteSentences ?? [], r.favoriteSentences ?? []),
  ];
  const sl = JSON.stringify(l.stats ?? {});
  const sr = JSON.stringify(r.stats ?? {});
  const statsWillSum = sl !== sr;
  return { collections, statsWillSum };
}

export function rowsForSlice(data: AppData, sliceKey: MergeSliceKey): { id: string }[] {
  if (sliceKey === "lessons") return data.lessons;
  if (sliceKey === "vocabCards") return data.vocabCards;
  if (sliceKey === "sentenceTasks") return data.sentenceTasks;
  if (sliceKey === "grammarTasks") return data.grammarTasks;
  if (sliceKey === "chatSessions") return data.chatSessions ?? [];
  if (sliceKey === "lessonNotes") return data.lessonNotes ?? [];
  return data.favoriteSentences ?? [];
}

/**
 * 合并弹层「只读 diff」：对同一 id 取本机 / 云端各一行，经与摘要相同的 `normalizeAppData` 规则后输出两段 JSON 文本。
 * 若某一侧缺该行，对应字符串为空串。
 */
export function getMergeRowNormalizedJsonPair(
  local: AppData,
  remote: AppData,
  sliceKey: MergeSliceKey,
  id: string,
): { localJson: string; remoteJson: string } {
  const l = normalizeAppData(local);
  const r = normalizeAppData(remote);
  const lr = rowsForSlice(l, sliceKey).find((x) => x.id === id);
  const rr = rowsForSlice(r, sliceKey).find((x) => x.id === id);
  return {
    localJson: lr ? normRowJson(sliceKey, lr) : "",
    remoteJson: rr ? normRowJson(sliceKey, rr) : "",
  };
}

/** 与 `statsWillSum` 判定一致：两侧 `stats` 经 JSON 序列化后的字符串（用于只读对比）。 */
export function getMergeStatsJsonPair(local: AppData, remote: AppData): { localJson: string; remoteJson: string } {
  const l = normalizeAppData(local);
  const r = normalizeAppData(remote);
  return {
    localJson: JSON.stringify(l.stats ?? {}),
    remoteJson: JSON.stringify(r.stats ?? {}),
  };
}

/** 合并摘要 id 列表：按子串筛选（大小写不敏感）；`query` 为空则返回原数组副本。 */
export function filterIdsBySubstring(ids: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...ids];
  return ids.filter((id) => id.toLowerCase().includes(q));
}
