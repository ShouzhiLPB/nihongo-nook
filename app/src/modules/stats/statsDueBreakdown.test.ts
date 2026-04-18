import { describe, expect, it } from "vitest";
import type { GrammarTask, Lesson, SentenceTask, VocabCard } from "@/shared/types";
import { buildGlobalDueReviewCounts, buildLessonDueBreakdown } from "./statsDueBreakdown";

const iso = "2026-01-01T00:00:00.000Z";
const today = "2026-04-10";

function vocab(id: string, lessonId: string, nextReviewDay: string): VocabCard {
  return {
    id,
    lessonId,
    term: "a",
    kana: "a",
    meanings: [{ zh: "a", example: "" }],
    etymology: "",
    vocabDistractors: ["x", "y", "z"],
    vocabZhDistractors: ["x", "y", "z"],
    latestExample: "",
    mastery: 0,
    nextReviewDay,
    createdAt: iso,
    updatedAt: iso,
  };
}

describe("buildGlobalDueReviewCounts + buildLessonDueBreakdown", () => {
  it("sums per-lesson vocab due into global when lesson exists", () => {
    const l1: Lesson = { id: "l1", name: "A", content: "x", category: "c", createdAt: iso, updatedAt: iso };
    const l2: Lesson = { id: "l2", name: "B", content: "y", category: "c", createdAt: iso, updatedAt: iso };
    const cards = [vocab("v1", "l1", today), vocab("v2", "l2", today)];
    const g = buildGlobalDueReviewCounts(cards, [], []);
    expect(g.vocab).toBe(2);
    const rows = buildLessonDueBreakdown([l1, l2], cards, [], []);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.vocab, 0)).toBe(2);
  });

  it("sorts lessons by total descending", () => {
    const l1: Lesson = { id: "l1", name: "甲", content: "x", category: "c", createdAt: iso, updatedAt: iso };
    const l2: Lesson = { id: "l2", name: "乙", content: "y", category: "c", createdAt: iso, updatedAt: iso };
    const mkS = (id: string, lessonId: string): SentenceTask => ({
      id,
      lessonId,
      zh: "z",
      jpAnswer: "a b",
      tokens: ["a", "b"],
      mastery: 0,
      nextReviewDay: today,
      createdAt: iso,
    });
    const rows = buildLessonDueBreakdown(
      [l1, l2],
      [vocab("v1", "l1", today)],
      [mkS("s1", "l2"), mkS("s2", "l2")],
      [],
    );
    expect(rows[0]?.lesson.id).toBe("l2");
    expect(rows[0]?.total).toBe(2);
    expect(rows[1]?.total).toBe(1);
  });

  it("excludes trashed-lesson tasks from global counts when omitLessonIds is set", () => {
    const cards = [vocab("v1", "l1", today), vocab("v2", "l2", today)];
    const omit = new Set(["l1"]);
    const g = buildGlobalDueReviewCounts(cards, [], [], omit);
    expect(g.vocab).toBe(1);
  });

  it("omits trashed lessons from per-lesson breakdown", () => {
    const l1: Lesson = {
      id: "l1",
      name: "A",
      content: "x",
      category: "c",
      createdAt: iso,
      updatedAt: iso,
      trashedAt: iso,
    };
    const l2: Lesson = { id: "l2", name: "B", content: "y", category: "c", createdAt: iso, updatedAt: iso };
    const cards = [vocab("v1", "l1", today), vocab("v2", "l2", today)];
    const rows = buildLessonDueBreakdown([l1, l2], cards, [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lesson.id).toBe("l2");
  });

  it("counts grammar due per lesson", () => {
    const l1: Lesson = { id: "l1", name: "课", content: "x", category: "c", createdAt: iso, updatedAt: iso };
    const g1: GrammarTask = {
      id: "g1",
      lessonId: "l1",
      prompt: "p",
      choices: [{ id: "a", text: "t" }],
      answerId: "a",
      explanation: "",
      mastery: 0,
      nextReviewDay: today,
      createdAt: iso,
    };
    const rows = buildLessonDueBreakdown([l1], [], [], [g1]);
    expect(rows[0]?.grammar).toBe(1);
    expect(buildGlobalDueReviewCounts([], [], [g1]).grammar).toBe(1);
  });
});
