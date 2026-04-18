import { describe, expect, it } from "vitest";
import { normalizeAppData } from "@/modules/storage/dataStore";
import type { AppData } from "@/shared/types";
import { mergeAppDataLocalAndRemote, type MergeConflictPicks } from "./cloudAppDataMerge";

const emptyBase: AppData = {
  lessons: [],
  vocabCards: [],
  sentenceTasks: [],
  grammarTasks: [],
  chatSessions: [],
  lessonNotes: [],
  favoriteSentences: [],
};

describe("mergeAppDataLocalAndRemote", () => {
  it("sums global practice counters and daily buckets", () => {
    const local = normalizeAppData({
      ...emptyBase,
      stats: {
        practiceMarkCorrect: 2,
        practiceMarkWrong: 1,
        practiceMarkEasy: 0,
        daily: {
          "2026-04-01": {
            practiceMarkCorrect: 1,
            practiceMarkWrong: 0,
            practiceMarkEasy: 0,
            dwellLessonReaderSec: 10,
            dwellPracticeSec: 5,
          },
        },
      },
    });
    const remote = normalizeAppData({
      ...emptyBase,
      stats: {
        practiceMarkCorrect: 3,
        practiceMarkWrong: 0,
        practiceMarkEasy: 1,
        daily: {
          "2026-04-01": {
            practiceMarkCorrect: 0,
            practiceMarkWrong: 2,
            practiceMarkEasy: 0,
            dwellLessonReaderSec: 3,
            dwellPracticeSec: 1,
          },
        },
      },
    });
    const m = mergeAppDataLocalAndRemote(local, remote);
    expect(m.stats?.practiceMarkCorrect).toBe(5);
    expect(m.stats?.practiceMarkWrong).toBe(1);
    expect(m.stats?.practiceMarkEasy).toBe(1);
    expect(m.stats?.daily?.["2026-04-01"]?.practiceMarkCorrect).toBe(1);
    expect(m.stats?.daily?.["2026-04-01"]?.practiceMarkWrong).toBe(2);
    expect(m.stats?.daily?.["2026-04-01"]?.dwellLessonReaderSec).toBe(13);
  });

  it("keeps newer lesson by updatedAt when ids collide", () => {
    const oldLesson = {
      id: "l1",
      name: "old",
      content: "a\n",
      category: "未分类",
      author: "著者不明",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      lessonKind: "text" as const,
    };
    const newLesson = {
      ...oldLesson,
      name: "new",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    const local = normalizeAppData({ ...emptyBase, lessons: [oldLesson] });
    const remote = normalizeAppData({ ...emptyBase, lessons: [newLesson] });
    const mL = mergeAppDataLocalAndRemote(local, remote);
    expect(mL.lessons[0]?.name).toBe("new");
    const mR = mergeAppDataLocalAndRemote(remote, local);
    expect(mR.lessons[0]?.name).toBe("new");
  });

  it("merges mediaLibrary with local keys winning (仅保留仍被课文引用的库键)", () => {
    const lessonLocalOnly = {
      id: "l1",
      name: "a",
      content: "x\n",
      category: "未分类",
      author: "著者不明",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lessonKind: "text" as const,
      coverIllustrationMediaKey: "k1",
    };
    const lessonRemoteOnly = {
      id: "l2",
      name: "b",
      content: "y\n",
      category: "未分类",
      author: "著者不明",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      lessonKind: "text" as const,
      coverIllustrationMediaKey: "k2",
    };
    const local = normalizeAppData({
      ...emptyBase,
      lessons: [lessonLocalOnly],
      mediaLibrary: { k1: { kind: "cover" as const, dataUrl: "data:image/png;base64,TE9DQUw=" } },
    });
    const remote = normalizeAppData({
      ...emptyBase,
      lessons: [lessonRemoteOnly],
      mediaLibrary: {
        k1: { kind: "cover" as const, dataUrl: "data:image/png;base64,UkVNT1RF" },
        k2: { kind: "cover" as const, dataUrl: "data:image/png;base64,T05MWVJFTQ==" },
      },
    });
    const m = mergeAppDataLocalAndRemote(local, remote);
    expect(m.lessons.map((l) => l.id).sort()).toEqual(["l1", "l2"]);
    expect(m.mediaLibrary?.k1.dataUrl).toBe("data:image/png;base64,TE9DQUw=");
    expect(m.mediaLibrary?.k2.dataUrl).toBe("data:image/png;base64,T05MWVJFTQ==");
  });

  it("honors conflict picks: force older local lesson over newer remote", () => {
    const oldLesson = {
      id: "l1",
      name: "local-wins",
      content: "a\n",
      category: "未分类",
      author: "著者不明",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      lessonKind: "text" as const,
    };
    const newLesson = {
      ...oldLesson,
      name: "remote-newer",
      updatedAt: "2026-01-10T00:00:00.000Z",
    };
    const local = normalizeAppData({ ...emptyBase, lessons: [oldLesson] });
    const remote = normalizeAppData({ ...emptyBase, lessons: [newLesson] });
    const picks: MergeConflictPicks = { lessons: { l1: "local" } };
    const m = mergeAppDataLocalAndRemote(local, remote, picks);
    expect(m.lessons[0]?.name).toBe("local-wins");
    const m2 = mergeAppDataLocalAndRemote(local, remote, { lessons: { l1: "remote" } });
    expect(m2.lessons[0]?.name).toBe("remote-newer");
  });
});
