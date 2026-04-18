import { defaultSrsForNewItem } from "@/modules/srs/scheduler";
import type { GrammarTask, SentenceTask, VocabCard } from "@/shared/types";
import { calendarTodayLocal, extractExampleSegmentForTerm, nowIso, tokenizeSentenceForDrag, uid } from "@/shared/utils";

const DISTRACTOR_FALLBACK = ["する", "なる", "ある", "いる", "見る", "聞く", "来る", "言う", "思う", "知る"];

const ZH_DISTRACTOR_FALLBACK = ["学习", "认识", "使用", "练习", "阅读", "说明", "变化", "影响", "完成", "决定"];

export function finalizeVocabDistractors(
  term: string,
  provided: string[] | undefined,
  siblingTerms: string[] | undefined,
): [string, string, string] {
  const t = term.trim();
  const out: string[] = [];
  for (const raw of provided ?? []) {
    const s = String(raw).trim();
    if (!s || s === t || out.includes(s)) continue;
    out.push(s);
    if (out.length >= 3) break;
  }
  for (const raw of siblingTerms ?? []) {
    if (out.length >= 3) break;
    const s = String(raw).trim();
    if (!s || s === t || out.includes(s)) continue;
    out.push(s);
  }
  let i = 0;
  while (out.length < 3) {
    const w = DISTRACTOR_FALLBACK[i % DISTRACTOR_FALLBACK.length]!;
    i += 1;
    if (w !== t && !out.includes(w)) out.push(w);
  }
  return [out[0]!, out[1]!, out[2]!];
}

export function finalizeVocabZhDistractors(
  zhCorrect: string,
  provided: string[] | undefined,
  siblingZhs: string[] | undefined,
): [string, string, string] {
  const t = zhCorrect.trim();
  const out: string[] = [];
  for (const raw of provided ?? []) {
    const s = String(raw).trim();
    if (!s || s === t || out.includes(s)) continue;
    out.push(s);
    if (out.length >= 3) break;
  }
  for (const raw of siblingZhs ?? []) {
    if (out.length >= 3) break;
    const s = String(raw).trim();
    if (!s || s === t || out.includes(s)) continue;
    out.push(s);
  }
  let i = 0;
  while (out.length < 3) {
    const w = ZH_DISTRACTOR_FALLBACK[i % ZH_DISTRACTOR_FALLBACK.length]!;
    i += 1;
    if (w !== t && !out.includes(w)) out.push(w);
  }
  return [out[0]!, out[1]!, out[2]!];
}

export function createVocabCard(params: {
  lessonId: string;
  term: string;
  kana: string;
  zh: string;
  etymology: string;
  lessonContent: string;
  /** 若已由 AI 或用户给出整句例文，则优先于课文规则截取 */
  exampleOverride?: string;
  distractors?: string[];
  zhDistractors?: string[];
  lessonSiblingTerms?: string[];
  lessonSiblingZhs?: string[];
}): VocabCard {
  const override = params.exampleOverride?.trim();
  const exampleSeg =
    (override && override.length > 0 ? override : null) ||
    extractExampleSegmentForTerm(params.lessonContent, params.term) ||
    params.term.trim();
  const zh0 = params.zh.trim();
  const vocabDistractors = finalizeVocabDistractors(params.term, params.distractors, params.lessonSiblingTerms);
  const vocabZhDistractors = finalizeVocabZhDistractors(zh0, params.zhDistractors, params.lessonSiblingZhs);
  const createdAt = nowIso();
  return {
    id: uid("vocab"),
    lessonId: params.lessonId,
    term: params.term.trim(),
    kana: params.kana.trim(),
    meanings: [{ zh: zh0, example: exampleSeg }],
    etymology: params.etymology.trim(),
    vocabDistractors,
    vocabZhDistractors,
    latestExample: exampleSeg,
    ...defaultSrsForNewItem(),
    createdAt,
    updatedAt: createdAt,
  };
}

export function createSentenceTask(params: {
  lessonId: string;
  sourceType?: "translation" | "listening";
  teachingNote?: string;
  zh: string;
  jpAnswer: string;
}): SentenceTask {
  const jpAnswer = params.jpAnswer.trim();
  const createdAt = nowIso();
  return {
    id: uid("sentence"),
    lessonId: params.lessonId,
    sourceType: params.sourceType ?? "translation",
    teachingNote: params.teachingNote?.trim() || undefined,
    zh: params.zh.trim(),
    jpAnswer,
    tokens: tokenizeSentenceForDrag(jpAnswer),
    ...defaultSrsForNewItem(),
    createdAt,
  };
}

export function createGrammarTask(params: {
  lessonId: string;
  sourceSentence?: string;
  prompt: string;
  zhPrompt?: string;
  choices: string[];
  answerIndex: number;
  explanation: string;
  wrongReasons?: string[];
  knowledgePoint?: string;
}): GrammarTask {
  const createdAt = nowIso();
  const choiceItems = params.choices.slice(0, 4).map((text, idx) => ({
    id: uid("choice"),
    text,
    correct: idx === params.answerIndex,
  }));
  return {
    id: uid("grammar"),
    lessonId: params.lessonId,
    sourceSentence: params.sourceSentence?.trim() || undefined,
    prompt: params.prompt.trim(),
    zhPrompt: params.zhPrompt?.trim() || undefined,
    choices: choiceItems,
    answerId: choiceItems[Math.max(0, params.answerIndex)]?.id ?? choiceItems[0]?.id ?? "",
    explanation: params.explanation.trim(),
    wrongReasonByChoiceId: choiceItems.reduce<Record<string, string>>((acc, choice, idx) => {
      if (!choice.correct && params.wrongReasons?.[idx]) {
        acc[choice.id] = params.wrongReasons[idx];
      }
      return acc;
    }, {}),
    knowledgePoint: params.knowledgePoint?.trim(),
    ...defaultSrsForNewItem(),
    createdAt,
  };
}

export function upsertVocabWithPolysemyReset(cards: VocabCard[], next: VocabCard): VocabCard[] {
  const sameTermCards = cards.filter((card) => card.term === next.term);
  if (sameTermCards.length === 0) {
    return [...cards, next];
  }

  const sameMeaningExists = sameTermCards.some(
    (card) => card.meanings[0]?.zh.trim() === next.meanings[0]?.zh.trim(),
  );
  if (sameMeaningExists) {
    return cards.map((card) =>
      card.term === next.term
        ? {
            ...card,
            mastery: 0,
            latestExample: next.latestExample,
            vocabDistractors: next.vocabDistractors?.length === 3 ? next.vocabDistractors : (card.vocabDistractors ?? []),
            vocabZhDistractors: next.vocabZhDistractors?.length === 3 ? next.vocabZhDistractors : (card.vocabZhDistractors ?? []),
            updatedAt: nowIso(),
          }
        : card,
    );
  }

  const day0 = calendarTodayLocal();
  return cards.map((card) =>
    card.term === next.term
      ? {
          ...card,
          mastery: 0,
          reviewStage: 0,
          nextReviewDay: day0,
          reviewGraduated: false,
          meanings: [...card.meanings, ...next.meanings],
          latestExample: next.latestExample,
          vocabDistractors: next.vocabDistractors?.length === 3 ? next.vocabDistractors : (card.vocabDistractors ?? []),
          vocabZhDistractors: next.vocabZhDistractors?.length === 3 ? next.vocabZhDistractors : (card.vocabZhDistractors ?? []),
          updatedAt: nowIso(),
        }
      : card,
  );
}

