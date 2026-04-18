export const appStorageKey = "japanese-learning-app-v1";

/** 作者未填或全空白时写入的日语「佚名」式默认 */
export const LESSON_AUTHOR_FALLBACK_JA = "著者不明";

export function lessonAuthorForSave(raw: string | undefined | null): string {
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : LESSON_AUTHOR_FALLBACK_JA;
}

/** 编辑框：已存为默认佚名时显示为空，便于改填真名 */
export function lessonAuthorInputValue(author: string | undefined | null): string {
  const t = (author ?? "").trim();
  if (!t || t === LESSON_AUTHOR_FALLBACK_JA) return "";
  return t;
}

export function lessonAuthorDisplay(author: string | undefined | null): string {
  const t = (author ?? "").trim();
  return t.length > 0 ? t : LESSON_AUTHOR_FALLBACK_JA;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 本地日历日 yyyy-MM-dd（复习 `nextReviewDay` 精确到天） */
export function calendarTodayLocal(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 从 ISO 或其它日期串取出 yyyy-MM-dd（失败则退回今天） */
export function calendarDayFromIso(iso: string): string {
  const t = iso.trim();
  if (t.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const dt = new Date(t);
  if (Number.isNaN(dt.getTime())) return calendarTodayLocal();
  return calendarTodayLocal(dt);
}

export function addCalendarDaysLocal(day: string, days: number): string {
  const [y, m, d] = day.split("-").map((x) => Number(x));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return calendarTodayLocal(dt);
}

/** 从 start 到 end（含）逐日列出 yyyy-MM-dd；若 start>end 返回空数组 */
export function iterCalendarDaysInclusive(start: string, end: string): string[] {
  if (start > end) return [];
  const out: string[] = [];
  let cur = start;
  for (;;) {
    out.push(cur);
    if (cur === end) break;
    cur = addCalendarDaysLocal(cur, 1);
  }
  return out;
}

/** 组句/句子填空：忽略首尾空白并将连续空白压成单一半角空格，便于与题库 `jpAnswer` 比较 */
export function normalizePracticeWhitespace(s: string): string {
  return s.trim().split(/\s+/).filter(Boolean).join(" ");
}

/**
 * 句子拖拽题 token 生成：
 * - 若答案已包含空格，按空格切词；
 * - 否则回退为逐字符切分（去除空白），确保拖拽至少可操作。
 */
export function tokenizeSentenceForDrag(jpAnswer: string): string[] {
  const normalized = normalizePracticeWhitespace(jpAnswer);
  if (!normalized) return [];
  const bySpace = normalized.split(" ").filter(Boolean);
  if (bySpace.length >= 2) return bySpace;
  const rough = normalized.match(/[一-龥々〆ヵヶ]+|[ぁ-ゖゝゞー]+|[ァ-ヺー]+|[a-zA-Z0-9]+|[、。！？.,!?]|[^\s]/gu) ?? [];
  return rough.filter((x) => x.trim().length > 0);
}

/** 单词填空：日语词条比对（NFKC、首尾空白、连续空白压一格） */
export function normalizeJaTermForPractice(s: string): string {
  try {
    return s.normalize("NFKC").trim().replace(/\s+/g, " ");
  } catch {
    return s.trim().replace(/\s+/g, " ");
  }
}

/** 单词填空：中文义项宽松比对（NFKC、去常见标点与空白） */
export function normalizeZhMeaningForPractice(s: string): string {
  let t: string;
  try {
    t = s.normalize("NFKC");
  } catch {
    t = s;
  }
  return t
    .trim()
    .replace(/\s+/g, "")
    .replace(/[。、，,.!?！？；:;（）()\[\]「」『』【】［］"'"、]/g, "")
    .toLowerCase();
}

export function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 剥离模型可能包裹的 ```json 围栏后解析 JSON 对象 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  let t = raw.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function splitExamplesFromLesson(content: string): string[] {
  return content
    .split(/\n|。/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 从课文截取「含该词条」的第一条短句作为例句（按换行与中日英句末标点切分），不调 AI。
 * 过长截断；找不到则返回空串。
 */
export function extractExampleSegmentForTerm(content: string, term: string, maxLen = 80): string {
  const norm = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const t = term.trim();
  if (!t) return "";
  const pieces = norm
    .split(/[\n。．.!?！？]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const p of pieces) {
    if (p.includes(t)) {
      return p.length <= maxLen ? p : `${p.slice(0, maxLen)}…`;
    }
  }
  return "";
}

/** 按换行与句末标点切成「小句」列表，供分句朗读与课文导出（与例句截取切分一致） */
export function splitLessonIntoSentences(content: string): string[] {
  const norm = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return norm
    .split(/[\n。．.!?！？]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export type LessonSentenceSpan = { jp: string; start: number; end: number };
export type ParsedVideoCue = { startSec: number; endSec: number; text: string };

/** 与 {@link splitLessonIntoSentences} 同序，并给出在统一换行后正文中的区间，便于对齐行译 */
export function splitLessonIntoSentenceSpans(content: string): LessonSentenceSpan[] {
  const norm = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const pieces = splitLessonIntoSentences(content);
  const spans: LessonSentenceSpan[] = [];
  let searchFrom = 0;
  for (const jp of pieces) {
    if (!jp) continue;
    const idx = norm.indexOf(jp, searchFrom);
    if (idx === -1) {
      spans.push({ jp, start: searchFrom, end: searchFrom });
      continue;
    }
    spans.push({ jp, start: idx, end: idx + jp.length });
    searchFrom = idx + jp.length;
    while (searchFrom < norm.length && /[\n。．.!?！？\s]/u.test(norm[searchFrom]!)) {
      searchFrom += 1;
    }
  }
  return spans;
}

/** 将小句在课文中的字符区间映射为所覆盖正文行的已存译文（与 lineZh 行对齐） */
export function zhHintForSentenceSpan(content: string, lineZh: string[], start: number, end: number): string {
  if (end <= start) return "";
  const norm = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lineStart = (norm.slice(0, Math.max(0, start)).match(/\n/g) || []).length;
  const lineEnd = (norm.slice(0, Math.min(end, norm.length)).match(/\n/g) || []).length;
  const parts: string[] = [];
  for (let L = lineStart; L <= lineEnd && L < lineZh.length; L++) {
    const t = lineZh[L]?.trim();
    if (t) parts.push(t);
  }
  return parts.join(" ").trim();
}

function parseSrtTimeToSec(raw: string): number | null {
  const t = raw.trim().replace(",", ".");
  const m = t.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const ms = Number((m[4] ?? "0").padEnd(3, "0"));
  if ([hh, mm, ss, ms].some((n) => !Number.isFinite(n))) return null;
  return hh * 3600 + mm * 60 + ss + ms / 1000;
}

/** SRT 文本解析为视频 cue（失败行自动跳过，结果按 startSec 升序） */
export function parseSrtToVideoCues(srt: string): ParsedVideoCue[] {
  const norm = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!norm) return [];
  const blocks = norm.split(/\n\s*\n/);
  const out: ParsedVideoCue[] = [];
  for (const blk of blocks) {
    const lines = blk
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (lines.length < 2) continue;
    const timeLine = lines.find((x) => x.includes("-->"));
    if (!timeLine) continue;
    const [a, b] = timeLine.split("-->").map((x) => x.trim());
    const startSec = parseSrtTimeToSec(a);
    const endSec = parseSrtTimeToSec(b);
    if (startSec === null || endSec === null || endSec <= startSec) continue;
    const text = lines.filter((x) => x !== timeLine && !/^\d+$/.test(x)).join(" ").trim();
    if (!text) continue;
    out.push({ startSec, endSec, text });
  }
  out.sort((x, y) => x.startSec - y.startSec);
  return out;
}

/**
 * 解析形如 `(0:07) 文本... (0:16) 文本...` 的时间戳字幕文本。
 * - 每个时间戳后的正文作为一个 cue；
 * - `endSec` 取下一条 `startSec`，最后一条默认 +8 秒；
 * - 若出现同秒时间戳，自动至少 +0.5 秒避免零长度区间。
 */
export function parseTimestampedTranscriptToVideoCues(raw: string): ParsedVideoCue[] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const re = /\((\d{1,2}):(\d{2})\)/g;
  const marks: Array<{ at: number; sec: number }> = [];
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(text))) {
    const mm = Number(m[1]);
    const ss = Number(m[2]);
    if (!Number.isFinite(mm) || !Number.isFinite(ss)) continue;
    marks.push({ at: m.index, sec: mm * 60 + ss });
  }
  if (marks.length === 0) return [];
  const out: ParsedVideoCue[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const cur = marks[i]!;
    const next = marks[i + 1];
    const start = cur.at;
    const bodyStart = text.indexOf(")", start);
    if (bodyStart < 0) continue;
    const bodyEnd = next ? next.at : text.length;
    const cueText = text
      .slice(bodyStart + 1, bodyEnd)
      .replace(/\s+/g, " ")
      .trim();
    if (!cueText) continue;
    const nextSec = next ? next.sec : cur.sec + 8;
    const endSec = nextSec > cur.sec ? nextSec : cur.sec + 0.5;
    out.push({ startSec: cur.sec, endSec, text: cueText });
  }
  return out;
}

/**
 * 划选「要挖空的原文」→ 在含该串的第一条小句内把该串替换为 ___（小句：换行或常见句末标点切分）。
 * 若划选里已有 ___ 则返回 null；找不到含选段的片段也返回 null。
 */
export function buildGrammarPromptFromSelection(content: string, selected: string): string | null {
  const norm = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const t = selected.trim();
  if (!t || t.includes("___")) return null;
  const pieces = norm
    .split(/[\n。．.!?！？]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const p of pieces) {
    if (!p.includes(t)) continue;
    const idx = p.indexOf(t);
    return `${p.slice(0, idx)}___${p.slice(idx + t.length)}`;
  }
  return null;
}

export function inMotivationWindow(date = new Date()): "dawn" | "night" | null {
  const hour = date.getHours();
  if (hour >= 5 && hour <= 8) {
    return "dawn";
  }
  if (hour >= 20 || hour <= 1) {
    return "night";
  }
  return null;
}

export function stableShuffle(words: string[], seed: string): string[] {
  const arr = [...words];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  for (let i = arr.length - 1; i > 0; i -= 1) {
    hash = (hash * 1664525 + 1013904223) >>> 0;
    const j = hash % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 课文正文按行拆分（统一换行符） */
export function lessonContentLines(content: string): string[] {
  const body = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return body.split("\n");
}

/** 将已存译文数组与当前正文行数对齐，缺行补空串，多行截断 */
export function alignLineTranslations(content: string, existing?: string[]): string[] {
  const lines = lessonContentLines(content);
  const out = lines.map((_, i) => (existing?.[i] ?? "").trimEnd());
  return out;
}

