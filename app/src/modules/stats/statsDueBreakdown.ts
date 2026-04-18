import { filterDueReviewItems } from "@/modules/srs/scheduler";
import type { GrammarTask, Lesson, SentenceTask, VocabCard } from "@/shared/types";

export type GlobalDueCounts = { vocab: number; sentence: number; grammar: number };

/** 全库今日待复习条数，与练习页 `filterDueReviewItems` 一致（可排除废纸篓课文下属题） */
export function buildGlobalDueReviewCounts(
  vocabCards: VocabCard[],
  sentenceTasks: SentenceTask[],
  grammarTasks: GrammarTask[],
  omitLessonIds?: Set<string>,
): GlobalDueCounts {
  const omit = omitLessonIds && omitLessonIds.size > 0 ? omitLessonIds : null;
  const v = omit ? vocabCards.filter((c) => !omit.has(c.lessonId)) : vocabCards;
  const s = omit ? sentenceTasks.filter((t) => !omit.has(t.lessonId)) : sentenceTasks;
  const g = omit ? grammarTasks.filter((t) => !omit.has(t.lessonId)) : grammarTasks;
  return {
    vocab: filterDueReviewItems(v).length,
    sentence: filterDueReviewItems(s).length,
    grammar: filterDueReviewItems(g).length,
  };
}

export type LessonDueBreakdownRow = {
  lesson: Lesson;
  vocab: number;
  sentence: number;
  grammar: number;
  total: number;
};

/** 各课文今日待复习（仅 total>0），按合计降序 */
export function buildLessonDueBreakdown(
  lessons: Lesson[],
  vocabCards: VocabCard[],
  sentenceTasks: SentenceTask[],
  grammarTasks: GrammarTask[],
): LessonDueBreakdownRow[] {
  return lessons
    .filter((lesson) => !lesson.trashedAt)
    .map((lesson) => {
      const lid = lesson.id;
      const vocab = filterDueReviewItems(vocabCards.filter((c) => c.lessonId === lid)).length;
      const sentence = filterDueReviewItems(sentenceTasks.filter((t) => t.lessonId === lid)).length;
      const grammar = filterDueReviewItems(grammarTasks.filter((t) => t.lessonId === lid)).length;
      return { lesson, vocab, sentence, grammar, total: vocab + sentence + grammar };
    })
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total || (a.lesson.name || "").localeCompare(b.lesson.name || "", "ja"));
}
