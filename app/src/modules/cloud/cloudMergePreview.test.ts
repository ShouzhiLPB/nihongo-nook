import { describe, expect, it } from "vitest";
import { normalizeAppData } from "@/modules/storage/dataStore";
import type { AppData } from "@/shared/types";
import {
  filterIdsBySubstring,
  getMergeRowNormalizedJsonPair,
  getMergeStatsJsonPair,
  summarizeAppDataMerge,
} from "./cloudMergePreview";

const empty: AppData = {
  lessons: [],
  vocabCards: [],
  sentenceTasks: [],
  grammarTasks: [],
  chatSessions: [],
  lessonNotes: [],
  favoriteSentences: [],
};

const lesson = (id: string, name: string, updatedAt: string): AppData["lessons"][number] => ({
  id,
  name,
  content: "a\n",
  category: "未分类",
  author: "著者不明",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
  lessonKind: "text",
});

describe("filterIdsBySubstring", () => {
  it("returns copy when query empty", () => {
    const ids = ["a1", "b2"];
    const out = filterIdsBySubstring(ids, "   ");
    expect(out).toEqual(ids);
    expect(out).not.toBe(ids);
  });

  it("filters case-insensitively", () => {
    expect(filterIdsBySubstring(["Lesson_ABC", "x"], "abc")).toEqual(["Lesson_ABC"]);
  });
});

describe("summarizeAppDataMerge", () => {
  it("detects only-local and only-remote lesson ids", () => {
    const local = normalizeAppData({ ...empty, lessons: [lesson("l1", "A", "2026-01-02T00:00:00.000Z")] });
    const remote = normalizeAppData({ ...empty, lessons: [lesson("l2", "B", "2026-01-03T00:00:00.000Z")] });
    const p = summarizeAppDataMerge(local, remote);
    const le = p.collections.find((c) => c.sliceKey === "lessons")!;
    expect(le.localOnly).toEqual(["l1"]);
    expect(le.remoteOnly).toEqual(["l2"]);
    expect(le.conflicting).toEqual([]);
  });

  it("flags same-id lessons when normalized payloads differ", () => {
    const local = normalizeAppData({ ...empty, lessons: [lesson("l1", "A", "2026-01-02T00:00:00.000Z")] });
    const remote = normalizeAppData({ ...empty, lessons: [lesson("l1", "B", "2026-01-02T00:00:00.000Z")] });
    const p = summarizeAppDataMerge(local, remote);
    const le = p.collections.find((c) => c.sliceKey === "lessons")!;
    expect(le.conflicting).toEqual(["l1"]);
  });

  it("getMergeRowNormalizedJsonPair: only-local id has empty remoteJson", () => {
    const local = normalizeAppData({ ...empty, lessons: [lesson("l1", "A", "2026-01-02T00:00:00.000Z")] });
    const remote = normalizeAppData({ ...empty, lessons: [] });
    const p = getMergeRowNormalizedJsonPair(local, remote, "lessons", "l1");
    expect(p.localJson.length).toBeGreaterThan(2);
    expect(p.remoteJson).toBe("");
  });

  it("getMergeRowNormalizedJsonPair matches summarize conflicting detection", () => {
    const local = normalizeAppData({ ...empty, lessons: [lesson("l1", "A", "2026-01-02T00:00:00.000Z")] });
    const remote = normalizeAppData({ ...empty, lessons: [lesson("l1", "B", "2026-01-02T00:00:00.000Z")] });
    const p = getMergeRowNormalizedJsonPair(local, remote, "lessons", "l1");
    expect(p.localJson).not.toBe(p.remoteJson);
    expect(summarizeAppDataMerge(local, remote).collections.find((c) => c.sliceKey === "lessons")!.conflicting).toContain("l1");
  });

  it("getMergeStatsJsonPair surfaces stats subtree", () => {
    const a = normalizeAppData({
      ...empty,
      stats: { practiceMarkCorrect: 1, practiceMarkWrong: 0, practiceMarkEasy: 0 },
    });
    const b = normalizeAppData({
      ...empty,
      stats: { practiceMarkCorrect: 2, practiceMarkWrong: 0, practiceMarkEasy: 0 },
    });
    const p = getMergeStatsJsonPair(a, b);
    expect(p.localJson).toContain("1");
    expect(p.remoteJson).toContain("2");
  });

  it("statsWillSum when stats JSON differs", () => {
    const a = normalizeAppData({
      ...empty,
      stats: { practiceMarkCorrect: 1, practiceMarkWrong: 0, practiceMarkEasy: 0 },
    });
    const b = normalizeAppData({
      ...empty,
      stats: { practiceMarkCorrect: 2, practiceMarkWrong: 0, practiceMarkEasy: 0 },
    });
    expect(summarizeAppDataMerge(a, b).statsWillSum).toBe(true);
    const twin = normalizeAppData({
      ...empty,
      stats: { practiceMarkCorrect: 1, practiceMarkWrong: 0, practiceMarkEasy: 0 },
    });
    expect(summarizeAppDataMerge(a, twin).statsWillSum).toBe(false);
  });
});
