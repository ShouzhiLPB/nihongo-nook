import { describe, expect, it } from "vitest";
import { normalizeAppData } from "@/modules/storage/dataStore";
import type { AppData } from "@/shared/types";
import { humanMergeConflictHints } from "./cloudMergeHumanDiff";

const empty: AppData = {
  lessons: [],
  vocabCards: [],
  sentenceTasks: [],
  grammarTasks: [],
  chatSessions: [],
  lessonNotes: [],
  favoriteSentences: [],
};

const lesson = (id: string, name: string, content: string, updatedAt: string): AppData["lessons"][number] => ({
  id,
  name,
  content: `${content}\n`,
  category: "未分类",
  author: "著者不明",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
  lessonKind: "text",
});

describe("humanMergeConflictHints", () => {
  it("describes lesson title and first line diff", () => {
    const local = normalizeAppData({
      ...empty,
      lessons: [lesson("l1", "甲课文", "第一行本\n第二", "2026-01-02T00:00:00.000Z")],
    });
    const remote = normalizeAppData({
      ...empty,
      lessons: [lesson("l1", "乙课文", "第一行云\n", "2026-01-03T00:00:00.000Z")],
    });
    const h = humanMergeConflictHints(local, remote, "lessons", "l1");
    expect(h.some((x) => x.includes("标题不同"))).toBe(true);
    expect(h.some((x) => x.includes("首行预览"))).toBe(true);
  });
});
