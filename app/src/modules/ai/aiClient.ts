import type { PromptMode } from "@/shared/types";

type GrammarAIResult = {
  choices: string[];
  answerIndex: number;
  explanation: string;
  zhPrompt?: string;
  wrongReasons?: string[];
};

export async function generateGrammarOptions(input: {
  prompt: string;
  knowledgePoint?: string;
}): Promise<GrammarAIResult> {
  const response = await fetch("/api/ai/grammar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    return {
      choices: ["は", "が", "を", "に"],
      answerIndex: 0,
      explanation: "AI 服务不可用，已使用默认选项。建议稍后重试以获取详细解析。",
      zhPrompt: "我每天早上___学习日语。",
      wrongReasons: ["", "主语提示不匹配。", "宾语关系不匹配。", "方向/对象关系不匹配。"],
    };
  }

  return (await response.json()) as GrammarAIResult;
}

export type VocabEnrichResult = {
  kana: string;
  zh: string;
  etymology: string;
  /** 含该词的自然日语例句（词典/课文无片段时由模型补写） */
  exampleJp?: string;
  /** 三道日语干扰项，与词条组成四选一 */
  distractors: string[];
  /** 三道错误中文义项，与 zh 组成日→中四选一 */
  zhDistractors: string[];
};

export async function generateSentenceFromSelection(japanese: string): Promise<{ zh: string; jpAnswer: string }> {
  const response = await fetch("/api/ai/sentence-from-selection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ japanese }),
  });

  if (!response.ok) {
    return { zh: "（服务不可用）", jpAnswer: japanese.trim() };
  }

  const data = (await response.json()) as { zh?: string; jpAnswer?: string };
  return {
    zh: (data.zh || "").trim() || "—",
    jpAnswer: (data.jpAnswer || japanese).trim() || japanese.trim(),
  };
}

export async function generateSentenceTeachingNote(input: { jp: string; zh?: string }): Promise<string> {
  const response = await fetch("/api/ai/sentence-teach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) return "暂无";
  const data = (await response.json()) as { teachingNote?: string };
  const note = (data.teachingNote || "").trim();
  return note || "暂无";
}

export async function enrichVocabFields(input: {
  term: string;
  exampleSegment: string;
  lessonTitle?: string;
  lessonCategory?: string;
}): Promise<VocabEnrichResult> {
  const response = await fetch("/api/ai/vocab-enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    return {
      kana: "—",
      zh: "—",
      etymology: "（服务不可用。）",
      exampleJp: undefined,
      distractors: ["する", "なる", "ある"],
      zhDistractors: ["学习", "认识", "使用"],
    };
  }

  const data = (await response.json()) as Partial<VocabEnrichResult>;
  const raw = Array.isArray(data.distractors) ? data.distractors : [];
  const distractors =
    raw.map((s) => String(s).trim()).filter(Boolean).length >= 3
      ? raw.map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
      : ["する", "なる", "ある"];
  const rawZh = Array.isArray(data.zhDistractors) ? data.zhDistractors : [];
  const zhDistractors =
    rawZh.map((s) => String(s).trim()).filter(Boolean).length >= 3
      ? rawZh.map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
      : ["学习", "认识", "使用"];
  const ex = typeof data.exampleJp === "string" ? data.exampleJp.trim() : "";
  return {
    kana: (data.kana || "—").trim() || "—",
    zh: (data.zh || "—").trim() || "—",
    etymology: (data.etymology || "—").trim() || "—",
    exampleJp: ex.length > 0 ? ex : undefined,
    distractors,
    zhDistractors,
  };
}

export type LessonIllustrationResult =
  | { dataUrl: string }
  | { skipped: true; message?: string }
  | { error: string; detail?: string };

export async function requestLessonIllustration(input: { title: string; themeHint: string }): Promise<LessonIllustrationResult> {
  const response = await fetch("/api/ai/lesson-illustration", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: input.title, themeHint: input.themeHint }),
  });

  const rawText = await response.text();
  type IllJson = {
    dataUrl?: string;
    skipped?: boolean;
    message?: string;
    error?: string;
    detail?: string;
  };
  let data: IllJson = {};
  try {
    data = rawText ? (JSON.parse(rawText) as IllJson) : {};
  } catch {
    return {
      error: "BAD_JSON",
      detail: rawText.slice(0, 240) || `HTTP ${response.status}`,
    };
  }

  if (data.skipped) {
    return { skipped: true, message: data.message };
  }
  if (data.dataUrl && typeof data.dataUrl === "string") {
    return { dataUrl: data.dataUrl };
  }
  if (!response.ok) {
    return { error: data.error || "请求失败", detail: data.detail || rawText.slice(0, 240) };
  }
  return { error: "EMPTY", detail: data.detail || rawText.slice(0, 240) };
}

export async function translateParagraph(paragraph: string): Promise<string> {
  const response = await fetch("/api/ai/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paragraph }),
  });

  if (!response.ok) {
    return "（翻译服务不可用。）";
  }

  const data = (await response.json()) as { zh?: string };
  return (data.zh || "").trim() || "（无译文。）";
}

/** 首页晨/夜彩蛋金句（服务端生成，勿从例句库抽取） */
export async function generateHomeMotivation(input: {
  window: "dawn" | "night";
  salt?: string;
}): Promise<string> {
  const response = await fetch("/api/ai/home-motivation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      window: input.window,
      salt: input.salt ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    }),
  });
  if (!response.ok) {
    return "风从书页里穿过，像有人轻轻翻了一页；今夜月色够用，心事可以慢一点。";
  }
  const data = (await response.json()) as { line?: string };
  const line = typeof data.line === "string" ? data.line.trim() : "";
  return line || "不知江月待何人，但见长江送流水——我读得慢，是因为把每个字都当成了月色。";
}

export async function chatWithLesson(input: {
  mode: PromptMode;
  lessonContent: string;
  message: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<string> {
  const response = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    return "当前 AI 服务暂不可用，请稍后重试。你也可以先继续做题保持学习节奏。";
  }

  const data = (await response.json()) as { answer: string };
  return data.answer;
}

