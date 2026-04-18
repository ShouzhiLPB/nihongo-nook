import { createVocabCard, upsertVocabWithPolysemyReset } from "@/modules/learning/lessonService";
import { bumpPracticeMarkStats, mergeDwellSecondsIntoStats } from "@/modules/storage/dataStore";
import { patchAfterCorrect, patchAfterWrong, sortByReviewPriority } from "@/modules/srs/scheduler";
import {
  addCalendarDaysLocal,
  calendarTodayLocal,
  inMotivationWindow,
  normalizeJaTermForPractice,
  normalizePracticeWhitespace,
  normalizeZhMeaningForPractice,
  stableShuffle,
} from "@/shared/utils";

export type CheckResult = {
  name: string;
  passed: boolean;
  detail: string;
};

export function runSelfChecks(): CheckResult[] {
  const checks: CheckResult[] = [];

  const card = createVocabCard({
    lessonId: "lesson_1",
    term: "勉強",
    kana: "べんきょう",
    zh: "学习",
    etymology: "词源测试",
    lessonContent: "今日は勉強します。明日も勉強します。",
  });
  checks.push({
    name: "词卡例句提取",
    passed: card.latestExample.includes("勉強"),
    detail: `例句=${card.latestExample}`,
  });
  checks.push({
    name: "单词练习备选项（自动生成）",
    passed: card.vocabDistractors.length === 3 && !card.vocabDistractors.includes(card.term),
    detail: `jp=${card.vocabDistractors.join(" | ")}`,
  });
  const zh0 = card.meanings[0]?.zh?.trim() ?? "";
  checks.push({
    name: "单词中文备选项（自动生成）",
    passed: card.vocabZhDistractors.length === 3 && Boolean(zh0) && !card.vocabZhDistractors.includes(zh0),
    detail: `zh=${card.vocabZhDistractors.join(" | ")}`,
  });
  checks.push({
    name: "单词复习初始排期",
    passed: Boolean(card.nextReviewDay && card.reviewStage === 0 && !card.reviewGraduated),
    detail: `next=${card.nextReviewDay}, stage=${card.reviewStage}`,
  });

  const merged = upsertVocabWithPolysemyReset([card], {
    ...card,
    id: "vocab_new",
    meanings: [{ zh: "用功", example: "彼は用功だ。" }],
    latestExample: "新例句",
  });
  checks.push({
    name: "同形异义熟练度归零",
    passed: merged[0]?.mastery === 0 && merged[0]?.reviewStage === 0,
    detail: `mastery=${merged[0]?.mastery}, stage=${merged[0]?.reviewStage}`,
  });

  const today = calendarTodayLocal();
  const w = patchAfterWrong({
    mastery: 50,
    createdAt: "2026-01-01T00:00:00.000Z",
    reviewStage: 2,
    nextReviewDay: today,
    reviewGraduated: false,
  });
  checks.push({
    name: "复习排期 · 答错",
    passed: w.reviewStage === 1 && w.nextReviewDay === addCalendarDaysLocal(today, 1),
    detail: `stage=${w.reviewStage}, next=${w.nextReviewDay}`,
  });

  const c = patchAfterCorrect(
    {
      mastery: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      reviewStage: 0,
      nextReviewDay: today,
      reviewGraduated: false,
    },
    "correct",
  );
  checks.push({
    name: "复习排期 · 答对",
    passed: Boolean(c && c.reviewStage === 1 && c.nextReviewDay === addCalendarDaysLocal(today, 1)),
    detail: c ? `stage=${c.reviewStage}, next=${c.nextReviewDay}` : "null",
  });

  const ez = patchAfterCorrect(
    {
      mastery: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      reviewStage: 2,
      nextReviewDay: today,
      reviewGraduated: false,
    },
    "easy",
  );
  checks.push({
    name: "太简单啦，直接毕业",
    passed: Boolean(ez?.reviewGraduated && ez.mastery === 100 && ez.reviewStage === 4),
    detail: ez ? `graduated=${ez.reviewGraduated}` : "null",
  });

  const queue = sortByReviewPriority([
    { mastery: 50, createdAt: "2026-02-01T00:00:00.000Z", reviewStage: 0, nextReviewDay: today, reviewGraduated: false },
    { mastery: 20, createdAt: "2026-01-01T00:00:00.000Z", reviewStage: 0, nextReviewDay: today, reviewGraduated: false },
  ]);
  checks.push({
    name: "复习队列排序（同日 createdAt 升序）",
    passed: queue[0]?.createdAt === "2026-01-01T00:00:00.000Z",
    detail: `first=${queue[0]?.createdAt}`,
  });

  const shuffledA = stableShuffle(["A", "B", "C"], "seed-1").join(",");
  const shuffledB = stableShuffle(["A", "B", "C"], "seed-1").join(",");
  checks.push({
    name: "稳定洗牌一致性",
    passed: shuffledA === shuffledB,
    detail: `${shuffledA} / ${shuffledB}`,
  });

  checks.push({
    name: "激励语时段判定",
    passed: inMotivationWindow(new Date("2026-01-01T06:00:00.000Z")) === "dawn",
    detail: "06:00 should be dawn",
  });

  checks.push({
    name: "组句答案空白规范化可比",
    passed:
      normalizePracticeWhitespace("  私は　学生だ ") === normalizePracticeWhitespace("私は 学生だ"),
    detail: normalizePracticeWhitespace("  私は　学生だ "),
  });

  checks.push({
    name: "单词填空日文规范化可比",
    passed: normalizeJaTermForPractice(" 学生　です ") === normalizeJaTermForPractice("学生 です"),
    detail: normalizeJaTermForPractice("学生 です"),
  });

  checks.push({
    name: "单词填空中文义项去标点",
    passed: normalizeZhMeaningForPractice("学习，") === normalizeZhMeaningForPractice("学习"),
    detail: normalizeZhMeaningForPractice("学习，"),
  });

  checks.push({
    name: "练习统计 bump",
    passed: bumpPracticeMarkStats({ practiceMarkCorrect: 5, practiceMarkWrong: 1, practiceMarkEasy: 0 }, "easy").practiceMarkEasy === 1,
    detail: "easy +1",
  });

  checks.push({
    name: "停留秒数 merge",
    passed:
      mergeDwellSecondsIntoStats(
        { practiceMarkCorrect: 0, practiceMarkWrong: 0, practiceMarkEasy: 0, dwellLessonReaderSec: 1, dwellPracticeSec: 2 },
        { lessonReaderSec: 4, practiceSec: 0 },
      ).dwellLessonReaderSec === 5,
    detail: "dwell +4",
  });

  return checks;
}
