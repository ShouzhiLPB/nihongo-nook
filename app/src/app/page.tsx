"use client";

import clsx from "clsx";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { CloudAuthPanel } from "@/components/CloudAuthPanel";
import {
  fetchUserAppRemoteUpdatedAt,
  isCloudUpdatedAfterLastSeen,
  mergePayloadDeltaToCloud,
  patchLessonNotePayloadInCloud,
  patchLessonPayloadInCloud,
  patchGrammarTaskPayloadInCloud,
  patchSentenceTaskPayloadInCloud,
  patchVocabCardPayloadInCloud,
  pickLessonPayloadCloudPatch,
  payloadDeltaHasEmptyMainArray,
  persistCloudSyncFingerprints,
  persistLastSeenRemoteUpdatedAt,
  planCloudAutoSync,
  readCloudSyncFingerprintPkg,
  shouldBlockSyncThatWouldWipeRemoteCore,
  upsertUserAppDataToCloud,
  type GrammarTaskPayloadCloudPatch,
  type LessonNotePayloadCloudPatch,
  type LessonPayloadCloudPatch,
  type SentenceTaskPayloadCloudPatch,
  type VocabPayloadCloudPatch,
} from "@/modules/cloud/cloudUserAppData";
import { getSupabaseBrowserClient, isSupabaseBrowserConfigured } from "@/modules/cloud/supabaseBrowserClient";
import { StatsFutureDueChart, StatsPastRangeChart } from "@/components/StatsTrendCharts";
import { LessonReaderPanel } from "@/components/LessonReaderPanel";
import { SentenceDragComposer } from "@/components/SentenceDragComposer";
import {
  chatWithLesson,
  enrichVocabFields,
  generateGrammarOptions,
  generateHomeMotivation,
  generateSentenceTeachingNote,
} from "@/modules/ai/aiClient";
import { createChatSession, pushMessage, recentContext } from "@/modules/chat/chatService";
import {
  createGrammarTask,
  createSentenceTask,
  createVocabCard,
  finalizeVocabDistractors,
  finalizeVocabZhDistractors,
  upsertVocabWithPolysemyReset,
} from "@/modules/learning/lessonService";
import {
  aggregateFutureFirstDueByDay,
  applyPastTailSlice,
  buildFutureChartRows,
  buildPastRangeChartSeries,
  resolveFutureHorizonLabel,
  resolvePastRangeBounds,
  resolvePastRangeLabel,
  resolvePastTailLabel,
  sumPastChartRows,
  STATS_FUTURE_HORIZON_OPTIONS,
  type StatsFutureHorizonPreset,
  type StatsPastGranularity,
  type StatsPastRangePreset,
  type StatsPastTailPreset,
  type StatsPastViewMode,
} from "@/modules/stats/statsAggregation";
import { buildFutureDueCsv, buildPastRangeCsv, buildStatsSummaryCsv } from "@/modules/stats/statsCsv";
import { buildGlobalDueReviewCounts, buildLessonDueBreakdown } from "@/modules/stats/statsDueBreakdown";
import {
  LS_STATS_FUTURE_CUMULATIVE,
  LS_STATS_PAST_GRANULARITY,
  LS_STATS_PAST_RANGE,
  LS_STATS_PAST_TAIL,
  LS_STATS_PAST_VIEW_MODE,
  readStatsTabPrefsFromStorage,
} from "@/modules/stats/statsTabLocalPrefs";
import { bumpPracticeMarkStats, mergeDwellSecondsIntoStats, normalizeAppData } from "@/modules/storage/dataStore";
import { resolveLessonCoverSrc } from "@/modules/storage/mediaDedupe";
import { loadLocalAppData, saveLocalAppData } from "@/modules/storage/localDeviceStore";
import { filterDueReviewItems, patchAfterCorrect, patchAfterWrong, sortByReviewPriority } from "@/modules/srs/scheduler";
import type { AppData, GrammarTask, Lesson, PracticeKind, PromptMode, SentenceTask, VocabCard } from "@/shared/types";
import { playPracticeError, playPracticeSuccess, playPracticeTap, resumePracticeAudio } from "@/shared/practiceSfx";
import { speakJapanese } from "@/shared/speech";
import {
  extractExampleSegmentForTerm,
  inMotivationWindow,
  lessonAuthorDisplay,
  lessonAuthorForSave,
  parseTimestampedTranscriptToVideoCues,
  normalizeJaTermForPractice,
  normalizePracticeWhitespace,
  normalizeZhMeaningForPractice,
  calendarTodayLocal,
  nowIso,
  stableShuffle,
  tokenizeSentenceForDrag,
  uid,
} from "@/shared/utils";

type PracticeQueueHead =
  | { kind: "vocab"; payload: VocabCard }
  | { kind: "sentence"; payload: SentenceTask }
  | { kind: "grammar"; payload: GrammarTask };

type PracticeChoiceKbSlot = { label: string; flashKey: string };

function isPracticeChoiceOrSentenceComposerCorrect(
  current: PracticeQueueHead,
  answer: string,
  vocabPracticeDir: "zh2jp" | "jp2zh",
): boolean {
  const a = answer.trim();
  if (current.kind === "vocab") {
    if (vocabPracticeDir === "zh2jp") return a === current.payload.term.trim();
    const raw = (current.payload.meanings[0]?.zh ?? "").trim();
    const correctLabel = raw.length > 0 ? raw : "—";
    return a === correctLabel;
  }
  if (current.kind === "grammar") {
    const ok = current.payload.choices.find((c) => c.id === current.payload.answerId);
    return ok ? a === ok.text.trim() : false;
  }
  if (current.kind === "sentence") {
    return normalizePracticeWhitespace(answer) === normalizePracticeWhitespace(current.payload.jpAnswer);
  }
  return false;
}

function isGrammarOrSentenceFillCorrect(current: PracticeQueueHead, answer: string): boolean {
  if (current.kind === "grammar") {
    const ok = current.payload.choices.find((c) => c.id === current.payload.answerId);
    return ok ? answer.trim() === ok.text.trim() : false;
  }
  if (current.kind === "sentence") {
    return normalizePracticeWhitespace(answer) === normalizePracticeWhitespace(current.payload.jpAnswer);
  }
  return false;
}

function matchesAnyJp2ZhMeaning(card: VocabCard, answerRaw: string): boolean {
  const a = normalizeZhMeaningForPractice(answerRaw);
  const zhs = card.meanings.map((m) => (m.zh ?? "").trim()).filter((z) => z.length > 0);
  if (zhs.length === 0) return a === normalizeZhMeaningForPractice("—");
  return zhs.some((z) => a === normalizeZhMeaningForPractice(z));
}

function isVocabInputAnswerCorrect(
  current: PracticeQueueHead,
  answer: string,
  vocabPracticeDir: "zh2jp" | "jp2zh",
): boolean {
  if (current.kind !== "vocab") return false;
  if (vocabPracticeDir === "zh2jp") {
    return normalizeJaTermForPractice(answer) === normalizeJaTermForPractice(current.payload.term);
  }
  return matchesAnyJp2ZhMeaning(current.payload, answer);
}

/** 四选一/语法选项：与按钮 `flashKey` 同形，用于判错后短暂标出正解 */
function getPracticeCorrectChoiceFlashKey(
  current: PracticeQueueHead,
  vocabPracticeDir: "zh2jp" | "jp2zh",
): string | null {
  if (current.kind === "vocab") {
    if (vocabPracticeDir === "zh2jp") return `v_${current.payload.term}`;
    const raw = (current.payload.meanings[0]?.zh ?? "").trim();
    const correctLabel = raw.length > 0 ? raw : "—";
    return `vz_${correctLabel}`;
  }
  if (current.kind === "grammar") {
    const ok = current.payload.choices.find((c) => c.id === current.payload.answerId);
    return ok ? `g_${ok.id}` : null;
  }
  return null;
}

function buildAutoWrongFeedback(current: PracticeQueueHead, vocabPracticeDir: "zh2jp" | "jp2zh"): string {
  const tail = "请再试一次。";
  if (current.kind === "vocab") {
    if (vocabPracticeDir === "zh2jp") return `与正解不符。正解词条：「${current.payload.term}」。${tail}`;
    const zhs = current.payload.meanings.map((m) => m.zh.trim()).filter(Boolean);
    const joined = zhs.length ? zhs.join(" / ") : "—";
    return `与卡片义项不符。卡片义项：「${joined}」（日→中填空接受其中任一条，已忽略标点）。${tail}`;
  }
  if (current.kind === "grammar") {
    const ok = current.payload.choices.find((c) => c.id === current.payload.answerId);
    return ok ? `与正解不符。正解：「${ok.text}」。${tail}` : `判为错误。${tail}`;
  }
  if (current.kind === "sentence") {
    return `与参考答案不一致（已按空格规范化比对）。正解：${current.payload.jpAnswer}。${tail}`;
  }
  return `判为错误。${tail}`;
}

function formatDwellLabel(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

const TABS = [
  { id: "home" as const, label: "首页" },
  { id: "lessons" as const, label: "课文" },
  { id: "words" as const, label: "单词" },
  { id: "practice" as const, label: "练习" },
  { id: "stats" as const, label: "数据" },
  { id: "data" as const, label: "设置" },
];

type AppTab = (typeof TABS)[number]["id"];

/** 全局 keydown 用 ref 持有最新回调，避免 useEffect 依赖项在 HMR 前后长度不一致 */
type PracticeHotkeySnapshot = {
  appTab: AppTab;
  mode: PracticeKind;
  answerMode: "choice" | "input";
  submitAnswer: (review: "correct" | "wrong" | "easy", opts?: { wrongHint?: string }) => void;
  confirmOrNextPractice: () => void;
  flashChoiceKey: (key: string) => void;
};

type DeviceTier = "phone" | "tablet" | "desktop";

const LS_ACTIVE_LESSON = "jpLearn_activeLessonId";
const LS_PRACTICE_MODE = "jpLearn_practiceKind";
const LS_STATS_FUTURE_HORIZON = "jpLearn_statsFutureHorizon";
const LS_VOCAB_DRILL_PROGRESS = "jpLearn_vocabDrillProgress";
const LS_VOCAB_DRILL_COMPLETED = "jpLearn_vocabDrillCompleted";
const LS_QUICK_START_DISMISSED = "jpLearn_quickStartDismissed";

function readStatsFutureHorizonFromStorage(): StatsFutureHorizonPreset | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(LS_STATS_FUTURE_HORIZON)?.trim();
  if (raw === "d7") return "d7";
  if (raw === "d15") return "d15";
  // 旧版 d14 / d30 已移除，统一到 15 日窗口
  if (raw === "d14" || raw === "d30") return "d15";
  return null;
}

const emptyData: AppData = {
  lessons: [],
  vocabCards: [],
  sentenceTasks: [],
  grammarTasks: [],
  chatSessions: [],
  lessonNotes: [],
  favoriteSentences: [],
  stats: {
    practiceMarkCorrect: 0,
    practiceMarkWrong: 0,
    practiceMarkEasy: 0,
    dwellLessonReaderSec: 0,
    dwellPracticeSec: 0,
    daily: {},
  },
};

export default function Home() {
  /** 首帧必须与 SSR 一致，避免 hydration mismatch；本地数据在 mount 后注入 */
  const [data, setData] = useState<AppData>(emptyData);
  const trashedLessonIdSet = useMemo(
    () => new Set(data.lessons.filter((l) => l.trashedAt).map((l) => l.id)),
    [data.lessons],
  );
  const activeLessons = useMemo(() => data.lessons.filter((l) => !l.trashedAt), [data.lessons]);
  const trashedLessons = useMemo(
    () =>
      [...data.lessons]
        .filter((l) => l.trashedAt)
        .sort((a, b) => (b.trashedAt || "").localeCompare(a.trashedAt || "")),
    [data.lessons],
  );
  const [storageReady, setStorageReady] = useState(false);
  /** 练习遇到单词题时是否自动调用浏览器 TTS（与「分句朗读」同源，不生成可下载 mp3） */
  const [autoSpeakVocab, setAutoSpeakVocab] = useState(true);
  const [appTab, setAppTab] = useState<AppTab>("home");
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [cloudConfigured, setCloudConfigured] = useState(false);
  const [cloudUserEmail, setCloudUserEmail] = useState("");
  const [cloudUserId, setCloudUserId] = useState("");
  /** 探测到云端 updated_at 晚于本机 lastSeen（他处可能已上传） */
  const [cloudRemoteAhead, setCloudRemoteAhead] = useState<{ show: boolean; at: string | null }>({ show: false, at: null });
  /** 用户点「稍后再说」时记下当时的 remoteAt；若云端再次变新则重新提示 */
  const [cloudAheadDismissRemoteAt, setCloudAheadDismissRemoteAt] = useState<string | null>(null);
  const [quickStartDismissed, setQuickStartDismissed] = useState(false);
  const [silentHealthIssue, setSilentHealthIssue] = useState<string | null>(null);
  const [lessonName, setLessonName] = useState("");
  const [lessonCategory, setLessonCategory] = useState("");
  const [lessonAuthor, setLessonAuthor] = useState("");
  const [lessonKindDraft, setLessonKindDraft] = useState<"text" | "video">("text");
  /** 视频课文：仅保存 http(s) 外链（YouTube/B站直链等），便于云端整包同步 */
  const [lessonVideoUrlDraft, setLessonVideoUrlDraft] = useState("");
  const [lessonSubtitleText, setLessonSubtitleText] = useState("");
  const [lessonMediaTip, setLessonMediaTip] = useState("");
  const [activeLessonId, setActiveLessonId] = useState<string>("");
  const [readerLessonId, setReaderLessonId] = useState<string | null>(null);
  const [categoryOpen, setCategoryOpen] = useState<Record<string, boolean>>({});
  const [lessonSearchQuery, setLessonSearchQuery] = useState("");
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [draggingLessonId, setDraggingLessonId] = useState<string | null>(null);
  const [lessonDropHint, setLessonDropHint] = useState<{ targetId: string; mode: "before" | "after" | "swap" } | null>(null);
  const [lessonReorderFlashIds, setLessonReorderFlashIds] = useState<Set<string>>(new Set());
  const [lessonBulkMode, setLessonBulkMode] = useState(false);
  const [lessonBulkSelected, setLessonBulkSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<PracticeKind>("vocab");
  /** 选择题：点选项；填空题：键盘输入答案 */
  const [answerMode, setAnswerMode] = useState<"choice" | "input">("choice");
  const [answer, setAnswer] = useState("");
  /** 填空题一键判分后是否展开底部详解/参考答案（选择题仍用 answerConfirmed 两阶段） */
  const [fillDetailReveal, setFillDetailReveal] = useState<"none" | "vocab" | "sentence" | "grammar">("none");
  const [feedback, setFeedback] = useState("");
  /** 「设置」页：备份导入结果提示，几秒后自动消失 */
  const [dataToast, setDataToast] = useState("");
  const [disableKinds, setDisableKinds] = useState<Set<PracticeKind>>(new Set());
  /** 答错后同一题立即再练：在今日待刷队列里钉到队首 */
  const [practiceRepeatPin, setPracticeRepeatPin] = useState<{ kind: PracticeKind; id: string } | null>(null);
  const [chatTitle, setChatTitle] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatMode, setChatMode] = useState<PromptMode>("fast");
  const [selectedChatId, setSelectedChatId] = useState<string>("");
  const [chatBusySessionId, setChatBusySessionId] = useState<string>("");
  const [vocabTerm, setVocabTerm] = useState("");
  const [vocabKana, setVocabKana] = useState("");
  const [vocabZh, setVocabZh] = useState("");
  const [vocabEtymology, setVocabEtymology] = useState("");
  /** 新建词卡：例句整句（课文规则或 AI 写入，可手改） */
  const [vocabExampleForNewCard, setVocabExampleForNewCard] = useState("");
  const [selectedVocabId, setSelectedVocabId] = useState<string>("");
  const [grammarKnowledgePoint, setGrammarKnowledgePoint] = useState("");
  const [latestGrammarExplanation, setLatestGrammarExplanation] = useState("");
  const [vocabSortKey, setVocabSortKey] = useState<"alpha" | "lesson">("alpha");
  const [vocabSortDir, setVocabSortDir] = useState<"asc" | "desc">("asc");
  const [vocabListFilter, setVocabListFilter] = useState<string>("all");
  const [wordsScope, setWordsScope] = useState<PracticeKind>("vocab");
  const [grammarStem, setGrammarStem] = useState("私は毎朝___日本語を勉強します。");
  const [practiceSentenceZh, setPracticeSentenceZh] = useState("");
  const [practiceSentenceJp, setPracticeSentenceJp] = useState("");
  const [vocabEditTerm, setVocabEditTerm] = useState("");
  const [vocabEditKana, setVocabEditKana] = useState("");
  const [vocabEditZh, setVocabEditZh] = useState("");
  const [vocabEditEtym, setVocabEditEtym] = useState("");
  const [vocabEditExample, setVocabEditExample] = useState("");
  const [vocabEditAiBusy, setVocabEditAiBusy] = useState(false);
  /** 句子题详情弹层草稿（点「保存修改」写入 data） */
  const [sentenceEditJp, setSentenceEditJp] = useState("");
  const [sentenceEditZh, setSentenceEditZh] = useState("");
  const [sentenceEditNote, setSentenceEditNote] = useState("");
  /** 语法题详情弹层草稿 */
  const [grammarEditPrompt, setGrammarEditPrompt] = useState("");
  const [grammarEditZhPrompt, setGrammarEditZhPrompt] = useState("");
  const [grammarEditKnowledge, setGrammarEditKnowledge] = useState("");
  const [grammarEditExplanation, setGrammarEditExplanation] = useState("");
  const [newVocabModalOpen, setNewVocabModalOpen] = useState(false);
  const [newVocabLessonId, setNewVocabLessonId] = useState<string>("");
  const [practiceToolsModalOpen, setPracticeToolsModalOpen] = useState(false);
  const [manualTargetLessonId, setManualTargetLessonId] = useState<string>("active");
  const [manualNewDictName, setManualNewDictName] = useState("");
  const [manualNewDictCategory, setManualNewDictCategory] = useState("词典");
  const [newVocabEnrichBusy, setNewVocabEnrichBusy] = useState(false);
  const [newVocabSaveBusy, setNewVocabSaveBusy] = useState(false);
  const [vocabSearchQuery, setVocabSearchQuery] = useState("");
  const [answerConfirmed, setAnswerConfirmed] = useState(false);
  const [selectedGrammarId, setSelectedGrammarId] = useState<string>("");
  const [selectedSentenceId, setSelectedSentenceId] = useState<string>("");
  const [portalReady, setPortalReady] = useState(false);
  const [statsPastRange, setStatsPastRange] = useState<StatsPastRangePreset>("d7");
  const [statsPastTailPreset, setStatsPastTailPreset] = useState<StatsPastTailPreset>("all");
  const [statsPastViewMode, setStatsPastViewMode] = useState<StatsPastViewMode>("chart");
  const [statsPastGranularity, setStatsPastGranularity] = useState<StatsPastGranularity>("day");
  const [statsFutureHorizon, setStatsFutureHorizon] = useState<StatsFutureHorizonPreset>("d15");
  const [statsFutureShowCumulative, setStatsFutureShowCumulative] = useState(true);
  /**
   * Iter 19：新词四连闭环（中↔日各两次选择）。
   * - 旧词默认视为已完成，不改变既有练习体验；
   * - 新入库词在本机完成 4 次后回退为原有稳定随机方向。
   */
  const [vocabDrillProgressById, setVocabDrillProgressById] = useState<Record<string, number>>({});
  const [vocabDrillCompletedIds, setVocabDrillCompletedIds] = useState<Set<string>>(new Set());
  const vocabDrillBootstrappedRef = useRef(false);

  const dataRef = useRef(data);
  dataRef.current = data;

  const choiceFlashTimerRef = useRef<number | null>(null);
  const lessonReorderFlashTimerRef = useRef<number | null>(null);
  const cloudAutosyncTimerRef = useRef<number | null>(null);
  const cloudSyncBusyRef = useRef(false);
  const cloudSessionRef = useRef<Session | null>(null);
  /** 由云同步 effect 赋值：本机 data 变化后可防抖触发，与 5 分钟轮询共用同一套上传逻辑 */
  const cloudSyncRunnerRef = useRef<(() => Promise<void>) | null>(null);
  const cloudDataDebounceTimerRef = useRef<number | null>(null);
  const lessonCloudPatchTimersRef = useRef<Record<string, number>>({});
  const lessonCloudPatchPendingRef = useRef<Record<string, LessonPayloadCloudPatch>>({});
  const vocabCloudPatchTimersRef = useRef<Record<string, number>>({});
  const vocabCloudPatchPendingRef = useRef<Record<string, VocabPayloadCloudPatch>>({});
  const sentenceCloudPatchTimersRef = useRef<Record<string, number>>({});
  const sentenceCloudPatchPendingRef = useRef<Record<string, SentenceTaskPayloadCloudPatch>>({});
  const grammarCloudPatchTimersRef = useRef<Record<string, number>>({});
  const grammarCloudPatchPendingRef = useRef<Record<string, GrammarTaskPayloadCloudPatch>>({});
  const lessonNoteCloudPatchTimersRef = useRef<Record<string, number>>({});
  const lessonNoteCloudPatchPendingRef = useRef<Record<string, LessonNotePayloadCloudPatch>>({});
  const notesFavsMergeTimerRef = useRef<number | null>(null);
  const chatSessionsMergeTimerRef = useRef<number | null>(null);
  const [choiceFlashKey, setChoiceFlashKey] = useState("");
  const [deviceTier, setDeviceTier] = useState<DeviceTier>("desktop");
  /** 自动判错后短暂圈出正解选项（与 choice 按钮 flashKey 一致） */
  const [practiceSolutionKey, setPracticeSolutionKey] = useState<string | null>(null);
  const practiceSolutionTimerRef = useRef<number | null>(null);
  /** 句子组句 / 句子填空：自动判错后短时展示正解 */
  const [sentenceSolutionReveal, setSentenceSolutionReveal] = useState(false);
  const sentenceRevealTimerRef = useRef<number | null>(null);
  /** 练习页快捷键 1–4：选项文案 + 与按钮一致的 flashKey */
  const practiceChoiceKbSlotsRef = useRef<PracticeChoiceKbSlot[]>([]);
  const practiceHotkeysRef = useRef<PracticeHotkeySnapshot | null>(null);
  const dwellPendingRef = useRef({ lessonReaderSec: 0, practiceSec: 0 });
  /** 最近一次已判分/确认的题目，用于「打开本题卡片」 */
  const practicePeekRef = useRef<{ kind: PracticeKind; id: string } | null>(null);

  useEffect(() => {
    const configured = isSupabaseBrowserConfigured();
    setCloudConfigured(configured);
    if (!configured) {
      setCloudUserEmail("");
      setCloudUserId("");
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseBrowserConfigured()) return;
    const sb = getSupabaseBrowserClient();
    if (!sb) return;
    let cancelled = false;

    const syncIfChanged = async () => {
      if (cancelled || cloudSyncBusyRef.current) return;
      const user = cloudSessionRef.current?.user;
      if (!user) return;
      const last = readCloudSyncFingerprintPkg(user.id);
      const plan = planCloudAutoSync(dataRef.current, last);
      if (plan.kind === "skip") return;

      cloudSyncBusyRef.current = true;
      try {
        const blockWipe = await shouldBlockSyncThatWouldWipeRemoteCore(sb, dataRef.current);
        if (plan.kind === "rpc") {
          if (blockWipe && payloadDeltaHasEmptyMainArray(plan.delta)) {
            return;
          }
          try {
            const mergedAt = await mergePayloadDeltaToCloud(sb, plan.delta);
            persistLastSeenRemoteUpdatedAt(user.id, mergedAt);
          } catch {
            if (blockWipe) return;
            await upsertUserAppDataToCloud(sb, user.id, dataRef.current);
            const at = await fetchUserAppRemoteUpdatedAt(sb);
            if (at) persistLastSeenRemoteUpdatedAt(user.id, at);
          }
        } else {
          if (blockWipe) return;
          await upsertUserAppDataToCloud(sb, user.id, dataRef.current);
          const at = await fetchUserAppRemoteUpdatedAt(sb);
          if (at) persistLastSeenRemoteUpdatedAt(user.id, at);
        }
        persistCloudSyncFingerprints(user.id, dataRef.current);
        setCloudRemoteAhead({ show: false, at: null });
        setCloudAheadDismissRemoteAt(null);
      } catch {
        // 静默失败，避免打断学习；下一个周期会继续重试
      } finally {
        cloudSyncBusyRef.current = false;
      }
    };

    const startTimer = () => {
      if (cloudAutosyncTimerRef.current != null) {
        window.clearInterval(cloudAutosyncTimerRef.current);
      }
      cloudAutosyncTimerRef.current = window.setInterval(() => {
        void syncIfChanged();
      }, 5 * 60 * 1000);
    };

    cloudSyncRunnerRef.current = syncIfChanged;

    void sb.auth.getSession().then(({ data: s }) => {
      if (cancelled) return;
      cloudSessionRef.current = s.session;
      setCloudUserEmail(s.session?.user?.email ?? "");
      setCloudUserId(s.session?.user?.id ?? "");
      void syncIfChanged();
    });

    startTimer();
    const { data: sub } = sb.auth.onAuthStateChange((_event, next) => {
      cloudSessionRef.current = next;
      setCloudUserEmail(next?.user?.email ?? "");
      setCloudUserId(next?.user?.id ?? "");
      void syncIfChanged();
    });

    return () => {
      cancelled = true;
      cloudSyncRunnerRef.current = null;
      sub.subscription.unsubscribe();
      if (cloudAutosyncTimerRef.current != null) {
        window.clearInterval(cloudAutosyncTimerRef.current);
        cloudAutosyncTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setQuickStartDismissed(localStorage.getItem(LS_QUICK_START_DISMISSED) === "1");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const probeKey = "__jpLearn_probe__";
      localStorage.setItem(probeKey, "1");
      localStorage.removeItem(probeKey);
    } catch {
      setSilentHealthIssue("浏览器本地存储不可用，学习记录可能无法持久化。建议切换浏览器或关闭无痕限制。");
      return;
    }
    if (typeof indexedDB === "undefined") {
      setSilentHealthIssue("当前环境不支持 IndexedDB，本地数据持久化能力受限。建议更换现代浏览器。");
      return;
    }
    setSilentHealthIssue(null);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const pickTier = (): DeviceTier => {
      const w = window.innerWidth;
      if (w < 768) return "phone";
      if (w < 1200) return "tablet";
      return "desktop";
    };
    const apply = () => setDeviceTier(pickTier());
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);

  const activeLesson = data.lessons.find((lesson) => lesson.id === activeLessonId);
  const readerLesson = readerLessonId ? data.lessons.find((l) => l.id === readerLessonId) : undefined;
  const shellMaxWidthClass = deviceTier === "desktop" ? "max-w-6xl" : "max-w-5xl";
  const headerLayoutClass = deviceTier === "phone" ? "flex-col gap-2" : "flex-col gap-3 md:flex-row md:items-center md:justify-between";

  const lessonById = useMemo(() => new Map(data.lessons.map((l) => [l.id, l])), [data.lessons]);

  const removeVocabCardById = useCallback((id: string, termLabel: string) => {
    const label = termLabel.trim() || "该词";
    if (!window.confirm(`确定删除单词「${label}」？删除后练习里也不再出现。`)) return;
    setData((prev) => ({ ...prev, vocabCards: prev.vocabCards.filter((c) => c.id !== id) }));
    setSelectedVocabId((cur) => (cur === id ? "" : cur));
  }, []);

  const removeSentenceTaskById = useCallback((id: string, previewLabel: string) => {
    const raw = previewLabel.trim().replace(/\s+/g, " ");
    const hint = raw.slice(0, 48);
    const tail = raw.length > 48 ? "…" : "";
    if (!window.confirm(`确定删除句子题「${hint || "本题"}${tail}」？删除后练习队列里也不再出现。`)) return;
    setData((prev) => ({ ...prev, sentenceTasks: prev.sentenceTasks.filter((t) => t.id !== id) }));
    setSelectedSentenceId((cur) => (cur === id ? "" : cur));
  }, []);

  const removeGrammarTaskById = useCallback((id: string, previewLabel: string) => {
    const raw = previewLabel.trim().replace(/\s+/g, " ");
    const hint = raw.slice(0, 56);
    const tail = raw.length > 56 ? "…" : "";
    if (!window.confirm(`确定删除语法题？\n${hint || "本题"}${tail}`)) return;
    setData((prev) => ({ ...prev, grammarTasks: prev.grammarTasks.filter((g) => g.id !== id) }));
    setSelectedGrammarId((cur) => (cur === id ? "" : cur));
  }, []);

  const clearCloudAheadBanner = useCallback(() => {
    setCloudRemoteAhead({ show: false, at: null });
    setCloudAheadDismissRemoteAt(null);
  }, []);

  const scheduleLessonCloudFieldPatch = useCallback(
    (lessonId: string, slice: LessonPayloadCloudPatch) => {
      if (!cloudUserId || !isSupabaseBrowserConfigured()) return;
      if (Object.keys(slice).length === 0) return;
      const sb = getSupabaseBrowserClient();
      if (!sb) return;

      const prevT = lessonCloudPatchTimersRef.current[lessonId];
      if (prevT != null) window.clearTimeout(prevT);

      const cur = lessonCloudPatchPendingRef.current[lessonId] ?? {};
      lessonCloudPatchPendingRef.current[lessonId] = { ...cur, ...slice };

      lessonCloudPatchTimersRef.current[lessonId] = window.setTimeout(() => {
        const merged = lessonCloudPatchPendingRef.current[lessonId];
        delete lessonCloudPatchPendingRef.current[lessonId];
        delete lessonCloudPatchTimersRef.current[lessonId];
        if (!merged || Object.keys(merged).length === 0) return;

        void (async () => {
          try {
            const at = await patchLessonPayloadInCloud(sb, lessonId, merged);
            if (!at) return;
            persistCloudSyncFingerprints(cloudUserId, dataRef.current);
            persistLastSeenRemoteUpdatedAt(cloudUserId, at);
          } catch {
            // 弱网或其它错误：静默；整包/子树增量稍后仍会再对齐
          }
        })();
      }, 2500);
    },
    [cloudUserId],
  );

  const scheduleVocabCloudFieldPatch = useCallback(
    (vocabId: string, slice: VocabPayloadCloudPatch) => {
      if (!cloudUserId || !isSupabaseBrowserConfigured()) return;
      if (Object.keys(slice).length === 0) return;
      const sb = getSupabaseBrowserClient();
      if (!sb) return;

      const prevT = vocabCloudPatchTimersRef.current[vocabId];
      if (prevT != null) window.clearTimeout(prevT);

      const cur = vocabCloudPatchPendingRef.current[vocabId] ?? {};
      vocabCloudPatchPendingRef.current[vocabId] = { ...cur, ...slice };

      vocabCloudPatchTimersRef.current[vocabId] = window.setTimeout(() => {
        const merged = vocabCloudPatchPendingRef.current[vocabId];
        delete vocabCloudPatchPendingRef.current[vocabId];
        delete vocabCloudPatchTimersRef.current[vocabId];
        if (!merged || Object.keys(merged).length === 0) return;

        void (async () => {
          try {
            const at = await patchVocabCardPayloadInCloud(sb, vocabId, merged);
            if (!at) return;
            persistCloudSyncFingerprints(cloudUserId, dataRef.current);
            persistLastSeenRemoteUpdatedAt(cloudUserId, at);
          } catch {
            // 静默；整包 / 子树增量稍后对齐
          }
        })();
      }, 2500);
    },
    [cloudUserId],
  );

  const scheduleSentenceCloudFieldPatch = useCallback(
    (taskId: string, slice: SentenceTaskPayloadCloudPatch) => {
      if (!cloudUserId || !isSupabaseBrowserConfigured()) return;
      if (Object.keys(slice).length === 0) return;
      const sb = getSupabaseBrowserClient();
      if (!sb) return;

      const prevT = sentenceCloudPatchTimersRef.current[taskId];
      if (prevT != null) window.clearTimeout(prevT);

      const cur = sentenceCloudPatchPendingRef.current[taskId] ?? {};
      sentenceCloudPatchPendingRef.current[taskId] = { ...cur, ...slice };

      sentenceCloudPatchTimersRef.current[taskId] = window.setTimeout(() => {
        const merged = sentenceCloudPatchPendingRef.current[taskId];
        delete sentenceCloudPatchPendingRef.current[taskId];
        delete sentenceCloudPatchTimersRef.current[taskId];
        if (!merged || Object.keys(merged).length === 0) return;

        void (async () => {
          try {
            const at = await patchSentenceTaskPayloadInCloud(sb, taskId, merged);
            if (!at) return;
            persistCloudSyncFingerprints(cloudUserId, dataRef.current);
            persistLastSeenRemoteUpdatedAt(cloudUserId, at);
          } catch {
            /* 静默 */
          }
        })();
      }, 2500);
    },
    [cloudUserId],
  );

  const scheduleGrammarCloudFieldPatch = useCallback(
    (taskId: string, slice: GrammarTaskPayloadCloudPatch) => {
      if (!cloudUserId || !isSupabaseBrowserConfigured()) return;
      if (Object.keys(slice).length === 0) return;
      const sb = getSupabaseBrowserClient();
      if (!sb) return;

      const prevT = grammarCloudPatchTimersRef.current[taskId];
      if (prevT != null) window.clearTimeout(prevT);

      const cur = grammarCloudPatchPendingRef.current[taskId] ?? {};
      grammarCloudPatchPendingRef.current[taskId] = { ...cur, ...slice };

      grammarCloudPatchTimersRef.current[taskId] = window.setTimeout(() => {
        const merged = grammarCloudPatchPendingRef.current[taskId];
        delete grammarCloudPatchPendingRef.current[taskId];
        delete grammarCloudPatchTimersRef.current[taskId];
        if (!merged || Object.keys(merged).length === 0) return;

        void (async () => {
          try {
            const at = await patchGrammarTaskPayloadInCloud(sb, taskId, merged);
            if (!at) return;
            persistCloudSyncFingerprints(cloudUserId, dataRef.current);
            persistLastSeenRemoteUpdatedAt(cloudUserId, at);
          } catch {
            /* 静默 */
          }
        })();
      }, 2500);
    },
    [cloudUserId],
  );

  const scheduleLessonNoteCloudFieldPatch = useCallback(
    (noteId: string, slice: LessonNotePayloadCloudPatch) => {
      if (!cloudUserId || !isSupabaseBrowserConfigured()) return;
      if (Object.keys(slice).length === 0) return;
      const sb = getSupabaseBrowserClient();
      if (!sb) return;

      const prevT = lessonNoteCloudPatchTimersRef.current[noteId];
      if (prevT != null) window.clearTimeout(prevT);

      const cur = lessonNoteCloudPatchPendingRef.current[noteId] ?? {};
      lessonNoteCloudPatchPendingRef.current[noteId] = { ...cur, ...slice };

      lessonNoteCloudPatchTimersRef.current[noteId] = window.setTimeout(() => {
        const merged = lessonNoteCloudPatchPendingRef.current[noteId];
        delete lessonNoteCloudPatchPendingRef.current[noteId];
        delete lessonNoteCloudPatchTimersRef.current[noteId];
        if (!merged || Object.keys(merged).length === 0) return;

        void (async () => {
          try {
            const at = await patchLessonNotePayloadInCloud(sb, noteId, merged);
            if (!at) return;
            persistCloudSyncFingerprints(cloudUserId, dataRef.current);
            persistLastSeenRemoteUpdatedAt(cloudUserId, at);
          } catch {
            /* 静默 */
          }
        })();
      }, 2500);
    },
    [cloudUserId],
  );

  const scheduleNotesFavsCloudSubtreeMerge = useCallback(() => {
    if (!cloudUserId || !isSupabaseBrowserConfigured()) return;
    if (notesFavsMergeTimerRef.current != null) window.clearTimeout(notesFavsMergeTimerRef.current);
    notesFavsMergeTimerRef.current = window.setTimeout(() => {
      notesFavsMergeTimerRef.current = null;
      void (async () => {
        try {
          const sb = getSupabaseBrowserClient();
          if (!sb || !cloudUserId) return;
          const d = dataRef.current;
          const mergedAt = await mergePayloadDeltaToCloud(sb, {
            lessonNotes: d.lessonNotes,
            favoriteSentences: d.favoriteSentences,
          });
          persistLastSeenRemoteUpdatedAt(cloudUserId, mergedAt);
          persistCloudSyncFingerprints(cloudUserId, d);
        } catch {
          /* 静默 */
        }
      })();
    }, 2500);
  }, [cloudUserId]);

  const scheduleChatSessionsCloudSubtreeMerge = useCallback(() => {
    if (!cloudUserId || !isSupabaseBrowserConfigured()) return;
    if (chatSessionsMergeTimerRef.current != null) window.clearTimeout(chatSessionsMergeTimerRef.current);
    chatSessionsMergeTimerRef.current = window.setTimeout(() => {
      chatSessionsMergeTimerRef.current = null;
      void (async () => {
        try {
          const sb = getSupabaseBrowserClient();
          if (!sb || !cloudUserId) return;
          const d = dataRef.current;
          const mergedAt = await mergePayloadDeltaToCloud(sb, { chatSessions: d.chatSessions });
          persistLastSeenRemoteUpdatedAt(cloudUserId, mergedAt);
          persistCloudSyncFingerprints(cloudUserId, d);
        } catch {
          /* 静默 */
        }
      })();
    }, 2500);
  }, [cloudUserId]);

  useEffect(() => {
    const lessonTimers = lessonCloudPatchTimersRef;
    const vocabTimers = vocabCloudPatchTimersRef;
    const sentenceTimers = sentenceCloudPatchTimersRef;
    const grammarTimers = grammarCloudPatchTimersRef;
    const noteTimers = lessonNoteCloudPatchTimersRef;
    return () => {
      for (const id of Object.keys(lessonTimers.current)) {
        const h = lessonTimers.current[id];
        if (h != null) window.clearTimeout(h);
      }
      lessonTimers.current = {};
      lessonCloudPatchPendingRef.current = {};
      for (const id of Object.keys(vocabTimers.current)) {
        const h = vocabTimers.current[id];
        if (h != null) window.clearTimeout(h);
      }
      vocabTimers.current = {};
      vocabCloudPatchPendingRef.current = {};
      for (const id of Object.keys(sentenceTimers.current)) {
        const h = sentenceTimers.current[id];
        if (h != null) window.clearTimeout(h);
      }
      sentenceTimers.current = {};
      sentenceCloudPatchPendingRef.current = {};
      for (const id of Object.keys(grammarTimers.current)) {
        const h = grammarTimers.current[id];
        if (h != null) window.clearTimeout(h);
      }
      grammarTimers.current = {};
      grammarCloudPatchPendingRef.current = {};
      for (const id of Object.keys(noteTimers.current)) {
        const h = noteTimers.current[id];
        if (h != null) window.clearTimeout(h);
      }
      noteTimers.current = {};
      lessonNoteCloudPatchPendingRef.current = {};
      if (notesFavsMergeTimerRef.current != null) {
        window.clearTimeout(notesFavsMergeTimerRef.current);
        notesFavsMergeTimerRef.current = null;
      }
      if (chatSessionsMergeTimerRef.current != null) {
        window.clearTimeout(chatSessionsMergeTimerRef.current);
        chatSessionsMergeTimerRef.current = null;
      }
    };
  }, []);
  const lessonIndexById = useMemo(() => {
    const m = new Map<string, number>();
    activeLessons.forEach((lesson, idx) => m.set(lesson.id, idx + 1));
    return m;
  }, [activeLessons]);

  const vocabFiltered = useMemo(() => {
    let cards = [...data.vocabCards];
    if (vocabListFilter !== "all") {
      cards = cards.filter((c) => c.lessonId === vocabListFilter);
    }
    const q = vocabSearchQuery.trim().toLowerCase();
    if (q) {
      cards = cards.filter((c) => {
        const zh = c.meanings.map((m) => m.zh).join(" ");
        const blob = `${c.term}\n${c.kana}\n${zh}\n${c.etymology}\n${c.latestExample}`.toLowerCase();
        return blob.includes(q);
      });
    }
    return cards;
  }, [data.vocabCards, vocabListFilter, vocabSearchQuery]);

  const sortedFilteredVocab = useMemo(() => {
    const cards = [...vocabFiltered];
    const asc = vocabSortDir === "asc";
    const dir = asc ? 1 : -1;
    const cmpTerm = (a: VocabCard, b: VocabCard) => dir * a.term.localeCompare(b.term, "ja");

    if (vocabSortKey === "alpha") {
      cards.sort(cmpTerm);
      return cards;
    }
    if (vocabListFilter !== "all") {
      cards.sort(cmpTerm);
      return cards;
    }
    cards.sort((a, b) => {
      const la = lessonById.get(a.lessonId);
      const lb = lessonById.get(b.lessonId);
      let cmp = (la?.category?.trim() || "未分类").localeCompare(lb?.category?.trim() || "未分类", "zh");
      if (cmp !== 0) return dir * cmp;
      const ia = activeLessons.findIndex((l) => l.id === a.lessonId);
      const ib = activeLessons.findIndex((l) => l.id === b.lessonId);
      cmp = ia - ib;
      if (cmp !== 0) return dir * cmp;
      return dir * a.term.localeCompare(b.term, "ja");
    });
    return cards;
  }, [vocabFiltered, lessonById, activeLessons, vocabSortKey, vocabSortDir, vocabListFilter]);

  type VocabGroupLesson = { lesson: (typeof data.lessons)[0]; cards: VocabCard[] };
  type VocabGroupBlock = { category: string; lessons: VocabGroupLesson[] };
  type SentenceGroupLesson = { lesson: (typeof data.lessons)[0]; rows: SentenceTask[] };
  type SentenceGroupBlock = { category: string; lessons: SentenceGroupLesson[] };
  type GrammarGroupLesson = { lesson: (typeof data.lessons)[0]; rows: GrammarTask[] };
  type GrammarGroupBlock = { category: string; lessons: GrammarGroupLesson[] };

  const vocabGroupedBlocks = useMemo((): VocabGroupBlock[] | null => {
    if (vocabSortKey !== "lesson" || vocabListFilter !== "all") return null;
    const asc = vocabSortDir === "asc";
    const cards = [...vocabFiltered];
    if (cards.length === 0) return [];

    const lessonOrder = new Map(activeLessons.map((l, i) => [l.id, i]));
    const byCat = new Map<string, Map<string, VocabCard[]>>();
    for (const c of cards) {
      const les = lessonById.get(c.lessonId);
      const cat = les?.category?.trim() || "未分类";
      if (!byCat.has(cat)) byCat.set(cat, new Map());
      const m = byCat.get(cat)!;
      if (!m.has(c.lessonId)) m.set(c.lessonId, []);
      m.get(c.lessonId)!.push(c);
    }
    for (const m of byCat.values()) {
      for (const arr of m.values()) {
        arr.sort((a, b) => (asc ? 1 : -1) * a.term.localeCompare(b.term, "ja"));
      }
    }
    const cats = [...byCat.keys()].sort((a, b) => (asc ? 1 : -1) * a.localeCompare(b, "zh"));
    const blocks: VocabGroupBlock[] = [];
    for (const category of cats) {
      const m = byCat.get(category)!;
      const lids = [...m.keys()].sort((ida, idb) => {
        const ia = lessonOrder.get(ida) ?? 99999;
        const ib = lessonOrder.get(idb) ?? 99999;
        return asc ? ia - ib : ib - ia;
      });
      const lessons: VocabGroupLesson[] = [];
      for (const lid of lids) {
        const lesson = lessonById.get(lid);
        if (lesson) lessons.push({ lesson, cards: m.get(lid)! });
      }
      blocks.push({ category, lessons });
    }
    return blocks;
  }, [vocabFiltered, vocabSortKey, vocabSortDir, vocabListFilter, lessonById, activeLessons]);

  const sentenceFiltered = useMemo(() => {
    const q = vocabSearchQuery.trim().toLowerCase();
    let rows = [...data.sentenceTasks];
    if (vocabListFilter !== "all") rows = rows.filter((s) => s.lessonId === vocabListFilter);
    if (q) rows = rows.filter((s) => `${s.jpAnswer}\n${s.zh}\n${s.sourceType ?? ""}`.toLowerCase().includes(q));
    const dir = vocabSortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      if (vocabSortKey === "alpha") return dir * a.jpAnswer.localeCompare(b.jpAnswer, "ja");
      const la = lessonById.get(a.lessonId);
      const lb = lessonById.get(b.lessonId);
      const ca = la?.category?.trim() || "未分类";
      const cb = lb?.category?.trim() || "未分类";
      const c = ca.localeCompare(cb, "zh");
      if (c !== 0) return dir * c;
      return dir * a.createdAt.localeCompare(b.createdAt);
    });
    return rows;
  }, [data.sentenceTasks, vocabListFilter, vocabSearchQuery, vocabSortDir, vocabSortKey, lessonById]);

  const grammarFiltered = useMemo(() => {
    const q = vocabSearchQuery.trim().toLowerCase();
    let rows = [...data.grammarTasks];
    if (vocabListFilter !== "all") rows = rows.filter((g) => g.lessonId === vocabListFilter);
    if (q) rows = rows.filter((g) => `${g.prompt}\n${g.zhPrompt ?? ""}\n${g.explanation}\n${g.knowledgePoint ?? ""}`.toLowerCase().includes(q));
    const dir = vocabSortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      if (vocabSortKey === "alpha") return dir * a.prompt.localeCompare(b.prompt, "ja");
      const la = lessonById.get(a.lessonId);
      const lb = lessonById.get(b.lessonId);
      const ca = la?.category?.trim() || "未分类";
      const cb = lb?.category?.trim() || "未分类";
      const c = ca.localeCompare(cb, "zh");
      if (c !== 0) return dir * c;
      return dir * a.createdAt.localeCompare(b.createdAt);
    });
    return rows;
  }, [data.grammarTasks, vocabListFilter, vocabSearchQuery, vocabSortDir, vocabSortKey, lessonById]);

  const sentenceGroupedBlocks = useMemo((): SentenceGroupBlock[] | null => {
    if (vocabSortKey !== "lesson" || vocabListFilter !== "all") return null;
    const asc = vocabSortDir === "asc";
    const rows = [...sentenceFiltered];
    if (rows.length === 0) return [];
    const lessonOrder = new Map(activeLessons.map((l, i) => [l.id, i]));
    const byCat = new Map<string, Map<string, SentenceTask[]>>();
    for (const row of rows) {
      const les = lessonById.get(row.lessonId);
      const cat = les?.category?.trim() || "未分类";
      if (!byCat.has(cat)) byCat.set(cat, new Map());
      const m = byCat.get(cat)!;
      if (!m.has(row.lessonId)) m.set(row.lessonId, []);
      m.get(row.lessonId)!.push(row);
    }
    for (const m of byCat.values()) {
      for (const arr of m.values()) arr.sort((a, b) => (asc ? 1 : -1) * a.jpAnswer.localeCompare(b.jpAnswer, "ja"));
    }
    const cats = [...byCat.keys()].sort((a, b) => (asc ? 1 : -1) * a.localeCompare(b, "zh"));
    return cats.map((category) => {
      const m = byCat.get(category)!;
      const lids = [...m.keys()].sort((ida, idb) => {
        const ia = lessonOrder.get(ida) ?? 99999;
        const ib = lessonOrder.get(idb) ?? 99999;
        return asc ? ia - ib : ib - ia;
      });
      const lessons = lids
        .map((lid) => {
          const lesson = lessonById.get(lid);
          return lesson ? { lesson, rows: m.get(lid)! } : null;
        })
        .filter((x): x is SentenceGroupLesson => x != null);
      return { category, lessons };
    });
  }, [vocabSortKey, vocabListFilter, vocabSortDir, sentenceFiltered, activeLessons, lessonById]);

  const grammarGroupedBlocks = useMemo((): GrammarGroupBlock[] | null => {
    if (vocabSortKey !== "lesson" || vocabListFilter !== "all") return null;
    const asc = vocabSortDir === "asc";
    const rows = [...grammarFiltered];
    if (rows.length === 0) return [];
    const lessonOrder = new Map(activeLessons.map((l, i) => [l.id, i]));
    const byCat = new Map<string, Map<string, GrammarTask[]>>();
    for (const row of rows) {
      const les = lessonById.get(row.lessonId);
      const cat = les?.category?.trim() || "未分类";
      if (!byCat.has(cat)) byCat.set(cat, new Map());
      const m = byCat.get(cat)!;
      if (!m.has(row.lessonId)) m.set(row.lessonId, []);
      m.get(row.lessonId)!.push(row);
    }
    for (const m of byCat.values()) {
      for (const arr of m.values()) arr.sort((a, b) => (asc ? 1 : -1) * a.prompt.localeCompare(b.prompt, "ja"));
    }
    const cats = [...byCat.keys()].sort((a, b) => (asc ? 1 : -1) * a.localeCompare(b, "zh"));
    return cats.map((category) => {
      const m = byCat.get(category)!;
      const lids = [...m.keys()].sort((ida, idb) => {
        const ia = lessonOrder.get(ida) ?? 99999;
        const ib = lessonOrder.get(idb) ?? 99999;
        return asc ? ia - ib : ib - ia;
      });
      const lessons = lids
        .map((lid) => {
          const lesson = lessonById.get(lid);
          return lesson ? { lesson, rows: m.get(lid)! } : null;
        })
        .filter((x): x is GrammarGroupLesson => x != null);
      return { category, lessons };
    });
  }, [vocabSortKey, vocabListFilter, vocabSortDir, grammarFiltered, activeLessons, lessonById]);

  const practiceStatsSnapshot = useMemo(
    () => ({
      practiceMarkCorrect: 0,
      practiceMarkWrong: 0,
      practiceMarkEasy: 0,
      dwellLessonReaderSec: 0,
      dwellPracticeSec: 0,
      daily: {},
      ...data.stats,
    }),
    [data.stats],
  );

  const statsFutureDueBundle = useMemo(
    () => aggregateFutureFirstDueByDay(data.vocabCards, data.sentenceTasks, data.grammarTasks, statsFutureHorizon),
    [data.vocabCards, data.sentenceTasks, data.grammarTasks, statsFutureHorizon],
  );

  const statsPastChartRowsFull = useMemo(
    () => buildPastRangeChartSeries(data.stats, statsPastRange),
    [data.stats, statsPastRange],
  );

  const statsPastChartRows = useMemo(
    () => applyPastTailSlice(statsPastChartRowsFull, statsPastRange, statsPastTailPreset),
    [statsPastChartRowsFull, statsPastRange, statsPastTailPreset],
  );

  /** 区间内过往图固定按「日历日」展示，与柱状图数据源一致（不按周聚合，避免 Tooltip/折线错位） */
  const statsPastChartRowsDisplayed = useMemo(() => statsPastChartRows, [statsPastChartRows]);

  const statsPastRangeSummary = useMemo(
    () => sumPastChartRows(statsPastChartRowsDisplayed),
    [statsPastChartRowsDisplayed],
  );

  const statsPastBoundsText = useMemo(() => {
    const weekSuffix = statsPastGranularity === "week" ? "横轴为自然周（周一至周日）汇总。" : "";
    const { start, end } = resolvePastRangeBounds(statsPastRange);
    const w = weekSuffix ? ` ${weekSuffix}` : "";
    if (statsPastRange === "allRecorded") {
      const base = "按日键从最早记录日到今日；旧备份若无 stats.daily 会偏少。";
      if (statsPastTailPreset !== "all") {
        return `${base} 趋势与下方「图中最近${statsPastTailPreset}天」一致（仅尾部日历日）。${w}`;
      }
      return `${base} 可缩小「图中」尾部天数以免点过密。${w}`;
    }
    return `${start} 至 ${end}（含首尾，本地日历）。${w}`;
  }, [statsPastRange, statsPastTailPreset, statsPastGranularity]);

  const statsFutureChartRows = useMemo(
    () => buildFutureChartRows(statsFutureDueBundle.rows),
    [statsFutureDueBundle.rows],
  );

  const practiceQueueSizes = useMemo(() => {
    const v = data.vocabCards.filter((c) => !trashedLessonIdSet.has(c.lessonId));
    const s = data.sentenceTasks.filter((t) => !trashedLessonIdSet.has(t.lessonId));
    const g = data.grammarTasks.filter((t) => !trashedLessonIdSet.has(t.lessonId));
    return {
      vocab: sortByReviewPriority(filterDueReviewItems(v)).length,
      sentence: sortByReviewPriority(filterDueReviewItems(s)).length,
      grammar: sortByReviewPriority(filterDueReviewItems(g)).length,
    };
  }, [data.vocabCards, data.sentenceTasks, data.grammarTasks, trashedLessonIdSet]);

  /** 全库今日（日历）待复习数量，与 SRS `filterDueReviewItems` 一致 */
  const globalDueReviewCounts = useMemo(
    () => buildGlobalDueReviewCounts(data.vocabCards, data.sentenceTasks, data.grammarTasks, trashedLessonIdSet),
    [data.vocabCards, data.sentenceTasks, data.grammarTasks, trashedLessonIdSet],
  );

  /** 各课文今日待复习条数（仅 total>0），便于统计页排序 */
  const lessonDueBreakdown = useMemo(
    () => buildLessonDueBreakdown(data.lessons, data.vocabCards, data.sentenceTasks, data.grammarTasks),
    [data.lessons, data.vocabCards, data.sentenceTasks, data.grammarTasks],
  );

  const lessonsByCategory = useMemo(() => {
    const map = new Map<string, typeof data.lessons>();
    for (const lesson of activeLessons) {
      const cat = lesson.category || "未分类";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(lesson);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0], "zh"))
      .map(([category, lessons]) => ({ category, lessons }));
  }, [activeLessons]);

  const lessonsByCategoryFiltered = useMemo(() => {
    const q = lessonSearchQuery.trim().toLowerCase();
    if (!q) return lessonsByCategory;
    return lessonsByCategory
      .map(({ category, lessons }) => ({
        category,
        lessons: lessons.filter(
          (l) =>
            (l.name || "").toLowerCase().includes(q) ||
            (l.category || "").toLowerCase().includes(q) ||
            lessonAuthorDisplay(l.author).toLowerCase().includes(q),
        ),
      }))
      .filter((block) => block.lessons.length > 0);
  }, [lessonsByCategory, lessonSearchQuery]);

  const allFilteredLessonIds = useMemo(
    () => lessonsByCategoryFiltered.flatMap((b) => b.lessons.map((l) => l.id)),
    [lessonsByCategoryFiltered],
  );

  function assignLessonCategory(lessonId: string, category: string) {
    const trimmed = category.trim() || "未分类";
    setData((prev) => ({
      ...prev,
      lessons: prev.lessons.map((l) =>
        l.id === lessonId ? { ...l, category: trimmed, updatedAt: nowIso() } : l,
      ),
    }));
  }

  function flashLessonReorder(ids: string[]) {
    setLessonReorderFlashIds(new Set(ids));
    if (lessonReorderFlashTimerRef.current) window.clearTimeout(lessonReorderFlashTimerRef.current);
    lessonReorderFlashTimerRef.current = window.setTimeout(() => {
      setLessonReorderFlashIds(new Set());
      lessonReorderFlashTimerRef.current = null;
    }, 260);
  }

  function applyLessonDrop(dragId: string, targetId: string, mode: "before" | "after" | "swap") {
    if (dragId === targetId) return;
    setData((prev) => {
      const list = [...prev.lessons];
      const dragIdx = list.findIndex((l) => l.id === dragId);
      const tgtIdx = list.findIndex((l) => l.id === targetId);
      if (dragIdx < 0 || tgtIdx < 0) return prev;
      if (mode === "swap") {
        const tmp = list[dragIdx];
        list[dragIdx] = list[tgtIdx]!;
        list[tgtIdx] = tmp!;
      } else {
        const [item] = list.splice(dragIdx, 1);
        let insert = list.findIndex((l) => l.id === targetId);
        if (insert < 0) insert = list.length;
        if (mode === "after") insert += 1;
        if (insert > list.length) insert = list.length;
        list.splice(insert, 0, item!);
      }
      return { ...prev, lessons: list };
    });
    flashLessonReorder([dragId, targetId]);
  }

  function resolveLessonDropMode(e: DragEvent<HTMLElement>): "before" | "after" | "swap" {
    const role = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-drop-role]")?.dataset.dropRole;
    if (role === "before" || role === "after" || role === "swap") return role;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < rect.width * 0.28) return "before";
    if (x > rect.width * 0.72) return "after";
    return "swap";
  }

  function categoryExpanded(cat: string) {
    return categoryOpen[cat] !== false;
  }

  function toggleCategory(cat: string) {
    setCategoryOpen((prev) => {
      const expanded = prev[cat] !== false;
      return { ...prev, [cat]: !expanded };
    });
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await loadLocalAppData();
      if (cancelled) return;
      const lessons = [...loaded.lessons].sort((a, b) => {
        const ta = new Date(a.createdAt).getTime();
        const tb = new Date(b.createdAt).getTime();
        if (ta !== tb) return ta - tb;
        return (a.name || "").localeCompare(b.name || "", "ja");
      });
      const loadedOrdered = { ...loaded, lessons };
      setData(loadedOrdered);
      if (typeof window !== "undefined") {
        const lid = localStorage.getItem(LS_ACTIVE_LESSON)?.trim();
        if (lid && loadedOrdered.lessons.some((l) => l.id === lid)) {
          setActiveLessonId(lid);
        }
        const pm = localStorage.getItem(LS_PRACTICE_MODE);
        if (pm === "vocab" || pm === "sentence" || pm === "grammar") {
          setMode(pm);
        }
      }
      queueMicrotask(() => {
        if (!cancelled) setStorageReady(true);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    void saveLocalAppData(data);
  }, [data, storageReady]);

  /** 登录且已配置云：本机数据变更后防抖上传，缩短多设备间「刚改完却还没上云」的空窗（仍尊重 busy 与指纹去重） */
  useEffect(() => {
    if (!storageReady || !isSupabaseBrowserConfigured()) return;
    if (cloudDataDebounceTimerRef.current != null) {
      window.clearTimeout(cloudDataDebounceTimerRef.current);
    }
    cloudDataDebounceTimerRef.current = window.setTimeout(() => {
      cloudDataDebounceTimerRef.current = null;
      void cloudSyncRunnerRef.current?.();
    }, 10_000);
    return () => {
      if (cloudDataDebounceTimerRef.current != null) {
        window.clearTimeout(cloudDataDebounceTimerRef.current);
        cloudDataDebounceTimerRef.current = null;
      }
    };
  }, [data, storageReady]);

  /** 回到前台立即尝试同步（上传侧），便于换设备前切走再回来时已推云 */
  useEffect(() => {
    if (!storageReady) return;
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void cloudSyncRunnerRef.current?.();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [storageReady]);

  useEffect(() => {
    setCloudAheadDismissRemoteAt(null);
  }, [cloudUserId]);

  useEffect(() => {
    if (appTab !== "data") setDataToast("");
  }, [appTab]);

  useEffect(() => {
    if (!dataToast) return;
    const t = window.setTimeout(() => setDataToast(""), 8000);
    return () => window.clearTimeout(t);
  }, [dataToast]);

  /** i2-5 余量：轮询云端元数据，若他处已上传则顶部提示（不自动覆盖本机） */
  useEffect(() => {
    if (!storageReady || !cloudUserId || !isSupabaseBrowserConfigured()) {
      setCloudRemoteAhead({ show: false, at: null });
      return;
    }
    let cancelled = false;
    const run = async () => {
      const sb = getSupabaseBrowserClient();
      if (!sb) return;
      try {
        const at = await fetchUserAppRemoteUpdatedAt(sb);
        if (cancelled) return;
        const show = isCloudUpdatedAfterLastSeen(cloudUserId, at);
        setCloudRemoteAhead({ show, at });
        if (!show) setCloudAheadDismissRemoteAt(null);
      } catch {
        if (!cancelled) setCloudRemoteAhead({ show: false, at: null });
      }
    };
    void run();
    const iv = window.setInterval(run, 60_000);
    const onVis = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [storageReady, cloudUserId]);

  useEffect(() => {
    if (!storageReady || !activeLessonId) return;
    const al = data.lessons.find((l) => l.id === activeLessonId);
    if (!al || al.trashedAt) {
      setActiveLessonId("");
    }
  }, [data.lessons, activeLessonId, storageReady]);

  useEffect(() => {
    if (!storageReady || !readerLessonId) return;
    const rl = data.lessons.find((l) => l.id === readerLessonId);
    if (!rl || rl.trashedAt) {
      setReaderLessonId(null);
    }
  }, [data.lessons, readerLessonId, storageReady]);

  useEffect(() => {
    if (appTab !== "lessons") {
      setLessonBulkMode(false);
      setLessonBulkSelected([]);
    }
  }, [appTab]);

  useEffect(() => {
    if (vocabListFilter === "all") return;
    const ok = data.lessons.some((l) => l.id === vocabListFilter && !l.trashedAt);
    if (!ok) setVocabListFilter("all");
  }, [data.lessons, vocabListFilter]);

  useEffect(() => {
    if (manualTargetLessonId === "active" || manualTargetLessonId === "__new_dict__") return;
    const ok = data.lessons.some((l) => l.id === manualTargetLessonId && !l.trashedAt);
    if (!ok) setManualTargetLessonId("active");
  }, [data.lessons, manualTargetLessonId]);

  useEffect(() => {
    if (newVocabLessonId === "" || newVocabLessonId === "__new_dict__") return;
    const ok = data.lessons.some((l) => l.id === newVocabLessonId && !l.trashedAt);
    if (!ok) setNewVocabLessonId("__new_dict__");
  }, [data.lessons, newVocabLessonId]);

  useEffect(() => {
    if (!storageReady) return;
    if (localStorage.getItem("jpLearn_autoSpeakVocab") === "0") {
      setAutoSpeakVocab(false);
    }
  }, [storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    const h = readStatsFutureHorizonFromStorage();
    if (h) setStatsFutureHorizon(h);
    const p = readStatsTabPrefsFromStorage();
    if (p.pastRange) setStatsPastRange(p.pastRange);
    if (p.pastTail !== undefined) setStatsPastTailPreset(p.pastTail);
    if (p.pastGranularity) setStatsPastGranularity(p.pastGranularity);
    if (p.pastViewMode) setStatsPastViewMode(p.pastViewMode);
    if (p.futureShowCumulative !== undefined) setStatsFutureShowCumulative(p.futureShowCumulative);
  }, [storageReady]);

  useEffect(() => {
    if (!storageReady || vocabDrillBootstrappedRef.current) return;
    let restoredProgress: Record<string, number> = {};
    let restoredCompleted = new Set<string>();
    try {
      const rawP = localStorage.getItem(LS_VOCAB_DRILL_PROGRESS);
      if (rawP) {
        const obj = JSON.parse(rawP) as Record<string, unknown>;
        restoredProgress = Object.fromEntries(
          Object.entries(obj).filter(([k, v]) => k && Number.isFinite(v) && Number(v) >= 0),
        ) as Record<string, number>;
      }
      const rawC = localStorage.getItem(LS_VOCAB_DRILL_COMPLETED);
      if (rawC) {
        const arr = JSON.parse(rawC) as unknown[];
        restoredCompleted = new Set(arr.filter((x): x is string => typeof x === "string" && x.length > 0));
      }
    } catch {
      restoredProgress = {};
      restoredCompleted = new Set();
    }
    // 首次无历史时：把现有词卡视作“已完成闭环”，避免打扰老数据体验。
    if (restoredCompleted.size === 0 && Object.keys(restoredProgress).length === 0 && data.vocabCards.length > 0) {
      restoredCompleted = new Set(data.vocabCards.map((v) => v.id));
    }
    setVocabDrillProgressById(restoredProgress);
    setVocabDrillCompletedIds(restoredCompleted);
    vocabDrillBootstrappedRef.current = true;
  }, [storageReady, data.vocabCards]);

  useEffect(() => {
    if (!storageReady) return;
    localStorage.setItem("jpLearn_autoSpeakVocab", autoSpeakVocab ? "1" : "0");
  }, [autoSpeakVocab, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    localStorage.setItem(LS_STATS_FUTURE_HORIZON, statsFutureHorizon);
  }, [statsFutureHorizon, storageReady]);

  useEffect(() => {
    if (!storageReady || !vocabDrillBootstrappedRef.current) return;
    localStorage.setItem(LS_VOCAB_DRILL_PROGRESS, JSON.stringify(vocabDrillProgressById));
  }, [storageReady, vocabDrillProgressById]);

  useEffect(() => {
    if (!storageReady || !vocabDrillBootstrappedRef.current) return;
    localStorage.setItem(LS_VOCAB_DRILL_COMPLETED, JSON.stringify([...vocabDrillCompletedIds]));
  }, [storageReady, vocabDrillCompletedIds]);

  useEffect(() => {
    if (!storageReady) return;
    localStorage.setItem(LS_STATS_PAST_RANGE, statsPastRange);
  }, [statsPastRange, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    localStorage.setItem(LS_STATS_PAST_TAIL, String(statsPastTailPreset));
  }, [statsPastTailPreset, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    localStorage.setItem(LS_STATS_PAST_GRANULARITY, statsPastGranularity);
  }, [statsPastGranularity, storageReady]);
  useEffect(() => {
    if (statsPastGranularity !== "day") setStatsPastGranularity("day");
  }, [statsPastGranularity]);

  useEffect(() => {
    if (!storageReady) return;
    localStorage.setItem(LS_STATS_PAST_VIEW_MODE, statsPastViewMode);
  }, [statsPastViewMode, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    localStorage.setItem(LS_STATS_FUTURE_CUMULATIVE, statsFutureShowCumulative ? "1" : "0");
  }, [statsFutureShowCumulative, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    if (activeLessonId) localStorage.setItem(LS_ACTIVE_LESSON, activeLessonId);
    else localStorage.removeItem(LS_ACTIVE_LESSON);
  }, [activeLessonId, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    localStorage.setItem(LS_PRACTICE_MODE, mode);
  }, [mode, storageReady]);

  /** 课文阅读全屏 / 练习标签：仅页面前台可见时每秒累计，每 30s 或切后台时写入 stats */
  useEffect(() => {
    if (!storageReady || typeof document === "undefined") return;
    const flush = () => {
      const p = dwellPendingRef.current;
      if (p.lessonReaderSec < 1 && p.practiceSec < 1) return;
      setData((prev) => ({
        ...prev,
        stats: mergeDwellSecondsIntoStats(prev.stats, {
          lessonReaderSec: p.lessonReaderSec,
          practiceSec: p.practiceSec,
        }),
      }));
      dwellPendingRef.current = { lessonReaderSec: 0, practiceSec: 0 };
    };

    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (readerLessonId) {
        dwellPendingRef.current.lessonReaderSec += 1;
      } else if (appTab === "practice") {
        dwellPendingRef.current.practiceSec += 1;
      }
      const sum = dwellPendingRef.current.lessonReaderSec + dwellPendingRef.current.practiceSec;
      if (sum >= 30) flush();
    };

    const id = window.setInterval(tick, 1000);
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      flush();
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [storageReady, readerLessonId, appTab]);

  useEffect(() => {
    if (!storageReady) return;
    if (appTab !== "stats") return;
    const p = dwellPendingRef.current;
    if (p.lessonReaderSec < 1 && p.practiceSec < 1) return;
    setData((prev) => ({
      ...prev,
      stats: mergeDwellSecondsIntoStats(prev.stats, {
        lessonReaderSec: p.lessonReaderSec,
        practiceSec: p.practiceSec,
      }),
    }));
    dwellPendingRef.current = { lessonReaderSec: 0, practiceSec: 0 };
  }, [appTab, storageReady]);

  /** 晨/夜彩蛋：仅拂晓与深夜显示，窗口内约每 30 分钟向 AI 求一句诗性短笺 */
  const [motivation, setMotivation] = useState("");
  const [motivationLoading, setMotivationLoading] = useState(false);
  const motivationLastFetchRef = useRef(0);
  const motivationFetchInFlightRef = useRef(false);
  const [homeHeroStage, setHomeHeroStage] = useState<"user" | "bundle" | "inline">("user");
  const [userHeroSrc, setUserHeroSrc] = useState("/picture.png");

  useEffect(() => {
    setUserHeroSrc(`/picture.png?cb=${Date.now()}`);
  }, []);

  useEffect(() => {
    const THIRTY_MIN_MS = 30 * 60 * 1000;
    const TICK_MS = 60 * 1000;

    const run = () => {
      const w = inMotivationWindow();
      if (!w) {
        setMotivation("");
        setMotivationLoading(false);
        motivationLastFetchRef.current = 0;
        motivationFetchInFlightRef.current = false;
        return;
      }
      const elapsed = Date.now() - motivationLastFetchRef.current;
      const needFetch = motivationLastFetchRef.current === 0 || elapsed >= THIRTY_MIN_MS;
      if (!needFetch || motivationFetchInFlightRef.current) return;
      motivationFetchInFlightRef.current = true;
      setMotivationLoading(true);
      void generateHomeMotivation({ window: w })
        .then((line) => {
          if (!inMotivationWindow()) return;
          setMotivation(line);
          motivationLastFetchRef.current = Date.now();
        })
        .catch(() => {
          if (!inMotivationWindow()) return;
          setMotivation("不知江月待何人，但见长江送流水——我读得慢，是因为把每个字都当成了月色。");
          motivationLastFetchRef.current = Date.now();
        })
        .finally(() => {
          motivationFetchInFlightRef.current = false;
          setMotivationLoading(false);
        });
    };

    run();
    const id = window.setInterval(run, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const queue = useMemo(() => {
    const vocabCardsActive = data.vocabCards.filter((c) => !trashedLessonIdSet.has(c.lessonId));
    const sentenceActive = data.sentenceTasks.filter((t) => !trashedLessonIdSet.has(t.lessonId));
    const grammarActive = data.grammarTasks.filter((t) => !trashedLessonIdSet.has(t.lessonId));
    const vocab = disableKinds.has("vocab")
      ? []
      : sortByReviewPriority(filterDueReviewItems(vocabCardsActive)).map((x) => ({
          kind: "vocab" as const,
          payload: x,
        }));
    const sentence = disableKinds.has("sentence")
      ? []
      : sortByReviewPriority(filterDueReviewItems(sentenceActive)).map((x) => ({
          kind: "sentence" as const,
          payload: x,
        }));
    const grammar = disableKinds.has("grammar")
      ? []
      : sortByReviewPriority(filterDueReviewItems(grammarActive)).map((x) => ({
          kind: "grammar" as const,
          payload: x,
        }));
    const list = [...vocab, ...sentence, ...grammar].filter((item) => item.kind === mode);
    if (!practiceRepeatPin || practiceRepeatPin.kind !== mode) return list;
    const idx = list.findIndex((i) => i.payload.id === practiceRepeatPin.id);
    if (idx <= 0) return list;
    const copy = [...list];
    const [picked] = copy.splice(idx, 1);
    return [picked!, ...copy];
  }, [data, disableKinds, mode, practiceRepeatPin, trashedLessonIdSet]);

  const current = queue[0];
  useEffect(() => {
    setFeedback("");
  }, [current?.payload.id, mode, answerMode, appTab]);

  const autoSpeakPracticeItem = useCallback((item: PracticeQueueHead | undefined) => {
    if (!item || typeof window === "undefined") return;
    if (item.kind === "vocab") {
      speakJapanese(item.payload.term);
      return;
    }
    if (item.kind === "sentence") {
      speakJapanese(item.payload.jpAnswer);
    }
  }, []);
  useEffect(() => {
    if (appTab !== "practice") return;
    if (!current || current.kind !== "sentence") return;
    if (current.payload.sourceType !== "listening") return;
    autoSpeakPracticeItem(current);
  }, [appTab, current?.payload.id, current?.kind, autoSpeakPracticeItem]);
  const vocabIdsInStore = useMemo(() => new Set(data.vocabCards.map((v) => v.id)), [data.vocabCards]);

  useEffect(() => {
    // 清理已删除词卡对应的闭环进度，避免 localStorage 积累无效键。
    setVocabDrillProgressById((prev) => {
      const next: Record<string, number> = {};
      let changed = false;
      for (const [id, n] of Object.entries(prev)) {
        if (vocabIdsInStore.has(id)) next[id] = n;
        else changed = true;
      }
      return changed ? next : prev;
    });
    setVocabDrillCompletedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (vocabIdsInStore.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [vocabIdsInStore]);
  const selectedVocab = data.vocabCards.find((card) => card.id === selectedVocabId);
  const selectedSentence = data.sentenceTasks.find((task) => task.id === selectedSentenceId);
  const selectedGrammar = data.grammarTasks.find((t) => t.id === selectedGrammarId);

  useEffect(() => {
    if (!selectedVocabId) {
      setVocabEditTerm("");
      setVocabEditKana("");
      setVocabEditZh("");
      setVocabEditEtym("");
      setVocabEditExample("");
      return;
    }
    const v = data.vocabCards.find((c) => c.id === selectedVocabId);
    if (!v) return;
    setVocabEditTerm(v.term);
    setVocabEditKana(v.kana);
    setVocabEditZh(v.meanings[0]?.zh ?? "");
    setVocabEditEtym(v.etymology);
    setVocabEditExample(v.latestExample ?? "");
  }, [selectedVocabId, data.vocabCards]);

  useEffect(() => {
    if (!selectedSentenceId) {
      setSentenceEditJp("");
      setSentenceEditZh("");
      setSentenceEditNote("");
      return;
    }
    const t = data.sentenceTasks.find((x) => x.id === selectedSentenceId);
    if (!t) return;
    setSentenceEditJp(t.jpAnswer);
    setSentenceEditZh(t.zh);
    setSentenceEditNote(t.teachingNote ?? "");
  }, [selectedSentenceId, data.sentenceTasks]);

  useEffect(() => {
    if (!selectedGrammarId) {
      setGrammarEditPrompt("");
      setGrammarEditZhPrompt("");
      setGrammarEditKnowledge("");
      setGrammarEditExplanation("");
      return;
    }
    const g = data.grammarTasks.find((x) => x.id === selectedGrammarId);
    if (!g) return;
    setGrammarEditPrompt(g.prompt);
    setGrammarEditZhPrompt(g.zhPrompt ?? "");
    setGrammarEditKnowledge(g.knowledgePoint ?? "");
    setGrammarEditExplanation(g.explanation);
  }, [selectedGrammarId, data.grammarTasks]);

  const sentenceShuffle = useMemo(() => {
    if (current?.kind !== "sentence") return { id: "", tokens: [] as string[] };
    return { id: current.payload.id, tokens: stableShuffle([...current.payload.tokens], current.payload.id) };
  }, [current]);

  const vocabMcOptions = useMemo(() => {
    if (current?.kind !== "vocab") return [] as string[];
    const c = current.payload;
    return stableShuffle([c.term, ...c.vocabDistractors], `${c.id}_mc`);
  }, [current]);

  const vocabPracticeDir = useMemo((): "zh2jp" | "jp2zh" => {
    if (current?.kind !== "vocab") return "zh2jp";
    const id = current.payload.id;
    // 新词四连闭环：0/2 -> 中→日；1/3 -> 日→中；完成后回退原稳定随机。
    if (!vocabDrillCompletedIds.has(id)) {
      const step = vocabDrillProgressById[id] ?? 0;
      return step % 2 === 0 ? "zh2jp" : "jp2zh";
    }
    const pick = stableShuffle(["zh2jp", "jp2zh"], `${id}_vdir`)[0];
    return pick === "jp2zh" ? "jp2zh" : "zh2jp";
  }, [current, vocabDrillCompletedIds, vocabDrillProgressById]);

  const currentVocabDrillStep = useMemo(() => {
    if (current?.kind !== "vocab") return null;
    const id = current.payload.id;
    if (vocabDrillCompletedIds.has(id)) return null;
    const step = vocabDrillProgressById[id] ?? 0;
    return Math.min(4, Math.max(1, step + 1));
  }, [current, vocabDrillCompletedIds, vocabDrillProgressById]);

  const vocabMcZhOptions = useMemo(() => {
    if (current?.kind !== "vocab") return [] as string[];
    const c = current.payload;
    const zh = c.meanings[0]?.zh?.trim() || "—";
    return stableShuffle([zh, ...c.vocabZhDistractors], `${c.id}_mczh`);
  }, [current]);

  useEffect(() => {
    if (!current) {
      practiceChoiceKbSlotsRef.current = [];
      return;
    }
    if (current.kind === "vocab" && answerMode === "choice") {
      practiceChoiceKbSlotsRef.current =
        vocabPracticeDir === "zh2jp"
          ? vocabMcOptions.map((label) => ({ label, flashKey: `v_${label}` }))
          : vocabMcZhOptions.map((label) => ({ label, flashKey: `vz_${label}` }));
      return;
    }
    if (current.kind === "grammar" && answerMode === "choice") {
      practiceChoiceKbSlotsRef.current = current.payload.choices.map((ch) => ({
        label: ch.text,
        flashKey: `g_${ch.id}`,
      }));
      return;
    }
    practiceChoiceKbSlotsRef.current = [];
  }, [current, answerMode, vocabPracticeDir, vocabMcOptions, vocabMcZhOptions]);

  useEffect(() => {
    if (appTab === "practice") resumePracticeAudio();
  }, [appTab]);

  useEffect(() => {
    return () => {
      if (choiceFlashTimerRef.current) window.clearTimeout(choiceFlashTimerRef.current);
      if (lessonReorderFlashTimerRef.current) window.clearTimeout(lessonReorderFlashTimerRef.current);
      if (practiceSolutionTimerRef.current) window.clearTimeout(practiceSolutionTimerRef.current);
      if (sentenceRevealTimerRef.current) window.clearTimeout(sentenceRevealTimerRef.current);
    };
  }, []);

  function createLesson() {
    if (!lessonName.trim()) return;
    if (lessonKindDraft === "video") {
      const vurl = lessonVideoUrlDraft.trim();
      if (!/^https?:\/\//i.test(vurl)) {
        setLessonMediaTip("视频课文请填写以 http:// 或 https:// 开头的视频链接（如 YouTube 观看页、B 站视频页或 .mp4 直链）。不再支持本机整文件 mp4 入库。");
        return;
      }
    }
    if (!lessonSubtitleText.trim()) {
      setLessonMediaTip("请先粘贴带时间戳的字幕文本。");
      return;
    }
    const cues = lessonSubtitleText.trim() ? parseTimestampedTranscriptToVideoCues(lessonSubtitleText) : [];
    if (cues.length === 0) {
      setLessonMediaTip("字幕不合规：必须包含 (0:07) 这种时间戳。");
      return;
    }
    const raw = cues.map((c) => c.text.trim()).filter(Boolean).join("\n");
    if (!/\S/.test(raw)) {
      setLessonMediaTip("字幕可用行为空，请检查后重试。");
      return;
    }
    const lesson = {
      id: uid("lesson"),
      name: lessonName.trim(),
      content: raw,
      category: lessonCategory.trim() || "未分类",
      author: lessonAuthorForSave(lessonAuthor),
      lessonKind: lessonKindDraft,
      listeningAudioDataUrl: undefined,
      videoSourceUrl: lessonKindDraft === "video" ? lessonVideoUrlDraft.trim() : undefined,
      videoCues: lessonKindDraft === "video" && cues.length > 0 ? cues : undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    setData((prev) => normalizeAppData({ ...prev, lessons: [...prev.lessons, lesson] }));
    setActiveLessonId(lesson.id);
    setReaderLessonId(lesson.id);
    setLessonName("");
    setLessonCategory("");
    setLessonAuthor("");
    setLessonKindDraft("text");
    setLessonVideoUrlDraft("");
    setLessonSubtitleText("");
    setLessonMediaTip("");
    setImportModalOpen(false);
    setAppTab("lessons");
  }

  function openLessonReader(lessonId: string) {
    const les = data.lessons.find((l) => l.id === lessonId);
    if (!les || les.trashedAt) return;
    setActiveLessonId(lessonId);
    setReaderLessonId(lessonId);
  }

  function changeLessonCategory(lessonId: string, current: string) {
    const next = window.prompt("修改该课文的分类名称", current || "未分类");
    if (next === null) return;
    const trimmed = next.trim() || "未分类";
    setData((prev) => ({
      ...prev,
      lessons: prev.lessons.map((l) => (l.id === lessonId ? { ...l, category: trimmed, updatedAt: nowIso() } : l)),
    }));
  }

  function toggleLessonBulkSelect(lessonId: string) {
    setLessonBulkSelected((prev) =>
      prev.includes(lessonId) ? prev.filter((id) => id !== lessonId) : [...prev, lessonId],
    );
  }

  function moveLessonsToTrash(ids: string[]) {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const at = nowIso();
    setData((prev) => ({
      ...prev,
      lessons: prev.lessons.map((l) => (idSet.has(l.id) ? { ...l, trashedAt: at, updatedAt: at } : l)),
    }));
    setLessonBulkSelected((prev) => prev.filter((id) => !idSet.has(id)));
    setLessonBulkMode(false);
  }

  function restoreLessonsFromTrash(ids: string[]) {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const t = nowIso();
    setData((prev) => ({
      ...prev,
      lessons: prev.lessons.map((l) => (idSet.has(l.id) ? { ...l, trashedAt: undefined, updatedAt: t } : l)),
    }));
  }

  function purgeLessonsForever(lessonIds: string[]) {
    if (lessonIds.length === 0) return;
    const idSet = new Set(lessonIds);
    setData((prev) => ({
      ...prev,
      lessons: prev.lessons.filter((l) => !idSet.has(l.id)),
      vocabCards: prev.vocabCards.filter((c) => !idSet.has(c.lessonId)),
      sentenceTasks: prev.sentenceTasks.filter((t) => !idSet.has(t.lessonId)),
      grammarTasks: prev.grammarTasks.filter((g) => !idSet.has(g.lessonId)),
      chatSessions: prev.chatSessions.filter((s) => !idSet.has(s.lessonId)),
      lessonNotes: prev.lessonNotes.filter((n) => !idSet.has(n.lessonId)),
      favoriteSentences: prev.favoriteSentences.filter((f) => !idSet.has(f.lessonId)),
    }));
    setLessonBulkSelected((prev) => prev.filter((id) => !idSet.has(id)));
  }

  function batchAssignLessonCategoryToSelection() {
    if (lessonBulkSelected.length === 0) return;
    const next = window.prompt(`将已选 ${lessonBulkSelected.length} 篇课文归入的分类名称`, "未分类");
    if (next === null) return;
    const trimmed = next.trim() || "未分类";
    const idSet = new Set(lessonBulkSelected);
    const t = nowIso();
    setData((prev) => ({
      ...prev,
      lessons: prev.lessons.map((l) => (idSet.has(l.id) ? { ...l, category: trimmed, updatedAt: t } : l)),
    }));
    setLessonBulkSelected([]);
    setLessonBulkMode(false);
  }

  const submitAnswer = useCallback(
    (review: "correct" | "wrong" | "easy", opts?: { wrongHint?: string }) => {
      if (!current) return;
      const currentKind = current.kind;
      const id = current.payload.id;
      practicePeekRef.current = { kind: currentKind, id };
      if (currentKind === "vocab") {
        const card0 = dataRef.current.vocabCards.find((c) => c.id === id);
        if (card0) {
          const srsPatch = review === "wrong" ? patchAfterWrong(card0) : patchAfterCorrect(card0, review);
          if (srsPatch) {
            const at = nowIso();
            scheduleVocabCloudFieldPatch(id, {
              mastery: srsPatch.mastery,
              reviewStage: srsPatch.reviewStage,
              nextReviewDay: srsPatch.nextReviewDay,
              reviewGraduated: srsPatch.reviewGraduated,
              updatedAt: at,
            });
          }
        }
      }
      if (currentKind === "sentence") {
        const t0 = dataRef.current.sentenceTasks.find((x) => x.id === id);
        if (t0) {
          const srsPatch = review === "wrong" ? patchAfterWrong(t0) : patchAfterCorrect(t0, review);
          if (srsPatch) {
            scheduleSentenceCloudFieldPatch(id, {
              mastery: srsPatch.mastery,
              reviewStage: srsPatch.reviewStage,
              nextReviewDay: srsPatch.nextReviewDay,
              reviewGraduated: srsPatch.reviewGraduated,
            });
          }
        }
      }
      if (currentKind === "grammar") {
        const g0 = dataRef.current.grammarTasks.find((x) => x.id === id);
        if (g0) {
          const srsPatch = review === "wrong" ? patchAfterWrong(g0) : patchAfterCorrect(g0, review);
          if (srsPatch) {
            scheduleGrammarCloudFieldPatch(id, {
              mastery: srsPatch.mastery,
              reviewStage: srsPatch.reviewStage,
              nextReviewDay: srsPatch.nextReviewDay,
              reviewGraduated: srsPatch.reviewGraduated,
            });
          }
        }
      }
      setData((prev) => {
        const stats = bumpPracticeMarkStats(prev.stats, review);
        if (currentKind === "vocab") {
          const card = prev.vocabCards.find((c) => c.id === id);
          if (!card) return prev;
          const patch = review === "wrong" ? patchAfterWrong(card) : patchAfterCorrect(card, review);
          if (review !== "wrong" && patch === null) return { ...prev, stats };
          return {
            ...prev,
            stats,
            vocabCards: prev.vocabCards.map((c) =>
              c.id === id ? { ...c, ...patch!, updatedAt: nowIso() } : c,
            ),
          };
        }
        if (currentKind === "sentence") {
          const task = prev.sentenceTasks.find((t) => t.id === id);
          if (!task) return prev;
          const patch = review === "wrong" ? patchAfterWrong(task) : patchAfterCorrect(task, review);
          if (review !== "wrong" && patch === null) return { ...prev, stats };
          return {
            ...prev,
            stats,
            sentenceTasks: prev.sentenceTasks.map((t) => (t.id === id ? { ...t, ...patch! } : t)),
          };
        }
        const g = prev.grammarTasks.find((t) => t.id === id);
        if (!g) return prev;
        const patch = review === "wrong" ? patchAfterWrong(g) : patchAfterCorrect(g, review);
        if (review !== "wrong" && patch === null) return { ...prev, stats };
        return {
          ...prev,
          stats,
          grammarTasks: prev.grammarTasks.map((t) => (t.id === id ? { ...t, ...patch! } : t)),
        };
      });
      if (review === "wrong") {
        playPracticeError();
        setPracticeRepeatPin({ kind: currentKind, id });
      } else {
        playPracticeSuccess();
        setPracticeRepeatPin(null);
      }
      if (currentKind === "vocab") {
        if (review === "easy") {
          setVocabDrillCompletedIds((prev) => (prev.has(id) ? prev : new Set([...prev, id])));
          setVocabDrillProgressById((prev) => {
            if (!(id in prev)) return prev;
            const { [id]: _omit, ...rest } = prev;
            return rest;
          });
        } else {
          const alreadyDone = vocabDrillCompletedIds.has(id);
          if (!alreadyDone) {
            setVocabDrillProgressById((prev) => {
              const nextN = (prev[id] ?? 0) + 1;
              if (nextN >= 4) {
                setVocabDrillCompletedIds((set0) => (set0.has(id) ? set0 : new Set([...set0, id])));
                const { [id]: _omit, ...rest } = prev;
                return rest;
              }
              return { ...prev, [id]: nextN };
            });
          }
        }
      }
      autoSpeakPracticeItem(current);
      setFeedback(
        review === "wrong"
          ? opts?.wrongHint ?? "答错了，但你在进步！再来一题就更稳了！"
          : review === "easy"
            ? "太简单！你这题拿捏住了！"
            : "答对了！干得漂亮，继续冲！",
      );
      setAnswer("");
      setAnswerConfirmed(false);
    },
    [
      current,
      vocabDrillCompletedIds,
      autoSpeakPracticeItem,
      scheduleVocabCloudFieldPatch,
      scheduleSentenceCloudFieldPatch,
      scheduleGrammarCloudFieldPatch,
    ],
  );

  const revealPracticeSolutionKey = useCallback((key: string) => {
    setPracticeSolutionKey(key);
    if (practiceSolutionTimerRef.current) window.clearTimeout(practiceSolutionTimerRef.current);
    practiceSolutionTimerRef.current = window.setTimeout(() => {
      setPracticeSolutionKey(null);
      practiceSolutionTimerRef.current = null;
    }, 2600);
  }, []);

  const pulseSentenceSolutionReveal = useCallback(() => {
    setSentenceSolutionReveal(true);
    if (sentenceRevealTimerRef.current) window.clearTimeout(sentenceRevealTimerRef.current);
    sentenceRevealTimerRef.current = window.setTimeout(() => {
      setSentenceSolutionReveal(false);
      sentenceRevealTimerRef.current = null;
    }, 3200);
  }, []);

  const flashChoiceKey = useCallback((key: string) => {
    setChoiceFlashKey(key);
    if (choiceFlashTimerRef.current) window.clearTimeout(choiceFlashTimerRef.current);
    choiceFlashTimerRef.current = window.setTimeout(() => {
      setChoiceFlashKey("");
      choiceFlashTimerRef.current = null;
    }, 420);
  }, []);

  /** 手动「判错」与自动判错共用：句子正解条 + 四选一正解格闪动/绿环 */
  const primeWrongRevealHints = useCallback(() => {
    if (!current) return;
    if (current.kind === "sentence") pulseSentenceSolutionReveal();
    if (answerMode === "choice" && (current.kind === "vocab" || current.kind === "grammar")) {
      const fk = getPracticeCorrectChoiceFlashKey(current, vocabPracticeDir);
      if (fk) {
        flashChoiceKey(fk);
        revealPracticeSolutionKey(fk);
      }
    }
  }, [answerMode, current, flashChoiceKey, pulseSentenceSolutionReveal, revealPracticeSolutionKey, vocabPracticeDir]);

  const confirmAnswer = useCallback(() => {
    if (!current) return;
    practicePeekRef.current = { kind: current.kind, id: current.payload.id };
    setAnswerConfirmed(true);
    const ok = isPracticeChoiceOrSentenceComposerCorrect(current, answer, vocabPracticeDir);
    setFeedback(ok ? "答对了！太棒了，继续保持！" : "答错了，没事！下一题拿下它！");
    autoSpeakPracticeItem(current);
  }, [current, autoSpeakPracticeItem, answer, vocabPracticeDir]);

  const confirmOrNextPractice = useCallback(() => {
    if (!current) return;
    if (answerMode === "input") {
      const emptyFill =
        current.kind === "sentence"
          ? normalizePracticeWhitespace(answer).length === 0
          : !answer.trim();
      if (emptyFill) {
        setFeedback(current.kind === "sentence" ? "请先输入完整日语句。" : "请先输入答案。");
        return;
      }
      if (current.kind === "grammar") {
        setFillDetailReveal("grammar");
        if (isGrammarOrSentenceFillCorrect(current, answer)) {
          submitAnswer("correct");
        } else {
          primeWrongRevealHints();
          submitAnswer("wrong", { wrongHint: buildAutoWrongFeedback(current, vocabPracticeDir) });
        }
        return;
      }
      if (current.kind === "sentence") {
        setFillDetailReveal("sentence");
        if (isGrammarOrSentenceFillCorrect(current, answer)) {
          submitAnswer("correct");
        } else {
          pulseSentenceSolutionReveal();
          primeWrongRevealHints();
          submitAnswer("wrong", { wrongHint: buildAutoWrongFeedback(current, vocabPracticeDir) });
        }
        return;
      }
      if (current.kind === "vocab") {
        if (isVocabInputAnswerCorrect(current, answer, vocabPracticeDir)) {
          if (autoSpeakVocab && vocabPracticeDir === "zh2jp" && typeof window !== "undefined") {
            speakJapanese(current.payload.term);
          }
          submitAnswer("correct");
        } else {
          setFillDetailReveal("vocab");
          primeWrongRevealHints();
          submitAnswer("wrong", { wrongHint: buildAutoWrongFeedback(current, vocabPracticeDir) });
        }
        return;
      }
      submitAnswer("correct");
      return;
    }
    if (!answerConfirmed) {
      if (!answer.trim()) {
        setFeedback("先点选一个选项。");
        return;
      }
      confirmAnswer();
    } else {
      if (isPracticeChoiceOrSentenceComposerCorrect(current, answer, vocabPracticeDir)) {
        submitAnswer("correct");
      } else {
        primeWrongRevealHints();
        submitAnswer("wrong", { wrongHint: buildAutoWrongFeedback(current, vocabPracticeDir) });
      }
    }
  }, [
    answerMode,
    answerConfirmed,
    answer,
    confirmAnswer,
    current,
    primeWrongRevealHints,
    pulseSentenceSolutionReveal,
    submitAnswer,
    vocabPracticeDir,
    autoSpeakVocab,
  ]);

  practiceHotkeysRef.current = {
    appTab,
    mode,
    answerMode,
    submitAnswer,
    confirmOrNextPractice,
    flashChoiceKey,
  };

  useEffect(() => {
    setAnswer("");
    setAnswerConfirmed(false);
    setPracticeSolutionKey(null);
    if (practiceSolutionTimerRef.current) {
      window.clearTimeout(practiceSolutionTimerRef.current);
      practiceSolutionTimerRef.current = null;
    }
    setSentenceSolutionReveal(false);
    if (sentenceRevealTimerRef.current) {
      window.clearTimeout(sentenceRevealTimerRef.current);
      sentenceRevealTimerRef.current = null;
    }
  }, [mode, current?.kind, current?.payload.id, answerMode]);

  useEffect(() => {
    setFillDetailReveal("none");
  }, [mode, current?.kind, current?.payload.id, answerMode]);

  useEffect(() => {
    setPracticeRepeatPin(null);
  }, [activeLessonId, mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const h = practiceHotkeysRef.current;
      if (!h || h.appTab !== "practice") return;
      const key = event.key;
      if (key === "Enter") {
        const tag = (event.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        event.preventDefault();
        h.confirmOrNextPractice();
        return;
      }
      if (/^[1-4]$/.test(key) && h.answerMode === "choice") {
        const slots = practiceChoiceKbSlotsRef.current;
        const idx = Number(key) - 1;
        const slot = slots[idx];
        if (!slot) return;
        event.preventDefault();
        resumePracticeAudio();
        playPracticeTap();
        setAnswer(slot.label);
        h.flashChoiceKey(slot.flashKey);
        return;
      }
      if (key.toLowerCase() === "n") {
        h.confirmOrNextPractice();
      }
      if (key.toLowerCase() === "j") {
        h.submitAnswer("easy");
      }
      if (key.toLowerCase() === "x") {
        setDisableKinds((prev) => new Set([...prev, h.mode]));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const closeNewVocabModal = useCallback(() => {
    setNewVocabModalOpen(false);
    setVocabTerm("");
    setVocabKana("");
    setVocabZh("");
    setVocabEtymology("");
    setVocabExampleForNewCard("");
  }, []);

  /** Esc：优先关最上层浮层（capture，避免与练习区内输入框抢键时仍可靠） */
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (selectedGrammarId) {
        event.preventDefault();
        setSelectedGrammarId("");
        return;
      }
      if (selectedSentenceId) {
        event.preventDefault();
        setSelectedSentenceId("");
        return;
      }
      if (selectedVocabId) {
        event.preventDefault();
        setSelectedVocabId("");
        return;
      }
      if (practiceToolsModalOpen) {
        event.preventDefault();
        setPracticeToolsModalOpen(false);
        return;
      }
      if (newVocabModalOpen) {
        event.preventDefault();
        closeNewVocabModal();
        return;
      }
      if (importModalOpen) {
        event.preventDefault();
        setImportModalOpen(false);
        return;
      }
      if (authDialogOpen) {
        event.preventDefault();
        setAuthDialogOpen(false);
        return;
      }
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [
    selectedGrammarId,
    selectedSentenceId,
    selectedVocabId,
    practiceToolsModalOpen,
    newVocabModalOpen,
    importModalOpen,
    authDialogOpen,
    closeNewVocabModal,
  ]);

  function openNewVocabModal() {
    const fallback = activeLessonId || data.lessons[0]?.id || "__new_dict__";
    setNewVocabLessonId(fallback);
    setVocabTerm("");
    setVocabKana("");
    setVocabZh("");
    setVocabEtymology("");
    setVocabExampleForNewCard("");
    setNewVocabModalOpen(true);
  }

  function resolveManualTargetLessonId(): string | null {
    if (manualTargetLessonId === "active") return activeLessonId || data.lessons[0]?.id || null;
    if (manualTargetLessonId !== "__new_dict__") return manualTargetLessonId;
    const name = manualNewDictName.trim() || "我的词典";
    const category = manualNewDictCategory.trim() || "词典";
    let createdId = "";
    setData((prev) => {
      const existed = prev.lessons.find((l) => l.name === name && l.category === category);
      if (existed) {
        createdId = existed.id;
        return prev;
      }
      const id = uid("lesson");
      createdId = id;
      const now = nowIso();
      const lesson = {
        id,
        name,
        category,
        author: "词典",
        content: "",
        lessonKind: "text" as const,
        createdAt: now,
        updatedAt: now,
      };
      return { ...prev, lessons: [lesson, ...prev.lessons] };
    });
    return createdId || null;
  }

  async function enrichNewVocabModal() {
    let lesson = data.lessons.find((l) => l.id === newVocabLessonId);
    if (newVocabLessonId === "__new_dict__") {
      lesson = { id: "", name: manualNewDictName.trim() || "我的词典", category: manualNewDictCategory.trim() || "词典", content: "", createdAt: nowIso() };
    }
    if (!lesson || !vocabTerm.trim()) return;
    setNewVocabEnrichBusy(true);
    try {
      const t = vocabTerm.trim();
      const fromLesson = extractExampleSegmentForTerm(lesson.content, t) || "";
      const segForAi = vocabExampleForNewCard.trim() || fromLesson || t;
      const r = await enrichVocabFields({
        term: t,
        exampleSegment: segForAi,
        lessonTitle: lesson.name,
        lessonCategory: lesson.category,
      });
      setVocabKana(r.kana);
      setVocabZh(r.zh);
      setVocabEtymology(r.etymology);
      if (r.exampleJp?.trim()) setVocabExampleForNewCard(r.exampleJp.trim());
      else setVocabExampleForNewCard((prev) => prev.trim() || fromLesson);
    } finally {
      setNewVocabEnrichBusy(false);
    }
  }

  async function submitNewVocabCard() {
    let lesson = data.lessons.find((l) => l.id === newVocabLessonId);
    if (!vocabTerm.trim() || newVocabSaveBusy) return;
    if (newVocabLessonId === "__new_dict__") {
      setManualTargetLessonId("__new_dict__");
      const id = resolveManualTargetLessonId();
      if (!id) return;
      lesson = dataRef.current.lessons.find((l) => l.id === id);
    }
    if (!lesson) return;
    setNewVocabSaveBusy(true);
    try {
      const t = vocabTerm.trim();
      const fromLesson = extractExampleSegmentForTerm(lesson.content, t) || "";
      const segForAi = vocabExampleForNewCard.trim() || fromLesson || t;
      const r = await enrichVocabFields({
        term: t,
        exampleSegment: segForAi,
        lessonTitle: lesson.name,
        lessonCategory: lesson.category,
      });
      const kanaOut = (vocabKana.trim() || r.kana).trim() || "—";
      const zhOut = (vocabZh.trim() || r.zh).trim() || "—";
      const etymOut = (vocabEtymology.trim() || r.etymology).trim() || "—";
      const exampleOverride =
        vocabExampleForNewCard.trim() || r.exampleJp?.trim() || (fromLesson || undefined);
      setData((prev) => {
        const siblings = prev.vocabCards
          .filter((c) => c.lessonId === lesson.id && c.term.trim() !== t)
          .map((c) => c.term);
        const siblingZhs = prev.vocabCards
          .filter((c) => c.lessonId === lesson.id && c.term.trim() !== t)
          .map((c) => c.meanings[0]?.zh?.trim())
          .filter((z): z is string => Boolean(z && z.length > 0));
        const card = createVocabCard({
          lessonId: lesson.id,
          term: t,
          kana: kanaOut,
          zh: zhOut,
          etymology: etymOut,
          lessonContent: lesson.content,
          exampleOverride,
          distractors: r.distractors,
          zhDistractors: r.zhDistractors,
          lessonSiblingTerms: siblings,
          lessonSiblingZhs: siblingZhs,
        });
        setVocabDrillCompletedIds((prevDone) => {
          if (!prevDone.has(card.id)) return prevDone;
          const next = new Set(prevDone);
          next.delete(card.id);
          return next;
        });
        setVocabDrillProgressById((prevProg) => ({ ...prevProg, [card.id]: 0 }));
        return { ...prev, vocabCards: upsertVocabWithPolysemyReset(prev.vocabCards, card) };
      });
      setActiveLessonId(lesson.id);
      closeNewVocabModal();
    } finally {
      setNewVocabSaveBusy(false);
    }
  }

  async function addDemoGrammar() {
    const targetLessonId = resolveManualTargetLessonId();
    if (!targetLessonId) return;
    const targetLesson = dataRef.current.lessons.find((l) => l.id === targetLessonId);
    if (!targetLesson) return;
    setPracticeToolsModalOpen(false);
    const stem = grammarStem.trim() || "私は毎朝___日本語を勉強します。";
    const ai = await generateGrammarOptions({
      prompt: stem,
      knowledgePoint: grammarKnowledgePoint.trim() || undefined,
    });
    const task = createGrammarTask({
      lessonId: targetLesson.id,
      sourceSentence: targetLesson.content.split(/\r?\n/).find((line) => line.includes(stem.replace("___", ""))) || stem,
      prompt: stem,
      zhPrompt: ai.zhPrompt,
      choices: ai.choices,
      answerIndex: ai.answerIndex,
      explanation: ai.explanation,
      wrongReasons: ai.wrongReasons,
      knowledgePoint: grammarKnowledgePoint.trim() || undefined,
    });
    setData((prev) => ({ ...prev, grammarTasks: [task, ...prev.grammarTasks] }));
    setLatestGrammarExplanation(ai.explanation);
  }

  function addSampleSentenceTask() {
    const targetLessonId = resolveManualTargetLessonId();
    if (!targetLessonId) return;
    setPracticeToolsModalOpen(false);
    const task = createSentenceTask({
      lessonId: targetLessonId,
      zh: "我今天要认真学习日语。",
      jpAnswer: "私は 今日 真面目に 日本語を 勉強します",
    });
    setData((prev) => ({ ...prev, sentenceTasks: [task, ...prev.sentenceTasks] }));
  }

  async function saveManualSentenceTask() {
    const targetLessonId = resolveManualTargetLessonId();
    if (!targetLessonId) return;
    const zh = practiceSentenceZh.trim();
    const jp = practiceSentenceJp.trim();
    if (!zh || !jp) return;
    const teachingNote = await generateSentenceTeachingNote({ jp, zh });
    const task = createSentenceTask({ lessonId: targetLessonId, zh, jpAnswer: jp, teachingNote });
    setData((prev) => ({ ...prev, sentenceTasks: [task, ...prev.sentenceTasks] }));
    setPracticeSentenceZh("");
    setPracticeSentenceJp("");
    setPracticeToolsModalOpen(false);
  }

  function allocateNewChatTitle(lessonId: string): string {
    const cur = dataRef.current;
    const titles = new Set(
      cur.chatSessions.filter((s) => s.lessonId === lessonId).map((s) => s.title.trim()),
    );
    let title = "新对话";
    if (titles.has(title)) {
      let n = 2;
      while (titles.has(`新对话 (${n})`)) n += 1;
      title = `新对话 (${n})`;
    }
    return title;
  }

  async function createOrReplyChat() {
    const userInput = chatInput.trim();
    if (!activeLesson || !userInput) return;
    if (chatBusySessionId) return;

    const existing = data.chatSessions.find((session) => session.id === selectedChatId);
    const session =
      existing ?? createChatSession(activeLesson.id, chatTitle.trim() || allocateNewChatTitle(activeLesson.id), chatMode);
    const withUser = pushMessage(session, "user", userInput);
    const pendingAssistantId = uid("msg");
    const withPendingAssistant = {
      ...withUser,
      messages: [...withUser.messages, { id: pendingAssistantId, role: "assistant" as const, content: "AI 正在回答中...", createdAt: nowIso() }],
      updatedAt: nowIso(),
    };

    // 乐观更新：立即清空输入框 + 先显示用户消息和“AI 正在回答中…”
    setChatInput("");
    setSelectedChatId(session.id);
    setChatBusySessionId(session.id);
    setData((prev) => ({
      ...prev,
      chatSessions: existing
        ? prev.chatSessions.map((item) => (item.id === existing.id ? withPendingAssistant : item))
        : [withPendingAssistant, ...prev.chatSessions],
    }));
    scheduleChatSessionsCloudSubtreeMerge();

    try {
      const reply = await chatWithLesson({
        mode: withUser.mode,
        lessonContent: withUser.mode === "deep" ? activeLesson.content : "",
        message: userInput,
        recentMessages: recentContext(withUser.messages).map((m) => ({ role: m.role, content: m.content })),
      });

      setData((prev) => ({
        ...prev,
        chatSessions: prev.chatSessions.map((item) =>
          item.id === session.id
            ? {
                ...item,
                messages: item.messages.map((m) => (m.id === pendingAssistantId ? { ...m, content: reply, createdAt: nowIso() } : m)),
                updatedAt: nowIso(),
              }
            : item,
        ),
      }));
    } catch {
      setData((prev) => ({
        ...prev,
        chatSessions: prev.chatSessions.map((item) =>
          item.id === session.id
            ? {
                ...item,
                messages: item.messages.map((m) =>
                  m.id === pendingAssistantId ? { ...m, content: "AI 暂时繁忙，请稍后再试。", createdAt: nowIso() } : m,
                ),
                updatedAt: nowIso(),
              }
            : item,
        ),
      }));
    } finally {
      setChatBusySessionId((cur) => (cur === session.id ? "" : cur));
      scheduleChatSessionsCloudSubtreeMerge();
    }
  }

  function renameSessionTo(id: string, title: string) {
    const t = title.trim();
    if (!t) return;
    setData((prev) => ({
      ...prev,
      chatSessions: prev.chatSessions.map((session) =>
        session.id === id ? { ...session, title: t, updatedAt: nowIso() } : session,
      ),
    }));
    scheduleChatSessionsCloudSubtreeMerge();
  }

  function createNewEmptyChatSession(lessonId: string, mode: PromptMode) {
    const title = allocateNewChatTitle(lessonId);
    const session = createChatSession(lessonId, title, mode);
    setData((prev) => ({ ...prev, chatSessions: [session, ...prev.chatSessions] }));
    setSelectedChatId(session.id);
    setChatTitle(title);
    scheduleChatSessionsCloudSubtreeMerge();
  }

  function deleteSession(id: string) {
    setData((prev) => ({
      ...prev,
      chatSessions: prev.chatSessions.filter((session) => session.id !== id),
    }));
    if (selectedChatId === id) {
      setSelectedChatId("");
    }
    scheduleChatSessionsCloudSubtreeMerge();
  }

  function addLessonNote(params: { lessonId: string; content: string; title?: string; lineIndex?: number }) {
    const t = params.content.trim();
    if (!t) return;
    const now = nowIso();
    setData((prev) => ({
      ...prev,
      lessonNotes: [
        {
          id: uid("note"),
          lessonId: params.lessonId,
          title: params.title?.trim() || undefined,
          lineIndex: params.lineIndex,
          content: t,
          createdAt: now,
          updatedAt: now,
        },
        ...prev.lessonNotes,
      ],
    }));
    scheduleNotesFavsCloudSubtreeMerge();
  }

  function updateLessonNote(noteId: string, content: string) {
    const t = content.trim();
    if (!t) return;
    const at = nowIso();
    setData((prev) => ({
      ...prev,
      lessonNotes: prev.lessonNotes.map((n) => (n.id === noteId ? { ...n, content: t, updatedAt: at } : n)),
    }));
    scheduleLessonNoteCloudFieldPatch(noteId, { content: t, updatedAt: at });
  }

  function deleteLessonNote(noteId: string) {
    setData((prev) => ({
      ...prev,
      lessonNotes: prev.lessonNotes.filter((n) => n.id !== noteId),
    }));
    scheduleNotesFavsCloudSubtreeMerge();
  }

  function addFavoriteSentence(params: { lessonId: string; jp: string; zhHint?: string; lineIndex: number }) {
    const jp = params.jp.trim();
    if (!jp) return;
    const now = nowIso();
    setData((prev) => ({
      ...prev,
      favoriteSentences: [
        {
          id: uid("fav"),
          lessonId: params.lessonId,
          jp,
          zhHint: params.zhHint?.trim() || undefined,
          lineIndex: params.lineIndex,
          createdAt: now,
        },
        ...prev.favoriteSentences,
      ],
    }));
    scheduleNotesFavsCloudSubtreeMerge();
  }

  function deleteFavoriteSentence(favId: string) {
    setData((prev) => ({
      ...prev,
      favoriteSentences: prev.favoriteSentences.filter((f) => f.id !== favId),
    }));
    scheduleNotesFavsCloudSubtreeMerge();
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "japanese-learning-backup.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadStatsCsv(filename: string, csvBody: string) {
    const blob = new Blob(["\ufeff", csvBody], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportPastStatsCsv() {
    const g = statsPastGranularity === "week" ? "week" : "day";
    const name = `jp-stats-past-${statsPastRange}-${g}-${calendarTodayLocal()}.csv`;
    downloadStatsCsv(name, buildPastRangeCsv(statsPastChartRowsDisplayed));
  }

  function exportFutureStatsCsv() {
    const name = `jp-stats-future-${statsFutureHorizon}-${calendarTodayLocal()}.csv`;
    downloadStatsCsv(name, buildFutureDueCsv(statsFutureChartRows));
  }

  function exportStatsSummaryCsv() {
    const name = `jp-stats-summary-${calendarTodayLocal()}.csv`;
    const body = buildStatsSummaryCsv({
      exportedAt: nowIso(),
      practiceMarkCorrect: practiceStatsSnapshot.practiceMarkCorrect,
      practiceMarkWrong: practiceStatsSnapshot.practiceMarkWrong,
      practiceMarkEasy: practiceStatsSnapshot.practiceMarkEasy,
      dwellLessonReaderSec: practiceStatsSnapshot.dwellLessonReaderSec ?? 0,
      dwellPracticeSec: practiceStatsSnapshot.dwellPracticeSec ?? 0,
      globalDue: globalDueReviewCounts,
      inventory: {
        lessons: data.lessons.length,
        vocabCards: data.vocabCards.length,
        sentenceTasks: data.sentenceTasks.length,
        grammarTasks: data.grammarTasks.length,
        lessonNotes: data.lessonNotes.length,
        favoriteSentences: data.favoriteSentences.length,
      },
      lessonDue: lessonDueBreakdown.map(({ lesson, vocab, sentence, grammar, total }) => ({
        lessonName: lesson.name,
        category: lesson.category || "",
        vocab,
        sentence,
        grammar,
        total,
      })),
    });
    downloadStatsCsv(name, body);
  }

  function importJson(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as AppData;
        const next = normalizeAppData(parsed);
        const cur = dataRef.current;
        const hasLocal =
          cur.lessons.length > 0 ||
          cur.vocabCards.length > 0 ||
          cur.sentenceTasks.length > 0 ||
          cur.grammarTasks.length > 0 ||
          cur.chatSessions.length > 0;
        if (hasLocal) {
          const ok = window.confirm(
            `会用文件里的内容替换你现在这一份（当前 ${cur.lessons.length} 篇课文、${cur.vocabCards.length} 个单词等）。确定吗？`,
          );
          if (!ok) {
            event.target.value = "";
            return;
          }
        }
        setData(next);
        setDataToast(`导入好了：${next.lessons.length} 篇课文、${next.vocabCards.length} 个单词等已替换为文件里的内容。`);
      } catch {
        setDataToast("这个文件读不了，换一个备份文件试试。");
      }
      event.target.value = "";
    });
  }

  const needLessonHint = activeLessons.length === 0 && appTab === "practice";

  const cloudAheadBannerVisible =
    cloudRemoteAhead.show &&
    Boolean(cloudRemoteAhead.at) &&
    (!cloudAheadDismissRemoteAt || (cloudRemoteAhead.at != null && cloudRemoteAhead.at > cloudAheadDismissRemoteAt));

  return (
    <div className="app-shell text-[color:var(--sun-ink)]">
      <div className="app-blob app-blob--a" aria-hidden />
      <div className="app-blob app-blob--b" aria-hidden />

      {!readerLessonId && (
        <header className="sticky top-0 z-30 px-3 pt-[max(0.75rem,env(safe-area-inset-top,0px))] pb-2 md:px-6">
          <div className={clsx("mx-auto flex", shellMaxWidthClass, headerLayoutClass)}>
            <div className="flex items-baseline gap-2 pl-1">
              <span className="text-lg font-black tracking-tight md:text-xl">日语学习</span>
              <span className="text-xs font-semibold text-[color:var(--sun-muted)]">温柔治愈 · 轻松学日语</span>
            </div>
            <nav
              className={clsx(
                "tab-bar max-w-full",
                deviceTier === "phone" && "tab-bar--scroll overflow-x-auto [-webkit-overflow-scrolling:touch]",
              )}
              aria-label="主导航"
            >
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={clsx("tab-pill", appTab === tab.id && "tab-pill--active")}
                  onClick={() => setAppTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>
        </header>
      )}

      <main
        className={clsx(
          "relative z-10 mx-auto px-3 pb-[max(5rem,env(safe-area-inset-bottom,0px))] md:px-6",
          shellMaxWidthClass,
        )}
      >
        {cloudAheadBannerVisible && (
          <div
            role="status"
            aria-live="polite"
            className="mb-3 flex flex-col gap-2 rounded-2xl border border-amber-500/70 bg-amber-100/95 px-3 py-2.5 text-sm text-amber-950 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4"
          >
            <p className="min-w-0 leading-relaxed">
              <span className="font-black">别处用这个账号保存过</span>
              ，看起来比当前浏览器里这份更新。可打开「设置」登录后点「同步数据」试试；暂时不想动就点「稍后再说」。
            </p>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button type="button" className="sun-btn !min-h-[40px] !px-4 !py-2 text-xs" onClick={() => setAppTab("data")}>
                去设置
              </button>
              <button
                type="button"
                className="sun-btn sun-btn--ghost !min-h-[40px] !px-4 !py-2 text-xs"
                onClick={() => {
                  if (cloudRemoteAhead.at) setCloudAheadDismissRemoteAt(cloudRemoteAhead.at);
                }}
              >
                稍后再说
              </button>
            </div>
          </div>
        )}
        {needLessonHint && (
          <div className="float-card mb-4 px-4 py-3 text-sm text-[color:var(--sun-muted)]">
            请先在「课文」里导入并选中一篇课文，再使用本标签。
            <button type="button" className="sun-btn sun-btn--ghost ml-3 !px-3 !py-1 text-xs" onClick={() => setAppTab("lessons")}>
              去选课文
            </button>
          </div>
        )}

        <div key={appTab} className="panel-switch flex flex-col gap-5">
          {appTab === "home" && (
            <>
              <section className="float-card p-6 md:p-8">
                <p className="text-2xl font-black md:text-3xl">日语学习小窝</p>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[color:var(--sun-muted)]">
                  不用注册直接学～登录就能同步进度，超省心哒
                </p>
                {motivation || motivationLoading ? (
                  <div className="mt-4 space-y-1.5">
                    <p className="rounded-2xl bg-amber-100/80 px-4 py-3 text-sm leading-7 text-[color:var(--sun-ink)]">
                      {motivationLoading && !motivation ? (
                        <span className="text-[color:var(--sun-muted)]">月色信笺生成中…</span>
                      ) : (
                        motivation
                      )}
                    </p>
                    {!motivationLoading && motivation ? (
                      <p className="px-1 text-[0.65rem] leading-relaxed text-[color:var(--sun-muted)]">
                        拂晓与夜深时的小小彩蛋 · 约每半小时换一笺（由 AI 写成，非例句库）
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {!quickStartDismissed && (
                  <div className="mt-4 rounded-2xl border border-amber-200/70 bg-amber-50/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-black text-[color:var(--sun-ink)]">新手快速上手</p>
                      <button
                        type="button"
                        className="text-xs font-semibold text-[color:var(--sun-muted)] underline decoration-amber-400 decoration-2 underline-offset-4"
                        onClick={() => {
                          setQuickStartDismissed(true);
                          localStorage.setItem(LS_QUICK_START_DISMISSED, "1");
                        }}
                      >
                        知道啦
                      </button>
                    </div>
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-[color:var(--sun-muted)]">
                      <li>点开始学习，免费直接用～</li>
                      <li>登录账号，多设备同步进度</li>
                      <li>备份数据，去设置就好啦</li>
                    </ol>
                  </div>
                )}
                {/* 庄周梦蝶国风装饰插画：请将 picture.png 置于 app/public/picture.png（16:9 画幅内 object-contain，不拉伸不裁剪） */}
                <div
                  className="relative mx-auto w-[90%] max-w-[800px] overflow-hidden bg-transparent pointer-events-none select-none"
                  style={{
                    marginTop: 24,
                    marginBottom: 24,
                    aspectRatio: "16 / 9",
                    borderRadius: 20,
                    boxShadow: "0 6px 20px rgba(200, 170, 130, 0.15)",
                  }}
                  aria-hidden
                >
                  {homeHeroStage === "inline" ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-[#fdf6e9] via-[#fce8dc]/90 to-[#f0e6ff]/80">
                      <svg className="h-[42%] max-h-[120px] w-auto text-amber-400/55" viewBox="0 0 120 80" fill="currentColor" aria-hidden>
                        <ellipse cx="40" cy="44" rx="22" ry="14" />
                        <ellipse cx="80" cy="44" rx="22" ry="14" />
                        <ellipse cx="60" cy="38" rx="8" ry="20" />
                      </svg>
                      <span className="mt-1 text-xs font-semibold tracking-wide text-amber-900/40">庄周梦蝶</span>
                    </div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- 需 onError 链式降级，避免 next/image 空白
                    <img
                      src={homeHeroStage === "user" ? userHeroSrc : "/home-hero-placeholder.svg"}
                      alt=""
                      className="absolute inset-0 h-full w-full object-contain bg-[#fdf6e9]/40"
                      draggable={false}
                      loading="eager"
                      decoding="async"
                      onError={() => {
                        setHomeHeroStage((s) => {
                          if (s === "user") return "bundle";
                          if (s === "bundle") return "inline";
                          return s;
                        });
                      }}
                    />
                  )}
                </div>
                {silentHealthIssue && (
                  <p className="mt-3 rounded-xl border border-red-300/70 bg-red-50/80 px-3 py-2 text-xs font-semibold text-red-700">
                    后台检测到异常：{silentHealthIssue}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-3">
                  <button type="button" className="sun-btn !min-h-[52px] !px-8" onClick={() => setAppTab("practice")}>
                    开始学习
                  </button>
                  <button type="button" className="sun-btn sun-btn--ghost !min-h-[52px] !px-6" onClick={() => setAuthDialogOpen(true)}>
                    {cloudUserEmail ? "已同步进度" : "登录 / 注册"}
                  </button>
                  <button type="button" className="sun-btn sun-btn--ghost !min-h-[52px] !px-6" onClick={() => setAppTab("data")}>
                    设置
                  </button>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-[color:var(--sun-muted)]">
                  {cloudConfigured
                    ? cloudUserEmail
                      ? `已登录，学习记录自动同步中～（${cloudUserEmail}）`
                      : "还没登录的话，进度会先保存在本机；需要换设备时再登录就好～"
                    : "多设备同步需要托管环境配置好以后才会出现哦；现在先安心本地学～"}
                </p>
                <dl className="mt-6 grid grid-cols-3 gap-2 rounded-2xl bg-white/50 px-2 py-4 text-center text-[color:var(--sun-ink)] ring-1 ring-amber-200/60 sm:gap-3 sm:px-4">
                  <div className="min-w-0">
                    <dt className="text-[0.65rem] font-bold text-[color:var(--sun-muted)]">答对</dt>
                    <dd className="mt-1 truncate text-lg font-black tabular-nums sm:text-xl">{practiceStatsSnapshot.practiceMarkCorrect}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[0.65rem] font-bold text-[color:var(--sun-muted)]">答错</dt>
                    <dd className="mt-1 truncate text-lg font-black tabular-nums sm:text-xl">{practiceStatsSnapshot.practiceMarkWrong}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[0.65rem] font-bold text-[color:var(--sun-muted)]">已掌握</dt>
                    <dd className="mt-1 truncate text-lg font-black tabular-nums sm:text-xl">{practiceStatsSnapshot.practiceMarkEasy}</dd>
                  </div>
                </dl>
                <p className="mt-2 text-xs leading-relaxed text-[color:var(--sun-muted)]">记录你的每一次练习，超棒哒～</p>
                <p className="mt-2 rounded-xl bg-white/55 px-3 py-2 text-xs leading-relaxed text-[color:var(--sun-muted)] ring-1 ring-amber-200/50">
                  今日待复习：单词 <strong className="tabular-nums text-[color:var(--sun-ink)]">{globalDueReviewCounts.vocab}</strong> 个
                  <span className="mx-1.5">|</span>句子 <strong className="tabular-nums text-[color:var(--sun-ink)]">{globalDueReviewCounts.sentence}</strong> 个
                  <span className="mx-1.5">|</span>语法 <strong className="tabular-nums text-[color:var(--sun-ink)]">{globalDueReviewCounts.grammar}</strong> 个
                </p>
              </section>
              <div className="grid gap-4 sm:grid-cols-3">
                <button type="button" className="float-card float-card--delay p-5 text-left" onClick={() => setAppTab("lessons")}>
                  <p className="text-lg font-black text-[color:var(--sun-ink)]">课文</p>
                  <p className="mt-1 text-lg font-black tabular-nums">已添加 {activeLessons.length} 篇</p>
                  {data.lessons.length > activeLessons.length ? (
                    <p className="mt-0.5 text-xs text-[color:var(--sun-muted)]">回收站 {data.lessons.length - activeLessons.length} 篇</p>
                  ) : null}
                </button>
                <button type="button" className="float-card float-card--delay p-5 text-left" onClick={() => setAppTab("words")}>
                  <p className="text-lg font-black text-[color:var(--sun-ink)]">单词本</p>
                  <p className="mt-1 text-lg font-black tabular-nums">已收藏 {data.vocabCards.length} 个</p>
                </button>
                <button type="button" className="float-card float-card--delay p-5 text-left" onClick={() => setAppTab("practice")}>
                  <p className="text-lg font-black text-[color:var(--sun-ink)]">刷题练习</p>
                  <p className="mt-1 text-xs text-[color:var(--sun-muted)]">开始复习啦</p>
                </button>
              </div>
            </>
          )}

          {appTab === "lessons" && (
            <section className="float-card float-card--delay p-5 md:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-lg font-black">我的课文合集</h2>
                  <p className="mt-1 max-w-xl text-xs text-[color:var(--sun-muted)]">拖拽调整顺序，右滑管理分类哦～</p>
                </div>
                <button type="button" className="sun-btn shrink-0 self-start !min-h-[48px] !px-6" onClick={() => setImportModalOpen(true)}>
                  添加课文
                </button>
              </div>
              <label className="mt-4 block text-xs font-bold text-[color:var(--sun-muted)]">
                搜索课文 / 作者
                <input
                  className="sun-input mt-1 w-full max-w-md"
                  value={lessonSearchQuery}
                  onChange={(e) => setLessonSearchQuery(e.target.value)}
                  placeholder="输入关键词找找看～"
                  autoComplete="off"
                />
              </label>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={clsx("sun-btn shrink-0 !min-h-[40px] !px-4 !py-2 text-xs", lessonBulkMode && "sun-btn--ghost")}
                  onClick={() => {
                    setLessonBulkMode((m) => {
                      if (m) setLessonBulkSelected([]);
                      return !m;
                    });
                  }}
                >
                  {lessonBulkMode ? "退出批量" : "批量选择"}
                </button>
                {lessonBulkMode && (
                  <>
                    <span className="text-xs font-semibold text-[color:var(--sun-muted)]">已选 {lessonBulkSelected.length}</span>
                    <button
                      type="button"
                      className="sun-btn sun-btn--ghost shrink-0 !min-h-[40px] !px-3 !py-2 text-xs"
                      disabled={allFilteredLessonIds.length === 0}
                      onClick={() => setLessonBulkSelected([...allFilteredLessonIds])}
                    >
                      全选当前筛选
                    </button>
                    <button
                      type="button"
                      className="sun-btn sun-btn--ghost shrink-0 !min-h-[40px] !px-3 !py-2 text-xs"
                      disabled={lessonBulkSelected.length === 0}
                      onClick={() => setLessonBulkSelected([])}
                    >
                      清空选择
                    </button>
                    <button
                      type="button"
                      className="sun-btn shrink-0 !min-h-[40px] !px-3 !py-2 text-xs"
                      disabled={lessonBulkSelected.length === 0}
                      onClick={() => batchAssignLessonCategoryToSelection()}
                    >
                      批量改类
                    </button>
                    <button
                      type="button"
                      className="sun-btn shrink-0 !min-h-[40px] !bg-rose-100 !px-3 !py-2 text-xs !text-rose-900"
                      disabled={lessonBulkSelected.length === 0}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `将已选 ${lessonBulkSelected.length} 篇课文移入废纸篓？（主列表隐藏，下属题暂不出现在练习待刷；可在文末恢复或永久删除。）`,
                          )
                        )
                          return;
                        moveLessonsToTrash(lessonBulkSelected);
                      }}
                    >
                      移入废纸篓
                    </button>
                  </>
                )}
              </div>
              {lessonsByCategory.length === 0 ? (
                <p className="mt-6 text-sm text-[color:var(--sun-muted)]">还没有课文，点右上角导入一篇吧。</p>
              ) : lessonsByCategoryFiltered.length === 0 ? (
                <p className="mt-6 text-sm text-[color:var(--sun-muted)]">没有匹配的课文，换个关键词试试。</p>
              ) : (
                <div className="mt-4 flex flex-col gap-3">
                  {lessonsByCategoryFiltered.map(({ category, lessons }) => (
                    <div
                      key={category}
                      className="overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_50%,transparent)] bg-[color-mix(in_srgb,#fff_72%,transparent)]"
                    >
                      <div className="flex min-h-[3.25rem] items-stretch">
                        <button
                          type="button"
                          className="flex flex-1 items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-white/50"
                          onClick={() => toggleCategory(category)}
                          aria-expanded={categoryExpanded(category)}
                        >
                          <span className="text-lg font-black text-[color:var(--sun-ink)]">
                            {category}（{lessons.length} 篇）
                          </span>
                          <span className="shrink-0 text-sm font-semibold text-[color:var(--sun-muted)]">
                            {categoryExpanded(category) ? "收起" : "展开"}
                          </span>
                        </button>
                        {draggingLessonId && (
                          <div
                            className="flex w-[4.5rem] shrink-0 flex-col items-center justify-center border-l border-[color-mix(in_srgb,var(--sun-warm)_55%,transparent)] bg-amber-100/90 px-1 text-center text-[0.65rem] font-black leading-tight text-amber-950"
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              assignLessonCategory(draggingLessonId, category);
                              setDraggingLessonId(null);
                              setLessonDropHint(null);
                            }}
                          >
                            分类
                          </div>
                        )}
                      </div>
                      {categoryExpanded(category) && (
                        <div className="border-t border-[color-mix(in_srgb,var(--sun-deep)_10%,transparent)] px-2 py-2">
                          <div className="grid gap-2 sm:grid-cols-2">
                            {lessons.map((lesson) => {
                              const preview = lesson.content
                                .replace(/\r\n/g, "\n")
                                .split("\n")
                                .find((line) => line.trim().length > 0);
                              const coverThumb = resolveLessonCoverSrc(lesson, data.mediaLibrary);
                              return (
                                <div
                                  key={lesson.id}
                                  draggable={!lessonBulkMode}
                                  className={clsx(
                                    "relative flex min-h-[5.25rem] items-stretch gap-1 rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] bg-white/75 shadow-sm transition-all duration-200",
                                    lesson.id === activeLessonId && "ring-2 ring-amber-400/70",
                                    lessonDropHint?.targetId === lesson.id &&
                                      lessonDropHint.mode === "swap" &&
                                      "ring-[3px] ring-sky-500 ring-offset-2 ring-offset-white bg-sky-50/70",
                                    lessonReorderFlashIds.has(lesson.id) && "scale-[1.015] shadow-md",
                                  )}
                                  onDragStart={(e) => {
                                    e.dataTransfer.setData("text/plain", lesson.id);
                                    e.dataTransfer.effectAllowed = "move";
                                    setDraggingLessonId(lesson.id);
                                    setLessonDropHint(null);
                                  }}
                                  onDragEnd={() => {
                                    setDraggingLessonId(null);
                                    setLessonDropHint(null);
                                  }}
                                  onDragOver={(e) => {
                                    if (draggingLessonId && draggingLessonId !== lesson.id) {
                                      e.preventDefault();
                                      e.dataTransfer.dropEffect = "move";
                                      const mode = resolveLessonDropMode(e);
                                      setLessonDropHint({ targetId: lesson.id, mode });
                                    }
                                  }}
                                  onDragEnter={(e) => {
                                    if (!draggingLessonId || draggingLessonId === lesson.id) return;
                                    const mode = resolveLessonDropMode(e);
                                    setLessonDropHint({ targetId: lesson.id, mode });
                                  }}
                                  onDragLeave={(e) => {
                                    if (lessonDropHint?.targetId !== lesson.id) return;
                                    const next = e.relatedTarget as Node | null;
                                    if (next && e.currentTarget.contains(next)) return;
                                    setLessonDropHint(null);
                                  }}
                                  onDrop={(e) => {
                                    e.preventDefault();
                                    if (draggingLessonId && draggingLessonId !== lesson.id) {
                                      const mode = lessonDropHint?.targetId === lesson.id ? lessonDropHint.mode : resolveLessonDropMode(e);
                                      applyLessonDrop(draggingLessonId, lesson.id, mode);
                                    }
                                    setDraggingLessonId(null);
                                    setLessonDropHint(null);
                                  }}
                                  onClick={() => setActiveLessonId(lesson.id)}
                                  onDoubleClick={() => openLessonReader(lesson.id)}
                                >
                                  {lessonDropHint?.targetId === lesson.id && lessonDropHint.mode === "before" && (
                                    <div className="pointer-events-none absolute inset-y-2 left-0 z-10 w-[5px] rounded-full bg-sky-600 shadow-[0_0_0_3px_rgba(255,255,255,0.95)]" />
                                  )}
                                  {lessonDropHint?.targetId === lesson.id && lessonDropHint.mode === "after" && (
                                    <div className="pointer-events-none absolute inset-y-2 right-0 z-10 w-[5px] rounded-full bg-teal-600 shadow-[0_0_0_3px_rgba(255,255,255,0.95)]" />
                                  )}
                                  {lessonBulkMode ? (
                                    <label
                                      className="flex w-11 shrink-0 cursor-pointer select-none flex-col items-center justify-center gap-1 rounded-l-lg border-r border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-white/90 py-2"
                                      onClick={(e) => e.stopPropagation()}
                                      onPointerDown={(e) => e.stopPropagation()}
                                    >
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4 accent-amber-800"
                                        checked={lessonBulkSelected.includes(lesson.id)}
                                        onChange={() => toggleLessonBulkSelect(lesson.id)}
                                      />
                                      <span className="text-[0.55rem] font-bold text-[color:var(--sun-muted)]">选</span>
                                    </label>
                                  ) : (
                                    <div
                                      data-drop-role="before"
                                      className="flex w-10 shrink-0 select-none items-center justify-center rounded-l-lg border-r border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-amber-50/80 text-sm font-black text-[color:var(--sun-muted)]"
                                    >
                                      #{lessonIndexById.get(lesson.id) ?? 0}
                                    </div>
                                  )}
                                  <div data-drop-role="swap" className="relative w-[4.5rem] shrink-0 self-stretch py-1 pl-0 pr-0 sm:w-[5rem]">
                                    {coverThumb ? (
                                      <img
                                        src={coverThumb}
                                        alt=""
                                        className="h-full min-h-[4.25rem] w-full rounded-lg border border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] object-cover"
                                        decoding="async"
                                      />
                                    ) : (
                                      <div className="flex h-full min-h-[4.25rem] w-full flex-col items-center justify-center rounded-lg border border-dashed border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-[color-mix(in_srgb,var(--sun-warm)_12%,transparent)] px-0.5 text-center text-[0.6rem] font-semibold leading-tight text-[color:var(--sun-muted)]">
                                        暂无
                                        <br />
                                        配图
                                      </div>
                                    )}
                                  </div>
                                  <div
                                    data-drop-role="swap"
                                    className={clsx("min-w-0 flex-1 px-3 py-3 text-left transition", lesson.id === activeLessonId ? "bg-amber-100/90" : "hover:bg-white/95")}
                                  >
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-black leading-snug sm:text-base">{lesson.name}</p>
                                      <span
                                        className={clsx(
                                          "rounded-full px-2 py-0.5 text-[0.6rem] font-black",
                                          lesson.lessonKind === "video" ? "bg-purple-100 text-purple-900" : "bg-emerald-100 text-emerald-900",
                                        )}
                                      >
                                        {lesson.lessonKind === "video" ? "视频" : "文字"}
                                      </span>
                                    </div>
                                    <p className="mt-0.5 text-[0.65rem] text-[color:var(--sun-accent)] sm:text-xs">
                                      作者：{lessonAuthorDisplay(lesson.author)}
                                    </p>
                                    <p className="mt-1 line-clamp-2 text-[0.7rem] leading-relaxed text-[color:var(--sun-muted)] sm:text-xs">
                                      {preview || "（空行开头或仅空白）"}
                                    </p>
                                  </div>
                                  <div className="flex shrink-0 flex-col items-stretch justify-center gap-1 self-center py-1">
                                    <button
                                      type="button"
                                      data-drop-role="after"
                                      className="sun-btn sun-btn--ghost !min-h-0 shrink-0 !px-2 !py-1.5 text-[0.65rem] sm:!px-3 sm:text-xs"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        changeLessonCategory(lesson.id, lesson.category);
                                      }}
                                    >
                                      分类
                                    </button>
                                    {!lessonBulkMode && (
                                      <button
                                        type="button"
                                        className="sun-btn sun-btn--ghost !min-h-0 shrink-0 !px-2 !py-1.5 text-[0.65rem] font-bold text-rose-800 sm:!px-3 sm:text-xs"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (
                                            !window.confirm(
                                              `将「${lesson.name}」移入废纸篓？主列表将隐藏该课文；下属题暂不出现在练习待刷，可在本页文末废纸篓恢复或永久删除。`,
                                            )
                                          )
                                            return;
                                          moveLessonsToTrash([lesson.id]);
                                        }}
                                      >
                                        删除
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {trashedLessons.length > 0 && (
                <details className="mt-6 rounded-2xl border border-rose-200/90 bg-rose-50/40 px-3 py-2">
                  <summary className="cursor-pointer select-none text-sm font-black text-rose-950">
                    废纸篓（{trashedLessons.length} 篇，恢复或永久删除）
                  </summary>
                  <p className="mt-2 text-xs leading-relaxed text-[color:var(--sun-muted)]">
                    废纸篓中的课文不会出现在上方序列；其词卡、句题、语法题<strong className="text-[color:var(--sun-ink)]">不会进入练习待刷与按课文待复习统计</strong>
                    。永久删除会一并移除该课下属词卡、题库、对话、笔记与重点句收藏（不可撤销）。
                  </p>
                  <ul className="mt-3 space-y-2">
                    {trashedLessons.map((lesson) => {
                      const nv = data.vocabCards.filter((c) => c.lessonId === lesson.id).length;
                      const ns = data.sentenceTasks.filter((t) => t.lessonId === lesson.id).length;
                      const ng = data.grammarTasks.filter((g) => g.lessonId === lesson.id).length;
                      return (
                        <li
                          key={lesson.id}
                          className="flex flex-col gap-2 rounded-xl border border-rose-200/70 bg-white/80 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-black text-[color:var(--sun-ink)]">{lesson.name}</p>
                            <p className="mt-0.5 text-[0.65rem] text-[color:var(--sun-muted)]">
                              {lesson.category} · 词 {nv} · 句 {ns} · 语法 {ng}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="sun-btn sun-btn--ghost !min-h-[36px] !px-3 !py-1.5 text-xs font-bold"
                              onClick={() => restoreLessonsFromTrash([lesson.id])}
                            >
                              恢复
                            </button>
                            <button
                              type="button"
                              className="sun-btn !min-h-[36px] !bg-rose-200 !px-3 !py-1.5 text-xs font-bold !text-rose-950"
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `永久删除「${lesson.name}」及下属 ${nv} 张词卡、${ns} 道句题、${ng} 道语法题与相关对话/笔记/收藏？不可恢复。`,
                                  )
                                )
                                  return;
                                purgeLessonsForever([lesson.id]);
                              }}
                            >
                              永久删除
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}
            </section>
          )}

          {appTab === "words" && (
            <section className="float-card float-card--delay p-5 md:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-lg font-black">单词本 · 句子 · 语法</h2>
                  <p className="mt-1 max-w-xl text-xs text-[color:var(--sun-muted)]">
                    在这里翻翻收藏、排排序，也能切到句子或语法题库～
                    {activeLessons.length === 0 && " 还没有课文，先去「课文」添加一篇吧。"}
                  </p>
                </div>
                <button
                  type="button"
                  className="sun-btn shrink-0 self-start !min-h-[48px] !px-6"
                  onClick={openNewVocabModal}
                >
                  新建单词
                </button>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(["vocab", "sentence", "grammar"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={clsx(
                      "rounded-2xl border px-3 py-2 text-left transition",
                      wordsScope === kind
                        ? "border-amber-500 bg-amber-100 text-amber-950 shadow-sm"
                        : "border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-white/70 text-[color:var(--sun-muted)] hover:bg-white/95",
                    )}
                    onClick={() => setWordsScope(kind)}
                  >
                    <p className="text-xs font-bold">{kind === "vocab" ? "单词" : kind === "sentence" ? "句子" : "语法"}</p>
                    <p className="mt-0.5 text-sm font-black tabular-nums">
                      {kind === "vocab" ? data.vocabCards.length : kind === "sentence" ? data.sentenceTasks.length : data.grammarTasks.length}
                    </p>
                  </button>
                ))}
              </div>

              <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                <label className="flex min-w-[9rem] flex-1 flex-col gap-1 text-xs font-bold text-[color:var(--sun-muted)]">
                  怎么排
                  <select
                    className="sun-select min-h-[48px] py-3"
                    value={vocabSortKey}
                    onChange={(e) => setVocabSortKey(e.target.value as "alpha" | "lesson")}
                  >
                    <option value="alpha">{wordsScope === "vocab" ? "按日语首字" : "按题干首字"}</option>
                    <option value="lesson">按课文（先分大类）</option>
                  </select>
                </label>
                <label className="flex min-w-[7rem] flex-col gap-1 text-xs font-bold text-[color:var(--sun-muted)]">
                  顺序
                  <select
                    className="sun-select min-h-[48px] py-3"
                    value={vocabSortDir}
                    onChange={(e) => setVocabSortDir(e.target.value as "asc" | "desc")}
                  >
                    <option value="asc">正序</option>
                    <option value="desc">倒序</option>
                  </select>
                </label>
                <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-xs font-bold text-[color:var(--sun-muted)]">
                  只看某一课
                  <select
                    className="sun-select min-h-[48px] py-3"
                    value={vocabListFilter}
                    onChange={(e) => setVocabListFilter(e.target.value)}
                  >
                    <option value="all">全部</option>
                    {activeLessons.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.category} · {l.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-[12rem] flex-[2] flex-col gap-1 text-xs font-bold text-[color:var(--sun-muted)]">
                  搜
                  <input
                    className="sun-input min-h-[48px] py-3"
                    value={vocabSearchQuery}
                    onChange={(e) => setVocabSearchQuery(e.target.value)}
                    placeholder={
                      wordsScope === "vocab"
                        ? "词、读音、中文、例句里搜"
                        : wordsScope === "sentence"
                          ? "句子日文、中文、题型里搜"
                          : "语法题干、中译、解析里搜"
                    }
                  />
                </label>
              </div>

              <div className="mt-5 flex flex-col gap-6">
                {wordsScope === "vocab" && vocabGroupedBlocks != null && vocabGroupedBlocks.length === 0 && (
                  <p className="text-sm text-[color:var(--sun-muted)]">单词本还是空的～</p>
                )}
                {wordsScope === "vocab" && vocabGroupedBlocks != null && vocabGroupedBlocks.length > 0
                  ? vocabGroupedBlocks.map((block) => (
                      <div key={block.category} className="rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-[color-mix(in_srgb,#fff_78%,transparent)] p-3 sm:p-4">
                        <p className="text-base font-black text-[color:var(--sun-ink)]">{block.category}</p>
                        <div className="mt-3 space-y-4">
                          {block.lessons.map(({ lesson, cards }) => (
                            <div key={lesson.id}>
                              <p className="text-xs font-bold text-[color:var(--sun-accent)]">{lesson.name}</p>
                              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                {cards.map((card) => {
                                  const les = lessonById.get(card.lessonId);
                                  return (
                                    <div
                                      key={card.id}
                                      className="flex min-h-[6.5rem] gap-0 rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] bg-white/75 shadow-sm sm:min-h-[7rem]"
                                    >
                                      <button
                                        type="button"
                                        className="flex min-w-0 flex-1 flex-col px-3 py-3 text-left transition hover:bg-white/95 sm:px-4 sm:py-3.5"
                                        onClick={() => {
                                          setSelectedVocabId(card.id);
                                          setActiveLessonId(card.lessonId);
                                        }}
                                      >
                                        <p className="text-sm font-black leading-snug sm:text-base">{card.term}</p>
                                        <p className="mt-0.5 text-sm leading-snug text-[color:var(--sun-muted)]">
                                          {card.meanings.map((m) => m.zh).join(" / ")}
                                        </p>
                                        <p className="mt-1 text-[0.65rem] font-semibold leading-tight text-[color:var(--sun-accent)] sm:text-xs">
                                          {les ? `${les.category} · ${les.name}` : "未知课文"}
                                        </p>
                                        <p className="mt-auto line-clamp-2 pt-2 text-[0.7rem] leading-relaxed text-[color:var(--sun-muted)] sm:text-xs">
                                          {card.latestExample}
                                        </p>
                                      </button>
                                      <div className="flex shrink-0 flex-col justify-center border-l border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] px-2 py-2">
                                        <button
                                          type="button"
                                          className="sun-btn sun-btn--ghost !min-h-[36px] !px-2 !py-1 text-[0.65rem] font-bold text-rose-800 sm:text-xs"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            removeVocabCardById(card.id, card.term);
                                          }}
                                        >
                                          删除
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  : null}
                {wordsScope === "vocab" && vocabGroupedBlocks == null && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {sortedFilteredVocab.length === 0 && (
                      <p className="col-span-full text-sm text-[color:var(--sun-muted)]">单词本还是空的～</p>
                    )}
                    {sortedFilteredVocab.map((card, idx) => {
                      const les = lessonById.get(card.lessonId);
                      return (
                        <div
                          key={card.id}
                          className="flex min-h-[6.5rem] gap-0 rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] bg-white/75 shadow-sm sm:min-h-[7rem]"
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 flex-col px-3 py-3 text-left transition hover:bg-white/95 sm:px-4 sm:py-3.5"
                            onClick={() => {
                              setSelectedVocabId(card.id);
                              setActiveLessonId(card.lessonId);
                            }}
                          >
                            <p className="text-[0.7rem] font-bold text-[color:var(--sun-muted)]">#{idx + 1}</p>
                            <p className="text-sm font-black leading-snug sm:text-base">{card.term}</p>
                            <p className="mt-0.5 text-sm leading-snug text-[color:var(--sun-muted)]">{card.meanings.map((m) => m.zh).join(" / ")}</p>
                            <p className="mt-1 text-[0.65rem] font-semibold leading-tight text-[color:var(--sun-accent)] sm:text-xs">
                              {les ? `${les.category} · ${les.name}` : "未知课文"}
                            </p>
                            <p className="mt-auto line-clamp-2 pt-2 text-[0.7rem] leading-relaxed text-[color:var(--sun-muted)] sm:text-xs">
                              {card.latestExample}
                            </p>
                          </button>
                          <div className="flex shrink-0 flex-col justify-center border-l border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] px-2 py-2">
                            <button
                              type="button"
                              className="sun-btn sun-btn--ghost !min-h-[36px] !px-2 !py-1 text-[0.65rem] font-bold text-rose-800 sm:text-xs"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeVocabCardById(card.id, card.term);
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {wordsScope === "sentence" && sentenceGroupedBlocks != null && (
                  <div className="flex flex-col gap-6">
                    {sentenceGroupedBlocks.length === 0 && <p className="text-sm text-[color:var(--sun-muted)]">暂无句子题。</p>}
                    {sentenceGroupedBlocks.map((block) => (
                      <div key={block.category} className="rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-[color-mix(in_srgb,#fff_78%,transparent)] p-3 sm:p-4">
                        <p className="text-base font-black text-[color:var(--sun-ink)]">{block.category}</p>
                        <div className="mt-3 space-y-4">
                          {block.lessons.map(({ lesson, rows }) => (
                            <div key={lesson.id}>
                              <p className="text-xs font-bold text-[color:var(--sun-accent)]">{lesson.name}</p>
                              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                {rows.map((task, idx) => (
                                  <div
                                    key={task.id}
                                    className="flex min-h-[6.5rem] gap-0 rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] bg-white/75 shadow-sm sm:min-h-[7rem]"
                                  >
                                    <button
                                      type="button"
                                      className="flex min-w-0 flex-1 flex-col px-3 py-3 text-left transition hover:bg-white/95 sm:px-4 sm:py-3.5"
                                      onClick={() => setSelectedSentenceId(task.id)}
                                    >
                                      <p className="text-[0.7rem] font-bold text-[color:var(--sun-muted)]">#{idx + 1}</p>
                                      <p className="text-sm font-black leading-snug sm:text-base">{task.jpAnswer}</p>
                                      <p className="mt-1 text-sm leading-snug text-[color:var(--sun-muted)]">{task.zh}</p>
                                    </button>
                                    <div className="flex shrink-0 flex-col justify-center border-l border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] px-2 py-2">
                                      <button
                                        type="button"
                                        className="sun-btn sun-btn--ghost !min-h-[36px] !px-2 !py-1 text-[0.65rem] font-bold text-rose-800 sm:text-xs"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          removeSentenceTaskById(task.id, task.jpAnswer || task.zh);
                                        }}
                                      >
                                        删除
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {wordsScope === "sentence" && sentenceGroupedBlocks == null && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {sentenceFiltered.length === 0 && <p className="col-span-full text-sm text-[color:var(--sun-muted)]">暂无句子题。</p>}
                    {sentenceFiltered.map((task, idx) => {
                      const les = lessonById.get(task.lessonId);
                      return (
                        <div
                          key={task.id}
                          className="flex min-h-[6.5rem] gap-0 rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] bg-white/75 shadow-sm sm:min-h-[7rem]"
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 flex-col px-3 py-3 text-left transition hover:bg-white/95 sm:px-4 sm:py-3.5"
                            onClick={() => setSelectedSentenceId(task.id)}
                          >
                            <p className="text-[0.7rem] font-bold text-[color:var(--sun-muted)]">#{idx + 1}</p>
                            <p className="text-sm font-black leading-snug sm:text-base">{task.zh}</p>
                            <p className="mt-1 text-sm leading-snug text-[color:var(--sun-ink)]">{task.jpAnswer}</p>
                            <p className="mt-1 text-[0.65rem] font-semibold text-[color:var(--sun-accent)]">
                              {task.sourceType === "listening" ? "听力句子" : "翻译句子"}
                            </p>
                            <p className="mt-auto text-[0.65rem] font-semibold leading-tight text-[color:var(--sun-accent)]">
                              {les ? `${les.category} · ${les.name}` : "未知课文"}
                            </p>
                          </button>
                          <div className="flex shrink-0 flex-col justify-center border-l border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] px-2 py-2">
                            <button
                              type="button"
                              className="sun-btn sun-btn--ghost !min-h-[36px] !px-2 !py-1 text-[0.65rem] font-bold text-rose-800 sm:text-xs"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeSentenceTaskById(task.id, task.jpAnswer || task.zh);
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {wordsScope === "grammar" && grammarGroupedBlocks != null && (
                  <div className="flex flex-col gap-6">
                    {grammarGroupedBlocks.length === 0 && <p className="text-sm text-[color:var(--sun-muted)]">暂无语法题。</p>}
                    {grammarGroupedBlocks.map((block) => (
                      <div key={block.category} className="rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-[color-mix(in_srgb,#fff_78%,transparent)] p-3 sm:p-4">
                        <p className="text-base font-black text-[color:var(--sun-ink)]">{block.category}</p>
                        <div className="mt-3 space-y-4">
                          {block.lessons.map(({ lesson, rows }) => (
                            <div key={lesson.id}>
                              <p className="text-xs font-bold text-[color:var(--sun-accent)]">{lesson.name}</p>
                              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                {rows.map((task, idx) => (
                                  <div
                                    key={task.id}
                                    className="flex min-h-[6.5rem] gap-0 rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] bg-white/75 shadow-sm sm:min-h-[7rem]"
                                  >
                                    <button
                                      type="button"
                                      className="flex min-w-0 flex-1 flex-col px-3 py-3 text-left transition hover:bg-white/95 sm:px-4 sm:py-3.5"
                                      onClick={() => setSelectedGrammarId(task.id)}
                                    >
                                      <p className="text-[0.7rem] font-bold text-[color:var(--sun-muted)]">#{idx + 1}</p>
                                      <p className="text-sm font-black leading-snug sm:text-base">{task.prompt}</p>
                                    </button>
                                    <div className="flex shrink-0 flex-col justify-center border-l border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] px-2 py-2">
                                      <button
                                        type="button"
                                        className="sun-btn sun-btn--ghost !min-h-[36px] !px-2 !py-1 text-[0.65rem] font-bold text-rose-800 sm:text-xs"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          removeGrammarTaskById(task.id, task.prompt);
                                        }}
                                      >
                                        删除
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {wordsScope === "grammar" && grammarGroupedBlocks == null && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {grammarFiltered.length === 0 && <p className="col-span-full text-sm text-[color:var(--sun-muted)]">暂无语法题。</p>}
                    {grammarFiltered.map((task, idx) => {
                      const les = lessonById.get(task.lessonId);
                      return (
                        <div
                          key={task.id}
                          className="flex min-h-[6.5rem] gap-0 rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] bg-white/75 shadow-sm sm:min-h-[7rem]"
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 flex-col px-3 py-3 text-left transition hover:bg-white/95 sm:px-4 sm:py-3.5"
                            onClick={() => setSelectedGrammarId(task.id)}
                          >
                            <p className="text-[0.7rem] font-bold text-[color:var(--sun-muted)]">#{idx + 1}</p>
                            <p className="text-sm font-black leading-snug sm:text-base">{task.prompt}</p>
                            <p className="mt-1 line-clamp-2 text-[0.75rem] leading-relaxed text-[color:var(--sun-muted)]">{task.zhPrompt || task.explanation}</p>
                            <p className="mt-auto text-[0.65rem] font-semibold leading-tight text-[color:var(--sun-accent)]">
                              {les ? `${les.category} · ${les.name}` : "未知课文"}
                            </p>
                          </button>
                          <div className="flex shrink-0 flex-col justify-center border-l border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] px-2 py-2">
                            <button
                              type="button"
                              className="sun-btn sun-btn--ghost !min-h-[36px] !px-2 !py-1 text-[0.65rem] font-bold text-rose-800 sm:text-xs"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeGrammarTaskById(task.id, task.prompt);
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          )}

          {appTab === "practice" && (
            <>
              <section className="float-card float-card--delay p-5 md:p-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="text-lg font-black">刷题复习</h2>
                  <button type="button" className="sun-btn sun-btn--ghost shrink-0 !min-h-[48px] !px-6" onClick={() => setPracticeToolsModalOpen(true)}>
                    出题工具
                  </button>
                </div>
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-[color:var(--sun-muted)]">
                    待复习：单词 {practiceQueueSizes.vocab} | 句子 {practiceQueueSizes.sentence} | 语法 {practiceQueueSizes.grammar}
                  </p>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {(["vocab", "sentence", "grammar"] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={clsx(
                        "rounded-2xl border px-3 py-2 text-left transition",
                        mode === item
                          ? "border-amber-500 bg-amber-100 text-amber-950 shadow-sm"
                          : "border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-white/70 text-[color:var(--sun-muted)] hover:bg-white/95",
                      )}
                      onClick={() => setMode(item)}
                    >
                      <p className="text-xs font-bold">
                        {item === "vocab" ? "单词练习" : item === "sentence" ? "句子练习" : "语法练习"}
                      </p>
                      <p className="mt-0.5 text-sm font-black tabular-nums">
                        待复习{" "}
                        {item === "vocab"
                          ? practiceQueueSizes.vocab
                          : item === "sentence"
                            ? practiceQueueSizes.sentence
                            : practiceQueueSizes.grammar}
                      </p>
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={clsx("chip", answerMode === "choice" && "chip--active")}
                    onClick={() => setAnswerMode((m) => (m === "choice" ? "input" : "choice"))}
                  >
                    题型：{answerMode === "choice" ? "选择题" : "填空题"}
                  </button>
                  <label className="chip flex cursor-pointer items-center gap-2 !border-amber-200/80 bg-white/60">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-amber-700"
                      checked={autoSpeakVocab}
                      onChange={(e) => setAutoSpeakVocab(e.target.checked)}
                    />
                    <span className="text-xs font-semibold">自动发音</span>
                  </label>
                </div>

                <div className="mt-4 rounded-2xl bg-white/75 px-4 py-4">
                  {!current && (
                    <div className="space-y-3 text-sm text-[color:var(--sun-muted)]">
                      <p>
                        当前模式（{mode === "vocab" ? "单词" : mode === "sentence" ? "句子" : "语法"}）暂无<strong className="text-[color:var(--sun-ink)]">今日待复习</strong>
                        到期题；可换模式试试，或先去课文里划选出题 / 单词页加卡。
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {(["vocab", "sentence", "grammar"] as const)
                          .filter((k) => k !== mode)
                          .map((k) => (
                            <button
                              key={k}
                              type="button"
                              className="sun-btn sun-btn--ghost !min-h-[40px] !px-4 !py-2 text-xs"
                              onClick={() => setMode(k)}
                            >
                              切到{k === "vocab" ? "单词" : k === "sentence" ? "句子" : "语法"}
                            </button>
                          ))}
                        <button
                          type="button"
                          className="sun-btn sun-btn--ghost !min-h-[40px] !px-4 !py-2 text-xs"
                          onClick={() => setAppTab("words")}
                        >
                          去单词页
                        </button>
                        <button
                          type="button"
                          className="sun-btn sun-btn--ghost !min-h-[40px] !px-4 !py-2 text-xs"
                          onClick={() => setAppTab("lessons")}
                        >
                          去课文
                        </button>
                      </div>
                    </div>
                  )}
                  {current && (
                    <div className="space-y-3">
                  {current.kind === "grammar" && answerMode === "input" && (
                    <p className="mb-2 rounded-xl bg-gradient-to-r from-amber-100 via-amber-50 to-amber-100 px-3 py-2 text-sm font-bold leading-relaxed text-amber-900">
                      题干中译：{current.payload.zhPrompt || "（本题为旧数据，暂无中译；可参考下方详解理解句意。）"}
                    </p>
                  )}
                  {current.kind === "grammar" && current.payload.sourceSentence?.trim() && (
                    <p className="mb-2 rounded-xl bg-sky-50/90 px-3 py-2 text-xs leading-relaxed text-sky-950">
                      原句：{current.payload.sourceSentence}
                    </p>
                  )}
                  {current.kind === "grammar" && current.payload.knowledgePoint?.trim() && (
                    <p className="mb-2 text-[0.68rem] font-semibold text-[color:var(--sun-muted)]">
                      知识点：{current.payload.knowledgePoint}
                    </p>
                  )}
                  <p className="text-[0.72rem] font-bold uppercase tracking-wide text-[color:var(--sun-muted)]">
                    当前练习模式：{current.kind === "vocab" ? "单词" : current.kind === "sentence" ? "句子" : "语法"}
                  </p>
                  <p className="text-lg font-black leading-snug">
                    {current.kind === "vocab"
                      ? answerMode === "choice"
                        ? vocabPracticeDir === "zh2jp"
                          ? "中文选日文"
                          : "日文选中文"
                        : vocabPracticeDir === "zh2jp"
                          ? "根据中文提示输入日语"
                          : "根据日文与读音输入中文"
                      : current.kind === "sentence"
                        ? current.payload.zh
                        : current.payload.prompt}
                  </p>
                      {(current.kind === "vocab" || current.kind === "sentence") && (
                        <button
                          type="button"
                          className="sun-btn sun-btn--ghost w-fit !px-3 !py-1.5 text-xs"
                          onClick={() => autoSpeakPracticeItem(current)}
                        >
                          听发音
                        </button>
                      )}
                      {current.kind === "vocab" && currentVocabDrillStep !== null && answerMode === "choice" && (
                        <p className="text-[0.68rem] font-bold text-emerald-800">新词热身：第 {currentVocabDrillStep}/4 步</p>
                      )}
                      {current.kind === "vocab" && vocabPracticeDir === "zh2jp" && (
                        <>
                          <p className="rounded-xl bg-amber-50/90 px-3 py-2 text-base font-black leading-relaxed text-[color:var(--sun-ink)] md:text-lg">
                            中文义：{current.payload.meanings.map((m) => m.zh).join(" / ")}
                          </p>
                          {(answerMode === "input" || answerConfirmed) && (
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-xs text-[color:var(--sun-muted)]">读音参考：{current.payload.kana}</p>
                            </div>
                          )}
                        </>
                      )}
                      {current.kind === "vocab" && vocabPracticeDir === "jp2zh" && (
                        <>
                          <p className="text-xl font-black text-[color:var(--sun-ink)]">{current.payload.term}</p>
                          <p className="text-sm text-[color:var(--sun-muted)]">读音：{current.payload.kana}</p>
                        </>
                      )}
                      {current.kind === "vocab" && answerMode === "choice" && vocabPracticeDir === "zh2jp" && (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {vocabMcOptions.map((label) => (
                            <button
                              key={`${current.payload.id}_${label}`}
                              type="button"
                              className={clsx(
                                "practice-choice-tile rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_50%,transparent)] bg-white/90 px-4 py-4 text-left text-base font-bold text-[color:var(--sun-ink)] shadow-sm",
                                choiceFlashKey === `v_${label}` && "practice-choice-tile--flash",
                                practiceSolutionKey === `v_${label}` && "ring-2 ring-emerald-600/85 ring-offset-2 ring-offset-amber-50/90",
                                answer.trim() === label.trim() && "ring-2 ring-amber-500/90",
                              )}
                              onClick={() => {
                                resumePracticeAudio();
                                playPracticeTap();
                                setAnswer(label);
                                flashChoiceKey(`v_${label}`);
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      )}
                      {current.kind === "vocab" && answerMode === "choice" && vocabPracticeDir === "jp2zh" && (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {vocabMcZhOptions.map((label) => (
                            <button
                              key={`${current.payload.id}_z_${label}`}
                              type="button"
                              className={clsx(
                                "practice-choice-tile rounded-2xl border border-[color-mix(in_srgb,var(--sun-mint)_45%,transparent)] bg-white/90 px-4 py-4 text-left text-sm font-bold leading-snug text-[color:var(--sun-ink)] shadow-sm",
                                choiceFlashKey === `vz_${label}` && "practice-choice-tile--flash",
                                practiceSolutionKey === `vz_${label}` && "ring-2 ring-emerald-600/85 ring-offset-2 ring-offset-white/90",
                                answer.trim() === label.trim() && "ring-2 ring-teal-500/90",
                              )}
                              onClick={() => {
                                resumePracticeAudio();
                                playPracticeTap();
                                setAnswer(label);
                                flashChoiceKey(`vz_${label}`);
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      )}
                      {current.kind === "grammar" && answerMode === "choice" && (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {current.payload.choices.map((choice) => (
                            <button
                              key={choice.id}
                              type="button"
                              className={clsx(
                                "practice-choice-tile rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_50%,transparent)] bg-gradient-to-br from-white/95 to-amber-50/90 px-4 py-4 text-left text-sm font-bold leading-snug text-[color:var(--sun-ink)] shadow-sm",
                                choiceFlashKey === `g_${choice.id}` && "practice-choice-tile--flash",
                                practiceSolutionKey === `g_${choice.id}` && "ring-2 ring-emerald-600/85 ring-offset-2 ring-offset-amber-50/90",
                                answer.trim() === choice.text.trim() && "ring-2 ring-teal-500/90",
                              )}
                              onClick={() => {
                                resumePracticeAudio();
                                playPracticeTap();
                                setAnswer(choice.text);
                                flashChoiceKey(`g_${choice.id}`);
                              }}
                            >
                              {choice.text}
                            </button>
                          ))}
                        </div>
                      )}
                      {current.kind === "sentence" && answerMode === "choice" && (
                        <SentenceDragComposer
                          key={sentenceShuffle.id}
                          tokens={sentenceShuffle.tokens}
                          correctTokens={current.payload.tokens}
                          onAnswerChange={(value) => setAnswer(value)}
                          revealSolutionOrder={sentenceSolutionReveal}
                        />
                      )}
                      {current.kind === "vocab" && answerMode === "input" && vocabPracticeDir === "zh2jp" && (
                        <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
                          填空：输入日语词条
                          <input
                            className="sun-input mt-1 w-full"
                            value={answer}
                            onChange={(e) => setAnswer(e.target.value)}
                            placeholder="如：学生、勉強する"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                confirmOrNextPractice();
                              }
                            }}
                          />
                        </label>
                      )}
                      {current.kind === "vocab" && answerMode === "input" && vocabPracticeDir === "jp2zh" && (
                        <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
                          填空：输入中文义项
                          <input
                            className="sun-input mt-1 w-full"
                            value={answer}
                            onChange={(e) => setAnswer(e.target.value)}
                            placeholder="用中文写出义项"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                confirmOrNextPractice();
                              }
                            }}
                          />
                        </label>
                      )}
                      {current.kind === "grammar" && answerMode === "input" && (
                        <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
                          填空：输入选项文字（与某一选项完全一致即可）
                          <input
                            className="sun-input mt-1 w-full"
                            value={answer}
                            onChange={(e) => setAnswer(e.target.value)}
                            placeholder="输入助词或短语"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                confirmOrNextPractice();
                              }
                            }}
                          />
                        </label>
                      )}
                      {current.kind === "sentence" && answerMode === "input" && (
                        <div className="space-y-2">
                          <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
                            填空：输入完整日语（词间空格须与题库一致）
                            <input
                              className="sun-input mt-1 w-full"
                              value={answer}
                              onChange={(e) => setAnswer(e.target.value)}
                              placeholder="在此输入整句日语"
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  confirmOrNextPractice();
                                }
                              }}
                            />
                          </label>
                          {sentenceSolutionReveal && (
                            <div
                              className="rounded-2xl border-2 border-emerald-400/60 bg-emerald-50/95 px-3 py-3 text-xs leading-relaxed text-emerald-950 shadow-sm"
                              role="status"
                              aria-live="polite"
                            >
                              <p className="font-black text-emerald-900">参考答案（整句）</p>
                              <p className="mt-1 font-mono text-sm font-semibold tracking-tight">{current.payload.jpAnswer}</p>
                            </div>
                          )}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className="sun-btn !px-4 !py-2 text-sm" onClick={() => void confirmOrNextPractice()}>
                          {answerMode === "input"
                            ? "提交答案"
                            : answerConfirmed
                              ? "下一题"
                              : "提交答案"}
                        </button>
                        <button type="button" className="sun-btn !bg-gradient-to-r !from-teal-200 !to-amber-200 !px-4 !py-2 text-sm" onClick={() => submitAnswer("easy")}>
                          已掌握
                        </button>
                        <button
                          type="button"
                          className="sun-btn !bg-rose-100 !px-4 !py-2 !text-rose-900 text-sm"
                          onClick={() => {
                            primeWrongRevealHints();
                            submitAnswer("wrong");
                          }}
                        >
                          答错啦
                        </button>
                        <button type="button" className="sun-btn sun-btn--ghost !px-4 !py-2 text-sm" onClick={() => setDisableKinds((prev) => new Set([...prev, mode]))}>
                          退出练习
                        </button>
                      </div>
                      {feedback && <p className="text-base font-black text-rose-700">{feedback}</p>}
                      {((answerMode === "choice" && answerConfirmed) || (answerMode === "input" && fillDetailReveal !== "none")) &&
                        practicePeekRef.current && (
                          <button
                            type="button"
                            className="text-left text-sm font-bold text-sky-800 underline decoration-2 underline-offset-2 hover:text-sky-950"
                            onClick={() => {
                              const x = practicePeekRef.current;
                              if (!x) return;
                              setSelectedVocabId("");
                              setSelectedSentenceId("");
                              setSelectedGrammarId("");
                              if (x.kind === "vocab") setSelectedVocabId(x.id);
                              else if (x.kind === "sentence") setSelectedSentenceId(x.id);
                              else setSelectedGrammarId(x.id);
                            }}
                          >
                            查看本题详情
                          </button>
                        )}
                      {current.kind === "vocab" &&
                        ((answerMode === "choice" && answerConfirmed) || (answerMode === "input" && fillDetailReveal === "vocab")) && (
                        <div className="max-h-52 overflow-auto rounded-2xl border border-[color-mix(in_srgb,var(--sun-mint)_40%,transparent)] bg-teal-50/80 px-3 py-3 text-xs leading-6 text-[color:var(--sun-ink)]">
                          <p className="font-black">参考答案</p>
                          <p className="mt-1">
                            <span className="font-bold">词条</span>：{current.payload.term}
                          </p>
                          <p>
                            <span className="font-bold">读音</span>：{current.payload.kana}
                          </p>
                          <p>
                            <span className="font-bold">义项</span>：{current.payload.meanings.map((m) => m.zh).join(" / ")}
                          </p>
                          <p>
                            <span className="font-bold">词源</span>：{current.payload.etymology || "—"}
                          </p>
                          <p>
                            <span className="font-bold">例句</span>：{current.payload.latestExample || "—"}
                          </p>
                        </div>
                      )}
                      {current.kind === "sentence" &&
                        ((answerMode === "choice" && answerConfirmed) || (answerMode === "input" && fillDetailReveal === "sentence")) && (
                        <div className="rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] bg-amber-50/80 px-3 py-3 text-xs leading-6 text-[color:var(--sun-ink)]">
                          <p className="font-black">参考答案</p>
                          <p className="mt-1">
                            <span className="font-bold">日语</span>：{current.payload.jpAnswer}
                          </p>
                          <p>
                            <span className="font-bold">中文</span>：{current.payload.zh}
                          </p>
                        </div>
                      )}
                      {current.kind === "grammar" &&
                        ((answerMode === "choice" && answerConfirmed) || (answerMode === "input" && fillDetailReveal === "grammar")) && (
                        <div className="max-h-44 overflow-auto rounded-2xl bg-amber-50/90 px-3 py-3 text-xs leading-6 text-[color:var(--sun-ink)]">
                          <p className="font-black">详解</p>
                          <p className="mt-1">{current.payload.explanation || latestGrammarExplanation || "暂无解析"}</p>
                          <div className="mt-2 space-y-1">
                            {current.payload.choices
                              .filter((choice) => !choice.correct)
                              .map((choice) => (
                                <p key={`reason_${choice.id}`}>
                                  <span className="font-bold">{choice.text}</span>：
                                  {current.payload.wrongReasonByChoiceId?.[choice.id] || "该选项与题干语法语义不匹配。"}
                                </p>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          {appTab === "stats" && (
            <>
              <section className="float-card p-5 md:p-6">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <h2 className="text-lg font-black">我的学习数据</h2>
                  <button type="button" className="sun-btn sun-btn--ghost shrink-0 !px-2 !py-1 text-xs" onClick={exportStatsSummaryCsv}>
                    导出摘要 CSV
                  </button>
                </div>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[color:var(--sun-muted)]">记录你的学习时光，越努力越优秀～</p>
                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                  <div className="rounded-2xl border border-amber-200/70 bg-amber-50/70 px-4 py-4">
                    <p className="text-xs font-black text-amber-900/80">累计练习</p>
                    <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <div>
                        <dt className="text-[0.65rem] font-bold text-[color:var(--sun-muted)]">答对</dt>
                        <dd className="mt-1 text-xl font-black tabular-nums text-[color:var(--sun-ink)]">{practiceStatsSnapshot.practiceMarkCorrect}</dd>
                      </div>
                      <div>
                        <dt className="text-[0.65rem] font-bold text-[color:var(--sun-muted)]">答错</dt>
                        <dd className="mt-1 text-xl font-black tabular-nums text-[color:var(--sun-ink)]">{practiceStatsSnapshot.practiceMarkWrong}</dd>
                      </div>
                      <div>
                        <dt className="text-[0.65rem] font-bold text-[color:var(--sun-muted)]">已掌握</dt>
                        <dd className="mt-1 text-xl font-black tabular-nums text-[color:var(--sun-ink)]">{practiceStatsSnapshot.practiceMarkEasy}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="rounded-2xl border border-teal-200/70 bg-teal-50/70 px-4 py-4">
                    <p className="text-xs font-black text-teal-900/80">学习时长</p>
                    <ul className="mt-3 space-y-2 text-sm text-[color:var(--sun-ink)]">
                      <li>
                        <span className="font-bold text-[color:var(--sun-muted)]">课文</span>{" "}
                        <span className="font-black tabular-nums">{formatDwellLabel(practiceStatsSnapshot.dwellLessonReaderSec ?? 0)}</span>
                      </li>
                      <li>
                        <span className="font-bold text-[color:var(--sun-muted)]">练习</span>{" "}
                        <span className="font-black tabular-nums">{formatDwellLabel(practiceStatsSnapshot.dwellPracticeSec ?? 0)}</span>
                      </li>
                    </ul>
                  </div>
                </div>
                <div className="mt-4 rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-white/70 px-4 py-4">
                  <p className="text-xs font-black text-[color:var(--sun-muted)]">今日待复习</p>
                  <p className="mt-2 text-lg font-black text-[color:var(--sun-ink)]">
                    词 <span className="tabular-nums text-amber-900">{globalDueReviewCounts.vocab}</span>
                    <span className="mx-2 text-[color:var(--sun-muted)]">·</span>句{" "}
                    <span className="tabular-nums text-amber-900">{globalDueReviewCounts.sentence}</span>
                    <span className="mx-2 text-[color:var(--sun-muted)]">·</span>语法{" "}
                    <span className="tabular-nums text-amber-900">{globalDueReviewCounts.grammar}</span>
                  </p>
                </div>
                <h3 className="mt-8 text-base font-black">课文待复习清单</h3>
                <p className="mt-1 text-xs text-[color:var(--sun-muted)]">点击去复习，一键开启刷题～</p>
                {lessonDueBreakdown.length === 0 ? (
                  <p className="mt-4 text-sm text-[color:var(--sun-muted)]">目前没有到期的题目，休息也很好。</p>
                ) : (
                  <div className="mt-4 max-h-80 overflow-auto rounded-xl border border-amber-200/60 bg-white/80">
                    <table className="w-full min-w-[280px] text-left text-sm">
                      <thead className="sticky top-0 bg-amber-50/95 text-xs font-black text-amber-950">
                        <tr>
                          <th className="px-3 py-2">课文</th>
                          <th className="px-2 py-2 text-center tabular-nums">词</th>
                          <th className="px-2 py-2 text-center tabular-nums">句</th>
                          <th className="px-2 py-2 text-center tabular-nums">法</th>
                          <th className="px-2 py-2 text-center tabular-nums">计</th>
                          <th className="px-2 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {lessonDueBreakdown.map(({ lesson, vocab, sentence, grammar, total }) => (
                          <tr key={lesson.id} className="border-t border-amber-100/90 text-[color:var(--sun-ink)]">
                            <td className="px-3 py-2">
                              <p className="font-bold leading-snug">{lesson.name}</p>
                              <p className="text-[0.65rem] text-[color:var(--sun-muted)]">{lesson.category}</p>
                            </td>
                            <td className="px-2 py-2 text-center tabular-nums">{vocab}</td>
                            <td className="px-2 py-2 text-center tabular-nums">{sentence}</td>
                            <td className="px-2 py-2 text-center tabular-nums">{grammar}</td>
                            <td className="px-2 py-2 text-center font-black tabular-nums">{total}</td>
                            <td className="px-2 py-2 text-right">
                              <button
                                type="button"
                                className="sun-btn sun-btn--ghost !px-2 !py-1 text-xs"
                                onClick={() => {
                                  setActiveLessonId(lesson.id);
                                  setAppTab("practice");
                                }}
                              >
                                去复习
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="float-card float-card--delay p-5 md:p-6">
                <h3 className="text-base font-black">区间内过往</h3>
                <p className="mt-1 text-xs text-[color:var(--sun-muted)]">{statsPastBoundsText}</p>
                <p className="mt-2 text-[0.65rem] leading-relaxed text-[color:var(--sun-muted)]">
                  「图中合计」与当前图一致；横轴固定按日。选「有记录以来」时可再限制图中尾部天数。
                </p>
                <p className="mt-4 text-[0.65rem] font-black uppercase tracking-wide text-indigo-900/80">时间范围</p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {(["today", "d7", "d14", "d30", "d60", "d90", "allRecorded"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={clsx(
                        "rounded-full border px-3 py-1.5 text-xs font-black transition",
                        statsPastRange === p
                          ? "border-indigo-500 bg-indigo-100 text-indigo-950 shadow-sm"
                          : "border-indigo-200/90 bg-white/70 text-[color:var(--sun-muted)] hover:bg-white",
                      )}
                      onClick={() => {
                        setStatsPastRange(p);
                        setStatsPastGranularity("day");
                      }}
                    >
                      {resolvePastRangeLabel(p)}
                    </button>
                  ))}
                </div>
                <p className="mt-4 text-[0.65rem] font-black uppercase tracking-wide text-indigo-900/80">横轴粒度：按日</p>
                {statsPastRange === "allRecorded" && (
                  <>
                    <p className="mt-4 text-[0.65rem] font-black uppercase tracking-wide text-indigo-900/80">图中日历日（尾部）</p>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {([30, 60, 90, 180, "all"] as const).map((t) => (
                        <button
                          key={String(t)}
                          type="button"
                          className={clsx(
                            "rounded-full border px-3 py-1.5 text-xs font-black transition",
                            statsPastTailPreset === t
                              ? "border-indigo-500 bg-indigo-100 text-indigo-950 shadow-sm"
                              : "border-indigo-200/90 bg-white/70 text-[color:var(--sun-muted)] hover:bg-white",
                          )}
                          onClick={() => setStatsPastTailPreset(t)}
                        >
                          {resolvePastTailLabel(t)}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <p className="mt-4 text-[0.65rem] font-black uppercase tracking-wide text-indigo-900/80">展示方式</p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={clsx(
                      "rounded-full border px-3 py-1.5 text-xs font-black transition",
                      statsPastViewMode === "chart"
                        ? "border-indigo-500 bg-indigo-100 text-indigo-950 shadow-sm"
                        : "border-indigo-200/90 bg-white/70 text-[color:var(--sun-muted)] hover:bg-white",
                    )}
                    onClick={() => setStatsPastViewMode("chart")}
                  >
                    学习时长趋势
                  </button>
                  <button
                    type="button"
                    className={clsx(
                      "rounded-full border px-3 py-1.5 text-xs font-black transition",
                      statsPastViewMode === "barsOnly"
                        ? "border-indigo-500 bg-indigo-100 text-indigo-950 shadow-sm"
                        : "border-indigo-200/90 bg-white/70 text-[color:var(--sun-muted)] hover:bg-white",
                    )}
                    onClick={() => setStatsPastViewMode("barsOnly")}
                  >
                    刷题数量趋势
                  </button>
                </div>
                <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
                  <p className="text-sm text-[color:var(--sun-ink)]">
                    累计：答对 <span className="font-black tabular-nums">{statsPastRangeSummary.practiceMarkCorrect}</span>
                    <span className="mx-1.5 text-[color:var(--sun-muted)]">|</span>答错{" "}
                    <span className="font-black tabular-nums">{statsPastRangeSummary.practiceMarkWrong}</span>
                    <span className="mx-1.5 text-[color:var(--sun-muted)]">|</span>已掌握{" "}
                    <span className="font-black tabular-nums">{statsPastRangeSummary.practiceMarkEasy}</span>
                    <span className="mx-2 text-[color:var(--sun-muted)]">|</span>
                    课文阅读 <span className="font-black tabular-nums">{formatDwellLabel(statsPastRangeSummary.dwellLessonReaderSec)}</span>
                    <span className="mx-1.5 text-[color:var(--sun-muted)]">·</span>练习页{" "}
                    <span className="font-black tabular-nums">{formatDwellLabel(statsPastRangeSummary.dwellPracticeSec)}</span>
                  </p>
                  <button type="button" className="sun-btn sun-btn--ghost shrink-0 !px-2 !py-1 text-xs" onClick={exportPastStatsCsv}>
                    导出 CSV
                  </button>
                </div>
                <StatsPastRangeChart data={statsPastChartRowsDisplayed} variant={statsPastViewMode === "chart" ? "timeOnly" : "barsOnly"} />
              </section>

              <section className="float-card float-card--delay p-5 md:p-6">
                <h3 className="text-base font-black">未来复习计划</h3>
                <p className="mt-1 text-xs leading-relaxed text-[color:var(--sun-muted)]">看看接下来几天要复习多少题，心里更有底～</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {STATS_FUTURE_HORIZON_OPTIONS.map((h) => (
                    <button
                      key={h}
                      type="button"
                      className={clsx(
                        "rounded-full border px-3 py-1.5 text-xs font-black transition",
                        statsFutureHorizon === h
                          ? "border-violet-500 bg-violet-100 text-violet-950 shadow-sm"
                          : "border-violet-200/90 bg-white/70 text-[color:var(--sun-muted)] hover:bg-white",
                      )}
                      onClick={() => setStatsFutureHorizon(h)}
                    >
                      {resolveFutureHorizonLabel(h)}
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
                  <p className="text-sm font-black text-[color:var(--sun-ink)]">
                    合计复习：{" "}
                    <span className="tabular-nums text-violet-950">{statsFutureDueBundle.sumTotal}</span> 个知识点（单词 {statsFutureDueBundle.sumVocab} · 句子{" "}
                    {statsFutureDueBundle.sumSentence} · 语法 {statsFutureDueBundle.sumGrammar}）
                  </p>
                  <button type="button" className="sun-btn sun-btn--ghost shrink-0 !px-2 !py-1 text-xs" onClick={exportFutureStatsCsv}>
                    导出 CSV
                  </button>
                </div>
                <p className="mt-3 text-[0.65rem] font-black uppercase tracking-wide text-violet-900/85">图例</p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={clsx(
                      "rounded-full border px-3 py-1.5 text-xs font-black transition",
                      statsFutureShowCumulative
                        ? "border-violet-500 bg-violet-100 text-violet-950 shadow-sm"
                        : "border-violet-200/90 bg-white/70 text-[color:var(--sun-muted)] hover:bg-white",
                    )}
                    onClick={() => setStatsFutureShowCumulative(true)}
                  >
                    柱 + 累计线
                  </button>
                  <button
                    type="button"
                    className={clsx(
                      "rounded-full border px-3 py-1.5 text-xs font-black transition",
                      !statsFutureShowCumulative
                        ? "border-violet-500 bg-violet-100 text-violet-950 shadow-sm"
                        : "border-violet-200/90 bg-white/70 text-[color:var(--sun-muted)] hover:bg-white",
                    )}
                    onClick={() => setStatsFutureShowCumulative(false)}
                  >
                    仅柱状
                  </button>
                </div>
                <p className="mt-2 text-[0.65rem] leading-relaxed text-[color:var(--sun-muted)]">把鼠标移到柱子上，可以看到当天要复习多少～</p>
                <StatsFutureDueChart data={statsFutureChartRows} showCumulativeLine={statsFutureShowCumulative} />
              </section>
            </>
          )}

          {appTab === "data" && (
            <>
              <section className="float-card p-5 md:p-6">
                <h2 className="text-lg font-black">小窝设置</h2>
                <p className="mt-1 text-sm leading-relaxed text-[color:var(--sun-muted)]">登录自动同步数据，安心学习不丢失～</p>
                {silentHealthIssue && (
                  <p className="mt-2 rounded-xl border border-red-300/70 bg-red-50/80 px-3 py-2 text-xs font-semibold text-red-700">
                    后台健康检查提示：{silentHealthIssue}
                  </p>
                )}
                {dataToast && (
                  <p role="status" className="mt-2 rounded-xl border border-emerald-500/60 bg-emerald-50/95 px-3 py-2 text-sm font-semibold text-emerald-950">
                    {dataToast}
                  </p>
                )}
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <section className="rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-white/70 p-4">
                    <h3 className="text-sm font-black">账号同步</h3>
                    <p className="mt-1 text-xs leading-relaxed text-[color:var(--sun-muted)]">多设备同步，进度不丢失～</p>
                    <CloudAuthPanel
                      localAppData={data}
                      onApplyCloudPayload={(next) => setData(next)}
                      onCloudSyncSuccess={clearCloudAheadBanner}
                      cloudToolbar="syncOnly"
                    />
                  </section>
                  <section className="rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-white/70 p-4">
                    <h3 className="text-sm font-black">备份与恢复</h3>
                    <p className="mt-1 text-xs leading-relaxed text-[color:var(--sun-muted)]">手动备份，双重安心～</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" className="sun-btn" onClick={exportJson}>
                        备份我的数据
                      </button>
                      <label className="sun-btn sun-btn--ghost cursor-pointer">
                        恢复数据
                        <input type="file" accept=".json,application/json" className="hidden" onChange={importJson} />
                      </label>
                    </div>
                  </section>
                </div>
              </section>

              <section className="float-card float-card--delay p-5 md:p-6">
                <h3 className="text-base font-black">我的单词本</h3>
                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {data.vocabCards.length === 0 && <p className="col-span-full text-sm text-[color:var(--sun-muted)]">单词本还是空的～</p>}
                  {data.vocabCards.map((card) => {
                    const les = lessonById.get(card.lessonId);
                    return (
                      <div
                        key={card.id}
                        className="flex min-h-[6.5rem] gap-0 rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] bg-white/75 shadow-sm sm:min-h-[7rem]"
                      >
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 flex-col px-3 py-3 text-left transition hover:bg-white/95 sm:px-4 sm:py-3.5"
                          onClick={() => {
                            setSelectedVocabId(card.id);
                            setAppTab("words");
                            setActiveLessonId(card.lessonId);
                          }}
                        >
                          <p
                            className={clsx(
                              "text-sm font-black leading-snug sm:text-base",
                              card.lessonId === activeLessonId ? "text-[#b45309]" : "text-[#1d4ed8]",
                            )}
                          >
                            {card.term}
                          </p>
                          <p className="mt-0.5 text-sm leading-snug text-[color:var(--sun-muted)]">{card.meanings.map((m) => m.zh).join(" / ")}</p>
                          <p className="mt-1 text-[0.65rem] font-semibold leading-tight text-[color:var(--sun-accent)] sm:text-xs">
                            {les ? `${les.category} · ${les.name}` : "未知课文"}
                          </p>
                          <p className="mt-auto line-clamp-2 pt-2 text-[0.7rem] leading-relaxed text-[color:var(--sun-muted)] sm:text-xs">
                            {card.latestExample}
                          </p>
                        </button>
                        <div className="flex shrink-0 flex-col justify-center border-l border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] px-2 py-2">
                          <button
                            type="button"
                            className="sun-btn sun-btn--ghost !min-h-[36px] !px-2 !py-1 text-[0.65rem] font-bold text-rose-800 sm:text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeVocabCardById(card.id, card.term);
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </>
          )}
        </div>

        {authDialogOpen && (
          <div
            className="fixed inset-0 z-[95] flex items-end justify-center bg-black/35 p-3 sm:items-center"
            role="dialog"
            aria-modal
            aria-labelledby="cloud-auth-title"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setAuthDialogOpen(false);
            }}
          >
            <div className="float-card max-h-[90vh] w-full max-w-lg overflow-auto p-5 shadow-2xl md:p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 id="cloud-auth-title" className="text-lg font-black">
                    登录 / 注册账号
                  </h2>
                  <p className="mt-1 text-xs text-[color:var(--sun-muted)]">
                    新手可先跳过，直接学习；登录后会自动同步云端。
                  </p>
                </div>
                <button type="button" className="sun-btn sun-btn--ghost !px-3 !py-1 text-xs" onClick={() => setAuthDialogOpen(false)}>
                  关闭
                </button>
              </div>
              <div className="mt-3">
                <CloudAuthPanel
                  localAppData={data}
                  onApplyCloudPayload={(next) => setData(next)}
                  mode="authOnly"
                  className="rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-white/70 p-4"
                />
              </div>
            </div>
          </div>
        )}

        {importModalOpen && (
          <div
            className="fixed inset-0 z-[90] flex items-end justify-center bg-black/35 p-3 sm:items-center"
            role="dialog"
            aria-modal
            aria-labelledby="import-lesson-title"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setImportModalOpen(false);
            }}
          >
            <div className="float-card max-h-[90vh] w-full max-w-3xl overflow-auto p-6 shadow-2xl">
              <h2 id="import-lesson-title" className="text-lg font-black">
                添加课文
              </h2>
              <p className="mt-1 text-xs text-[color:var(--sun-muted)]">
                仅保留必要信息：标题、分类、作者、媒体文件与带时间戳字幕文本。
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
                <div className="flex flex-col gap-3">
                  <input
                    className="sun-input w-full py-3"
                    placeholder="课文名称"
                    value={lessonName}
                    onChange={(e) => setLessonName(e.target.value)}
                  />
                  <input
                    className="sun-input w-full py-3"
                    placeholder="分类（如：N3 阅读、会话课本）"
                    value={lessonCategory}
                    onChange={(e) => setLessonCategory(e.target.value)}
                  />
                  <input
                    className="sun-input w-full py-3"
                    placeholder="作者（可空，保存后为空则记为「著者不明」）"
                    value={lessonAuthor}
                    onChange={(e) => setLessonAuthor(e.target.value)}
                  />
                  <div className="rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_42%,transparent)] bg-white/80 p-3">
                    <p className="text-xs font-bold text-[color:var(--sun-muted)]">课文形式</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={clsx(
                          "rounded-full border px-3 py-1.5 text-xs font-black transition",
                          lessonKindDraft === "text"
                            ? "border-amber-500 bg-amber-100 text-amber-950 shadow-sm"
                            : "border-amber-200/90 bg-white/70 text-[color:var(--sun-muted)] hover:bg-white",
                        )}
                        onClick={() => setLessonKindDraft("text")}
                      >
                        文字课文
                      </button>
                      <button
                        type="button"
                        className={clsx(
                          "rounded-full border px-3 py-1.5 text-xs font-black transition",
                          lessonKindDraft === "video"
                            ? "border-sky-500 bg-sky-100 text-sky-950 shadow-sm"
                            : "border-sky-200/90 bg-white/70 text-[color:var(--sun-muted)] hover:bg-white",
                        )}
                        onClick={() => setLessonKindDraft("video")}
                      >
                        视频课文
                      </button>
                    </div>
                    {lessonKindDraft === "video" && (
                      <div className="mt-3 space-y-3">
                        <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
                          视频链接（必填，仅存 URL，整包同步更轻）
                          <input
                            className="sun-input mt-1 w-full py-2 font-mono text-xs"
                            placeholder="https://www.youtube.com/watch?v=… 或 https://…/video.mp4"
                            value={lessonVideoUrlDraft}
                            onChange={(e) => setLessonVideoUrlDraft(e.target.value)}
                          />
                        </label>
                        <p className="text-[0.65rem] leading-relaxed text-[color:var(--sun-muted)]">
                          YouTube 请粘贴浏览器地址栏的观看页链接；直链 mp4 也可。不再提供「本机选 mp4 文件」入库（避免云端超时）。
                        </p>
                        <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
                          字幕 txt（格式示例：(0:07) こんにちは...）
                          <textarea
                            className="sun-textarea mt-1 min-h-[8rem] w-full resize-y py-2 font-mono text-xs"
                            placeholder="(0:07) こんにちは、... (0:16) 次の文..."
                            value={lessonSubtitleText}
                            onChange={(e) => setLessonSubtitleText(e.target.value)}
                          />
                        </label>
                        <div className="rounded-xl border border-sky-300/70 bg-sky-50/80 p-3">
                          <p className="text-xs font-black text-sky-950">推荐流程（点击可跳转）</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <a
                              className="sun-btn !min-h-[38px] !bg-sky-600 !px-3 !py-1.5 !text-xs !text-white hover:!bg-sky-700"
                              href="https://snapany.com/zh/bilibili"
                              target="_blank"
                              rel="noreferrer"
                            >
                              点击跳转 SnapAny（下载视频）
                            </a>
                            <a
                              className="sun-btn !min-h-[38px] !bg-indigo-600 !px-3 !py-1.5 !text-xs !text-white hover:!bg-indigo-700"
                              href="https://turboscribe.ai/zh-CN/dashboard"
                              target="_blank"
                              rel="noreferrer"
                            >
                              点击跳转 TurboScribe（提取时间戳文字）
                            </a>
                          </div>
                          <p className="mt-2 text-[0.72rem] leading-relaxed text-sky-900">
                            用本地工具处理音视频后，把<strong>时间戳字幕</strong>粘贴到下方；视频本身只填上面的在线链接即可。
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <p className="text-[0.7rem] font-semibold text-[color:var(--sun-muted)]">
                            导入时会自动从时间戳字幕提取正文。
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                  {lessonMediaTip ? <p className="text-xs text-sky-900">{lessonMediaTip}</p> : null}
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button
                      type="button"
                      className="sun-btn sun-btn--ghost min-h-[40px] !px-4 text-xs"
                      onClick={() => {
                        setLessonName("");
                        setLessonCategory("");
                        setLessonAuthor("");
                        setLessonKindDraft("text");
                        setLessonVideoUrlDraft("");
                        setLessonSubtitleText("");
                        setLessonMediaTip("");
                      }}
                    >
                      清空表单
                    </button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-col rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] bg-[color-mix(in_srgb,#fff_92%,transparent)] p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-black text-[color:var(--sun-ink)]">选择课文分类</p>
                    <button
                      type="button"
                      className="sun-btn sun-btn--ghost !px-3 !py-1 text-[0.7rem]"
                      onClick={() => {
                        setLessonCategory("");
                      }}
                    >
                      清空分类
                    </button>
                  </div>
                  {activeLessons.length === 0 ? (
                    <p className="text-xs text-[color:var(--sun-muted)]">当前还没有历史分类，直接在左侧填写新分类名即可。</p>
                  ) : (
                    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-xl bg-amber-50/60 p-2 text-xs">
                      {[...new Set(activeLessons.map((l) => l.category?.trim() || "未分类"))]
                        .sort((a, b) => a.localeCompare(b, "zh-CN"))
                        .map((category) => (
                          <button
                            key={category}
                            type="button"
                            className="block w-full rounded-lg bg-white/90 px-3 py-2 text-left text-[0.7rem] leading-relaxed hover:bg-amber-100/80"
                            onClick={() => {
                              setLessonCategory(category);
                            }}
                          >
                            <p className="truncate text-[0.8rem] font-bold text-[color:var(--sun-ink)]">{category}</p>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-6 flex flex-wrap gap-3">
                <button type="button" className="sun-btn sun-btn--ghost min-h-[48px] !px-6" onClick={() => setImportModalOpen(false)}>
                  取消
                </button>
                <button type="button" className="sun-btn min-h-[48px] !px-8" onClick={createLesson}>
                  导入并打开
                </button>
              </div>
            </div>
          </div>
        )}

        {newVocabModalOpen && (
          <div
            className="fixed inset-0 z-[90] flex items-end justify-center bg-black/35 p-3 sm:items-center"
            role="dialog"
            aria-modal
            aria-labelledby="new-vocab-title"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) closeNewVocabModal();
            }}
          >
            <div className="float-card max-h-[90vh] w-full max-w-lg overflow-auto p-6 shadow-2xl">
              <h2 id="new-vocab-title" className="text-lg font-black">
                新建单词
              </h2>
              <p className="mt-1 text-xs text-[color:var(--sun-muted)]">
                先选绑定课文并输入词条；点<strong className="text-[color:var(--sun-ink)]">保存词卡</strong>
                时会<strong>自动调用 AI</strong>补全假名、中文义、词源和例句（也可先点「AI 补全」预览后再改）。词典分组无课文时更依赖例句哦。
              </p>
              <div className="mt-4 flex flex-col gap-3">
                <label className="text-xs font-bold text-[color:var(--sun-muted)]">
                  绑定课文
                  <select
                    className="sun-select mt-1 w-full min-h-[48px] py-3"
                    value={newVocabLessonId}
                    onChange={(e) => setNewVocabLessonId(e.target.value)}
                  >
                    <option value="__new_dict__">新建词典分组</option>
                    {activeLessons.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.category} · {l.name}
                      </option>
                    ))}
                  </select>
                </label>
                {newVocabLessonId === "__new_dict__" && (
                  <div className="grid grid-cols-1 gap-2">
                    <input
                      className="sun-input py-2"
                      placeholder="词典名称（如：新标日N3词典）"
                      value={manualNewDictName}
                      onChange={(e) => setManualNewDictName(e.target.value)}
                    />
                    <input
                      className="sun-input py-2"
                      placeholder="词典分类（如：词典/N3）"
                      value={manualNewDictCategory}
                      onChange={(e) => setManualNewDictCategory(e.target.value)}
                    />
                  </div>
                )}
                <input
                  className="sun-input py-3"
                  placeholder="单词（日语）"
                  value={vocabTerm}
                  onChange={(e) => setVocabTerm(e.target.value)}
                />
                {(() => {
                  const les = data.lessons.find((l) => l.id === newVocabLessonId);
                  const hintEx = les && vocabTerm.trim() ? extractExampleSegmentForTerm(les.content, vocabTerm.trim()) : "";
                  return (
                    <div className="space-y-1">
                      <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
                        例句（整句写入词卡；可从课文填入或 AI 生成）
                        <textarea
                          className="sun-textarea mt-1 min-h-[4.5rem] w-full resize-y py-3 text-sm leading-relaxed"
                          placeholder={newVocabLessonId === "__new_dict__" ? "词典无课文时可留空，点 AI 补全生成例句。" : "留空则保存/补全时按课文规则截取；也可自写。"}
                          value={vocabExampleForNewCard}
                          onChange={(e) => setVocabExampleForNewCard(e.target.value)}
                        />
                      </label>
                      {hintEx ? (
                        <button
                          type="button"
                          className="sun-btn sun-btn--ghost !px-3 !py-1.5 text-[0.7rem] font-bold"
                          disabled={!vocabTerm.trim()}
                          onClick={() => setVocabExampleForNewCard(hintEx)}
                        >
                          用课文匹配片段填入
                        </button>
                      ) : null}
                    </div>
                  );
                })()}
                <button
                  type="button"
                  className="sun-btn sun-btn--ghost w-fit !px-5 !py-2.5 text-sm disabled:opacity-50"
                  disabled={!vocabTerm.trim() || newVocabEnrichBusy}
                  onClick={() => void enrichNewVocabModal()}
                >
                  {newVocabEnrichBusy ? "AI 补全中…" : "AI 补全（假名·释义·词源·例句）"}
                </button>
                <input className="sun-input py-3" placeholder="音标/假名" value={vocabKana} onChange={(e) => setVocabKana(e.target.value)} />
                <input className="sun-input py-3" placeholder="中文释义（<=2词）" value={vocabZh} onChange={(e) => setVocabZh(e.target.value)} />
                <label className="text-xs font-bold text-[color:var(--sun-muted)]">
                  词源 / 备注（可多行）
                  <textarea
                    className="sun-textarea mt-1 min-h-[5.5rem] w-full resize-y py-3 text-sm leading-relaxed"
                    placeholder="词源、记忆钩子或多行备注"
                    value={vocabEtymology}
                    onChange={(e) => setVocabEtymology(e.target.value)}
                  />
                </label>
              </div>
              <div className="mt-6 flex flex-wrap gap-3">
                <button type="button" className="sun-btn sun-btn--ghost min-h-[48px] !px-6" onClick={closeNewVocabModal}>
                  取消
                </button>
                <button
                  type="button"
                  className="sun-btn min-h-[48px] !px-8 disabled:cursor-wait disabled:opacity-70"
                  disabled={!vocabTerm.trim() || newVocabSaveBusy}
                  onClick={() => void submitNewVocabCard()}
                >
                  {newVocabSaveBusy ? "保存中…" : "保存到单词本"}
                </button>
              </div>
            </div>
          </div>
        )}

        {practiceToolsModalOpen && (
          <div
            className="fixed inset-0 z-[90] flex items-end justify-center bg-black/35 p-3 sm:items-center"
            role="dialog"
            aria-modal
            aria-labelledby="practice-tools-title"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setPracticeToolsModalOpen(false);
            }}
          >
            <div className="float-card max-h-[90vh] w-full max-w-lg overflow-auto p-6 shadow-2xl">
              <h2 id="practice-tools-title" className="text-lg font-black">
                出题工具
              </h2>
              <p className="mt-1 text-sm text-[color:var(--sun-muted)]">
                可写入现有课文，或新建一个词典分组（不和课文混在一起）。
              </p>
              <label className="mt-3 block text-sm">
                写入到
                <select className="sun-select mt-1 w-full py-2" value={manualTargetLessonId} onChange={(e) => setManualTargetLessonId(e.target.value)}>
                  <option value="active">当前课文（若有）</option>
                  {activeLessons.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.category} · {l.name}
                    </option>
                  ))}
                  <option value="__new_dict__">新建词典分组</option>
                </select>
              </label>
              {manualTargetLessonId === "__new_dict__" && (
                <div className="mt-2 grid grid-cols-1 gap-2">
                  <input
                    className="sun-input w-full py-2"
                    placeholder="词典名称（如：新标日N3词典）"
                    value={manualNewDictName}
                    onChange={(e) => setManualNewDictName(e.target.value)}
                  />
                  <input
                    className="sun-input w-full py-2"
                    placeholder="词典分类（如：词典/N3）"
                    value={manualNewDictCategory}
                    onChange={(e) => setManualNewDictCategory(e.target.value)}
                  />
                </div>
              )}

              <p className="mt-5 text-xs font-bold text-[color:var(--sun-muted)]">句子题</p>
              <label className="mt-1 block text-sm">
                中文提示
                <input
                  className="sun-input mt-1 w-full py-2"
                  value={practiceSentenceZh}
                  onChange={(e) => setPracticeSentenceZh(e.target.value)}
                  placeholder="例如：我今天要认真学习日语。"
                />
              </label>
              <label className="mt-2 block text-sm">
                日语答案（词之间用空格）
                <input
                  className="sun-input mt-1 w-full py-2 font-mono text-sm"
                  value={practiceSentenceJp}
                  onChange={(e) => setPracticeSentenceJp(e.target.value)}
                  placeholder="私は 今日 真面目に 日本語を 勉強します"
                />
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="sun-btn" onClick={saveManualSentenceTask}>
                  保存句子题
                </button>
                <button type="button" className="sun-btn sun-btn--ghost" onClick={addSampleSentenceTask}>
                  插入一条示例
                </button>
              </div>

              <p className="mt-6 text-xs font-bold text-[color:var(--sun-muted)]">语法题</p>
              <label className="mt-1 block text-sm">
                题干（要有 ___ 表示空）
                <textarea
                  className="sun-textarea mt-1 min-h-[4.5rem] w-full py-2 font-mono text-sm"
                  value={grammarStem}
                  onChange={(e) => setGrammarStem(e.target.value)}
                />
              </label>
              <label className="mt-2 block text-sm">
                知识点（可不填）
                <input
                  className="sun-input mt-1 w-full py-2"
                  placeholder="如：助词は与が"
                  value={grammarKnowledgePoint}
                  onChange={(e) => setGrammarKnowledgePoint(e.target.value)}
                />
              </label>
              <div className="mt-2">
                <button type="button" className="sun-btn" onClick={() => void addDemoGrammar()}>
                  AI 生成选项
                </button>
              </div>

              <div className="mt-6">
                <button type="button" className="sun-btn sun-btn--ghost min-h-[48px] !px-6" onClick={() => setPracticeToolsModalOpen(false)}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}

        {readerLesson && (
          <LessonReaderPanel
            lesson={readerLesson}
            mediaLibrary={data.mediaLibrary}
            onClose={() => setReaderLessonId(null)}
            onPersistLesson={(patch) => {
              setData((prev) =>
                normalizeAppData({
                  ...prev,
                  lessons: prev.lessons.map((l) =>
                    l.id === readerLesson.id ? { ...l, ...patch, updatedAt: patch.updatedAt ?? nowIso() } : l,
                  ),
                }),
              );
              const slice = pickLessonPayloadCloudPatch(patch, nowIso());
              if (slice) scheduleLessonCloudFieldPatch(readerLesson.id, slice);
            }}
            onSaveVocab={(fields) => {
              setData((prev) => {
                const siblings = prev.vocabCards
                  .filter((c) => c.lessonId === readerLesson.id && c.term.trim() !== fields.term.trim())
                  .map((c) => c.term);
                const siblingZhs = prev.vocabCards
                  .filter((c) => c.lessonId === readerLesson.id && c.term.trim() !== fields.term.trim())
                  .map((c) => c.meanings[0]?.zh?.trim())
                  .filter((z): z is string => Boolean(z && z.length > 0));
                const card = createVocabCard({
                  lessonId: readerLesson.id,
                  term: fields.term,
                  kana: fields.kana,
                  zh: fields.zh,
                  etymology: fields.etymology,
                  lessonContent: readerLesson.content,
                  distractors: fields.distractors,
                  zhDistractors: fields.zhDistractors,
                  lessonSiblingTerms: siblings,
                  lessonSiblingZhs: siblingZhs,
                });
                setVocabDrillCompletedIds((prevDone) => {
                  if (!prevDone.has(card.id)) return prevDone;
                  const next = new Set(prevDone);
                  next.delete(card.id);
                  return next;
                });
                setVocabDrillProgressById((prevProg) => ({ ...prevProg, [card.id]: 0 }));
                return { ...prev, vocabCards: upsertVocabWithPolysemyReset(prev.vocabCards, card) };
              });
            }}
            chatMode={chatMode}
            onChatModeChange={setChatMode}
            chatTitle={chatTitle}
            onChatTitleChange={setChatTitle}
            chatInput={chatInput}
            onChatInputChange={setChatInput}
            chatBusy={chatBusySessionId === selectedChatId && selectedChatId.length > 0}
            selectedChatId={selectedChatId}
            onSelectChatId={setSelectedChatId}
            sessions={data.chatSessions.filter((session) => session.lessonId === readerLesson.id)}
            onSendChat={createOrReplyChat}
            onRenameSessionTo={renameSessionTo}
            onCreateNewEmptySession={() => createNewEmptyChatSession(readerLesson.id, chatMode)}
            onDeleteSession={deleteSession}
            onAddSentenceTask={(task: SentenceTask) => {
              setData((prev) => ({ ...prev, sentenceTasks: [task, ...prev.sentenceTasks] }));
            }}
            onAddGrammarTask={(task: GrammarTask) => {
              setData((prev) => ({ ...prev, grammarTasks: [task, ...prev.grammarTasks] }));
            }}
            onOpenVocabCard={(id) => {
              setSelectedVocabId(id);
            }}
            onOpenGrammarCard={(id) => {
              setSelectedGrammarId(id);
            }}
            vocabCards={data.vocabCards}
            grammarTasks={data.grammarTasks}
            sentenceTasks={data.sentenceTasks}
            lessonNotes={data.lessonNotes
              .filter((n) => n.lessonId === readerLesson.id)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))}
            favoriteSentences={data.favoriteSentences
              .filter((f) => f.lessonId === readerLesson.id)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))}
            onAddLessonNote={(payload) => addLessonNote({ lessonId: readerLesson.id, ...payload })}
            onUpdateLessonNote={updateLessonNote}
            onDeleteLessonNote={deleteLessonNote}
            onAddFavoriteSentence={(jp, zhHint, lineIndex) =>
              addFavoriteSentence({ lessonId: readerLesson.id, jp, zhHint, lineIndex })
            }
            onDeleteFavoriteSentence={deleteFavoriteSentence}
          />
        )}

        {portalReady &&
          selectedVocab &&
          typeof document !== "undefined" &&
          createPortal(
            <div
              className="fixed inset-0 z-[260] flex items-end justify-center bg-black/25 p-3 sm:items-center"
              role="dialog"
              aria-modal
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setSelectedVocabId("");
              }}
            >
              <div className="float-card max-h-[85vh] w-full max-w-lg overflow-auto p-6 shadow-2xl">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-lg font-black">单词本</h2>
                  <button type="button" className="sun-btn sun-btn--ghost !px-3 !py-1 text-sm" onClick={() => setSelectedVocabId("")}>
                    关闭
                  </button>
                </div>
                <div className="mt-4 flex flex-col gap-3 text-sm">
                  <label className="font-semibold">
                    日语
                    <input className="sun-input mt-1 w-full py-2 font-mono" value={vocabEditTerm} onChange={(e) => setVocabEditTerm(e.target.value)} />
                  </label>
                  <label className="font-semibold">
                    读音
                    <input className="sun-input mt-1 w-full py-2" value={vocabEditKana} onChange={(e) => setVocabEditKana(e.target.value)} />
                  </label>
                  <label className="font-semibold">
                    中文（第一条义项）
                    <input className="sun-input mt-1 w-full py-2" value={vocabEditZh} onChange={(e) => setVocabEditZh(e.target.value)} />
                  </label>
                  <label className="font-semibold">
                    例句
                    <textarea
                      className="sun-textarea mt-1 min-h-[5rem] w-full py-2"
                      value={vocabEditExample}
                      onChange={(e) => setVocabEditExample(e.target.value)}
                    />
                  </label>
                  <label className="font-semibold">
                    词源 / 备注
                    <textarea
                      className="sun-textarea mt-1 min-h-[4rem] w-full py-2"
                      value={vocabEditEtym}
                      onChange={(e) => setVocabEditEtym(e.target.value)}
                    />
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="sun-btn !px-3 !py-2 text-xs"
                      onClick={() => speakJapanese(vocabEditTerm.trim() || selectedVocab.term)}
                    >
                      朗读
                    </button>
                    <button
                      type="button"
                      className="sun-btn sun-btn--ghost !px-3 !py-2 text-xs"
                      disabled={vocabEditAiBusy || !vocabEditTerm.trim()}
                      onClick={() => {
                        void (async () => {
                          const t = vocabEditTerm.trim();
                          const ex = vocabEditExample.trim() || t;
                          const lesson = data.lessons.find((l) => l.id === selectedVocab.lessonId);
                          setVocabEditAiBusy(true);
                          try {
                            const r = await enrichVocabFields({
                              term: t,
                              exampleSegment: ex,
                              lessonTitle: lesson?.name,
                              lessonCategory: lesson?.category,
                            });
                            setVocabEditKana(r.kana);
                            setVocabEditZh(r.zh);
                            setVocabEditEtym(r.etymology);
                            if (r.exampleJp) setVocabEditExample(r.exampleJp);
                          } finally {
                            setVocabEditAiBusy(false);
                          }
                        })();
                      }}
                    >
                      {vocabEditAiBusy ? "AI 中…" : "重新 AI 补全"}
                    </button>
                    <button
                      type="button"
                      className="sun-btn !px-3 !py-2 text-xs"
                      disabled={!vocabEditTerm.trim()}
                      onClick={() => {
                        const t = vocabEditTerm.trim();
                        const k = vocabEditKana.trim();
                        const zh = vocabEditZh.trim();
                        if (!t || !zh) return;
                        const snap = dataRef.current;
                        const c0 = snap.vocabCards.find((x) => x.id === selectedVocab.id);
                        if (!c0) return;
                        const siblings = snap.vocabCards
                          .filter((x) => x.lessonId === c0.lessonId && x.id !== c0.id)
                          .map((x) => x.term.trim())
                          .filter(Boolean);
                        const siblingZhs = snap.vocabCards
                          .filter((x) => x.lessonId === c0.lessonId && x.id !== c0.id)
                          .map((x) => x.meanings[0]?.zh?.trim() ?? "")
                          .filter((z) => z.length > 0 && z !== zh);
                        const triple = finalizeVocabDistractors(t, undefined, siblings);
                        const tripleZh = finalizeVocabZhDistractors(zh, undefined, siblingZhs);
                        const ex = vocabEditExample.trim();
                        const at = nowIso();
                        const cloudPatch: VocabPayloadCloudPatch = {
                          term: t,
                          kana: k,
                          meanings: [{ zh, example: ex || zh }, ...c0.meanings.slice(1)],
                          latestExample: ex || c0.latestExample,
                          etymology: vocabEditEtym.trim(),
                          vocabDistractors: [...triple],
                          vocabZhDistractors: [...tripleZh],
                          updatedAt: at,
                        };
                        setData((prev) => {
                          const c1 = prev.vocabCards.find((x) => x.id === selectedVocab.id);
                          if (!c1) return prev;
                          const sib = prev.vocabCards
                            .filter((x) => x.lessonId === c1.lessonId && x.id !== c1.id)
                            .map((x) => x.term.trim())
                            .filter(Boolean);
                          const sibZh = prev.vocabCards
                            .filter((x) => x.lessonId === c1.lessonId && x.id !== c1.id)
                            .map((x) => x.meanings[0]?.zh?.trim() ?? "")
                            .filter((z) => z.length > 0 && z !== zh);
                          const tr = finalizeVocabDistractors(t, undefined, sib);
                          const trZh = finalizeVocabZhDistractors(zh, undefined, sibZh);
                          return {
                            ...prev,
                            vocabCards: prev.vocabCards.map((c) =>
                              c.id === selectedVocab.id
                                ? {
                                    ...c,
                                    term: t,
                                    kana: k,
                                    meanings: [{ zh, example: ex || zh }, ...c.meanings.slice(1)],
                                    latestExample: ex || c.latestExample,
                                    etymology: vocabEditEtym.trim(),
                                    vocabDistractors: [...tr],
                                    vocabZhDistractors: [...trZh],
                                    updatedAt: at,
                                  }
                                : c,
                            ),
                          };
                        });
                        scheduleVocabCloudFieldPatch(selectedVocab.id, cloudPatch);
                        setSelectedVocabId("");
                      }}
                    >
                      保存修改
                    </button>
                    <button
                      type="button"
                      className="sun-btn sun-btn--ghost !px-3 !py-2 text-xs text-rose-700"
                      onClick={() => removeVocabCardById(selectedVocab.id, selectedVocab.term)}
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      className="sun-btn sun-btn--ghost !px-3 !py-2 text-xs"
                      onClick={() => {
                        const lesson = data.lessons.find((item) => item.id === selectedVocab.lessonId);
                        if (lesson) {
                          setActiveLessonId(lesson.id);
                          setReaderLessonId(lesson.id);
                          setSelectedVocabId("");
                          setAppTab("lessons");
                        }
                      }}
                    >
                      去课文
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )}

        {portalReady &&
          selectedSentence &&
          typeof document !== "undefined" &&
          createPortal(
            <div
              className="fixed inset-0 z-[265] flex items-end justify-center bg-black/30 p-3 sm:items-center"
              role="dialog"
              aria-modal
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setSelectedSentenceId("");
              }}
            >
              <div className="float-card max-h-[90vh] w-full max-w-xl overflow-auto p-6 shadow-2xl">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-lg font-black">句子题详情</h2>
                  <button type="button" className="sun-btn sun-btn--ghost !px-3 !py-1 text-sm" onClick={() => setSelectedSentenceId("")}>
                    关闭
                  </button>
                </div>
                <div className="mt-3 space-y-3 text-[0.95rem] font-medium leading-relaxed text-[color:var(--sun-ink)]">
                  <p className="text-xs font-bold text-[color:var(--sun-accent)]">
                    类型：{selectedSentence.sourceType === "listening" ? "听力句子" : "翻译句子"}
                  </p>
                  <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
                    日语（保存后练习按此句判分）
                    <textarea
                      className="sun-textarea mt-1 min-h-[6rem] w-full resize-y py-3 text-base font-medium leading-relaxed text-[color:var(--sun-ink)]"
                      value={sentenceEditJp}
                      onChange={(e) => setSentenceEditJp(e.target.value)}
                    />
                  </label>
                  <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
                    {selectedSentence.sourceType === "listening" ? "中文题面 / 提示（听力题）" : "中文提示（翻译题）"}
                    <textarea
                      className="sun-textarea mt-1 min-h-[3rem] w-full resize-y py-3 text-base font-medium leading-relaxed text-[color:var(--sun-ink)]"
                      value={sentenceEditZh}
                      onChange={(e) => setSentenceEditZh(e.target.value)}
                    />
                  </label>
                  <label className="block rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-white/85 px-3 py-3">
                    <p className="text-xs font-black text-[color:var(--sun-muted)]">AI 句子讲解（知识点 + 语感体会）</p>
                    <textarea
                      className="sun-textarea mt-1 min-h-[8rem] w-full resize-y py-3 text-base font-medium leading-relaxed text-[color:var(--sun-ink)]"
                      placeholder="暂无"
                      value={sentenceEditNote}
                      onChange={(e) => setSentenceEditNote(e.target.value)}
                    />
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="sun-btn !px-3 !py-2 text-xs"
                      onClick={() => speakJapanese(sentenceEditJp.trim() || selectedSentence.jpAnswer)}
                    >
                      朗读句子
                    </button>
                    <button
                      type="button"
                      className="sun-btn !px-3 !py-2 text-xs"
                      disabled={!sentenceEditJp.trim()}
                      onClick={() => {
                        const id = selectedSentenceId;
                        const jp = sentenceEditJp.trim();
                        if (!jp) return;
                        const tokens = tokenizeSentenceForDrag(jp);
                        const cloudPatch: SentenceTaskPayloadCloudPatch = {
                          jpAnswer: jp,
                          tokens,
                          zh: sentenceEditZh,
                          teachingNote: sentenceEditNote.trim(),
                        };
                        setData((prev) => ({
                          ...prev,
                          sentenceTasks: prev.sentenceTasks.map((t) =>
                            t.id === id
                              ? {
                                  ...t,
                                  jpAnswer: jp,
                                  tokens,
                                  zh: sentenceEditZh,
                                  teachingNote: sentenceEditNote.trim() || undefined,
                                }
                              : t,
                          ),
                        }));
                        scheduleSentenceCloudFieldPatch(id, cloudPatch);
                        setSelectedSentenceId("");
                      }}
                    >
                      保存修改
                    </button>
                    <button
                      type="button"
                      className="sun-btn sun-btn--ghost !px-3 !py-2 text-xs text-rose-700"
                      onClick={() => removeSentenceTaskById(selectedSentence.id, selectedSentence.jpAnswer || selectedSentence.zh)}
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      className="sun-btn sun-btn--ghost !px-3 !py-2 text-xs"
                      onClick={() => {
                        setActiveLessonId(selectedSentence.lessonId);
                        setReaderLessonId(selectedSentence.lessonId);
                        setSelectedSentenceId("");
                        setAppTab("lessons");
                      }}
                    >
                      去课文
                    </button>
                  </div>
                  <p className="mt-3 text-[0.7rem] leading-relaxed text-[color:var(--sun-muted)]">
                    与词卡相同：点「保存修改」后写入本机并关闭；仅关闭则放弃未保存的改动。备份请用「数据」页导出。
                  </p>
                </div>
              </div>
            </div>,
            document.body,
          )}

        {portalReady &&
          selectedGrammar &&
          typeof document !== "undefined" &&
          createPortal(
            <div
              className="fixed inset-0 z-[270] flex items-end justify-center bg-black/30 p-3 sm:items-center"
              role="dialog"
              aria-modal
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setSelectedGrammarId("");
              }}
            >
              <div className="float-card max-h-[90vh] w-full max-w-xl overflow-auto p-6 shadow-2xl">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-lg font-black">语法题详情</h2>
                  <button type="button" className="sun-btn sun-btn--ghost !px-3 !py-1 text-sm" onClick={() => setSelectedGrammarId("")}>
                    关闭
                  </button>
                </div>
                <div className="mt-3 space-y-2 text-sm">
                  <label className="text-xs font-bold text-[color:var(--sun-muted)]">
                    题干
                    <textarea
                      className="sun-textarea mt-1 min-h-[3.5rem] w-full py-2 text-sm"
                      value={grammarEditPrompt}
                      onChange={(e) => setGrammarEditPrompt(e.target.value)}
                    />
                  </label>
                  <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
                    题干中译
                    <textarea
                      className="sun-textarea mt-1 min-h-[3rem] w-full py-2 text-sm"
                      value={grammarEditZhPrompt}
                      onChange={(e) => setGrammarEditZhPrompt(e.target.value)}
                    />
                  </label>
                  <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
                    知识点标签（可选）
                    <input
                      className="sun-input mt-1 w-full py-2 text-sm"
                      placeholder="如：助词は vs が"
                      value={grammarEditKnowledge}
                      onChange={(e) => setGrammarEditKnowledge(e.target.value)}
                    />
                  </label>
                  <div className="mt-2 rounded-2xl bg-amber-50/90 px-3 py-2 text-xs leading-relaxed text-[color:var(--sun-ink)]">
                    <p className="font-black">选项</p>
                    <ul className="mt-1 space-y-1">
                      {selectedGrammar.choices.map((c) => (
                        <li key={c.id}>
                          <span
                            className={clsx(
                              "inline-block rounded-full px-2 py-0.5 text-[0.7rem] font-semibold",
                              c.correct ? "bg-emerald-100 text-emerald-900" : "bg-white/80 text-[color:var(--sun-ink)]",
                            )}
                          >
                            {c.text}
                          </span>
                          {!c.correct && selectedGrammar.wrongReasonByChoiceId?.[c.id] && (
                            <span className="ml-2 text-[0.7rem] text-[color:var(--sun-muted)]">
                              {selectedGrammar.wrongReasonByChoiceId[c.id]}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="mt-2 rounded-2xl bg-white/90 px-3 py-2 text-xs leading-relaxed text-[color:var(--sun-ink)]">
                    <p className="font-black">详解</p>
                    <textarea
                      className="sun-textarea mt-1 min-h-[6rem] w-full py-2 text-sm"
                      value={grammarEditExplanation}
                      onChange={(e) => setGrammarEditExplanation(e.target.value)}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="sun-btn !px-3 !py-2 text-xs"
                      disabled={!grammarEditPrompt.trim()}
                      onClick={() => {
                        const gid = selectedGrammarId;
                        if (!grammarEditPrompt.trim()) return;
                        const cloudPatch: GrammarTaskPayloadCloudPatch = {
                          prompt: grammarEditPrompt,
                          zhPrompt: grammarEditZhPrompt.trim() || undefined,
                          knowledgePoint: grammarEditKnowledge.trim() || undefined,
                          explanation: grammarEditExplanation,
                        };
                        setData((prev) => ({
                          ...prev,
                          grammarTasks: prev.grammarTasks.map((g) =>
                            g.id === gid
                              ? {
                                  ...g,
                                  prompt: grammarEditPrompt,
                                  zhPrompt: grammarEditZhPrompt.trim() || undefined,
                                  knowledgePoint: grammarEditKnowledge.trim() || undefined,
                                  explanation: grammarEditExplanation,
                                }
                              : g,
                          ),
                        }));
                        scheduleGrammarCloudFieldPatch(gid, cloudPatch);
                        setSelectedGrammarId("");
                      }}
                    >
                      保存修改
                    </button>
                    <button
                      type="button"
                      className="sun-btn sun-btn--ghost !px-3 !py-2 text-xs text-rose-700"
                      onClick={() => removeGrammarTaskById(selectedGrammar.id, selectedGrammar.prompt)}
                    >
                      删除
                    </button>
                  </div>
                  <p className="mt-2 text-[0.7rem] leading-relaxed text-[color:var(--sun-muted)]">
                    与词卡相同：点「保存修改」后写入本机并关闭；仅关闭则放弃未保存的改动。选项与标答未在此编辑，需改请删题后重新出题。
                  </p>
                </div>
              </div>
            </div>,
            document.body,
          )}
      </main>
    </div>
  );
}
