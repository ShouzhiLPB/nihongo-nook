import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppData } from "@/shared/types";
import { calendarTodayLocal } from "@/shared/utils";
import { resolveLessonCoverSrc } from "./mediaDedupe";

describe("resolveLessonCoverSrc", () => {
  it("returns https image URL for list / reader thumbnails", () => {
    const lesson = {
      id: "l1",
      name: "x",
      content: "a\n",
      category: "未分类",
      author: "著者不明",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lessonKind: "text" as const,
      coverIllustrationDataUrl: "  https://example.com/a.png  ",
    };
    expect(resolveLessonCoverSrc(lesson, undefined)).toBe("https://example.com/a.png");
  });
});
import {
  bumpPracticeMarkStats,
  LEGACY_SINGLE_VIDEO_LESSON_FALLBACK_URL,
  mergeDwellSecondsIntoStats,
  migrateLegacySingleEmbeddedVideoLesson,
  normalizeAppData,
  pruneOrphanLessonScopedEntries,
} from "./dataStore";

describe("bumpPracticeMarkStats", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("increments from undefined and writes daily bucket", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 10, 12, 0, 0));
    const day = calendarTodayLocal();
    expect(bumpPracticeMarkStats(undefined, "correct")).toEqual({
      practiceMarkCorrect: 1,
      practiceMarkWrong: 0,
      practiceMarkEasy: 0,
      dwellLessonReaderSec: 0,
      dwellPracticeSec: 0,
      daily: {
        [day]: {
          practiceMarkCorrect: 1,
          practiceMarkWrong: 0,
          practiceMarkEasy: 0,
          dwellLessonReaderSec: 0,
          dwellPracticeSec: 0,
        },
      },
    });
  });

  it("increments each field", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 8, 0, 0));
    const base = { practiceMarkCorrect: 2, practiceMarkWrong: 1, practiceMarkEasy: 4 };
    expect(bumpPracticeMarkStats(base, "wrong").practiceMarkWrong).toBe(2);
    expect(bumpPracticeMarkStats(base, "easy").practiceMarkEasy).toBe(5);
  });
});

describe("normalizeAppData stats", () => {
  it("fills missing stats with zeros", () => {
    const raw = {
      lessons: [],
      vocabCards: [],
      sentenceTasks: [],
      grammarTasks: [],
      chatSessions: [],
      lessonNotes: [],
      favoriteSentences: [],
    } as AppData;
    const n = normalizeAppData(raw);
    expect(n.stats).toEqual({
      practiceMarkCorrect: 0,
      practiceMarkWrong: 0,
      practiceMarkEasy: 0,
      dwellLessonReaderSec: 0,
      dwellPracticeSec: 0,
      daily: {},
    });
  });

  it("floors negative junk from import", () => {
    const raw = {
      lessons: [],
      vocabCards: [],
      sentenceTasks: [],
      grammarTasks: [],
      chatSessions: [],
      lessonNotes: [],
      favoriteSentences: [],
      stats: { practiceMarkCorrect: -3, practiceMarkWrong: 1.9, practiceMarkEasy: NaN },
    } as unknown as AppData;
    const n = normalizeAppData(raw);
    expect(n.stats).toEqual({
      practiceMarkCorrect: 0,
      practiceMarkWrong: 1,
      practiceMarkEasy: 0,
      dwellLessonReaderSec: 0,
      dwellPracticeSec: 0,
      daily: {},
    });
  });
});

describe("normalizeAppData media dedupe (i2-3)", () => {
  it("merges identical cover data URLs into one mediaLibrary entry", () => {
    const sharedCover = "data:image/png;base64,TESTDEDUPE";
    const baseLesson = {
      name: "L",
      content: "あ\n",
      category: "未分类",
      author: "著者不明",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lessonKind: "text" as const,
    };
    const raw = {
      lessons: [
        { ...baseLesson, id: "lesson-a", coverIllustrationDataUrl: sharedCover },
        { ...baseLesson, id: "lesson-b", coverIllustrationDataUrl: sharedCover },
      ],
      vocabCards: [],
      sentenceTasks: [],
      grammarTasks: [],
      chatSessions: [],
      lessonNotes: [],
      favoriteSentences: [],
    } as AppData;
    const n = normalizeAppData(raw);
    expect(n.lessons[0]?.coverIllustrationDataUrl).toBeUndefined();
    expect(n.lessons[1]?.coverIllustrationDataUrl).toBeUndefined();
    const k0 = n.lessons[0]?.coverIllustrationMediaKey;
    const k1 = n.lessons[1]?.coverIllustrationMediaKey;
    expect(k0).toBeTruthy();
    expect(k0).toBe(k1);
    expect(Object.keys(n.mediaLibrary ?? {}).length).toBe(1);
    expect(resolveLessonCoverSrc(n.lessons[0]!, n.mediaLibrary)).toBe(sharedCover);
  });
});

describe("migrateLegacySingleEmbeddedVideoLesson", () => {
  const baseVideo = {
    id: "v1",
    name: "Vid",
    content: "a\n",
    category: "未分类",
    author: "著者不明",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lessonKind: "video" as const,
    videoSourceUrl: "data:video/mp4;base64,QUJD",
  };

  it("when exactly one non-http video lesson, rewrites to fallback YouTube URL and drops media key", () => {
    const ml = { mk1: { kind: "videoData" as const, dataUrl: "data:video/mp4;base64,QQ==" } };
    const lessons = [{ ...baseVideo, videoSourceUrl: undefined, videoSourceMediaKey: "mk1" }];
    const out = migrateLegacySingleEmbeddedVideoLesson(lessons, ml);
    expect(out.lessons[0]?.videoSourceUrl).toBe(LEGACY_SINGLE_VIDEO_LESSON_FALLBACK_URL);
    expect(out.lessons[0]?.videoSourceMediaKey).toBeUndefined();
    expect(out.mediaLibrary).toBeUndefined();
  });

  it("normalizeAppData applies migration before dedupe", () => {
    const raw = {
      lessons: [{ ...baseVideo }],
      vocabCards: [],
      sentenceTasks: [],
      grammarTasks: [],
      chatSessions: [],
      lessonNotes: [],
      favoriteSentences: [],
    } as AppData;
    const n = normalizeAppData(raw);
    expect(n.lessons[0]?.videoSourceUrl).toBe(LEGACY_SINGLE_VIDEO_LESSON_FALLBACK_URL);
    expect(n.lessons[0]?.videoSourceUrl?.startsWith("data:")).toBe(false);
  });

  it("does not rewrite when two embedded video lessons exist", () => {
    const a = { ...baseVideo, id: "a" };
    const b = { ...baseVideo, id: "b", name: "V2" };
    const out = migrateLegacySingleEmbeddedVideoLesson([a, b], undefined);
    expect(out.lessons[0]).toEqual(a);
    expect(out.lessons[1]).toEqual(b);
  });
});

describe("pruneOrphanLessonScopedEntries", () => {
  it("drops vocab and notes whose lessonId is missing from lessons", () => {
    const baseLesson = {
      id: "l1",
      name: "A",
      content: "x\n",
      category: "未分类",
      author: "著者不明",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lessonKind: "text" as const,
    };
    const raw = {
      lessons: [baseLesson],
      vocabCards: [
        {
          id: "v1",
          lessonId: "l1",
          term: "a",
          kana: "a",
          meanings: [{ zh: "a", example: "a" }],
          etymology: "",
          vocabDistractors: ["b", "c", "d"],
          vocabZhDistractors: ["b", "c", "d"],
          latestExample: "",
          mastery: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "v2",
          lessonId: "gone",
          term: "b",
          kana: "b",
          meanings: [{ zh: "b", example: "b" }],
          etymology: "",
          vocabDistractors: ["c", "d", "e"],
          vocabZhDistractors: ["c", "d", "e"],
          latestExample: "",
          mastery: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sentenceTasks: [],
      grammarTasks: [],
      chatSessions: [{ id: "c1", lessonId: "gone", title: "t", mode: "fast" as const, messages: [], createdAt: "t", updatedAt: "t" }],
      lessonNotes: [{ id: "n1", lessonId: "l1", content: "n", createdAt: "t", updatedAt: "t" }],
      favoriteSentences: [],
    } as AppData;
    const p = pruneOrphanLessonScopedEntries(raw);
    expect(p.vocabCards).toHaveLength(1);
    expect(p.vocabCards[0]?.id).toBe("v1");
    expect(p.chatSessions).toHaveLength(0);
    expect(p.lessonNotes).toHaveLength(1);
  });
});

describe("mergeDwellSecondsIntoStats", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds dwell deltas", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 10, 0, 0));
    const day = calendarTodayLocal();
    const base = {
      practiceMarkCorrect: 0,
      practiceMarkWrong: 0,
      practiceMarkEasy: 0,
      dwellLessonReaderSec: 10,
      dwellPracticeSec: 5,
    };
    const n = mergeDwellSecondsIntoStats(base, { lessonReaderSec: 3, practiceSec: 2 });
    expect(n.dwellLessonReaderSec).toBe(13);
    expect(n.dwellPracticeSec).toBe(7);
    expect(n.daily?.[day]).toEqual({
      practiceMarkCorrect: 0,
      practiceMarkWrong: 0,
      practiceMarkEasy: 0,
      dwellLessonReaderSec: 3,
      dwellPracticeSec: 2,
    });
  });
});
