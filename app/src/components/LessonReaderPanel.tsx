"use client";

import clsx from "clsx";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  enrichVocabFields,
  generateGrammarOptions,
  generateSentenceFromSelection,
  generateSentenceTeachingNote,
  requestLessonIllustration,
  translateParagraph,
} from "@/modules/ai/aiClient";
import { createGrammarTask, createSentenceTask } from "@/modules/learning/lessonService";
import { postYoutubeIframeCommand, toYoutubeIframeSrc } from "@/modules/lesson/youtubeEmbed";
import { resolveLessonCoverSrc, resolveLessonVideoSrc } from "@/modules/storage/mediaDedupe";
import type {
  AppData,
  ChatSession,
  GrammarTask,
  Lesson,
  LessonFavoriteSentence,
  LessonNote,
  PromptMode,
  SentenceTask,
  VocabCard,
} from "@/shared/types";
import { speakJapanese, stopJapaneseSpeech } from "@/shared/speech";
import {
  alignLineTranslations,
  buildGrammarPromptFromSelection,
  extractExampleSegmentForTerm,
  lessonAuthorDisplay,
  lessonAuthorForSave,
  lessonAuthorInputValue,
  lessonContentLines,
  nowIso,
  splitLessonIntoSentenceSpans,
  zhHintForSentenceSpan,
} from "@/shared/utils";

type LessonPersistPatch = Partial<
  Pick<
    Lesson,
    | "lineTranslations"
    | "translationVisible"
    | "name"
    | "content"
    | "category"
    | "author"
    | "updatedAt"
    | "coverIllustrationDataUrl"
    | "listeningAudioDataUrl"
    | "videoSourceUrl"
    | "videoCues"
  >
>;

type LessonReaderPanelProps = {
  lesson: Lesson;
  /** 与 `AppData.mediaLibrary` 一致，用于解析 `*MediaKey` 引用 */
  mediaLibrary?: AppData["mediaLibrary"];
  onClose: () => void;
  onPersistLesson: (patch: LessonPersistPatch) => void;
  onSaveVocab: (fields: {
    term: string;
    kana: string;
    zh: string;
    etymology: string;
    distractors?: string[];
    zhDistractors?: string[];
  }) => void;
  chatMode: PromptMode;
  onChatModeChange: (mode: PromptMode) => void;
  chatTitle: string;
  onChatTitleChange: (title: string) => void;
  chatInput: string;
  onChatInputChange: (text: string) => void;
  chatBusy: boolean;
  selectedChatId: string;
  onSelectChatId: (id: string) => void;
  sessions: ChatSession[];
  onSendChat: () => void | Promise<void>;
  onRenameSessionTo: (id: string, title: string) => void;
  onCreateNewEmptySession: () => void;
  onDeleteSession: (id: string) => void;
  onAddSentenceTask: (task: SentenceTask) => void;
  onAddGrammarTask: (task: GrammarTask) => void;
  onOpenVocabCard: (id: string) => void;
  onOpenGrammarCard: (id: string) => void;
  vocabCards: VocabCard[];
  grammarTasks: GrammarTask[];
  sentenceTasks: SentenceTask[];
  lessonNotes: LessonNote[];
  favoriteSentences: LessonFavoriteSentence[];
  onAddLessonNote: (payload: { content: string; title?: string; lineIndex?: number }) => void;
  onUpdateLessonNote: (id: string, content: string) => void;
  onDeleteLessonNote: (id: string) => void;
  onAddFavoriteSentence: (jp: string, zhHint: string | undefined, lineIndex: number) => void;
  onDeleteFavoriteSentence: (id: string) => void;
};

export function LessonReaderPanel({
  lesson,
  mediaLibrary,
  onClose,
  onPersistLesson,
  onSaveVocab,
  chatMode,
  onChatModeChange,
  chatTitle,
  onChatTitleChange,
  chatInput,
  onChatInputChange,
  chatBusy,
  selectedChatId,
  onSelectChatId,
  sessions,
  onSendChat,
  onRenameSessionTo,
  onCreateNewEmptySession,
  onDeleteSession,
  onAddSentenceTask,
  onAddGrammarTask,
  onOpenVocabCard,
  onOpenGrammarCard,
  vocabCards,
  grammarTasks,
  sentenceTasks,
  lessonNotes,
  favoriteSentences,
  onAddLessonNote,
  onUpdateLessonNote,
  onDeleteLessonNote,
  onAddFavoriteSentence,
  onDeleteFavoriteSentence,
}: LessonReaderPanelProps) {
  const coverSrc = useMemo(() => resolveLessonCoverSrc(lesson, mediaLibrary), [lesson, mediaLibrary]);
  const videoSrc = useMemo(() => resolveLessonVideoSrc(lesson, mediaLibrary), [lesson, mediaLibrary]);
  const youtubeIframeSrc = useMemo(() => toYoutubeIframeSrc(videoSrc), [videoSrc]);
  const useNativeVideoPlayer = Boolean(videoSrc && !youtubeIframeSrc);

  const normalizeChatPlainText = useCallback((raw: string) => {
    const text = String(raw ?? "");
    return text
      .replace(/```([\s\S]*?)```/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）")
      .replace(/\\([`*_#>\-[\]])/g, "$1")
      .replace(/[*#`]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }, []);

  const activeSession = useMemo(() => {
    if (!selectedChatId) return null;
    return sessions.find((s) => s.id === selectedChatId) ?? null;
  }, [sessions, selectedChatId]);

  const lines = useMemo(() => lessonContentLines(lesson.content), [lesson.content]);
  const lineZh = useMemo(() => alignLineTranslations(lesson.content, lesson.lineTranslations), [lesson.content, lesson.lineTranslations]);
  const compact = useCallback((s: string) => s.replace(/\s+/g, "").trim(), []);
  const lessonTermSet = useMemo(
    () =>
      new Set(
        vocabCards
          .filter((c) => c.lessonId === lesson.id)
          .map((c) => c.term.trim())
          .filter((t) => t.length >= 2),
      ),
    [lesson.id, vocabCards],
  );
  const otherTermSet = useMemo(
    () =>
      new Set(
        vocabCards
          .filter((c) => c.lessonId !== lesson.id)
          .map((c) => c.term.trim())
          .filter((t) => t.length >= 2 && !lessonTermSet.has(t)),
      ),
    [lesson.id, lessonTermSet, vocabCards],
  );
  const termCardByTerm = useMemo(() => {
    const m = new Map<string, VocabCard>();
    for (const c of vocabCards) {
      const t = c.term.trim();
      if (!t) continue;
      const prev = m.get(t);
      if (!prev || (prev.lessonId !== lesson.id && c.lessonId === lesson.id)) {
        m.set(t, c);
      }
    }
    return m;
  }, [lesson.id, vocabCards]);
  const sortedTerms = useMemo(
    () =>
      [...lessonTermSet, ...otherTermSet]
        .sort((a, b) => b.length - a.length)
        .slice(0, 140),
    [lessonTermSet, otherTermSet],
  );
  const termRegex = useMemo(() => {
    if (!sortedTerms.length) return null;
    const escaped = sortedTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`(${escaped.join("|")})`, "g");
  }, [sortedTerms]);
  const lessonGrammarKeys = useMemo(
    () =>
      grammarTasks
        .filter((g) => g.lessonId === lesson.id)
        .map((g) => compact(g.prompt.replace(/___/g, "")))
        .filter((k) => k.length >= 2),
    [compact, grammarTasks, lesson.id],
  );
  const otherGrammarKeys = useMemo(
    () =>
      grammarTasks
        .filter((g) => g.lessonId !== lesson.id)
        .map((g) => compact(g.prompt.replace(/___/g, "")))
        .filter((k) => k.length >= 2),
    [compact, grammarTasks, lesson.id],
  );
  const lessonSentenceKeys = useMemo(
    () =>
      sentenceTasks
        .filter((s) => s.lessonId === lesson.id)
        .map((s) => compact(s.jpAnswer))
        .filter((k) => k.length >= 3),
    [compact, lesson.id, sentenceTasks],
  );
  const otherSentenceKeys = useMemo(
    () =>
      sentenceTasks
        .filter((s) => s.lessonId !== lesson.id)
        .map((s) => compact(s.jpAnswer))
        .filter((k) => k.length >= 3),
    [compact, lesson.id, sentenceTasks],
  );
  const translationShown = lesson.translationVisible !== false;
  const [mounted, setMounted] = useState(false);
  const [translateAllBusy, setTranslateAllBusy] = useState(false);
  const [translateProgress, setTranslateProgress] = useState("");
  const [coverIllustrationBusy, setCoverIllustrationBusy] = useState(false);
  const [illustrationTip, setIllustrationTip] = useState("");
  const illustrationTipClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [notesModalOpen, setNotesModalOpen] = useState(false);
  /** list：只读列表；detail：单条阅读；compose：仅划选后新建 */
  const [notesSheet, setNotesSheet] = useState<"list" | "detail" | "compose">("list");
  const [notesDetailId, setNotesDetailId] = useState<string | null>(null);
  const [newNoteContent, setNewNoteContent] = useState("");
  const [newNoteTitle, setNewNoteTitle] = useState("");
  const [newNoteLineIndex, setNewNoteLineIndex] = useState<number | undefined>(undefined);
  const [notesFilterLineIndex, setNotesFilterLineIndex] = useState<number | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteContent, setEditingNoteContent] = useState("");
  const [flashLineIndex, setFlashLineIndex] = useState<number | null>(null);
  const lineFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    return () => {
      if (lineFlashTimerRef.current) clearTimeout(lineFlashTimerRef.current);
    };
  }, []);

  const scrollToFavoriteLine = useCallback((lineIndex: number | undefined) => {
    if (lineIndex == null || lineIndex < 0) return;
    const el = document.getElementById(`lesson-line-${lineIndex}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (lineFlashTimerRef.current) clearTimeout(lineFlashTimerRef.current);
    setFlashLineIndex(lineIndex);
    lineFlashTimerRef.current = setTimeout(() => setFlashLineIndex(null), 2200);
  }, []);

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editAuthor, setEditAuthor] = useState("");
  const [editContent, setEditContent] = useState("");

  const [selectionBar, setSelectionBar] = useState<{ text: string; lineIndex?: number } | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [sessionRenameDraft, setSessionRenameDraft] = useState("");
  /** 划选建词：后台 AI + 自动入库，不弹编辑层 */
  const [vocabBuildStatus, setVocabBuildStatus] = useState<{
    phase: "busy" | "done" | "error";
    term: string;
    message: string;
  } | null>(null);
  const vocabImportAliveRef = useRef(true);
  const [sentenceDraft, setSentenceDraft] = useState<{
    jpFragment: string;
    zh: string;
    jpAnswer: string;
    busy: boolean;
  } | null>(null);
  const [grammarDraft, setGrammarDraft] = useState<{
    sourceSentence: string;
    prompt: string;
    knowledgePoint: string;
    busy: boolean;
    ai: Awaited<ReturnType<typeof generateGrammarOptions>> | null;
  } | null>(null);

  const sentenceSpans = useMemo(() => splitLessonIntoSentenceSpans(lesson.content), [lesson.content]);
  const notesByLine = useMemo(() => {
    const m = new Map<number, LessonNote[]>();
    for (const n of lessonNotes) {
      if (n.lineIndex == null || n.lineIndex < 0) continue;
      const arr = m.get(n.lineIndex) ?? [];
      arr.push(n);
      m.set(n.lineIndex, arr);
    }
    return m;
  }, [lessonNotes]);
  const visibleNotes = useMemo(
    () => (notesFilterLineIndex == null ? lessonNotes : lessonNotes.filter((n) => n.lineIndex === notesFilterLineIndex)),
    [lessonNotes, notesFilterLineIndex],
  );
  const readSentences = useMemo(() => sentenceSpans.map((s) => s.jp), [sentenceSpans]);
  const readSentencesRef = useRef(readSentences);
  readSentencesRef.current = readSentences;
  const readGenRef = useRef(0);
  const [lessonViewMode, setLessonViewMode] = useState<"read" | "follow">("read");
  const [activeReadIdx, setActiveReadIdx] = useState<number | null>(null);
  const [autoChainRead, setAutoChainRead] = useState(true);
  const [videoPlaybackRate, setVideoPlaybackRate] = useState(1);
  const [listeningBatchTip, setListeningBatchTip] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const youtubeIframeRef = useRef<HTMLIFrameElement>(null);
  const [videoTip, setVideoTip] = useState("");

  function bumpReadGenAndSpeak(text: string) {
    readGenRef.current += 1;
    speakJapanese(text);
  }

  const stopLessonReading = useCallback(() => {
    readGenRef.current += 1;
    stopJapaneseSpeech();
    if (videoRef.current) {
      videoRef.current.pause();
    }
    postYoutubeIframeCommand(youtubeIframeRef.current, "pauseVideo");
    setActiveReadIdx(null);
  }, []);

  /* 仅依赖 ref，避免课文切换时闭包陈旧 */
  const startReadingFrom = useCallback((startIdx: number, chain: boolean) => {
    readGenRef.current += 1;
    const gen = readGenRef.current;
    stopJapaneseSpeech();
    const list = readSentencesRef.current;
    if (startIdx < 0 || startIdx >= list.length) return;

    const playOne = (idx: number) => {
      if (gen !== readGenRef.current) return;
      const listNow = readSentencesRef.current;
      if (idx < 0 || idx >= listNow.length) {
        setActiveReadIdx(null);
        return;
      }
      const raw = listNow[idx] ?? "";
      const text = raw.length > 450 ? `${raw.slice(0, 450)}…` : raw;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP";
      u.rate = 0.92;
      u.onend = () => {
        if (gen !== readGenRef.current) return;
        if (chain && idx + 1 < listNow.length) {
          playOne(idx + 1);
        } else {
          setActiveReadIdx(null);
        }
      };
      u.onerror = () => {
        if (gen === readGenRef.current) setActiveReadIdx(null);
      };
      setActiveReadIdx(idx);
      window.speechSynthesis.speak(u);
    };
    playOne(startIdx);
  }, []);

  function downloadReadSentencesTxt() {
    const body = readSentences.join("\n");
    const safe = lesson.name.replace(/[/\\:*?"<>|]/g, "_").slice(0, 80) || "lesson";
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safe}-分句.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function seekVideoToCue(idx: number) {
    const cues = lesson.videoCues ?? [];
    const cue = cues[idx];
    if (!cue) return;
    const ysrc = toYoutubeIframeSrc(videoSrc);
    if (ysrc && youtubeIframeRef.current) {
      postYoutubeIframeCommand(youtubeIframeRef.current, "seekTo", [Math.max(0, cue.startSec + 0.01), true]);
      postYoutubeIframeCommand(youtubeIframeRef.current, "playVideo");
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, cue.startSec + 0.01);
    void v.play().catch(() => undefined);
  }

  function onFollowSentenceClick(i: number) {
    if (videoSrc) {
      setActiveReadIdx(i);
      if ((lesson.videoCues?.length ?? 0) > i) {
        seekVideoToCue(i);
      } else {
        setVideoTip("该视频未配置对应字幕分段，已仅高亮句卡。可回到「导入新课文」里补充字幕 txt。");
      }
      return;
    }
    startReadingFrom(i, autoChainRead);
  }

  function openListeningSentenceFromSelection() {
    if (!selectionBar?.text.trim()) return;
    const jp = selectionBar.text.trim();
    if (jp.length < 2) return;
    const existing = new Set(
      sentenceTasks
        .filter((s) => s.lessonId === lesson.id)
        .filter((s) => s.sourceType === "listening")
        .map((s) => compact(s.jpAnswer)),
    );
    const key = compact(jp);
    if (existing.has(key)) {
      setListeningBatchTip("该句已存在听力题，已跳过。");
      setSelectionBar(null);
      window.getSelection()?.removeAllRanges();
      return;
    }
    const task = createSentenceTask({
      lessonId: lesson.id,
      sourceType: "listening",
      zh: "听写题：请根据音频写出该句",
      jpAnswer: jp,
    });
    onAddSentenceTask(task);
    setListeningBatchTip("已新增 1 条听力句子题。");
    setSelectionBar(null);
    window.getSelection()?.removeAllRanges();
  }

  useEffect(() => {
    if (activeReadIdx === null) return;
    const el = document.getElementById(`lesson-read-row-${activeReadIdx}`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeReadIdx]);

  useEffect(() => {
    if (!useNativeVideoPlayer) return;
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = videoPlaybackRate;
  }, [videoPlaybackRate, videoSrc, useNativeVideoPlayer]);

  useEffect(() => {
    if (!useNativeVideoPlayer) return;
    const v = videoRef.current;
    if (!v) return;
    const cues = lesson.videoCues ?? [];
    if (!videoSrc || cues.length === 0) return;
    const onTime = () => {
      const t = v.currentTime;
      const idx = cues.findIndex((c) => t >= c.startSec && t < c.endSec);
      if (idx >= 0) setActiveReadIdx(idx);
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [videoSrc, lesson.videoCues, useNativeVideoPlayer]);

  useEffect(() => {
    return () => {
      stopJapaneseSpeech();
    };
  }, []);

  useEffect(() => {
    vocabImportAliveRef.current = true;
    return () => {
      vocabImportAliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    setVocabBuildStatus(null);
  }, [lesson.id]);

  useEffect(() => {
    setIllustrationTip("");
    if (illustrationTipClearRef.current) {
      clearTimeout(illustrationTipClearRef.current);
      illustrationTipClearRef.current = null;
    }
  }, [lesson.id]);

  useEffect(() => {
    return () => {
      if (illustrationTipClearRef.current) clearTimeout(illustrationTipClearRef.current);
    };
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select")) return;
      if (sentenceDraft) {
        setSentenceDraft(null);
        return;
      }
      if (grammarDraft) {
        setGrammarDraft(null);
        return;
      }
      if (notesModalOpen) {
        if (notesSheet === "detail") {
          setNotesSheet("list");
          setNotesDetailId(null);
          return;
        }
        if (notesSheet === "compose") {
          setNotesSheet("list");
          return;
        }
        setNotesModalOpen(false);
        setNotesSheet("list");
        setNotesDetailId(null);
        return;
      }
      if (editOpen) {
        setEditOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editOpen, sentenceDraft, grammarDraft, notesModalOpen, notesSheet]);

  function openEditLesson() {
    setEditName(lesson.name);
    setEditCategory(lesson.category);
    setEditAuthor(lessonAuthorInputValue(lesson.author));
    setEditContent(lesson.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
    setEditOpen(true);
  }

  function saveEditLesson() {
    const raw = editContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!editName.trim() || !/\S/.test(raw)) return;
    const nextTranslations = alignLineTranslations(raw, lesson.lineTranslations);
    onPersistLesson({
      name: editName.trim(),
      category: editCategory.trim() || "未分类",
      author: lessonAuthorForSave(editAuthor),
      content: raw,
      lineTranslations: nextTranslations,
      updatedAt: nowIso(),
    });
    setEditOpen(false);
  }

  const refreshSelection = useCallback(() => {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.isCollapsed) {
      setSelectionBar(null);
      return;
    }
    const root = articleRef.current;
    const title = titleRef.current;
    const anchor = sel.anchorNode as Node | null;
    const focus = sel.focusNode as Node | null;
    const inTitle = Boolean(title && anchor && focus && title.contains(anchor) && title.contains(focus));
    const inArticle = Boolean(root && anchor && focus && root.contains(anchor) && root.contains(focus));
    if (!inTitle && !inArticle) {
      setSelectionBar(null);
      return;
    }
    const anchorEl = (anchor instanceof HTMLElement ? anchor : anchor?.parentElement) as HTMLElement | null;
    const focusEl = (focus instanceof HTMLElement ? focus : focus?.parentElement) as HTMLElement | null;
    const anchorScope = anchorEl?.closest?.("[data-lesson-selectable='1']");
    const focusScope = focusEl?.closest?.("[data-lesson-selectable='1']");
    if (!anchorScope || !focusScope) {
      setSelectionBar(null);
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 1) {
      setSelectionBar(null);
      return;
    }
    let lineIndex: number | undefined;
    if (inArticle) {
      const lineEl = anchorScope?.closest?.("[data-lesson-line-index]") as HTMLElement | null;
      const raw = lineEl?.dataset?.lessonLineIndex;
      if (raw !== undefined && raw !== "") {
        const n = Number.parseInt(raw, 10);
        if (!Number.isNaN(n)) lineIndex = n;
      }
    }
    setSelectionBar({ text, lineIndex });
  }, []);

  function buildIllustrationThemeHint(zhLines: string[]) {
    const jpSample = lines
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(" ")
      .slice(0, 420);
    const zhSample = zhLines
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(" ")
      .slice(0, 420);
    return [`分类：${lesson.category}`, jpSample ? `【课文摘录】${jpSample}` : "", zhSample ? `【参考译文】${zhSample}` : ""]
      .filter(Boolean)
      .join("\n");
  }

  function flashIllustrationTip(message: string) {
    if (illustrationTipClearRef.current) {
      clearTimeout(illustrationTipClearRef.current);
    }
    setIllustrationTip(message);
    illustrationTipClearRef.current = setTimeout(() => {
      setIllustrationTip("");
      illustrationTipClearRef.current = null;
    }, 10000);
  }

  async function persistCoverIllustrationFromZhLines(zhLines: string[]): Promise<
    { kind: "ok" } | { kind: "skipped"; message: string } | { kind: "fail"; message: string }
  > {
    const themeHint = buildIllustrationThemeHint(zhLines);
    const ill = await requestLessonIllustration({ title: lesson.name, themeHint });
    if ("dataUrl" in ill && ill.dataUrl) {
      onPersistLesson({ coverIllustrationDataUrl: ill.dataUrl, updatedAt: nowIso() });
      return { kind: "ok" };
    }
    if ("skipped" in ill && ill.skipped) {
      return { kind: "skipped", message: ill.message || "未配置文生图密钥。" };
    }
    const detail = "detail" in ill ? ill.detail : undefined;
    const err = "error" in ill ? ill.error : undefined;
    const msg = [err, detail].filter(Boolean).join(" — ").trim() || "接口未返回图片数据";
    return { kind: "fail", message: msg.slice(0, 420) };
  }

  async function runCoverIllustrationOnly() {
    if (coverIllustrationBusy || translateAllBusy) return;
    setCoverIllustrationBusy(true);
    try {
      const zhLines = alignLineTranslations(lesson.content, lesson.lineTranslations);
      const outcome = await persistCoverIllustrationFromZhLines(zhLines);
      if (outcome.kind === "ok") {
        flashIllustrationTip("配图已生成并保存（阅读区上方可见）。");
      } else if (outcome.kind === "skipped") {
        flashIllustrationTip(outcome.message);
      } else {
        flashIllustrationTip(`配图失败：${outcome.message}`);
      }
    } catch (e) {
      flashIllustrationTip(`配图请求异常：${String((e as Error)?.message || e).slice(0, 320)}`);
    } finally {
      setCoverIllustrationBusy(false);
    }
  }

  async function runTranslateAll() {
    if (translateAllBusy) return;
    setTranslateAllBusy(true);
    let arr = alignLineTranslations(lesson.content, lesson.lineTranslations);
    try {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (!line.trim()) {
          arr[i] = "";
          onPersistLesson({ lineTranslations: [...arr] });
          continue;
        }
        setTranslateProgress(`全译进度 ${i + 1}/${lines.length}`);
        const zh = (await translateParagraph(line)).trim();
        arr = alignLineTranslations(lesson.content, arr);
        arr[i] = zh;
        onPersistLesson({ lineTranslations: [...arr] });
      }
    } finally {
      setTranslateProgress("");
      setTranslateAllBusy(false);
    }
  }

  function toggleTranslationLayer() {
    if (translationShown) {
      onPersistLesson({ translationVisible: false });
    } else {
      onPersistLesson({ translationVisible: true });
    }
  }

  function renderHighlightedLine(line: string) {
    if (!termRegex) return line;
    const parts = line.split(termRegex);
    return parts.map((chunk, idx) => {
      if (!chunk) return null;
      if (lessonTermSet.has(chunk)) {
        const card = termCardByTerm.get(chunk);
        return (
          <button
            key={`mark_l_${idx}_${chunk}`}
            type="button"
            className="cursor-pointer rounded-sm bg-rose-100/95 px-0.5 py-0.5 font-bold text-rose-700 hover:bg-rose-200/90"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              if (card) onOpenVocabCard(card.id);
            }}
          >
            {chunk}
          </button>
        );
      }
      if (otherTermSet.has(chunk)) {
        const card = termCardByTerm.get(chunk);
        return (
          <button
            key={`mark_o_${idx}_${chunk}`}
            type="button"
            className="cursor-pointer rounded-sm bg-sky-100/95 px-0.5 py-0.5 font-semibold text-sky-700 hover:bg-sky-200/90"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              if (card) onOpenVocabCard(card.id);
            }}
          >
            {chunk}
          </button>
        );
      }
      return <span key={`txt_${idx}`}>{chunk}</span>;
    });
  }

  function lineTaskHint(line: string) {
    const k = compact(line);
    if (!k) return { ownGrammar: false, otherGrammar: false, ownSentence: false, otherSentence: false };
    const hasOwnGrammar = lessonGrammarKeys.some((x) => x && (k.includes(x) || x.includes(k)));
    const hasOtherGrammar = otherGrammarKeys.some((x) => x && (k.includes(x) || x.includes(k)));
    const hasOwnSentence = lessonSentenceKeys.some((x) => x && (k.includes(x) || x.includes(k)));
    const hasOtherSentence = otherSentenceKeys.some((x) => x && (k.includes(x) || x.includes(k)));
    return { ownGrammar: hasOwnGrammar, otherGrammar: hasOtherGrammar, ownSentence: hasOwnSentence, otherSentence: hasOtherSentence };
  }

  function firstGrammarIdInLine(line: string): string | null {
    const k = compact(line);
    if (!k) return null;
    const match = (prompt: string) => {
      const clue = compact(prompt.replace(/___/g, ""));
      if (!clue || clue.length < 2) return false;
      // 更宽松：允许包含反向与部分重叠，减少“语法线索却点出词卡”的情况
      return k.includes(clue) || clue.includes(k);
    };

    const own = grammarTasks.find((g) => g.lessonId === lesson.id && match(g.prompt));
    if (own) return own.id;
    const other = grammarTasks.find((g) => g.lessonId !== lesson.id && match(g.prompt));
    return other ? other.id : null;
  }

  async function enqueueVocabFromSelection() {
    if (!selectionBar) return;
    const term = selectionBar.text.trim();
    if (!term) return;
    if (vocabBuildStatus?.phase === "busy") return;
    const lessonIdAtStart = lesson.id;
    setSelectionBar(null);
    window.getSelection()?.removeAllRanges();
    setVocabBuildStatus({ phase: "busy", term, message: `「${term}」：正在请求 AI 并写入词卡…` });
    try {
      const example = extractExampleSegmentForTerm(lesson.content, term) || term;
      const enriched = await enrichVocabFields({
        term,
        exampleSegment: example,
        lessonTitle: lesson.name,
        lessonCategory: lesson.category,
      });
      if (!vocabImportAliveRef.current || lesson.id !== lessonIdAtStart) {
        setVocabBuildStatus(null);
        return;
      }
      onSaveVocab({
        term,
        kana: enriched.kana.trim() || "—",
        zh: enriched.zh.trim() || "—",
        etymology: enriched.etymology.trim() || "—",
        distractors: enriched.distractors,
        zhDistractors: enriched.zhDistractors,
      });
      if (!vocabImportAliveRef.current) return;
      setVocabBuildStatus({
        phase: "done",
        term,
        message: `「${term}」已加入单词本～假名和释义都帮你填好啦，去「单词」看看要不要微调。`,
      });
    } catch {
      if (vocabImportAliveRef.current) {
        setVocabBuildStatus({
          phase: "error",
          term,
          message: `「${term}」：加入失败（网络或服务异常）。可稍后重试划选。`,
        });
      }
    }
  }

  function runSentenceAiForFragment(jp: string) {
    setSentenceDraft({ jpFragment: jp, zh: "", jpAnswer: "", busy: true });
    void generateSentenceFromSelection(jp)
      .then((out) => {
        setSentenceDraft((d) => (d && d.jpFragment === jp ? { ...d, zh: out.zh, jpAnswer: out.jpAnswer, busy: false } : d));
      })
      .catch(() => {
        setSentenceDraft((d) => (d && d.jpFragment === jp ? { ...d, zh: "", jpAnswer: jp, busy: false } : d));
      });
  }

  function openSentenceFromSelection() {
    if (!selectionBar?.text.trim()) return;
    const jp = selectionBar.text.trim();
    if (jp.length < 2) return;
    setSelectionBar(null);
    window.getSelection()?.removeAllRanges();
    runSentenceAiForFragment(jp);
  }

  function rerunSentenceAi() {
    if (!sentenceDraft) return;
    runSentenceAiForFragment(sentenceDraft.jpFragment);
  }

  async function submitSentenceDraft() {
    if (!sentenceDraft || sentenceDraft.busy) return;
    const zh = sentenceDraft.zh.trim();
    const jpAnswer = sentenceDraft.jpAnswer.trim();
    if (!zh || !jpAnswer) return;
    const teachingNote = await generateSentenceTeachingNote({ jp: jpAnswer, zh });
    const task = createSentenceTask({ lessonId: lesson.id, zh, jpAnswer, teachingNote });
    onAddSentenceTask(task);
    setSentenceDraft(null);
  }

  function openGrammarFromSelection() {
    if (!selectionBar?.text.trim()) return;
    const raw = selectionBar.text.trim();
    setSelectionBar(null);
    window.getSelection()?.removeAllRanges();
    const auto = buildGrammarPromptFromSelection(lesson.content, raw);
    const prompt = auto ?? raw;
    setGrammarDraft({ sourceSentence: raw, prompt, knowledgePoint: "", busy: false, ai: null });
  }

  function openFavoriteFromSelection() {
    if (!selectionBar?.text.trim()) return;
    if (selectionBar.lineIndex === undefined) return;
    const jp = selectionBar.text.trim();
    const zh = lineZh[selectionBar.lineIndex]?.trim();
    onAddFavoriteSentence(jp, zh || undefined, selectionBar.lineIndex);
    setSelectionBar(null);
    window.getSelection()?.removeAllRanges();
  }

  function openBookmarkNoteFromSelection() {
    if (!selectionBar?.text.trim()) return;
    const text = selectionBar.text.trim();
    setNewNoteTitle(text.length > 24 ? `${text.slice(0, 24)}…` : text);
    setNewNoteContent(text);
    setNewNoteLineIndex(selectionBar.lineIndex);
    setNotesFilterLineIndex(selectionBar.lineIndex ?? null);
    setNotesSheet("compose");
    setNotesDetailId(null);
    setNotesModalOpen(true);
    setSelectionBar(null);
    window.getSelection()?.removeAllRanges();
  }

  async function runGrammarAi() {
    if (!grammarDraft?.prompt.trim()) return;
    const prompt = grammarDraft.prompt.trim();
    const kp = grammarDraft.knowledgePoint.trim() || undefined;
    setGrammarDraft((d) => (d ? { ...d, busy: true } : d));
    try {
      const ai = await generateGrammarOptions({ prompt, knowledgePoint: kp });
      setGrammarDraft((d) => (d ? { ...d, ai, busy: false } : null));
    } catch {
      setGrammarDraft((d) => (d ? { ...d, busy: false } : null));
    }
  }

  function commitGrammarTask() {
    if (!grammarDraft || !grammarDraft.ai) return;
    const { sourceSentence, prompt, knowledgePoint, ai } = grammarDraft;
    const task = createGrammarTask({
      lessonId: lesson.id,
      sourceSentence,
      prompt: prompt.trim(),
      zhPrompt: ai.zhPrompt,
      choices: ai.choices,
      answerIndex: ai.answerIndex,
      explanation: ai.explanation,
      wrongReasons: ai.wrongReasons,
      knowledgePoint: knowledgePoint.trim() || undefined,
    });
    onAddGrammarTask(task);
    setGrammarDraft(null);
  }

  const hasAnyTranslation = lineZh.some((s) => s.trim().length > 0);
  const showLineZh = translationShown;
  const shellWide =
    "mx-auto w-full max-w-[min(100%,100vw-1.25rem)] sm:max-w-[min(100%,38rem)] md:max-w-[56rem] lg:max-w-[min(100%,64rem)]";

  const shell = (
    <div
      className="lesson-reader-portal fixed inset-0 z-[200] flex min-h-0 touch-manipulation flex-col bg-[color:var(--sun-cream)] text-[color:var(--sun-ink)] shadow-[0_0_0_1px_rgba(0,0,0,0.04)]"
      role="dialog"
      aria-modal
      aria-label="课文阅读"
    >
      <header className="relative z-[210] shrink-0 border-b border-[color-mix(in_srgb,var(--sun-warm)_50%,transparent)] bg-[color-mix(in_srgb,var(--sun-surface)_92%,transparent)] px-3 pb-3 pt-[max(0.65rem,env(safe-area-inset-top))] backdrop-blur-md md:px-6">
        <div className={clsx(shellWide, "flex flex-col gap-3")}>
          <div className="flex items-start gap-2">
            <button
              type="button"
              className="sun-btn sun-btn--ghost shrink-0 !min-h-[48px] !px-4 !py-3 text-base font-bold"
              onClick={onClose}
            >
              ← 返回
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-wide text-[color:var(--sun-accent)]">{lesson.category}</p>
              <h1
                ref={titleRef}
                data-lesson-selectable="1"
                onMouseUp={refreshSelection}
                onTouchEnd={refreshSelection}
                className="select-text text-xl font-black leading-tight md:text-2xl"
              >
                {lesson.name}
              </h1>
              <p className="mt-1 text-xs text-[color:var(--sun-muted)]">作者：{lessonAuthorDisplay(lesson.author)}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="sun-btn !min-h-[44px] !px-4 !py-2.5 text-sm font-bold disabled:cursor-wait disabled:opacity-70"
              disabled={translateAllBusy}
              onClick={() => void runTranslateAll()}
            >
              {translateAllBusy ? translateProgress || "翻译中…" : "全文翻译"}
            </button>
            <button
              type="button"
              className={clsx("sun-btn sun-btn--ghost !min-h-[44px] !px-4 !py-2.5 text-sm font-semibold", !hasAnyTranslation && "pointer-events-none opacity-45")}
              disabled={!hasAnyTranslation}
              onClick={toggleTranslationLayer}
            >
              {translationShown ? "显示译文" : "隐藏译文"}
            </button>
            <button
              type="button"
              className="sun-btn sun-btn--ghost !min-h-[44px] !px-4 !py-2.5 text-sm font-semibold"
              onClick={() => setLessonViewMode((m) => (m === "read" ? "follow" : "read"))}
            >
              {lessonViewMode === "read" ? "阅读模式" : "逐句跟读"}
            </button>
          </div>

          <div className="-mx-1 flex max-w-[100vw] gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch] px-1">
            <button type="button" className="sun-btn sun-btn--ghost shrink-0 !min-h-[40px] !px-3 !py-2 text-xs" onClick={openEditLesson}>
              编辑内容
            </button>
            <button
              type="button"
              className="sun-btn sun-btn--ghost shrink-0 !min-h-[40px] !px-3 !py-2 text-xs disabled:cursor-wait disabled:opacity-65"
              disabled={coverIllustrationBusy || translateAllBusy}
              title="建议先有译文再配图，效果更贴课文～"
              onClick={() => void runCoverIllustrationOnly()}
            >
              {coverIllustrationBusy ? "配图生成中…" : "生成配图"}
            </button>
            <button
              type="button"
              className="sun-btn sun-btn--ghost shrink-0 !min-h-[40px] !px-3 !py-2 text-xs"
              onClick={() => {
                setNotesSheet("list");
                setNotesDetailId(null);
                setNotesModalOpen(true);
              }}
            >
              笔记
            </button>
            <button
              type="button"
              className={clsx("sun-btn shrink-0 !min-h-[40px] !px-3 !py-2 text-xs", chatOpen && "chip--active")}
              onClick={() => setChatOpen((v) => !v)}
            >
              {chatOpen ? "收起练习区" : "跟读对话"}
            </button>
          </div>
          <p className="text-[0.7rem] text-[color:var(--sun-muted)]">选中句子就能收藏、出题、发音或写笔记哦～</p>
          {listeningBatchTip ? <p className="text-[0.7rem] text-teal-900">{listeningBatchTip}</p> : null}
          {videoTip ? <p className="text-[0.7rem] text-sky-900">{videoTip}</p> : null}
          {illustrationTip ? (
            <p className="mt-1.5 text-[0.72rem] leading-relaxed text-teal-900" role="status">
              {illustrationTip}
            </p>
          ) : null}
        </div>
      </header>

      {vocabBuildStatus && (
        <div className={clsx(shellWide, "mx-auto shrink-0 px-3 pt-2 md:px-6")}>
          <div
            role="status"
            aria-live="polite"
            className={clsx(
              "flex items-start justify-between gap-2 rounded-xl border px-3 py-2.5 text-sm",
              vocabBuildStatus.phase === "busy" && "border-amber-300/80 bg-amber-50/95 text-amber-950",
              vocabBuildStatus.phase === "done" && "border-teal-300/80 bg-teal-50/95 text-teal-950",
              vocabBuildStatus.phase === "error" && "border-rose-300/80 bg-rose-50/95 text-rose-950",
            )}
          >
            <p className="min-w-0 flex-1 leading-relaxed">{vocabBuildStatus.message}</p>
            {vocabBuildStatus.phase !== "busy" && (
              <button type="button" className="shrink-0 text-xs font-bold text-[color:var(--sun-ink)] underline" onClick={() => setVocabBuildStatus(null)}>
                关闭
              </button>
            )}
          </div>
        </div>
      )}

      <div
        className={clsx(
          "relative z-[205] flex min-h-0 flex-1 flex-col overflow-hidden px-3 pt-3 md:px-6",
          selectionBar
            ? "pb-[max(7rem,env(safe-area-inset-bottom))]"
            : "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
          shellWide,
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
          {/* 阅读内容 */}
          {lessonViewMode === "follow" && (
            <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_50%,transparent)] bg-white/85 px-3 py-3 shadow-sm sm:px-4">
              <h3 className="text-sm font-black text-[color:var(--sun-ink)]">逐句跟读</h3>
              <p className="mt-1 text-[0.65rem] text-[color:var(--sun-muted)]">点句子就能播放发音啦～</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="sun-btn !min-h-[40px] !px-3 !py-2 text-xs"
                  disabled={readSentences.length === 0}
                  onClick={() => startReadingFrom(0, autoChainRead)}
                >
                  从头播放
                </button>
                <button type="button" className="sun-btn sun-btn--ghost !min-h-[40px] !px-3 !py-2 text-xs" onClick={stopLessonReading}>
                  暂停
                </button>
                <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-[color:var(--sun-muted)]">
                  <input
                    type="checkbox"
                    checked={autoChainRead}
                    onChange={(e) => setAutoChainRead(e.target.checked)}
                    className="h-4 w-4 accent-amber-700"
                  />
                  自动下一句
                </label>
                {useNativeVideoPlayer ? (
                  <label className="flex items-center gap-2 text-xs font-semibold text-[color:var(--sun-muted)]">
                    倍速
                    <select
                      className="sun-select min-h-[34px] py-1 text-xs"
                      value={String(videoPlaybackRate)}
                      onChange={(e) => setVideoPlaybackRate(Number(e.target.value))}
                    >
                      <option value="0.6">0.6x</option>
                      <option value="0.7">0.7x</option>
                      <option value="0.8">0.8x</option>
                      <option value="0.9">0.9x</option>
                      <option value="1">1.0x</option>
                      <option value="1.5">1.5x</option>
                    </select>
                  </label>
                ) : null}
              </div>
              <div className={clsx("mt-2 min-h-0 flex-1 gap-2", videoSrc ? "grid lg:grid-cols-[minmax(0,0.5fr)_minmax(0,1fr)]" : "flex flex-col")}>
                {videoSrc && youtubeIframeSrc ? (
                  <div className="rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-white/85 px-2 py-2">
                    <p className="text-[0.65rem] font-semibold text-[color:var(--sun-muted)]">视频（左 · YouTube）</p>
                    <iframe
                      ref={youtubeIframeRef}
                      title="课文视频"
                      className="mt-1 aspect-video w-full rounded-lg bg-black/90"
                      src={youtubeIframeSrc}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                    />
                  </div>
                ) : videoSrc ? (
                  <div className="rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-white/85 px-2 py-2">
                    <p className="text-[0.65rem] font-semibold text-[color:var(--sun-muted)]">视频（左）</p>
                    <video ref={videoRef} className="mt-1 w-full rounded-lg bg-black/90" controls preload="metadata" src={videoSrc} />
                  </div>
                ) : null}
                {readSentences.length === 0 ? (
                  <p className="mt-2 text-xs text-[color:var(--sun-muted)]">正文中没有可切分的小句。</p>
                ) : (
                  <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain rounded-xl bg-amber-50/50 p-2 sm:p-3">
                  {sentenceSpans.map((span, i) => {
                    const zhHint = zhHintForSentenceSpan(lesson.content, lineZh, span.start, span.end);
                    const jpDisp = span.jp.length > 220 ? `${span.jp.slice(0, 220)}…` : span.jp;
                    return (
                      <li key={`read_${span.start}_${i}`}>
                        <button
                          type="button"
                          id={`lesson-read-row-${i}`}
                          className={clsx(
                            "w-full rounded-xl px-3 py-3 text-left transition sm:px-4 sm:py-3.5",
                            activeReadIdx === i ? "bg-amber-200/95 ring-2 ring-amber-400/80" : "bg-white/80 hover:bg-white",
                          )}
                          onClick={() => onFollowSentenceClick(i)}
                        >
                          <p className="whitespace-pre-wrap text-[0.95rem] font-medium leading-relaxed text-[color:var(--sun-ink)] sm:text-base md:text-lg">
                            {jpDisp}
                          </p>
                          {showLineZh && zhHint ? (
                            <p className="mt-2 rounded-lg bg-teal-50/95 px-3 py-2 text-xs leading-relaxed text-teal-950 sm:text-sm">{zhHint}</p>
                          ) : showLineZh ? (
                            <p className="mt-2 text-[0.65rem] text-[color:var(--sun-muted)]">（覆盖行暂无译文，可先一键全译）</p>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                  </ul>
                )}
              </div>
            </section>
          )}

          {lessonViewMode === "read" && (
            <article
              ref={articleRef}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-white/70 px-3 py-3 select-none sm:px-4 md:px-5 md:py-4"
              onMouseUp={refreshSelection}
              onTouchEnd={refreshSelection}
            >
              {coverSrc ? (
                <figure className="mb-6 overflow-hidden rounded-2xl border-2 border-[color-mix(in_srgb,var(--sun-accent)_22%,transparent)] bg-[color-mix(in_srgb,var(--sun-warm)_18%,white)] shadow-sm">
                  <img
                    src={coverSrc}
                    alt=""
                    className="mx-auto max-h-[min(52vh,28rem)] w-full object-contain"
                    decoding="async"
                  />
                </figure>
              ) : null}
              {lines.map((line, index) => {
                const isBlank = line.length === 0;
                const translated = lineZh[index] ?? "";
                const hint = isBlank ? { ownGrammar: false, otherGrammar: false, ownSentence: false, otherSentence: false } : lineTaskHint(line);
                return (
                  <div
                    key={`ln_${index}`}
                    id={`lesson-line-${index}`}
                    data-lesson-line-index={index}
                    className={clsx(
                      "border-b border-[color-mix(in_srgb,var(--sun-deep)_8%,transparent)] py-1.5 last:border-b-0 md:py-2",
                      flashLineIndex === index && "rounded-xl bg-amber-100/90 ring-2 ring-amber-400/75 transition",
                    )}
                  >
                    {isBlank ? (
                      <div className="min-h-[1.25rem]" aria-hidden />
                    ) : (
                      <>
                        <p
                          data-lesson-selectable="1"
                          className={clsx(
                            "whitespace-pre-wrap select-text text-base leading-relaxed tracking-wide text-[color:var(--sun-ink)] md:text-[1.05rem]",
                            hint.ownGrammar
                              ? "cursor-pointer underline [text-decoration-style:wavy] decoration-rose-500 underline-offset-4"
                              : hint.otherGrammar
                                ? "cursor-pointer underline [text-decoration-style:wavy] decoration-sky-500 underline-offset-4"
                                : null,
                          )}
                          onClick={() => {
                            if (!(hint.ownGrammar || hint.otherGrammar)) return;
                            const gid = firstGrammarIdInLine(line);
                            if (gid) onOpenGrammarCard(gid);
                          }}
                          onDoubleClick={() => {
                            if (!(hint.ownGrammar || hint.otherGrammar)) return;
                            const gid = firstGrammarIdInLine(line);
                            if (gid) onOpenGrammarCard(gid);
                          }}
                        >
                          {renderHighlightedLine(line)}
                        </p>
                        {(hint.ownSentence || hint.otherSentence) && (
                          <p className={clsx("mt-1 text-[0.66rem] font-semibold", hint.ownSentence ? "text-rose-700" : "text-sky-700")}>
                            {hint.ownSentence ? "本课句子题线索" : "他课句子题线索"}
                          </p>
                        )}
                        {showLineZh && translated.trim().length > 0 && (
                          <p className="mt-1.5 rounded-xl bg-teal-50/90 px-3 py-2 text-sm leading-relaxed text-teal-950 md:text-[0.95rem]">{translated}</p>
                        )}
                        {notesByLine.get(index)?.length ? (
                          <button
                            type="button"
                            className="mt-1 rounded-full bg-amber-100 px-2 py-1 text-[0.65rem] font-bold text-amber-900"
                            onClick={() => {
                              setNotesFilterLineIndex(index);
                              setNotesSheet("list");
                              setNotesDetailId(null);
                              setNotesModalOpen(true);
                            }}
                          >
                            本行笔记 {notesByLine.get(index)?.length}
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })}
            </article>
          )}

          {/* 右侧：对话栏（类似 1Langue / 微信布局） */}
          {chatOpen && (
            <div
              className={clsx(
                "mt-3 flex min-h-0 w-full flex-col gap-3 lg:mt-0 lg:w-[min(22rem,40%)] lg:max-w-[40%] lg:shrink-0 lg:self-stretch",
              )}
            >
              <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_55%,transparent)] bg-white/80 p-4 shadow-inner">
                <div className="flex items-center justify-between gap-2">
                  <select className="sun-select min-h-[40px] py-2 text-xs" value={chatMode} onChange={(e) => onChatModeChange(e.target.value as PromptMode)}>
                    <option value="fast">练习模式</option>
                    <option value="deep">思考模式（带课文）</option>
                  </select>
                  <button
                    type="button"
                    className="sun-btn sun-btn--ghost !px-3 !py-2 text-xs"
                    onClick={() => {
                      setRenamingSessionId(null);
                      onCreateNewEmptySession();
                    }}
                  >
                    新建练习
                  </button>
                </div>
                <div className="mt-2 flex min-h-[40px] items-center gap-2 overflow-x-auto rounded-full bg-amber-50/80 px-2 py-1 text-[0.7rem]">
                  {sessions.length === 0 ? (
                    <span className="whitespace-nowrap text-[color:var(--sun-muted)]">先点「新建练习」吧～</span>
                  ) : (
                    sessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        className={clsx(
                          "whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold",
                          session.id === selectedChatId
                            ? "bg-amber-500 text-white shadow-sm"
                            : "bg-white/90 text-[color:var(--sun-ink)] hover:bg-amber-100/90",
                        )}
                        onClick={() => {
                          setRenamingSessionId(null);
                          onSelectChatId(session.id);
                        }}
                      >
                        {session.title}
                      </button>
                    ))
                  )}
                </div>
                {activeSession ? (
                  <div className="mt-2 flex min-h-[38px] flex-wrap items-center gap-2 border-b border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] pb-2">
                    {renamingSessionId === activeSession.id ? (
                      <>
                        <input
                          className="sun-input min-h-[34px] min-w-0 flex-1 py-1.5 text-xs"
                          value={sessionRenameDraft}
                          onChange={(e) => setSessionRenameDraft(e.target.value)}
                          autoFocus
                        />
                        <button
                          type="button"
                          className="sun-btn min-h-[34px] !px-2.5 py-1 text-[0.68rem]"
                          onClick={() => {
                            onRenameSessionTo(activeSession.id, sessionRenameDraft);
                            setRenamingSessionId(null);
                          }}
                        >
                          保存
                        </button>
                        <button type="button" className="sun-btn sun-btn--ghost min-h-[34px] !px-2.5 py-1 text-[0.68rem]" onClick={() => setRenamingSessionId(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate text-xs font-bold text-[color:var(--sun-ink)]" title={activeSession.title}>
                          {activeSession.title}
                        </span>
                        <button
                          type="button"
                          className="sun-btn sun-btn--ghost shrink-0 !min-h-[34px] !px-2.5 py-1 text-[0.68rem]"
                          onClick={() => {
                            setRenamingSessionId(activeSession.id);
                            setSessionRenameDraft(activeSession.title);
                          }}
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          className="sun-btn sun-btn--ghost shrink-0 !min-h-[34px] !px-2.5 py-1 text-[0.68rem] text-rose-700"
                          onClick={() => {
                            setRenamingSessionId(null);
                            onDeleteSession(activeSession.id);
                          }}
                        >
                          删除会话
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-[0.68rem] text-[color:var(--sun-muted)]">选一个练习会话，或新建一条～</p>
                )}
                <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain rounded-xl bg-amber-50/60 px-3 py-2 text-xs">
                  {activeSession?.messages.slice(-30).map((msg) => (
                    <div key={msg.id} className={clsx("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                      <div
                        className={clsx(
                          "max-w-[90%] whitespace-pre-wrap rounded-2xl px-3 py-2 leading-relaxed ring-1",
                          msg.role === "user"
                            ? "bg-amber-500 text-white ring-amber-500/30"
                            : "bg-white/90 text-[color:var(--sun-ink)] ring-[color-mix(in_srgb,var(--sun-warm)_30%,transparent)]",
                        )}
                      >
                        {msg.content === "AI 正在回答中..." ? (
                          <span className="inline-flex items-center gap-1 text-[0.78rem] font-semibold text-[color:var(--sun-muted)] animate-pulse">
                            <span>AI 正在回答中</span>
                            <span className="tracking-widest">...</span>
                          </span>
                        ) : (
                          normalizeChatPlainText(msg.content)
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <textarea
                    className="sun-input min-h-[5.5rem] max-h-[10rem] flex-1 resize-y overflow-y-auto py-2 text-sm leading-relaxed"
                    placeholder="输入内容，回车发送"
                    rows={4}
                    value={chatInput}
                    onChange={(e) => onChatInputChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !chatBusy) {
                        e.preventDefault();
                        void onSendChat();
                      }
                    }}
                    disabled={chatBusy}
                  />
                  <button
                    type="button"
                    className="sun-btn min-h-[5.5rem] shrink-0 self-stretch !px-4 text-sm disabled:cursor-wait disabled:opacity-70"
                    onClick={() => void onSendChat()}
                    disabled={chatBusy}
                  >
                    {chatBusy ? "回答中…" : "发送"}
                  </button>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>

      {selectionBar && (
        <div className="fixed inset-x-0 bottom-0 z-[220] border-t border-[color-mix(in_srgb,var(--sun-warm)_60%,transparent)] bg-[color-mix(in_srgb,var(--sun-surface)_94%,transparent)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-lg">
          <div className={clsx(shellWide, "flex flex-col gap-3")}>
            <p className="min-w-0 text-sm">
              <span className="font-bold">已选</span>{" "}
              <span className="break-all text-[color:var(--sun-muted)]">{selectionBar.text}</span>
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="sun-btn sun-btn--ghost min-h-[44px] !px-4 text-sm" onClick={() => setSelectionBar(null)}>
                取消
              </button>
              <button
                type="button"
                className="sun-btn sun-btn--ghost min-h-[44px] !px-4 text-sm"
                title="使用本机朗读日语"
                onClick={() => bumpReadGenAndSpeak(selectionBar.text)}
              >
                发音
              </button>
              <button
                type="button"
                className="sun-btn min-h-[44px] !px-4 text-sm disabled:cursor-wait disabled:opacity-60"
                disabled={vocabBuildStatus?.phase === "busy"}
                onClick={() => void enqueueVocabFromSelection()}
              >
                {vocabBuildStatus?.phase === "busy" ? "处理中…" : "收藏单词"}
              </button>
              <button
                type="button"
                className="sun-btn min-h-[44px] !bg-gradient-to-r !from-teal-100 !to-amber-100 !px-4 text-sm"
                onClick={openSentenceFromSelection}
              >
                句子练习
              </button>
              <button type="button" className="sun-btn min-h-[44px] !px-4 text-sm" onClick={openListeningSentenceFromSelection}>
                听力练习
              </button>
              <button type="button" className="sun-btn min-h-[44px] !px-4 text-sm" onClick={openGrammarFromSelection}>
                语法练习
              </button>
              <button
                type="button"
                className="sun-btn min-h-[44px] !px-4 text-sm disabled:opacity-45"
                disabled={selectionBar.lineIndex === undefined}
                title={selectionBar.lineIndex === undefined ? "请在课文正文内划选整句或片段" : "收藏为当前课文重点句"}
                onClick={openFavoriteFromSelection}
              >
                收藏句子
              </button>
              <button type="button" className="sun-btn min-h-[44px] !px-4 text-sm" onClick={openBookmarkNoteFromSelection}>
                写笔记
              </button>
            </div>
          </div>
        </div>
      )}

      {notesModalOpen && (
        <div
          className="fixed inset-0 z-[234] flex items-end justify-center bg-black/40 p-3 sm:items-center"
          role="dialog"
          aria-modal
          aria-labelledby="lesson-notes-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setNotesModalOpen(false);
              setNotesSheet("list");
              setNotesDetailId(null);
              setEditingNoteId(null);
            }
          }}
        >
          <div className="float-card max-h-[88vh] w-full max-w-md overflow-hidden p-0 shadow-2xl sm:max-w-lg">
            <div className="border-b border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] bg-[color-mix(in_srgb,var(--sun-soft)_55%,white)] px-5 py-4">
              <h2 id="lesson-notes-title" className="text-lg font-black text-[color:var(--sun-ink)]">
                {notesSheet === "compose" ? "写笔记" : notesSheet === "detail" ? "笔记正文" : "我的笔记"}
              </h2>
              {notesSheet === "list" ? (
                <p className="mt-1 text-xs leading-relaxed text-[color:var(--sun-muted)]">点一条阅读全文；新建请在课文里划选后点「写笔记」～</p>
              ) : notesSheet === "compose" ? (
                <p className="mt-1 text-xs text-[color:var(--sun-muted)]">写完好记得保存呀</p>
              ) : (
                <p className="mt-1 text-xs text-[color:var(--sun-muted)]">左右滑动心情，慢慢看就好</p>
              )}
            </div>

            <div className="max-h-[min(72vh,560px)] overflow-y-auto overscroll-contain px-5 py-4">
              {notesSheet === "compose" ? (
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    className="self-start text-xs font-bold text-[color:var(--sun-muted)] underline decoration-2 underline-offset-2"
                    onClick={() => {
                      setNotesSheet("list");
                      setNewNoteContent("");
                      setNewNoteTitle("");
                    }}
                  >
                    ← 返回列表
                  </button>
                  <textarea
                    className="sun-textarea min-h-[10rem] w-full resize-y py-3 text-[0.95rem] leading-relaxed"
                    value={newNoteContent}
                    placeholder="写点你的想法、易错点或可爱碎碎念…"
                    onChange={(e) => setNewNoteContent(e.target.value)}
                  />
                  <button
                    type="button"
                    className="sun-btn min-h-[44px] w-full text-sm"
                    disabled={!newNoteContent.trim()}
                    onClick={() => {
                      const body = newNoteContent.trim();
                      onAddLessonNote({
                        content: body,
                        title: newNoteTitle.trim() || undefined,
                        lineIndex: newNoteLineIndex,
                      });
                      setNewNoteContent("");
                      setNewNoteTitle("");
                      setNewNoteLineIndex(undefined);
                      setNotesSheet("list");
                    }}
                  >
                    保存笔记
                  </button>
                </div>
              ) : notesSheet === "detail" ? (
                (() => {
                  const note = lessonNotes.find((n) => n.id === notesDetailId);
                  if (!note) {
                    return <p className="text-sm text-[color:var(--sun-muted)]">这条笔记不见啦，返回列表看看吧。</p>;
                  }
                  return (
                    <div className="flex flex-col gap-4">
                      <button
                        type="button"
                        className="self-start text-xs font-bold text-[color:var(--sun-muted)] underline decoration-2 underline-offset-2"
                        onClick={() => {
                          setNotesSheet("list");
                          setNotesDetailId(null);
                          setEditingNoteId(null);
                        }}
                      >
                        ← 返回列表
                      </button>
                      {editingNoteId === note.id ? (
                        <div className="flex flex-col gap-2">
                          <textarea
                            className="sun-textarea min-h-[10rem] w-full resize-y py-3 text-[0.95rem] leading-relaxed"
                            value={editingNoteContent}
                            onChange={(e) => setEditingNoteContent(e.target.value)}
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="sun-btn min-h-[40px] !px-4 text-sm"
                              onClick={() => {
                                onUpdateLessonNote(note.id, editingNoteContent);
                                setEditingNoteId(null);
                              }}
                            >
                              保存
                            </button>
                            <button type="button" className="sun-btn sun-btn--ghost min-h-[40px] !px-4 text-sm" onClick={() => setEditingNoteId(null)}>
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="whitespace-pre-wrap text-[0.98rem] leading-[1.65] text-[color:var(--sun-ink)]">{note.content}</p>
                          <div className="flex flex-wrap gap-2 border-t border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] pt-4">
                            <button
                              type="button"
                              className="sun-btn sun-btn--ghost min-h-[40px] !px-4 text-sm"
                              onClick={() => {
                                setEditingNoteId(note.id);
                                setEditingNoteContent(note.content);
                              }}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="sun-btn sun-btn--ghost min-h-[40px] !px-4 text-sm text-rose-700"
                              onClick={() => {
                                onDeleteLessonNote(note.id);
                                setNotesSheet("list");
                                setNotesDetailId(null);
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })()
              ) : (
                <>
                  <div className="mb-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={clsx(
                        "rounded-full border px-3 py-1 text-xs font-black transition",
                        notesFilterLineIndex == null ? "border-amber-400 bg-amber-100 text-amber-950" : "border-transparent bg-white/80 text-[color:var(--sun-muted)]",
                      )}
                      onClick={() => setNotesFilterLineIndex(null)}
                    >
                      全部
                    </button>
                    {notesFilterLineIndex != null ? (
                      <button
                        type="button"
                        className="rounded-full border border-sky-300 bg-sky-50 px-3 py-1 text-xs font-black text-sky-950"
                        onClick={() => scrollToFavoriteLine(notesFilterLineIndex)}
                      >
                        第 {notesFilterLineIndex + 1} 行附近
                      </button>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    {visibleNotes.length === 0 ? (
                      <p className="rounded-xl border border-dashed border-amber-200/80 bg-amber-50/50 px-4 py-6 text-center text-sm leading-relaxed text-[color:var(--sun-muted)]">
                        还没有笔记呢～在课文里<strong className="text-[color:var(--sun-ink)]">划选句子</strong>，再点底栏「写笔记」就可以啦
                      </p>
                    ) : (
                      visibleNotes.map((note) => {
                        const preview = note.content.trim().replace(/\s+/g, " ");
                        const short = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;
                        return (
                          <button
                            key={note.id}
                            type="button"
                            className="w-full rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_40%,white)] bg-white/90 px-4 py-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                            onClick={() => {
                              setNotesDetailId(note.id);
                              setNotesSheet("detail");
                            }}
                          >
                            <p className="text-[0.95rem] leading-relaxed text-[color:var(--sun-ink)]">{short || "（空笔记）"}</p>
                          </button>
                        );
                      })
                    )}
                  </div>
                  <div className="mt-8 border-t border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] pt-5">
                    <p className="text-xs font-bold text-[color:var(--sun-muted)]">收藏句子</p>
                    <div className="mt-3 space-y-2">
                      {favoriteSentences.length === 0 ? (
                        <p className="text-sm text-[color:var(--sun-muted)]">暂无收藏句子。</p>
                      ) : (
                        favoriteSentences.map((f) => (
                          <div
                            key={f.id}
                            className="flex flex-col gap-2 rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] bg-amber-50/50 p-3"
                          >
                            <p className="whitespace-pre-wrap text-sm font-medium leading-relaxed text-[color:var(--sun-ink)]">{f.jp}</p>
                            {f.zhHint ? <p className="rounded-lg bg-teal-50/90 px-2 py-1.5 text-xs text-teal-950">{f.zhHint}</p> : null}
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                className="sun-btn sun-btn--ghost min-h-[36px] !px-3 text-xs"
                                onClick={() => {
                                  scrollToFavoriteLine(f.lineIndex);
                                  setNotesModalOpen(false);
                                  setNotesSheet("list");
                                  setNotesDetailId(null);
                                }}
                              >
                                去课文里看
                              </button>
                              <button
                                type="button"
                                className="sun-btn sun-btn--ghost min-h-[36px] !px-3 text-xs text-rose-700"
                                onClick={() => onDeleteFavoriteSentence(f.id)}
                              >
                                删除
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="border-t border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] bg-white/80 px-5 py-3">
              <button
                type="button"
                className="sun-btn sun-btn--ghost min-h-[44px] w-full text-sm"
                onClick={() => {
                  setNotesModalOpen(false);
                  setNotesSheet("list");
                  setNotesDetailId(null);
                  setEditingNoteId(null);
                }}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {editOpen && (
        <div className="fixed inset-0 z-[235] flex items-end justify-center bg-black/40 p-3 sm:items-center" role="dialog" aria-modal>
          <div className="float-card max-h-[92vh] w-full max-w-lg overflow-auto p-5 shadow-2xl">
            <h2 className="text-lg font-black">编辑课文</h2>
            <div className="mt-4 flex flex-col gap-3">
              <label className="text-sm font-semibold">
                名称
                <input className="sun-input mt-1 w-full py-3" value={editName} onChange={(e) => setEditName(e.target.value)} />
              </label>
              <label className="text-sm font-semibold">
                分类
                <input className="sun-input mt-1 w-full py-3" value={editCategory} onChange={(e) => setEditCategory(e.target.value)} />
              </label>
              <label className="text-sm font-semibold">
                作者
                <input
                  className="sun-input mt-1 w-full py-3"
                  value={editAuthor}
                  placeholder="留空则保存为「著者不明」"
                  onChange={(e) => setEditAuthor(e.target.value)}
                />
              </label>
              <label className="text-sm font-semibold">
                正文
                <textarea
                  className="sun-textarea mt-1 min-h-[12rem] w-full resize-y py-3 font-mono text-sm leading-relaxed"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
              </label>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" className="sun-btn sun-btn--ghost min-h-[48px] !px-5" onClick={() => setEditOpen(false)}>
                取消
              </button>
              <button type="button" className="sun-btn min-h-[48px] !px-8" onClick={saveEditLesson}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {sentenceDraft && (
        <div className="fixed inset-0 z-[232] flex items-end justify-center bg-black/40 p-3 sm:items-center" role="dialog" aria-modal>
          <div className="float-card max-h-[90vh] w-full max-w-lg overflow-auto p-5 shadow-2xl">
            <h2 className="text-lg font-black">从划选生成 · 句子题</h2>
            <p className="mt-2 rounded-xl bg-white/85 px-3 py-2 text-xs text-[color:var(--sun-muted)]">
              <span className="font-bold text-[color:var(--sun-ink)]">划选原文</span>：{sentenceDraft.jpFragment}
            </p>
            <div className="mt-4 flex flex-col gap-3">
              <label className="text-sm font-semibold">
                中文提示 / 题面
                <input
                  className="sun-input mt-1 w-full py-3"
                  disabled={sentenceDraft.busy}
                  value={sentenceDraft.zh}
                  onChange={(e) => setSentenceDraft((d) => (d ? { ...d, zh: e.target.value } : d))}
                />
              </label>
              <label className="text-sm font-semibold">
                日语参考答案（单空格分块）
                <textarea
                  className="sun-textarea mt-1 min-h-[5rem] w-full py-3 font-mono text-sm"
                  disabled={sentenceDraft.busy}
                  value={sentenceDraft.jpAnswer}
                  onChange={(e) => setSentenceDraft((d) => (d ? { ...d, jpAnswer: e.target.value } : d))}
                />
              </label>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" className="sun-btn sun-btn--ghost min-h-[48px] !px-5" onClick={() => setSentenceDraft(null)}>
                关闭
              </button>
              <button
                type="button"
                className="sun-btn min-h-[48px] !px-8 disabled:opacity-50"
                disabled={sentenceDraft.busy}
                onClick={rerunSentenceAi}
              >
                重新生成
              </button>
              <button
                type="button"
                className="sun-btn min-h-[48px] !px-8 disabled:opacity-50"
                disabled={sentenceDraft.busy || !sentenceDraft.zh.trim() || !sentenceDraft.jpAnswer.trim()}
                onClick={submitSentenceDraft}
              >
                加入练习队列
              </button>
            </div>
          </div>
        </div>
      )}

      {grammarDraft && (
        <div className="fixed inset-0 z-[233] flex items-end justify-center bg-black/40 p-3 sm:items-center" role="dialog" aria-modal>
          <div className="float-card max-h-[90vh] w-full max-w-lg overflow-auto p-5 shadow-2xl">
            <h2 className="text-lg font-black">从划选生成 · 语法题</h2>
            <p className="mt-1 text-xs text-[color:var(--sun-muted)]">
              题干里要有 <span className="font-mono">___</span> 表示空。可改字，再点 AI 生成选项。
            </p>
            <div className="mt-4 flex flex-col gap-3">
              <label className="text-sm font-semibold">
                来源原句（练习区会展示）
                <textarea
                  className="sun-textarea mt-1 min-h-[4rem] w-full py-3 font-mono text-sm"
                  value={grammarDraft.sourceSentence}
                  onChange={(e) => setGrammarDraft((d) => (d ? { ...d, sourceSentence: e.target.value } : d))}
                />
              </label>
              <label className="text-sm font-semibold">
                题干
                <textarea
                  className="sun-textarea mt-1 min-h-[6rem] w-full py-3 font-mono text-sm"
                  value={grammarDraft.prompt}
                  onChange={(e) => setGrammarDraft((d) => (d ? { ...d, prompt: e.target.value, ai: null } : d))}
                />
              </label>
              <label className="text-sm font-semibold">
                语法知识点（可选）
                <input
                  className="sun-input mt-1 w-full py-3"
                  value={grammarDraft.knowledgePoint}
                  onChange={(e) => setGrammarDraft((d) => (d ? { ...d, knowledgePoint: e.target.value, ai: null } : d))}
                />
              </label>
              <button
                type="button"
                className="sun-btn w-fit disabled:opacity-50"
                disabled={grammarDraft.busy || !grammarDraft.prompt.includes("___")}
                onClick={() => void runGrammarAi()}
              >
                {grammarDraft.busy ? "生成中…" : "AI 生成选项"}
              </button>
              {grammarDraft.ai && (() => {
                const g = grammarDraft.ai;
                return (
                <div className="max-h-[50vh] overflow-auto rounded-xl bg-amber-50/90 px-3 py-3 text-xs leading-relaxed text-[color:var(--sun-ink)]">
                  <p className="font-black">选项</p>
                  <p className="mt-1">{g.choices.join(" · ")}</p>
                  <p className="mt-2 font-black">解析</p>
                  <p className="mt-1 whitespace-pre-wrap">{g.explanation}</p>
                  <p className="mt-2 font-black">错误项为何不对</p>
                  <div className="mt-1 space-y-1.5">
                    {g.choices.map((c, i) =>
                      i === g.answerIndex ? null : (
                        <p key={`gr_${i}`}>
                          <span className="font-bold">{c}</span>：{g.wrongReasons?.[i]?.trim() || "—"}
                        </p>
                      ),
                    )}
                  </div>
                </div>
                );
              })()}
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" className="sun-btn sun-btn--ghost min-h-[48px] !px-5" onClick={() => setGrammarDraft(null)}>
                关闭
              </button>
              <button
                type="button"
                className="sun-btn min-h-[48px] !px-8 disabled:opacity-45"
                disabled={!grammarDraft.ai || grammarDraft.busy}
                onClick={commitGrammarTask}
              >
                加入练习队列
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );

  if (!mounted || typeof document === "undefined") {
    return null;
  }

  return createPortal(shell, document.body);
}
