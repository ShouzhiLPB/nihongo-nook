/**
 * i2-3：大体积 data URL（封面 / 课文音频 / 内嵌视频）按内容去重进 `mediaLibrary`，课文仅存 `*MediaKey`。
 * 哈希为同步 FNV-1a 32 位 + 长度，极低碰撞概率下用 `_1`、`_2` 后缀分桶。
 */
import type { AppData, AppMediaKind, AppMediaResource, Lesson } from "@/shared/types";

function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function stableMediaKeyBase(dataUrl: string): string {
  return `m${fnv1a32Hex(dataUrl)}_${dataUrl.length}`;
}

function normalizeMediaLibraryRaw(raw: unknown): Record<string, AppMediaResource> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, AppMediaResource> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || typeof v !== "object" || v === null || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    const dataUrl = typeof o.dataUrl === "string" && o.dataUrl.startsWith("data:") ? o.dataUrl : "";
    if (!dataUrl) continue;
    const kind = o.kind === "listeningAudio" || o.kind === "videoData" ? o.kind : "cover";
    out[k] = { kind, dataUrl };
  }
  return out;
}

/** 解析课文封面图 src（内联或 mediaLibrary）。支持 data URL 与 http(s) 外链图（便于粘贴图床 / CDN 地址）。 */
export function resolveLessonCoverSrc(lesson: Lesson, lib: AppData["mediaLibrary"]): string | undefined {
  const k = lesson.coverIllustrationMediaKey;
  if (k && lib?.[k]?.dataUrl) return lib[k].dataUrl;
  const u = lesson.coverIllustrationDataUrl?.trim();
  if (!u) return undefined;
  if (u.startsWith("data:")) return u;
  if (/^https?:\/\//i.test(u)) return u;
  return undefined;
}

/** 解析课文音频 data URL */
export function resolveLessonListeningAudioSrc(lesson: Lesson, lib: AppData["mediaLibrary"]): string | undefined {
  const k = lesson.listeningAudioMediaKey;
  if (k && lib?.[k]?.dataUrl) return lib[k].dataUrl;
  const u = lesson.listeningAudioDataUrl;
  return typeof u === "string" && u.startsWith("data:") ? u : undefined;
}

/** 视频：http(s) 等外链保留 `videoSourceUrl`；仅 data: 走 mediaLibrary */
export function resolveLessonVideoSrc(lesson: Lesson, lib: AppData["mediaLibrary"]): string | undefined {
  const k = lesson.videoSourceMediaKey;
  if (k && lib?.[k]?.dataUrl) return lib[k].dataUrl;
  const u = lesson.videoSourceUrl;
  return typeof u === "string" && u.length > 0 ? u : undefined;
}

function lessonHasInlineDataMedia(lesson: Lesson): boolean {
  return Boolean(
    lesson.coverIllustrationDataUrl?.startsWith("data:") ||
      lesson.listeningAudioDataUrl?.startsWith("data:") ||
      lesson.videoSourceUrl?.startsWith("data:"),
  );
}

/**
 * 将内联 data URL 迁入 `mediaLibrary` 并改写课文引用；外链 `videoSourceUrl` 不变。
 * 在 `normalizeAppData` 末尾调用（输入已是字段合法的 Lesson[]）。
 */
export function dedupeMediaInAppData(data: AppData): AppData {
  const hadLibrary = data.mediaLibrary && Object.keys(data.mediaLibrary).length > 0;
  const needsInlineMigration = data.lessons.some(lessonHasInlineDataMedia);
  if (!needsInlineMigration && !hadLibrary) {
    return data;
  }

  const lib = normalizeMediaLibraryRaw(data.mediaLibrary);

  function assignKey(dataUrl: string, kind: AppMediaKind): string {
    let base = stableMediaKeyBase(dataUrl);
    let key = base;
    let n = 0;
    while (lib[key] && lib[key].dataUrl !== dataUrl) {
      n += 1;
      key = `${base}_${n}`;
    }
    if (!lib[key]) lib[key] = { kind, dataUrl };
    return key;
  }

  const nextLessons = data.lessons.map((lesson) => {
    let L: Lesson = { ...lesson };

    if (L.coverIllustrationDataUrl?.startsWith("data:")) {
      const key = assignKey(L.coverIllustrationDataUrl, "cover");
      L = {
        ...L,
        coverIllustrationMediaKey: key,
        coverIllustrationDataUrl: undefined,
      };
    } else if (L.coverIllustrationMediaKey) {
      const entry = lib[L.coverIllustrationMediaKey];
      if (entry?.dataUrl) {
        L = { ...L, coverIllustrationDataUrl: undefined };
      } else {
        L = { ...L, coverIllustrationMediaKey: undefined };
      }
    }

    if (L.listeningAudioDataUrl?.startsWith("data:")) {
      const key = assignKey(L.listeningAudioDataUrl, "listeningAudio");
      L = {
        ...L,
        listeningAudioMediaKey: key,
        listeningAudioDataUrl: undefined,
      };
    } else if (L.listeningAudioMediaKey) {
      const entry = lib[L.listeningAudioMediaKey];
      if (entry?.dataUrl) {
        L = { ...L, listeningAudioDataUrl: undefined };
      } else {
        L = { ...L, listeningAudioMediaKey: undefined };
      }
    }

    if (L.videoSourceUrl?.startsWith("data:")) {
      const key = assignKey(L.videoSourceUrl, "videoData");
      L = {
        ...L,
        videoSourceMediaKey: key,
        videoSourceUrl: undefined,
      };
    } else if (L.videoSourceMediaKey) {
      const entry = lib[L.videoSourceMediaKey];
      if (entry?.dataUrl) {
        L = { ...L, videoSourceUrl: undefined };
      } else {
        L = { ...L, videoSourceMediaKey: undefined };
      }
    }

    return L;
  });

  const used = new Set<string>();
  for (const L of nextLessons) {
    if (L.coverIllustrationMediaKey) used.add(L.coverIllustrationMediaKey);
    if (L.listeningAudioMediaKey) used.add(L.listeningAudioMediaKey);
    if (L.videoSourceMediaKey) used.add(L.videoSourceMediaKey);
  }
  const pruned: Record<string, AppMediaResource> = {};
  for (const k of used) {
    const e = lib[k];
    if (e) pruned[k] = e;
  }

  return {
    ...data,
    lessons: nextLessons,
    mediaLibrary: Object.keys(pruned).length > 0 ? pruned : undefined,
  };
}
