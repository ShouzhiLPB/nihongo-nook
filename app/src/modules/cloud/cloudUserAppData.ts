import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeAppData } from "@/modules/storage/dataStore";
import type {
  AppData,
  AppMediaResource,
  AppStatsCounters,
  ChatSession,
  GrammarTask,
  Lesson,
  LessonFavoriteSentence,
  LessonNote,
  SentenceTask,
  VocabCard,
} from "@/shared/types";

/** 与 `supabase/migrations/*user_app_data.sql` 表名一致 */
export const USER_APP_DATA_TABLE = "user_app_data";

/** 自动同步：整包内容指纹（legacy 单键，与 pkg 中 full 同步） */
export const LS_CLOUD_LAST_SYNC_FINGERPRINT_PREFIX = "jpLearn_cloudLastSyncFingerprint_";
/** 自动同步：多子树指纹 JSON（含 full / stats / core / notes / favs / lessons / …），支持 i2-4 RPC 增量 */
export const LS_CLOUD_FP_PKG_PREFIX = "jpLearn_cloudFpPkg_";
/** i2-5：本机记录的「上次确认过的云端快照时间」（仅在成功上传 / 同步 / 恢复后写入，用于恢复前提示） */
export const LS_CLOUD_LAST_SEEN_REMOTE_AT_PREFIX = "jpLearn_cloudLastSeenRemoteAt_";

/** 与 `20260418000000_merge_payload_delta.sql` 中函数名一致 */
export const MERGE_PAYLOAD_DELTA_RPC = "jp_learn_merge_payload_delta";
/** 与 `20260424120000_user_app_data_sync_guard_and_rpc_upsert.sql` 一致：轻量空壳判断，避免整包 select */
export const REMOTE_SYNC_GUARD_META_RPC = "jp_learn_remote_sync_guard_meta";
/** 同上：服务端整包 upsert + 放宽 statement_timeout；未部署时回退为 REST upsert */
export const UPSERT_USER_APP_DATA_RPC = "jp_learn_upsert_user_app_data";
/** 与 `20260425120000` + `20260426120000_jp_learn_patch_lesson_payload_extend.sql` 一致：白名单字段合并进 `payload.lessons[]` */
export const PATCH_LESSON_PAYLOAD_RPC = "jp_learn_patch_lesson_payload";

/** 允许经 `jp_learn_patch_lesson_payload` 上云的课文字段（阅读器编辑 + 媒体键/外链等） */
export type LessonPayloadCloudPatch = Partial<
  Pick<
    Lesson,
    | "name"
    | "content"
    | "updatedAt"
    | "category"
    | "author"
    | "lineTranslations"
    | "translationVisible"
    | "lessonKind"
    | "coverIllustrationDataUrl"
    | "coverIllustrationMediaKey"
    | "listeningAudioDataUrl"
    | "listeningAudioMediaKey"
    | "videoSourceUrl"
    | "videoSourceMediaKey"
    | "videoCues"
    | "trashedAt"
  >
>;

/**
 * 从阅读器 `onPersistLesson` 的 patch 抽出可 RPC 上云的字段；无可同步字段时返回 `null`。
 * 若有任意同步字段且未带 `updatedAt`，则用 `updatedAtFallback`（通常为 `nowIso()`）。
 */
export function pickLessonPayloadCloudPatch(patch: Partial<Lesson>, updatedAtFallback: string): LessonPayloadCloudPatch | null {
  const slice: LessonPayloadCloudPatch = {};
  if (typeof patch.name === "string") slice.name = patch.name;
  if (typeof patch.content === "string") slice.content = patch.content;
  if (typeof patch.category === "string") slice.category = patch.category;
  if (typeof patch.author === "string") slice.author = patch.author;
  if (typeof patch.updatedAt === "string" && patch.updatedAt.length > 0) slice.updatedAt = patch.updatedAt;
  if (patch.translationVisible !== undefined && typeof patch.translationVisible === "boolean") {
    slice.translationVisible = patch.translationVisible;
  }
  if (patch.lessonKind === "text" || patch.lessonKind === "video") slice.lessonKind = patch.lessonKind;
  if (Array.isArray(patch.lineTranslations) && patch.lineTranslations.every((x) => typeof x === "string")) {
    slice.lineTranslations = patch.lineTranslations;
  }
  if (typeof patch.coverIllustrationDataUrl === "string") slice.coverIllustrationDataUrl = patch.coverIllustrationDataUrl;
  if (typeof patch.coverIllustrationMediaKey === "string") slice.coverIllustrationMediaKey = patch.coverIllustrationMediaKey;
  if (typeof patch.listeningAudioDataUrl === "string") slice.listeningAudioDataUrl = patch.listeningAudioDataUrl;
  if (typeof patch.listeningAudioMediaKey === "string") slice.listeningAudioMediaKey = patch.listeningAudioMediaKey;
  if (typeof patch.videoSourceUrl === "string") slice.videoSourceUrl = patch.videoSourceUrl;
  if (typeof patch.videoSourceMediaKey === "string") slice.videoSourceMediaKey = patch.videoSourceMediaKey;
  if (typeof patch.trashedAt === "string") slice.trashedAt = patch.trashedAt;
  if (Array.isArray(patch.videoCues)) slice.videoCues = patch.videoCues;

  const keys = Object.keys(slice) as (keyof LessonPayloadCloudPatch)[];
  if (keys.length === 0) return null;
  if (!(typeof slice.updatedAt === "string" && slice.updatedAt.length > 0)) {
    slice.updatedAt = updatedAtFallback;
  }
  return slice;
}

function looksLikeMissingPostgrestRpc(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const o = error as { code?: string; message?: string; details?: string };
  const code = typeof o.code === "string" ? o.code : "";
  if (code === "PGRST202") return true;
  const blob = `${o.message ?? ""} ${o.details ?? ""}`.toLowerCase();
  return (
    blob.includes("could not find the function") ||
    (blob.includes("function") && (blob.includes("does not exist") || blob.includes("not found")))
  );
}

function jsonBoolField(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "t" || t === "1") return true;
    if (t === "false" || t === "f" || t === "0") return false;
  }
  return null;
}

function parseRemoteSyncGuardMeta(data: unknown): { exists: boolean; bareShell: boolean } | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const o = data as { exists?: unknown; bare_shell?: unknown };
  const exists = jsonBoolField(o.exists);
  const bareShell = jsonBoolField(o.bare_shell);
  if (exists === null || bareShell === null) return null;
  return { exists, bareShell };
}

/** 不下载整包 payload；未部署 RPC 时返回 null（调用方应回退整包 fetch）。 */
export async function fetchRemoteSyncGuardMeta(
  sb: SupabaseClient,
): Promise<{ exists: boolean; bareShell: boolean } | null> {
  const { data, error } = await sb.rpc(REMOTE_SYNC_GUARD_META_RPC);
  if (error) {
    if (looksLikeMissingPostgrestRpc(error)) return null;
    throw error;
  }
  return parseRemoteSyncGuardMeta(data);
}

export type CloudUserAppSnapshot = {
  payload: AppData;
  updatedAt: string;
};

function fnv1a32Hex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 读取当前登录用户在云上的快照（RLS 仅允许自己的行）。
 * 表不存在或尚无数据时返回 null；其它错误抛出。
 */
export async function fetchUserAppDataFromCloud(sb: SupabaseClient): Promise<CloudUserAppSnapshot | null> {
  const { data, error } = await sb.from(USER_APP_DATA_TABLE).select("payload,updated_at").maybeSingle();
  if (error) throw error;
  if (!data || data.payload == null) return null;
  const raw = data.payload as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const updatedAt = typeof data.updated_at === "string" ? data.updated_at : "";
  return { payload: normalizeAppData(raw as AppData), updatedAt };
}

/** 只查云端行的更新时间（不下载整包 JSON），用于界面与冲突提示。 */
export async function fetchUserAppRemoteUpdatedAt(sb: SupabaseClient): Promise<string | null> {
  const { data, error } = await sb.from(USER_APP_DATA_TABLE).select("updated_at").maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const u = (data as { updated_at?: string }).updated_at;
  return typeof u === "string" && u.length > 0 ? u : null;
}

/** 将本机规范化后的 AppData 整包写入云端（单行 upsert；优先走服务端 RPC 以放宽 statement_timeout）。 */
export async function upsertUserAppDataToCloud(sb: SupabaseClient, userId: string, payload: AppData): Promise<string> {
  const normalized = normalizeAppData(payload);
  const { data, error } = await sb.rpc(UPSERT_USER_APP_DATA_RPC, { p_payload: normalized });
  if (!error) {
    if (typeof data === "string" && data.length > 0) return data;
    if (data != null && typeof (data as { toISOString?: () => string }).toISOString === "function") {
      return (data as Date).toISOString();
    }
    const serverAt = await fetchUserAppRemoteUpdatedAt(sb);
    if (serverAt) return serverAt;
    return new Date().toISOString();
  }
  if (looksLikeMissingPostgrestRpc(error)) {
    const updated_at = new Date().toISOString();
    const { error: e2 } = await sb.from(USER_APP_DATA_TABLE).upsert(
      { user_id: userId, payload: normalized, updated_at },
      { onConflict: "user_id" },
    );
    if (e2) throw e2;
    return updated_at;
  }
  throw error;
}

/**
 * 在云端 `payload.lessons` 中按 id 合并白名单字段（不整包 upsert）。
 * - 未部署 RPC → `null`
 * - 尚无云端行 / 课 id 不在云端 → `null`（常见于首次仅本机编辑）
 * 成功时返回该行新的 `updated_at`（ISO 字符串）。
 */
export async function patchLessonPayloadInCloud(
  sb: SupabaseClient,
  lessonId: string,
  patch: LessonPayloadCloudPatch,
): Promise<string | null> {
  const p_patch: Record<string, unknown> = {};
  if (patch.name !== undefined) p_patch.name = patch.name;
  if (patch.content !== undefined) p_patch.content = patch.content;
  if (patch.updatedAt !== undefined) p_patch.updatedAt = patch.updatedAt;
  if (patch.category !== undefined) p_patch.category = patch.category;
  if (patch.author !== undefined) p_patch.author = patch.author;
  if (patch.translationVisible !== undefined) p_patch.translationVisible = patch.translationVisible;
  if (patch.lessonKind !== undefined) p_patch.lessonKind = patch.lessonKind;
  if (patch.lineTranslations !== undefined) p_patch.lineTranslations = patch.lineTranslations;
  if (patch.coverIllustrationDataUrl !== undefined) p_patch.coverIllustrationDataUrl = patch.coverIllustrationDataUrl;
  if (patch.coverIllustrationMediaKey !== undefined) p_patch.coverIllustrationMediaKey = patch.coverIllustrationMediaKey;
  if (patch.listeningAudioDataUrl !== undefined) p_patch.listeningAudioDataUrl = patch.listeningAudioDataUrl;
  if (patch.listeningAudioMediaKey !== undefined) p_patch.listeningAudioMediaKey = patch.listeningAudioMediaKey;
  if (patch.videoSourceUrl !== undefined) p_patch.videoSourceUrl = patch.videoSourceUrl;
  if (patch.videoSourceMediaKey !== undefined) p_patch.videoSourceMediaKey = patch.videoSourceMediaKey;
  if (patch.videoCues !== undefined) p_patch.videoCues = patch.videoCues;
  if (patch.trashedAt !== undefined) p_patch.trashedAt = patch.trashedAt;
  if (Object.keys(p_patch).length === 0) return null;

  const { data, error } = await sb.rpc(PATCH_LESSON_PAYLOAD_RPC, { p_lesson_id: lessonId, p_patch: p_patch });
  if (!error) {
    if (typeof data === "string" && data.length > 0) return data;
    if (data != null && typeof (data as { toISOString?: () => string }).toISOString === "function") {
      return (data as Date).toISOString();
    }
    const serverAt = await fetchUserAppRemoteUpdatedAt(sb);
    return serverAt;
  }
  if (looksLikeMissingPostgrestRpc(error)) return null;
  const msg = `${(error as { message?: string }).message ?? ""}`.toLowerCase();
  if (msg.includes("lesson id not found") || msg.includes("no cloud row")) return null;
  throw error;
}

/** 与 `20260427120000_jp_learn_patch_vocab_card_payload.sql` 一致 */
export const PATCH_VOCAB_CARD_PAYLOAD_RPC = "jp_learn_patch_vocab_card_payload";

export type VocabPayloadCloudPatch = Partial<
  Pick<
    VocabCard,
    | "term"
    | "kana"
    | "meanings"
    | "etymology"
    | "latestExample"
    | "vocabDistractors"
    | "vocabZhDistractors"
    | "mastery"
    | "reviewStage"
    | "nextReviewDay"
    | "reviewGraduated"
    | "updatedAt"
  >
>;

/**
 * 在云端 `payload.vocabCards` 中按 id 合并白名单字段（不整包 upsert）。
 * - 未部署 RPC / 无云端行 / 词卡 id 不在云端 → `null`
 */
export async function patchVocabCardPayloadInCloud(
  sb: SupabaseClient,
  vocabId: string,
  patch: VocabPayloadCloudPatch,
): Promise<string | null> {
  const p_patch: Record<string, unknown> = {};
  if (patch.term !== undefined) p_patch.term = patch.term;
  if (patch.kana !== undefined) p_patch.kana = patch.kana;
  if (patch.etymology !== undefined) p_patch.etymology = patch.etymology;
  if (patch.latestExample !== undefined) p_patch.latestExample = patch.latestExample;
  if (patch.updatedAt !== undefined) p_patch.updatedAt = patch.updatedAt;
  if (patch.meanings !== undefined) p_patch.meanings = patch.meanings;
  if (patch.vocabDistractors !== undefined) p_patch.vocabDistractors = patch.vocabDistractors;
  if (patch.vocabZhDistractors !== undefined) p_patch.vocabZhDistractors = patch.vocabZhDistractors;
  if (patch.mastery !== undefined) p_patch.mastery = patch.mastery;
  if (patch.reviewStage !== undefined) p_patch.reviewStage = patch.reviewStage;
  if (patch.nextReviewDay !== undefined) p_patch.nextReviewDay = patch.nextReviewDay;
  if (patch.reviewGraduated !== undefined) p_patch.reviewGraduated = patch.reviewGraduated;
  if (Object.keys(p_patch).length === 0) return null;

  const { data, error } = await sb.rpc(PATCH_VOCAB_CARD_PAYLOAD_RPC, { p_vocab_id: vocabId, p_patch: p_patch });
  if (!error) {
    if (typeof data === "string" && data.length > 0) return data;
    if (data != null && typeof (data as { toISOString?: () => string }).toISOString === "function") {
      return (data as Date).toISOString();
    }
    const serverAt = await fetchUserAppRemoteUpdatedAt(sb);
    return serverAt;
  }
  if (looksLikeMissingPostgrestRpc(error)) return null;
  const msg = `${(error as { message?: string }).message ?? ""}`.toLowerCase();
  if (msg.includes("vocab id not found") || msg.includes("no cloud row")) return null;
  throw error;
}

/** 与 `20260428120000_jp_learn_patch_sentence_and_grammar_task_payload.sql` 一致 */
export const PATCH_SENTENCE_TASK_PAYLOAD_RPC = "jp_learn_patch_sentence_task_payload";
export const PATCH_GRAMMAR_TASK_PAYLOAD_RPC = "jp_learn_patch_grammar_task_payload";

export type SentenceTaskPayloadCloudPatch = Partial<
  Pick<
    SentenceTask,
    | "zh"
    | "jpAnswer"
    | "tokens"
    | "teachingNote"
    | "sourceType"
    | "mastery"
    | "reviewStage"
    | "nextReviewDay"
    | "reviewGraduated"
  >
>;

export type GrammarTaskPayloadCloudPatch = Partial<
  Pick<
    GrammarTask,
    | "prompt"
    | "zhPrompt"
    | "explanation"
    | "knowledgePoint"
    | "sourceSentence"
    | "answerId"
    | "choices"
    | "wrongReasonByChoiceId"
    | "mastery"
    | "reviewStage"
    | "nextReviewDay"
    | "reviewGraduated"
  >
>;

export async function patchSentenceTaskPayloadInCloud(
  sb: SupabaseClient,
  taskId: string,
  patch: SentenceTaskPayloadCloudPatch,
): Promise<string | null> {
  const p_patch: Record<string, unknown> = {};
  if (patch.zh !== undefined) p_patch.zh = patch.zh;
  if (patch.jpAnswer !== undefined) p_patch.jpAnswer = patch.jpAnswer;
  if (patch.teachingNote !== undefined) p_patch.teachingNote = patch.teachingNote;
  if (patch.sourceType !== undefined) p_patch.sourceType = patch.sourceType;
  if (patch.tokens !== undefined) p_patch.tokens = patch.tokens;
  if (patch.mastery !== undefined) p_patch.mastery = patch.mastery;
  if (patch.reviewStage !== undefined) p_patch.reviewStage = patch.reviewStage;
  if (patch.nextReviewDay !== undefined) p_patch.nextReviewDay = patch.nextReviewDay;
  if (patch.reviewGraduated !== undefined) p_patch.reviewGraduated = patch.reviewGraduated;
  if (Object.keys(p_patch).length === 0) return null;

  const { data, error } = await sb.rpc(PATCH_SENTENCE_TASK_PAYLOAD_RPC, { p_task_id: taskId, p_patch: p_patch });
  if (!error) {
    if (typeof data === "string" && data.length > 0) return data;
    if (data != null && typeof (data as { toISOString?: () => string }).toISOString === "function") {
      return (data as Date).toISOString();
    }
    const serverAt = await fetchUserAppRemoteUpdatedAt(sb);
    return serverAt;
  }
  if (looksLikeMissingPostgrestRpc(error)) return null;
  const msg = `${(error as { message?: string }).message ?? ""}`.toLowerCase();
  if (msg.includes("sentence task id not found") || msg.includes("no cloud row")) return null;
  throw error;
}

export async function patchGrammarTaskPayloadInCloud(
  sb: SupabaseClient,
  taskId: string,
  patch: GrammarTaskPayloadCloudPatch,
): Promise<string | null> {
  const p_patch: Record<string, unknown> = {};
  if (patch.prompt !== undefined) p_patch.prompt = patch.prompt;
  if (patch.zhPrompt !== undefined) p_patch.zhPrompt = patch.zhPrompt;
  if (patch.explanation !== undefined) p_patch.explanation = patch.explanation;
  if (patch.knowledgePoint !== undefined) p_patch.knowledgePoint = patch.knowledgePoint;
  if (patch.sourceSentence !== undefined) p_patch.sourceSentence = patch.sourceSentence;
  if (patch.answerId !== undefined) p_patch.answerId = patch.answerId;
  if (patch.choices !== undefined) p_patch.choices = patch.choices;
  if (patch.wrongReasonByChoiceId !== undefined) p_patch.wrongReasonByChoiceId = patch.wrongReasonByChoiceId;
  if (patch.mastery !== undefined) p_patch.mastery = patch.mastery;
  if (patch.reviewStage !== undefined) p_patch.reviewStage = patch.reviewStage;
  if (patch.nextReviewDay !== undefined) p_patch.nextReviewDay = patch.nextReviewDay;
  if (patch.reviewGraduated !== undefined) p_patch.reviewGraduated = patch.reviewGraduated;
  if (Object.keys(p_patch).length === 0) return null;

  const { data, error } = await sb.rpc(PATCH_GRAMMAR_TASK_PAYLOAD_RPC, { p_task_id: taskId, p_patch: p_patch });
  if (!error) {
    if (typeof data === "string" && data.length > 0) return data;
    if (data != null && typeof (data as { toISOString?: () => string }).toISOString === "function") {
      return (data as Date).toISOString();
    }
    const serverAt = await fetchUserAppRemoteUpdatedAt(sb);
    return serverAt;
  }
  if (looksLikeMissingPostgrestRpc(error)) return null;
  const msg = `${(error as { message?: string }).message ?? ""}`.toLowerCase();
  if (msg.includes("grammar task id not found") || msg.includes("no cloud row")) return null;
  throw error;
}

/** 与 `20260429120000_jp_learn_patch_lesson_note_and_favorite_sentence.sql` 一致 */
export const PATCH_LESSON_NOTE_PAYLOAD_RPC = "jp_learn_patch_lesson_note_payload";
export const PATCH_FAVORITE_SENTENCE_PAYLOAD_RPC = "jp_learn_patch_favorite_sentence_payload";

export type LessonNotePayloadCloudPatch = Partial<Pick<LessonNote, "title" | "content" | "lineIndex" | "updatedAt">>;

export type FavoriteSentencePayloadCloudPatch = Partial<
  Pick<LessonFavoriteSentence, "jp" | "zhHint" | "lineIndex">
>;

export async function patchLessonNotePayloadInCloud(
  sb: SupabaseClient,
  noteId: string,
  patch: LessonNotePayloadCloudPatch,
): Promise<string | null> {
  const p_patch: Record<string, unknown> = {};
  if (patch.title !== undefined) p_patch.title = patch.title;
  if (patch.content !== undefined) p_patch.content = patch.content;
  if (patch.lineIndex !== undefined) p_patch.lineIndex = patch.lineIndex;
  if (patch.updatedAt !== undefined) p_patch.updatedAt = patch.updatedAt;
  if (Object.keys(p_patch).length === 0) return null;

  const { data, error } = await sb.rpc(PATCH_LESSON_NOTE_PAYLOAD_RPC, { p_note_id: noteId, p_patch: p_patch });
  if (!error) {
    if (typeof data === "string" && data.length > 0) return data;
    if (data != null && typeof (data as { toISOString?: () => string }).toISOString === "function") {
      return (data as Date).toISOString();
    }
    const serverAt = await fetchUserAppRemoteUpdatedAt(sb);
    return serverAt;
  }
  if (looksLikeMissingPostgrestRpc(error)) return null;
  const msg = `${(error as { message?: string }).message ?? ""}`.toLowerCase();
  if (msg.includes("lesson note id not found") || msg.includes("no cloud row")) return null;
  throw error;
}

export async function patchFavoriteSentencePayloadInCloud(
  sb: SupabaseClient,
  favId: string,
  patch: FavoriteSentencePayloadCloudPatch,
): Promise<string | null> {
  const p_patch: Record<string, unknown> = {};
  if (patch.jp !== undefined) p_patch.jp = patch.jp;
  if (patch.zhHint !== undefined) p_patch.zhHint = patch.zhHint;
  if (patch.lineIndex !== undefined) p_patch.lineIndex = patch.lineIndex;
  if (Object.keys(p_patch).length === 0) return null;

  const { data, error } = await sb.rpc(PATCH_FAVORITE_SENTENCE_PAYLOAD_RPC, { p_fav_id: favId, p_patch: p_patch });
  if (!error) {
    if (typeof data === "string" && data.length > 0) return data;
    if (data != null && typeof (data as { toISOString?: () => string }).toISOString === "function") {
      return (data as Date).toISOString();
    }
    const serverAt = await fetchUserAppRemoteUpdatedAt(sb);
    return serverAt;
  }
  if (looksLikeMissingPostgrestRpc(error)) return null;
  const msg = `${(error as { message?: string }).message ?? ""}`.toLowerCase();
  if (msg.includes("favorite sentence id not found") || msg.includes("no cloud row")) return null;
  throw error;
}

export type PayloadDelta = {
  stats?: AppStatsCounters;
  mediaLibrary?: Record<string, AppMediaResource>;
  /** 整段替换 `payload.lessonNotes`（需服务端迁移含数组分支） */
  lessonNotes?: LessonNote[];
  /** 整段替换 `payload.favoriteSentences` */
  favoriteSentences?: LessonFavoriteSentence[];
  lessons?: Lesson[];
  vocabCards?: VocabCard[];
  sentenceTasks?: SentenceTask[];
  grammarTasks?: GrammarTask[];
  chatSessions?: ChatSession[];
};

/**
 * 在云端已有快照行上合并片段（需已执行 `jp_learn_merge_payload_delta` 迁移）。
 * - `stats`：整段替换 `payload.stats`（与整包上传时该子树一致）。
 * - `mediaLibrary`：与现有 `payload.mediaLibrary` 做 jsonb 对象键合并（新增/覆盖键）。
 * - `lessonNotes` / `favoriteSentences` / `lessons` / `vocabCards` / `sentenceTasks` / `grammarTasks` / `chatSessions`：整段替换为数组（与 stats 同理；未部署对应迁移时 RPC 会忽略未知键，客户端应整包 upsert）。
 */
export async function mergePayloadDeltaToCloud(sb: SupabaseClient, delta: PayloadDelta): Promise<string> {
  const p_delta: Record<string, unknown> = {};
  if (delta.stats !== undefined) {
    p_delta.stats = delta.stats as unknown;
  }
  if (delta.mediaLibrary !== undefined && Object.keys(delta.mediaLibrary).length > 0) {
    p_delta.mediaLibrary = delta.mediaLibrary as unknown;
  }
  if (delta.lessonNotes !== undefined) {
    p_delta.lessonNotes = delta.lessonNotes as unknown;
  }
  if (delta.favoriteSentences !== undefined) {
    p_delta.favoriteSentences = delta.favoriteSentences as unknown;
  }
  if (delta.lessons !== undefined) {
    p_delta.lessons = delta.lessons as unknown;
  }
  if (delta.vocabCards !== undefined) {
    p_delta.vocabCards = delta.vocabCards as unknown;
  }
  if (delta.sentenceTasks !== undefined) {
    p_delta.sentenceTasks = delta.sentenceTasks as unknown;
  }
  if (delta.grammarTasks !== undefined) {
    p_delta.grammarTasks = delta.grammarTasks as unknown;
  }
  if (delta.chatSessions !== undefined) {
    p_delta.chatSessions = delta.chatSessions as unknown;
  }
  if (Object.keys(p_delta).length === 0) {
    throw new Error("mergePayloadDeltaToCloud: empty delta");
  }
  const { data, error } = await sb.rpc(MERGE_PAYLOAD_DELTA_RPC, { p_delta: p_delta });
  if (error) throw error;
  if (typeof data === "string" && data.length > 0) return data;
  if (data != null && typeof (data as { toISOString?: () => string }).toISOString === "function") {
    return (data as Date).toISOString();
  }
  return new Date().toISOString();
}

/**
 * 计算快照指纹：用于“内容未变化不上传”。
 * 采用轻量 FNV-1a 32bit，输出 8 位十六进制字符串。
 */
export function fingerprintAppData(payload: AppData): string {
  const normalized = normalizeAppData(payload);
  return fnv1a32Hex(JSON.stringify(normalized));
}

/** 除 `stats` 外的 AppData 指纹（用于判断是否仅需 stats 增量上传）。 */
export function fingerprintAppDataExcludingStats(payload: AppData): string {
  const normalized = normalizeAppData(payload);
  const { stats: _omit, ...rest } = normalized;
  return fnv1a32Hex(JSON.stringify(rest));
}

/** 仅 `stats` 子树指纹。 */
export function fingerprintStatsSubtree(payload: AppData): string {
  const normalized = normalizeAppData(payload);
  return fnv1a32Hex(JSON.stringify(normalized.stats ?? {}));
}

/** 不含 `stats`、`lessonNotes`、`favoriteSentences` 的指纹，用于判断能否走子树 RPC 而非整包 upsert。 */
export function fingerprintContentCore(payload: AppData): string {
  const normalized = normalizeAppData(payload);
  const { stats: _s, lessonNotes: _n, favoriteSentences: _f, ...core } = normalized;
  return fnv1a32Hex(JSON.stringify(core));
}

export function fingerprintLessonNotesSubtree(payload: AppData): string {
  const normalized = normalizeAppData(payload);
  return fnv1a32Hex(JSON.stringify(normalized.lessonNotes ?? []));
}

export function fingerprintFavoriteSentencesSubtree(payload: AppData): string {
  const normalized = normalizeAppData(payload);
  return fnv1a32Hex(JSON.stringify(normalized.favoriteSentences ?? []));
}

export function fingerprintMediaLibrarySubtree(payload: AppData): string {
  const normalized = normalizeAppData(payload);
  return fnv1a32Hex(JSON.stringify(normalized.mediaLibrary ?? {}));
}

export function fingerprintLessonsSubtree(payload: AppData): string {
  const normalized = normalizeAppData(payload);
  return fnv1a32Hex(JSON.stringify(normalized.lessons ?? []));
}

export function fingerprintVocabCardsSubtree(payload: AppData): string {
  const normalized = normalizeAppData(payload);
  return fnv1a32Hex(JSON.stringify(normalized.vocabCards ?? []));
}

export function fingerprintSentenceTasksSubtree(payload: AppData): string {
  const normalized = normalizeAppData(payload);
  return fnv1a32Hex(JSON.stringify(normalized.sentenceTasks ?? []));
}

export function fingerprintGrammarTasksSubtree(payload: AppData): string {
  const normalized = normalizeAppData(payload);
  return fnv1a32Hex(JSON.stringify(normalized.grammarTasks ?? []));
}

export function fingerprintChatSessionsSubtree(payload: AppData): string {
  const normalized = normalizeAppData(payload);
  return fnv1a32Hex(JSON.stringify(normalized.chatSessions ?? []));
}

export type CloudSyncFingerprintPkg = {
  full: string;
  rest: string;
  stats: string;
  /** 不含 stats / 笔记 / 收藏句；旧客户端未写入时为空串 */
  core: string;
  notes: string;
  favs: string;
  /** 以下字段 i2-4 全量子树指纹；旧包未写入时为空串，自动同步走 legacy 或整包 upsert */
  lessons: string;
  vocabCards: string;
  sentenceTasks: string;
  grammarTasks: string;
  chatSessions: string;
  mediaLibrary: string;
};

const EMPTY_FP_PKG: CloudSyncFingerprintPkg = {
  full: "",
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
};

export function readCloudSyncFingerprintPkg(userId: string): CloudSyncFingerprintPkg {
  if (typeof window === "undefined") return { ...EMPTY_FP_PKG };
  try {
    const raw = localStorage.getItem(`${LS_CLOUD_FP_PKG_PREFIX}${userId}`);
    if (raw) {
      const o = JSON.parse(raw) as {
        full?: string;
        rest?: string;
        stats?: string;
        core?: string;
        notes?: string;
        favs?: string;
        lessons?: string;
        vocabCards?: string;
        sentenceTasks?: string;
        grammarTasks?: string;
        chatSessions?: string;
        mediaLibrary?: string;
      };
      if (o && typeof o.full === "string") {
        return {
          full: o.full,
          rest: typeof o.rest === "string" ? o.rest : "",
          stats: typeof o.stats === "string" ? o.stats : "",
          core: typeof o.core === "string" ? o.core : "",
          notes: typeof o.notes === "string" ? o.notes : "",
          favs: typeof o.favs === "string" ? o.favs : "",
          lessons: typeof o.lessons === "string" ? o.lessons : "",
          vocabCards: typeof o.vocabCards === "string" ? o.vocabCards : "",
          sentenceTasks: typeof o.sentenceTasks === "string" ? o.sentenceTasks : "",
          grammarTasks: typeof o.grammarTasks === "string" ? o.grammarTasks : "",
          chatSessions: typeof o.chatSessions === "string" ? o.chatSessions : "",
          mediaLibrary: typeof o.mediaLibrary === "string" ? o.mediaLibrary : "",
        };
      }
    }
    const legacy = localStorage.getItem(`${LS_CLOUD_LAST_SYNC_FINGERPRINT_PREFIX}${userId}`) ?? "";
    return { ...EMPTY_FP_PKG, full: legacy };
  } catch {
    return { ...EMPTY_FP_PKG };
  }
}

/** 在整包或增量上传成功后调用，避免下一轮误传或误判 */
export function persistCloudSyncFingerprints(userId: string, payload: AppData): void {
  if (typeof window === "undefined") return;
  const full = fingerprintAppData(payload);
  const rest = fingerprintAppDataExcludingStats(payload);
  const stats = fingerprintStatsSubtree(payload);
  const core = fingerprintContentCore(payload);
  const notes = fingerprintLessonNotesSubtree(payload);
  const favs = fingerprintFavoriteSentencesSubtree(payload);
  const lessons = fingerprintLessonsSubtree(payload);
  const vocabCards = fingerprintVocabCardsSubtree(payload);
  const sentenceTasks = fingerprintSentenceTasksSubtree(payload);
  const grammarTasks = fingerprintGrammarTasksSubtree(payload);
  const chatSessions = fingerprintChatSessionsSubtree(payload);
  const mediaLibrary = fingerprintMediaLibrarySubtree(payload);
  try {
    localStorage.setItem(
      `${LS_CLOUD_FP_PKG_PREFIX}${userId}`,
      JSON.stringify({
        full,
        rest,
        stats,
        core,
        notes,
        favs,
        lessons,
        vocabCards,
        sentenceTasks,
        grammarTasks,
        chatSessions,
        mediaLibrary,
      }),
    );
    localStorage.setItem(`${LS_CLOUD_LAST_SYNC_FINGERPRINT_PREFIX}${userId}`, full);
  } catch {
    /* ignore */
  }
}

/** 指纹包是否含「全量子树」基准（旧包仅有 core/full 时走 legacy 判定，避免把 `last.xxx === ""` 误判为子树已变）。 */
export function cloudSyncGranularFingerprintsReady(pkg: CloudSyncFingerprintPkg): boolean {
  return (
    pkg.lessons !== "" &&
    pkg.vocabCards !== "" &&
    pkg.sentenceTasks !== "" &&
    pkg.grammarTasks !== "" &&
    pkg.chatSessions !== "" &&
    pkg.mediaLibrary !== ""
  );
}

const CLOUD_DELTA_SUBTREE_KEYS = [
  "stats",
  "mediaLibrary",
  "lessonNotes",
  "favoriteSentences",
  "lessons",
  "vocabCards",
  "sentenceTasks",
  "grammarTasks",
  "chatSessions",
] as const;

export type CloudDeltaSubtreeKey = (typeof CLOUD_DELTA_SUBTREE_KEYS)[number];

export type CloudAutoSyncPlan = { kind: "skip" } | { kind: "rpc"; delta: PayloadDelta } | { kind: "upsert" };

/**
 * 自动同步：在指纹包与环境门控下决定整包 upsert 或 RPC 子树合并。
 * - `stats` / `mediaLibrary`：基线迁移后即可 RPC（media 为键合并）。
 * - `lessonNotes` / `favoriteSentences`：`NEXT_PUBLIC_CLOUD_DELTA_NOTES_FAVS=1` 或 `NEXT_PUBLIC_CLOUD_DELTA_EXTENDED=1`。
 * - 主数组：`NEXT_PUBLIC_CLOUD_DELTA_EXTENDED=1` 且指纹包已含各子树字段（成功同步过一次新版本客户端）。
 */
export function planCloudAutoSync(payload: AppData, last: CloudSyncFingerprintPkg): CloudAutoSyncPlan {
  const normalized = normalizeAppData(payload);
  const fpFull = fingerprintAppData(payload);
  if (fpFull === last.full) return { kind: "skip" };
  if (last.full === "") return { kind: "upsert" };

  const extendedEnv = process.env.NEXT_PUBLIC_CLOUD_DELTA_EXTENDED === "1";
  const notesFavsEnv = extendedEnv || process.env.NEXT_PUBLIC_CLOUD_DELTA_NOTES_FAVS === "1";

  const fpStats = fingerprintStatsSubtree(payload);
  const fpCore = fingerprintContentCore(payload);
  const fpNotes = fingerprintLessonNotesSubtree(payload);
  const fpFavs = fingerprintFavoriteSentencesSubtree(payload);
  const fpMedia = fingerprintMediaLibrarySubtree(payload);
  const fpLessons = fingerprintLessonsSubtree(payload);
  const fpVocab = fingerprintVocabCardsSubtree(payload);
  const fpSent = fingerprintSentenceTasksSubtree(payload);
  const fpGram = fingerprintGrammarTasksSubtree(payload);
  const fpChat = fingerprintChatSessionsSubtree(payload);

  const statsComparable = last.stats !== "";
  const mediaComparable = last.mediaLibrary !== "";
  const notesComparable = last.notes !== "";
  const favsComparable = last.favs !== "";
  const lessonsComparable = last.lessons !== "";
  const vocabComparable = last.vocabCards !== "";
  const sentComparable = last.sentenceTasks !== "";
  const gramComparable = last.grammarTasks !== "";
  const chatComparable = last.chatSessions !== "";

  const changed = {
    stats: statsComparable && fpStats !== last.stats,
    mediaLibrary: mediaComparable && fpMedia !== last.mediaLibrary,
    lessonNotes: notesComparable && fpNotes !== last.notes,
    favoriteSentences: favsComparable && fpFavs !== last.favs,
    lessons: lessonsComparable && fpLessons !== last.lessons,
    vocabCards: vocabComparable && fpVocab !== last.vocabCards,
    sentenceTasks: sentComparable && fpSent !== last.sentenceTasks,
    grammarTasks: gramComparable && fpGram !== last.grammarTasks,
    chatSessions: chatComparable && fpChat !== last.chatSessions,
  } satisfies Record<CloudDeltaSubtreeKey, boolean>;

  const mergeable = (k: CloudDeltaSubtreeKey): boolean => {
    if (k === "stats" || k === "mediaLibrary") return true;
    if (k === "lessonNotes" || k === "favoriteSentences") return notesFavsEnv;
    return extendedEnv;
  };

  const anyChanged = CLOUD_DELTA_SUBTREE_KEYS.some((k) => changed[k]);
  if (!anyChanged) return { kind: "upsert" };

  const granularReady = cloudSyncGranularFingerprintsReady(last);
  const unmergeable = CLOUD_DELTA_SUBTREE_KEYS.filter((k) => changed[k] && !mergeable(k));

  if (!granularReady) {
    const legacyCoreMatch = last.core !== "" && fpCore === last.core;
    if (!legacyCoreMatch) return { kind: "upsert" };
    const legacyAllowed: CloudDeltaSubtreeKey[] = ["stats", "mediaLibrary"];
    if (notesFavsEnv) legacyAllowed.push("lessonNotes", "favoriteSentences");
    for (const k of CLOUD_DELTA_SUBTREE_KEYS) {
      if (changed[k] && !legacyAllowed.includes(k)) return { kind: "upsert" };
    }
  } else if (unmergeable.length > 0) {
    return { kind: "upsert" };
  }

  const delta: PayloadDelta = {};
  if (changed.stats) {
    delta.stats = normalized.stats ?? {
      practiceMarkCorrect: 0,
      practiceMarkWrong: 0,
      practiceMarkEasy: 0,
    };
  }
  if (changed.mediaLibrary) {
    const ml = normalized.mediaLibrary ?? {};
    if (Object.keys(ml).length === 0) return { kind: "upsert" };
    delta.mediaLibrary = ml;
  }
  if (changed.lessonNotes && notesFavsEnv) delta.lessonNotes = normalized.lessonNotes;
  if (changed.favoriteSentences && notesFavsEnv) delta.favoriteSentences = normalized.favoriteSentences;
  if (changed.lessons && extendedEnv) delta.lessons = normalized.lessons;
  if (changed.vocabCards && extendedEnv) delta.vocabCards = normalized.vocabCards;
  if (changed.sentenceTasks && extendedEnv) delta.sentenceTasks = normalized.sentenceTasks;
  if (changed.grammarTasks && extendedEnv) delta.grammarTasks = normalized.grammarTasks;
  if (changed.chatSessions && extendedEnv) delta.chatSessions = normalized.chatSessions;

  if (Object.keys(delta).length === 0) return { kind: "upsert" };
  return { kind: "rpc", delta };
}

export function readLastSeenRemoteUpdatedAt(userId: string): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(`${LS_CLOUD_LAST_SEEN_REMOTE_AT_PREFIX}${userId}`) ?? "";
  } catch {
    return "";
  }
}

/** 在成功上传、自动同步写云、或从云端恢复后调用，便于检测「云端是否在他处又更新过」。 */
export function persistLastSeenRemoteUpdatedAt(userId: string, iso: string): void {
  if (typeof window === "undefined" || !iso) return;
  try {
    localStorage.setItem(`${LS_CLOUD_LAST_SEEN_REMOTE_AT_PREFIX}${userId}`, iso);
  } catch {
    /* ignore */
  }
}

/**
 * 云端行 `updated_at` 是否晚于本机记录的「上次确认过的云端时间」。
 * 与恢复前确认文案中的「云端可能又更新过」同口径（需已有 lastSeen，避免新设备误报）。
 */
export function isCloudUpdatedAfterLastSeen(userId: string, remoteUpdatedAt: string | null): boolean {
  const lastSeen = readLastSeenRemoteUpdatedAt(userId);
  return (
    lastSeen !== "" &&
    remoteUpdatedAt != null &&
    remoteUpdatedAt.length > 0 &&
    remoteUpdatedAt > lastSeen
  );
}

/** 本机是否像「有真学习数据」——从未同步过时用于恢复前一句白话提示。 */
/** 不含 `stats` / `mediaLibrary`：课文 / 词卡 / 题库 / 聊天 / 笔记 / 收藏句总条数（用于防「空壳」冲掉云端）。 */
export function learningCoreEntryCount(data: AppData): number {
  const n = normalizeAppData(data);
  return (
    n.lessons.length +
    n.vocabCards.length +
    n.sentenceTasks.length +
    n.grammarTasks.length +
    (n.chatSessions?.length ?? 0) +
    (n.lessonNotes?.length ?? 0) +
    (n.favoriteSentences?.length ?? 0)
  );
}

/** 手/自动上传被拦截时与 UI 共用的说明（防空壳冲掉云端）。 */
export const BARE_SHELL_WOULD_WIPE_REMOTE_MESSAGE =
  "已拦截：本机是空壳数据（课文/词卡/题库与统计、媒体等均无占用），但云端该账号仍有资料。继续上传会把云端冲掉。请先用「从云端对齐」以云端为准拉回，或从有数据的设备导入 JSON 后再上传。";

/**
 * 是否等价于「无可保留的学习快照」：无核心数组条目、无统计占用、无媒体库键。
 * 用于与云端快照对比，避免仅因远端课文数组被清空就放行整包上传。
 */
export function appDataIsBareShellForCloudUpload(data: AppData): boolean {
  const n = normalizeAppData(data);
  if (learningCoreEntryCount(n) > 0) return false;
  if (localAppDataLooksNonEmpty(n)) return false;
  const ml = n.mediaLibrary ?? {};
  return Object.keys(ml).length === 0;
}

/** 纯函数版拦截条件（便于单测）；异步版内部复用。 */
export function shouldBlockBareShellUploadOverRemotePayload(local: AppData, remotePayload: AppData): boolean {
  return appDataIsBareShellForCloudUpload(local) && !appDataIsBareShellForCloudUpload(remotePayload);
}

/** RPC delta 里是否携带「主数组空数组」——在空本机 + 云端有资料时可能误清远端条目。 */
export function payloadDeltaHasEmptyMainArray(delta: PayloadDelta): boolean {
  const keys: (keyof PayloadDelta)[] = [
    "lessons",
    "vocabCards",
    "sentenceTasks",
    "grammarTasks",
    "chatSessions",
    "lessonNotes",
    "favoriteSentences",
  ];
  for (const k of keys) {
    const v = delta[k];
    if (v !== undefined && Array.isArray(v) && v.length === 0) return true;
  }
  return false;
}

/**
 * 本机为「空壳」但云端快照仍含可保留数据（课文/统计/媒体等任一）：整包 upsert 或带空主数组的 RPC 会冲掉云端。
 * 用于跳过自动同步或拦截手动上传（stats-only RPC 不受影响）。
 */
export async function shouldBlockSyncThatWouldWipeRemoteCore(sb: SupabaseClient, local: AppData): Promise<boolean> {
  if (!appDataIsBareShellForCloudUpload(local)) return false;
  const meta = await fetchRemoteSyncGuardMeta(sb);
  if (meta != null) {
    if (!meta.exists) return false;
    return !meta.bareShell;
  }
  const snap = await fetchUserAppDataFromCloud(sb);
  if (!snap) return false;
  return !appDataIsBareShellForCloudUpload(snap.payload);
}

export function localAppDataLooksNonEmpty(data: AppData): boolean {
  const n = normalizeAppData(data);
  if (learningCoreEntryCount(n) > 0) return true;
  const s = n.stats;
  if (!s) return false;
  if ((s.practiceMarkCorrect ?? 0) + (s.practiceMarkWrong ?? 0) + (s.practiceMarkEasy ?? 0) > 0) return true;
  if ((s.dwellLessonReaderSec ?? 0) > 0 || (s.dwellPracticeSec ?? 0) > 0) return true;
  if (s.daily && Object.keys(s.daily).length > 0) return true;
  return false;
}

/** 与「从云端对齐」弹层共用的情境判断（不含操作说明首段）。 */
export type CloudRestoreScenario = {
  hadSyncBefore: boolean;
  localUnsynced: boolean;
  cloudPossiblyNewer: boolean;
  localLooksNonEmptyWhenNeverSynced: boolean;
};

export function getCloudRestoreScenario(userId: string, localPayload: AppData, remoteUpdatedAt: string | null): CloudRestoreScenario {
  const pkg = readCloudSyncFingerprintPkg(userId);
  const fpNow = fingerprintAppData(localPayload);
  const hadSyncBefore = pkg.full !== "";
  return {
    hadSyncBefore,
    localUnsynced: hadSyncBefore && fpNow !== pkg.full,
    cloudPossiblyNewer: isCloudUpdatedAfterLastSeen(userId, remoteUpdatedAt),
    localLooksNonEmptyWhenNeverSynced: !hadSyncBefore && localAppDataLooksNonEmpty(localPayload),
  };
}

/** 弹层内展示的提醒列表（白话，无「CRDT」等术语）。 */
export function cloudRestoreScenarioHints(s: CloudRestoreScenario): string[] {
  const hints: string[] = [];
  if (s.localLooksNonEmptyWhenNeverSynced) {
    hints.push("说明：您本机还从来没有成功同步到这个登录账号。如果云端几乎是空的或很旧，一恢复反而可能把本机已有内容冲掉。");
  }
  if (s.localUnsynced) {
    hints.push("提醒：本机内容和上次成功上传到云端时的样子不一样。继续的话，这段还没上传的进度会丢掉。");
  }
  if (s.cloudPossiblyNewer) {
    hints.push("提醒：按本机记录，云端在您上次确认的时间之后可能又更新过（例如在别的电脑或浏览器里上传过）。");
  }
  if (s.localUnsynced && s.cloudPossiblyNewer) {
    hints.push("以上两条可能同时成立：请一定先导出本机，想清楚再恢复。");
  }
  return hints;
}

/**
 * 从云端恢复前用的确认文案（整段给 `window.confirm`；新 UI 优先用 `getCloudRestoreScenario` + 弹层）。
 * 不引入「冲突 / merge」术语，只说明可能丢进度、可能云端已变。
 */
export function describeCloudRestoreConfirmText(
  userId: string,
  localPayload: AppData,
  remoteUpdatedAt: string | null,
): string {
  const s = getCloudRestoreScenario(userId, localPayload, remoteUpdatedAt);
  const blocks: string[] = [];
  blocks.push("确定要用云端的学习数据覆盖本机吗？覆盖后，本浏览器里现在的进度会被换成云端那一套。");
  blocks.push("建议先到「数据」页点「导出备份」，把当前进度存成 JSON，再点确定继续。");
  blocks.push(...cloudRestoreScenarioHints(s));
  return blocks.join("\n\n");
}
