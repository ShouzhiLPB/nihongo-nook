import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { AppData } from "@/shared/types";
import { normalizeAppData } from "@/modules/storage/dataStore";
import {
  appDataIsBareShellForCloudUpload,
  getCloudRestoreScenario,
  LS_CLOUD_FP_PKG_PREFIX,
  LS_CLOUD_LAST_SEEN_REMOTE_AT_PREFIX,
  shouldBlockBareShellUploadOverRemotePayload,
  USER_APP_DATA_TABLE,
  type CloudSyncFingerprintPkg,
  fingerprintAppData,
  fingerprintAppDataExcludingStats,
  fingerprintChatSessionsSubtree,
  fingerprintContentCore,
  fingerprintFavoriteSentencesSubtree,
  fingerprintGrammarTasksSubtree,
  fingerprintLessonNotesSubtree,
  fingerprintLessonsSubtree,
  fingerprintMediaLibrarySubtree,
  fingerprintSentenceTasksSubtree,
  fingerprintStatsSubtree,
  fingerprintVocabCardsSubtree,
  isCloudUpdatedAfterLastSeen,
  localAppDataLooksNonEmpty,
  learningCoreEntryCount,
  payloadDeltaHasEmptyMainArray,
  planCloudAutoSync,
  PATCH_LESSON_PAYLOAD_RPC,
  PATCH_FAVORITE_SENTENCE_PAYLOAD_RPC,
  PATCH_GRAMMAR_TASK_PAYLOAD_RPC,
  PATCH_LESSON_NOTE_PAYLOAD_RPC,
  PATCH_SENTENCE_TASK_PAYLOAD_RPC,
  PATCH_VOCAB_CARD_PAYLOAD_RPC,
  patchFavoriteSentencePayloadInCloud,
  patchGrammarTaskPayloadInCloud,
  patchLessonNotePayloadInCloud,
  patchLessonPayloadInCloud,
  patchSentenceTaskPayloadInCloud,
  patchVocabCardPayloadInCloud,
  pickLessonPayloadCloudPatch,
} from "./cloudUserAppData";

describe("cloudUserAppData", () => {
  it("uses stable public table name for migrations + client", () => {
    expect(USER_APP_DATA_TABLE).toBe("user_app_data");
  });

  it("PATCH_LESSON_PAYLOAD_RPC matches migration function name", () => {
    expect(PATCH_LESSON_PAYLOAD_RPC).toBe("jp_learn_patch_lesson_payload");
  });

  it("PATCH_VOCAB_CARD_PAYLOAD_RPC matches migration function name", () => {
    expect(PATCH_VOCAB_CARD_PAYLOAD_RPC).toBe("jp_learn_patch_vocab_card_payload");
  });

  it("PATCH_SENTENCE_TASK_PAYLOAD_RPC matches migration function name", () => {
    expect(PATCH_SENTENCE_TASK_PAYLOAD_RPC).toBe("jp_learn_patch_sentence_task_payload");
  });

  it("PATCH_GRAMMAR_TASK_PAYLOAD_RPC matches migration function name", () => {
    expect(PATCH_GRAMMAR_TASK_PAYLOAD_RPC).toBe("jp_learn_patch_grammar_task_payload");
  });

  it("PATCH_LESSON_NOTE_PAYLOAD_RPC matches migration function name", () => {
    expect(PATCH_LESSON_NOTE_PAYLOAD_RPC).toBe("jp_learn_patch_lesson_note_payload");
  });

  it("PATCH_FAVORITE_SENTENCE_PAYLOAD_RPC matches migration function name", () => {
    expect(PATCH_FAVORITE_SENTENCE_PAYLOAD_RPC).toBe("jp_learn_patch_favorite_sentence_payload");
  });

  it("patchLessonPayloadInCloud returns null when RPC is not deployed", async () => {
    const sb = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } }),
    } as unknown as SupabaseClient;
    await expect(patchLessonPayloadInCloud(sb, "l1", { name: "x" })).resolves.toBeNull();
  });

  it("patchLessonPayloadInCloud returns null on empty patch keys", async () => {
    const sb = { rpc: vi.fn() } as unknown as SupabaseClient;
    await expect(patchLessonPayloadInCloud(sb, "l1", {})).resolves.toBeNull();
    expect((sb as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });

  it("patchLessonPayloadInCloud returns ISO string on success", async () => {
    const iso = "2026-04-25T12:00:00.000Z";
    const sb = {
      rpc: vi.fn().mockResolvedValue({ data: iso, error: null }),
    } as unknown as SupabaseClient;
    await expect(patchLessonPayloadInCloud(sb, "l1", { name: "n", updatedAt: iso })).resolves.toBe(iso);
  });

  it("pickLessonPayloadCloudPatch picks translation + lines and fills updatedAt", () => {
    const iso = "2026-04-26T00:00:00.000Z";
    const p = pickLessonPayloadCloudPatch({ translationVisible: false, lineTranslations: ["a", ""] }, iso);
    expect(p).toEqual({
      translationVisible: false,
      lineTranslations: ["a", ""],
      updatedAt: iso,
    });
  });

  it("pickLessonPayloadCloudPatch keeps explicit updatedAt", () => {
    const p = pickLessonPayloadCloudPatch(
      { name: "t", updatedAt: "2026-01-02T00:00:00.000Z" },
      "2026-04-26T00:00:00.000Z",
    );
    expect(p?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("pickLessonPayloadCloudPatch returns null when nothing syncable", () => {
    expect(pickLessonPayloadCloudPatch({}, "2026-04-26T00:00:00.000Z")).toBeNull();
  });

  it("patchVocabCardPayloadInCloud returns null when RPC is not deployed", async () => {
    const sb = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } }),
    } as unknown as SupabaseClient;
    await expect(
      patchVocabCardPayloadInCloud(sb, "v1", { term: "x", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ).resolves.toBeNull();
  });

  it("patchVocabCardPayloadInCloud returns null on empty patch keys", async () => {
    const sb = { rpc: vi.fn() } as unknown as SupabaseClient;
    await expect(patchVocabCardPayloadInCloud(sb, "v1", {})).resolves.toBeNull();
    expect((sb as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });

  it("patchSentenceTaskPayloadInCloud returns null when RPC missing", async () => {
    const sb = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202" } }),
    } as unknown as SupabaseClient;
    await expect(patchSentenceTaskPayloadInCloud(sb, "s1", { zh: "a" })).resolves.toBeNull();
  });

  it("patchGrammarTaskPayloadInCloud returns null when RPC missing", async () => {
    const sb = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202" } }),
    } as unknown as SupabaseClient;
    await expect(patchGrammarTaskPayloadInCloud(sb, "g1", { prompt: "p" })).resolves.toBeNull();
  });

  it("patchLessonNotePayloadInCloud returns null when RPC missing", async () => {
    const sb = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202" } }),
    } as unknown as SupabaseClient;
    await expect(patchLessonNotePayloadInCloud(sb, "n1", { content: "x", updatedAt: "2026-01-01T00:00:00.000Z" })).resolves.toBeNull();
  });

  it("patchFavoriteSentencePayloadInCloud returns null when RPC missing", async () => {
    const sb = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202" } }),
    } as unknown as SupabaseClient;
    await expect(patchFavoriteSentencePayloadInCloud(sb, "f1", { jp: "x" })).resolves.toBeNull();
  });

  it("localAppDataLooksNonEmpty is false for empty app", () => {
    const empty: AppData = {
      lessons: [],
      vocabCards: [],
      sentenceTasks: [],
      grammarTasks: [],
      chatSessions: [],
      lessonNotes: [],
      favoriteSentences: [],
    };
    expect(localAppDataLooksNonEmpty(empty)).toBe(false);
    expect(
      localAppDataLooksNonEmpty({
        ...empty,
        lessons: [
          {
            id: "l1",
            name: "x",
            content: "a\n",
            category: "未分类",
            author: "著者不明",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            lessonKind: "text",
          },
        ],
      }),
    ).toBe(true);
  });

  it("isCloudUpdatedAfterLastSeen matches lastSeen vs remote updated_at", () => {
    const store: Record<string, string> = {};
    const ls: Storage = {
      get length() {
        return Object.keys(store).length;
      },
      clear() {
        for (const k of Object.keys(store)) delete store[k];
      },
      getItem(key: string) {
        return Object.prototype.hasOwnProperty.call(store, key) ? store[key]! : null;
      },
      key() {
        return null;
      },
      removeItem(key: string) {
        delete store[key];
      },
      setItem(key: string, value: string) {
        store[key] = value;
      },
    };
    const win = { localStorage: ls };
    const prevWin = (globalThis as { window?: unknown }).window;
    const prevLs = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { window: typeof win; localStorage: Storage }).window = win;
    (globalThis as { localStorage: Storage }).localStorage = ls;
    try {
      const uid = "test-user-cloud-ahead";
      const key = `${LS_CLOUD_LAST_SEEN_REMOTE_AT_PREFIX}${uid}`;
      ls.setItem(key, "2026-01-01T00:00:00.000Z");
      expect(isCloudUpdatedAfterLastSeen(uid, "2026-06-01T00:00:00.000Z")).toBe(true);
      expect(isCloudUpdatedAfterLastSeen(uid, "2025-12-01T00:00:00.000Z")).toBe(false);
      ls.removeItem(key);
      expect(isCloudUpdatedAfterLastSeen(uid, "2026-06-01T00:00:00.000Z")).toBe(false);
    } finally {
      if (prevWin !== undefined) (globalThis as { window: unknown }).window = prevWin;
      else delete (globalThis as { window?: unknown }).window;
      if (prevLs !== undefined) (globalThis as { localStorage: Storage }).localStorage = prevLs;
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it("fingerprintAppDataExcludingStats ignores stats-only changes", () => {
    const empty: AppData = {
      lessons: [],
      vocabCards: [],
      sentenceTasks: [],
      grammarTasks: [],
      chatSessions: [],
      lessonNotes: [],
      favoriteSentences: [],
    };
    const a = normalizeAppData({ ...empty, stats: { practiceMarkCorrect: 1, practiceMarkWrong: 0, practiceMarkEasy: 0 } });
    const b = normalizeAppData({ ...empty, stats: { practiceMarkCorrect: 99, practiceMarkWrong: 0, practiceMarkEasy: 0 } });
    expect(fingerprintAppDataExcludingStats(a)).toBe(fingerprintAppDataExcludingStats(b));
    expect(fingerprintStatsSubtree(a)).not.toBe(fingerprintStatsSubtree(b));
  });

  it("fingerprintContentCore ignores stats, lessonNotes, favoriteSentences", () => {
    const base: AppData = {
      lessons: [
        {
          id: "l1",
          name: "x",
          content: "a\n",
          category: "未分类",
          author: "著者不明",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          lessonKind: "text",
        },
      ],
      vocabCards: [],
      sentenceTasks: [],
      grammarTasks: [],
      chatSessions: [],
      lessonNotes: [],
      favoriteSentences: [],
    };
    const a = normalizeAppData({
      ...base,
      stats: { practiceMarkCorrect: 1, practiceMarkWrong: 0, practiceMarkEasy: 0 },
    });
    const b = normalizeAppData({
      ...base,
      stats: { practiceMarkCorrect: 99, practiceMarkWrong: 0, practiceMarkEasy: 0 },
      lessonNotes: [
        {
          id: "n1",
          lessonId: "l1",
          content: "note",
          lineIndex: 0,
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      favoriteSentences: [
        {
          id: "f1",
          lessonId: "l1",
          jp: "あ",
          lineIndex: 0,
          createdAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    });
    expect(fingerprintContentCore(a)).toBe(fingerprintContentCore(b));
    expect(fingerprintStatsSubtree(a)).not.toBe(fingerprintStatsSubtree(b));
    expect(fingerprintLessonNotesSubtree(a)).not.toBe(fingerprintLessonNotesSubtree(b));
    expect(fingerprintFavoriteSentencesSubtree(a)).not.toBe(fingerprintFavoriteSentencesSubtree(b));
  });
});

function lessonStub(id: string, name: string): AppData["lessons"][number] {
  return {
    id,
    name,
    content: "a\n",
    category: "未分类",
    author: "著者不明",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lessonKind: "text",
  };
}

function fingerprintPkgFromPayload(p: AppData, granular: boolean): CloudSyncFingerprintPkg {
  const base: CloudSyncFingerprintPkg = {
    full: fingerprintAppData(p),
    rest: fingerprintAppDataExcludingStats(p),
    stats: fingerprintStatsSubtree(p),
    core: fingerprintContentCore(p),
    notes: fingerprintLessonNotesSubtree(p),
    favs: fingerprintFavoriteSentencesSubtree(p),
    lessons: granular ? fingerprintLessonsSubtree(p) : "",
    vocabCards: granular ? fingerprintVocabCardsSubtree(p) : "",
    sentenceTasks: granular ? fingerprintSentenceTasksSubtree(p) : "",
    grammarTasks: granular ? fingerprintGrammarTasksSubtree(p) : "",
    chatSessions: granular ? fingerprintChatSessionsSubtree(p) : "",
    mediaLibrary: granular ? fingerprintMediaLibrarySubtree(p) : "",
  };
  return base;
}

describe("getCloudRestoreScenario", () => {
  it("marks localUnsynced when full fingerprint differs from stored pkg", () => {
    const store: Record<string, string> = {};
    const ls: Storage = {
      get length() {
        return Object.keys(store).length;
      },
      clear() {
        for (const k of Object.keys(store)) delete store[k];
      },
      getItem(key: string) {
        return Object.prototype.hasOwnProperty.call(store, key) ? store[key]! : null;
      },
      key() {
        return null;
      },
      removeItem(key: string) {
        delete store[key];
      },
      setItem(key: string, value: string) {
        store[key] = value;
      },
    };
    const win = { localStorage: ls };
    const prevWin = (globalThis as { window?: unknown }).window;
    const prevLs = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { window: typeof win; localStorage: Storage }).window = win;
    (globalThis as { localStorage: Storage }).localStorage = ls;
    try {
      const uid = "u-restore-scen";
      const empty: AppData = {
        lessons: [],
        vocabCards: [],
        sentenceTasks: [],
        grammarTasks: [],
        chatSessions: [],
        lessonNotes: [],
        favoriteSentences: [],
      };
      const base = normalizeAppData({ ...empty, stats: { practiceMarkCorrect: 0, practiceMarkWrong: 0, practiceMarkEasy: 0 } });
      const pkgKey = `${LS_CLOUD_FP_PKG_PREFIX}${uid}`;
      ls.setItem(
        pkgKey,
        JSON.stringify({
          full: fingerprintAppData(base),
          rest: "",
          stats: "",
          core: "",
          notes: "",
          favs: "",
          lessons: "",
          vocabCards: "",
          sentenceTasks: "",
          grammarTasks: "",
          chatSessions: "",
          mediaLibrary: "",
        }),
      );
      const changed = normalizeAppData({ ...base, stats: { practiceMarkCorrect: 1, practiceMarkWrong: 0, practiceMarkEasy: 0 } });
      const s = getCloudRestoreScenario(uid, changed, null);
      expect(s.hadSyncBefore).toBe(true);
      expect(s.localUnsynced).toBe(true);
    } finally {
      if (prevWin !== undefined) (globalThis as { window: unknown }).window = prevWin;
      else delete (globalThis as { window?: unknown }).window;
      if (prevLs !== undefined) (globalThis as { localStorage: Storage }).localStorage = prevLs;
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

describe("planCloudAutoSync", () => {
  const empty: AppData = {
    lessons: [],
    vocabCards: [],
    sentenceTasks: [],
    grammarTasks: [],
    chatSessions: [],
    lessonNotes: [],
    favoriteSentences: [],
  };

  it("returns skip when full fingerprint matches", () => {
    const p = normalizeAppData(empty);
    const last = fingerprintPkgFromPayload(p, true);
    expect(planCloudAutoSync(p, last).kind).toBe("skip");
  });

  it("legacy pkg: stats-only change yields rpc delta", () => {
    vi.stubEnv("NEXT_PUBLIC_CLOUD_DELTA_NOTES_FAVS", "0");
    vi.stubEnv("NEXT_PUBLIC_CLOUD_DELTA_EXTENDED", "0");
    try {
      const base = normalizeAppData({
        ...empty,
        lessons: [lessonStub("l1", "A")],
        stats: { practiceMarkCorrect: 0, practiceMarkWrong: 0, practiceMarkEasy: 0 },
      });
      const next = normalizeAppData({
        ...base,
        stats: { practiceMarkCorrect: 3, practiceMarkWrong: 0, practiceMarkEasy: 0 },
      });
      const last = fingerprintPkgFromPayload(base, false);
      const plan = planCloudAutoSync(next, last);
      expect(plan.kind).toBe("rpc");
      if (plan.kind === "rpc") expect(plan.delta.stats?.practiceMarkCorrect).toBe(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("granular pkg + EXTENDED: lesson rename yields rpc with lessons", () => {
    vi.stubEnv("NEXT_PUBLIC_CLOUD_DELTA_EXTENDED", "1");
    try {
      const base = normalizeAppData({ ...empty, lessons: [lessonStub("l1", "A")] });
      const next = normalizeAppData({ ...empty, lessons: [lessonStub("l1", "B")] });
      const last = fingerprintPkgFromPayload(base, true);
      const plan = planCloudAutoSync(next, last);
      expect(plan.kind).toBe("rpc");
      if (plan.kind === "rpc") {
        expect(plan.delta.lessons).toHaveLength(1);
        expect(plan.delta.lessons?.[0]?.name).toBe("B");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("learningCoreEntryCount sums main arrays only", () => {
    const empty: AppData = {
      lessons: [],
      vocabCards: [],
      sentenceTasks: [],
      grammarTasks: [],
      chatSessions: [],
      lessonNotes: [],
      favoriteSentences: [],
    };
    expect(learningCoreEntryCount(empty)).toBe(0);
    const p = normalizeAppData({
      ...empty,
      lessons: [lessonStub("l1", "A")],
      stats: { practiceMarkCorrect: 99, practiceMarkWrong: 0, practiceMarkEasy: 0 },
    });
    expect(learningCoreEntryCount(p)).toBe(1);
  });

  it("payloadDeltaHasEmptyMainArray detects empty lessons array", () => {
    expect(payloadDeltaHasEmptyMainArray({ lessons: [] })).toBe(true);
    expect(payloadDeltaHasEmptyMainArray({ stats: { practiceMarkCorrect: 1, practiceMarkWrong: 0, practiceMarkEasy: 0 } })).toBe(false);
  });

  it("appDataIsBareShellForCloudUpload: empty core + no stats is bare; stats or lesson breaks", () => {
    const empty: AppData = {
      lessons: [],
      vocabCards: [],
      sentenceTasks: [],
      grammarTasks: [],
      chatSessions: [],
      lessonNotes: [],
      favoriteSentences: [],
    };
    expect(appDataIsBareShellForCloudUpload(normalizeAppData(empty))).toBe(true);
    expect(
      appDataIsBareShellForCloudUpload(
        normalizeAppData({
          ...empty,
          stats: { practiceMarkCorrect: 1, practiceMarkWrong: 0, practiceMarkEasy: 0 },
        }),
      ),
    ).toBe(false);
    expect(
      appDataIsBareShellForCloudUpload(
        normalizeAppData({
          ...empty,
          lessons: [
            {
              id: "l1",
              name: "x",
              content: "a\n",
              category: "未分类",
              author: "著者不明",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              lessonKind: "text",
              coverIllustrationDataUrl: "data:image/png;base64,AAAA",
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("shouldBlockBareShellUploadOverRemotePayload when remote has stats only", () => {
    const empty: AppData = {
      lessons: [],
      vocabCards: [],
      sentenceTasks: [],
      grammarTasks: [],
      chatSessions: [],
      lessonNotes: [],
      favoriteSentences: [],
    };
    const local = normalizeAppData(empty);
    const remote = normalizeAppData({
      ...empty,
      stats: { practiceMarkCorrect: 2, practiceMarkWrong: 0, practiceMarkEasy: 0 },
    });
    expect(shouldBlockBareShellUploadOverRemotePayload(local, remote)).toBe(true);
    expect(shouldBlockBareShellUploadOverRemotePayload(remote, local)).toBe(false);
    expect(shouldBlockBareShellUploadOverRemotePayload(local, local)).toBe(false);
  });

  it("granular pkg without EXTENDED: lesson change forces upsert", () => {
    vi.stubEnv("NEXT_PUBLIC_CLOUD_DELTA_EXTENDED", "0");
    vi.stubEnv("NEXT_PUBLIC_CLOUD_DELTA_NOTES_FAVS", "0");
    try {
      const base = normalizeAppData({ ...empty, lessons: [lessonStub("l1", "A")] });
      const next = normalizeAppData({ ...empty, lessons: [lessonStub("l1", "B")] });
      const last = fingerprintPkgFromPayload(base, true);
      expect(planCloudAutoSync(next, last).kind).toBe("upsert");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
