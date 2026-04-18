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
import type { MergeSliceKey } from "./cloudMergePreview";
import { rowsForSlice } from "./cloudMergePreview";

function truncOneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/**
 * 合并前「人话」提示：不替代 JSON 技术对比，帮助不懂字段名的用户猜侧哪边更像自己要的。
 * 每条最多返回 `cap` 句。
 */
export function humanMergeConflictHints(
  local: AppData,
  remote: AppData,
  sliceKey: MergeSliceKey,
  id: string,
  cap = 4,
): string[] {
  const l = normalizeAppData(local);
  const r = normalizeAppData(remote);
  const lr = rowsForSlice(l, sliceKey).find((x) => x.id === id) as unknown;
  const rr = rowsForSlice(r, sliceKey).find((x) => x.id === id) as unknown;
  if (!lr || !rr) return [];
  const out: string[] = [];

  switch (sliceKey) {
    case "lessons": {
      const a = lr as Lesson;
      const b = rr as Lesson;
      if (a.name !== b.name) {
        out.push(`标题不同：本「${truncOneLine(a.name, 36)}」／云「${truncOneLine(b.name, 36)}」`);
      }
      if (a.content !== b.content) {
        out.push(`正文：本约 ${a.content.length} 字／云约 ${b.content.length} 字（规范化换行后比较）`);
        const la = (a.content.split("\n")[0] ?? "").trim();
        const lb = (b.content.split("\n")[0] ?? "").trim();
        if (la !== lb) {
          out.push(`首行预览：本「${truncOneLine(la, 48)}」／云「${truncOneLine(lb, 48)}」`);
        }
      }
      if (a.updatedAt !== b.updatedAt) {
        out.push(`本机 updatedAt：${a.updatedAt}；云端：${b.updatedAt}（「自动」会选较新）`);
      }
      break;
    }
    case "vocabCards": {
      const a = lr as VocabCard;
      const b = rr as VocabCard;
      if (a.term !== b.term) out.push(`词条不同：本「${truncOneLine(a.term, 28)}」／云「${truncOneLine(b.term, 28)}」`);
      const m0 = a.meanings?.[0]?.zh ?? "";
      const m1 = b.meanings?.[0]?.zh ?? "";
      if (m0 !== m1) out.push(`义项1（中文）：本「${truncOneLine(m0, 36)}」／云「${truncOneLine(m1, 36)}」`);
      break;
    }
    case "sentenceTasks": {
      const a = lr as SentenceTask;
      const b = rr as SentenceTask;
      if (a.zh !== b.zh) out.push(`中文题面不同：本「${truncOneLine(a.zh, 36)}」／云「${truncOneLine(b.zh, 36)}」`);
      if (a.jpAnswer !== b.jpAnswer) out.push(`日文参考答案不同（长度 本 ${a.jpAnswer.length}／云 ${b.jpAnswer.length}）`);
      break;
    }
    case "grammarTasks": {
      const a = lr as GrammarTask;
      const b = rr as GrammarTask;
      if (a.prompt !== b.prompt) out.push(`题干不同：本「${truncOneLine(a.prompt, 40)}」／云「${truncOneLine(b.prompt, 40)}」`);
      break;
    }
    case "chatSessions": {
      const a = lr as ChatSession;
      const b = rr as ChatSession;
      if (a.title !== b.title) out.push(`会话标题：本「${truncOneLine(a.title, 32)}」／云「${truncOneLine(b.title, 32)}」`);
      const la = a.messages?.length ?? 0;
      const lb = b.messages?.length ?? 0;
      if (la !== lb) out.push(`消息条数：本 ${la} 条／云 ${lb} 条`);
      const t0 = a.messages?.[0]?.content ?? "";
      const u0 = b.messages?.[0]?.content ?? "";
      if (t0 !== u0 && (t0 || u0)) {
        out.push(`首条消息：本「${truncOneLine(t0, 36)}」／云「${truncOneLine(u0, 36)}」`);
      }
      break;
    }
    case "lessonNotes": {
      const a = lr as LessonNote;
      const b = rr as LessonNote;
      if (a.content !== b.content) {
        out.push(`笔记正文长度：本 ${a.content.length}／云 ${b.content.length}`);
        out.push(`开头：本「${truncOneLine(a.content, 40)}」／云「${truncOneLine(b.content, 40)}」`);
      }
      break;
    }
    case "favoriteSentences": {
      const a = lr as LessonFavoriteSentence;
      const b = rr as LessonFavoriteSentence;
      if (a.jp !== b.jp) {
        out.push(`收藏句：本「${truncOneLine(a.jp, 44)}」／云「${truncOneLine(b.jp, 44)}」`);
      }
      break;
    }
    default:
      break;
  }

  return out.slice(0, cap);
}
