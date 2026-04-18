import { describe, expect, it } from "vitest";
import { createGrammarTask, createSentenceTask, createVocabCard, upsertVocabWithPolysemyReset } from "./lessonService";

describe("lessonService", () => {
  it("extracts first sentence as example", () => {
    const card = createVocabCard({
      lessonId: "l1",
      term: "学生",
      kana: "がくせい",
      zh: "学生",
      etymology: "词源说明",
      lessonContent: "私は学生です。彼も学生です。",
    });
    expect(card.latestExample).toContain("学生");
    expect(card.vocabDistractors).toHaveLength(3);
    expect(card.vocabZhDistractors).toHaveLength(3);
  });

  it("resets mastery when same term appears", () => {
    const initial = createVocabCard({
      lessonId: "l1",
      term: "学生",
      kana: "がくせい",
      zh: "学生",
      etymology: "词源说明",
      lessonContent: "私は学生です。",
    });
    initial.mastery = 80;
    const merged = upsertVocabWithPolysemyReset([initial], {
      ...initial,
      id: "v2",
      meanings: [{ zh: "学习者", example: "彼はよく学ぶ。" }],
      latestExample: "彼はよく学ぶ。",
    });
    expect(merged[0]?.mastery).toBe(0);
    expect(merged[0]?.reviewStage).toBe(0);
    expect(merged[0]?.reviewGraduated).toBe(false);
  });

  it("creates draggable sentence tokens even when jpAnswer has no spaces", () => {
    const task = createSentenceTask({
      lessonId: "l1",
      zh: "我是学生。",
      jpAnswer: "私は学生です",
    });
    expect(task.tokens.length).toBeGreaterThan(1);
    expect(task.tokens.join("")).toBe("私は学生です");
  });

  it("stores grammar sourceSentence and knowledgePoint", () => {
    const g = createGrammarTask({
      lessonId: "l1",
      sourceSentence: "  私は毎朝日本語を勉強します。  ",
      prompt: "私は毎朝___日本語を勉強します。",
      choices: ["は", "を", "に", "で"],
      answerIndex: 1,
      explanation: "动词他动词对象用を。",
      knowledgePoint: "他动词对象标记",
    });
    expect(g.sourceSentence).toBe("私は毎朝日本語を勉強します。");
    expect(g.knowledgePoint).toBe("他动词对象标记");
  });
});

