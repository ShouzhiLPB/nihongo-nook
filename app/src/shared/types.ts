export type PromptMode = "fast" | "deep";

export type PracticeKind = "vocab" | "sentence" | "grammar";

export type Choice = {
  id: string;
  text: string;
  correct?: boolean;
};

export type VocabMeaning = {
  zh: string;
  example: string;
};

export type VocabCard = {
  id: string;
  lessonId: string;
  term: string;
  kana: string;
  meanings: VocabMeaning[];
  etymology: string;
  /** 三道错误日语干扰项；练习时与 `term` 合并为四选一 */
  vocabDistractors: string[];
  /** 三道错误中文义项干扰；日→中四选一用 */
  vocabZhDistractors: string[];
  latestExample: string;
  mastery: number;
  /** SRS 阶段 0–4；答对满档后再答对一次即毕业 */
  reviewStage?: number;
  /** 本地 yyyy-MM-dd，到日才进入「今日待刷」 */
  nextReviewDay?: string;
  /** 已从 SRS 队列毕业，不再出现 */
  reviewGraduated?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SentenceTask = {
  id: string;
  lessonId: string;
  /** 句题来源：翻译题 / 听写题 */
  sourceType?: "translation" | "listening";
  /** AI 讲解：知识点、语感、原汁原味表达体会（旧数据可为空） */
  teachingNote?: string;
  zh: string;
  jpAnswer: string;
  tokens: string[];
  mastery: number;
  reviewStage?: number;
  nextReviewDay?: string;
  reviewGraduated?: boolean;
  createdAt: string;
};

export type GrammarTask = {
  id: string;
  lessonId: string;
  /** 题目来源原句（用于练习区回看） */
  sourceSentence?: string;
  prompt: string;
  /** 题干中文译文（主要用于填空模式下的精准理解） */
  zhPrompt?: string;
  choices: Choice[];
  answerId: string;
  explanation: string;
  wrongReasonByChoiceId?: Record<string, string>;
  knowledgePoint?: string;
  mastery: number;
  reviewStage?: number;
  nextReviewDay?: string;
  reviewGraduated?: boolean;
  createdAt: string;
};

export type Lesson = {
  id: string;
  name: string;
  content: string;
  /** 课文分类，用于筛选与归档 */
  category: string;
  /** 作者；保存时若留空则存为「著者不明」 */
  author?: string;
  createdAt: string;
  /** 最近保存时间，用于列表排序；旧数据可与 createdAt 相同 */
  updatedAt?: string;
  /**
   * 与 content 按换行拆分后的行一一对应；空行对应空字符串。
   * 一键全译后写入本地并随导入导出备份。
   */
  lineTranslations?: string[];
  /** false 时隐藏已保存的译文展示（数据仍保留） */
  translationVisible?: boolean;
  /**
   * 整课配图：可为 data URL（AI 生成）或 **https? 外链图片**（图床/CDN）；外链不入 mediaLibrary 去重，体积由远端控制。
   */
  coverIllustrationDataUrl?: string;
  /** 配图在 `AppData.mediaLibrary` 中的键（与内联二选一，规范化后仅存 key） */
  coverIllustrationMediaKey?: string;
  /**
   * 本地上传的课文音频（data URL）。用于听力/跟读 MVP，不依赖外部存储。
   */
  listeningAudioDataUrl?: string;
  listeningAudioMediaKey?: string;
  /** 视频课文来源 URL：推荐 YouTube/B 站观看页或 .mp4 直链（仅存 http(s)，便于云端同步；不再把整文件 mp4 以 data URL 入库） */
  videoSourceUrl?: string;
  /** 仅当视频源为内联 data URL 时使用，外链仍用 `videoSourceUrl` */
  videoSourceMediaKey?: string;
  /** 视频字幕/分句时间轴（用于跟读点句 seek） */
  videoCues?: LessonVideoCue[];
  /** 课文形态：文本 / 视频（用于创建流程与 UI 引导） */
  lessonKind?: "text" | "video";
  /** 移入废纸篓的 UTC 时间；有值时自课文主列表隐藏，练习/统计不计该课下属题，直至恢复或永久删除 */
  trashedAt?: string;
};

export type LessonVideoCue = {
  startSec: number;
  endSec: number;
  text: string;
};

/** 与 `AppData.mediaLibrary` 条目一致：data URL 体积大，按哈希去重后课文仅存 key */
export type AppMediaKind = "cover" | "listeningAudio" | "videoData";

export type AppMediaResource = {
  kind: AppMediaKind;
  dataUrl: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type ChatSession = {
  id: string;
  lessonId: string;
  title: string;
  mode: PromptMode;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};

/** 课文阅读内随手记，纯文本 */
export type LessonNote = {
  id: string;
  lessonId: string;
  /** 书签标题（为空时由内容首行回退） */
  title?: string;
  content: string;
  /** 关联正文行号（可跳转） */
  lineIndex?: number;
  createdAt: string;
  updatedAt: string;
};

/** 从正文中收藏的重点句 */
export type LessonFavoriteSentence = {
  id: string;
  lessonId: string;
  jp: string;
  /** 对应行译文（若有） */
  zhHint?: string;
  /** 与 lessonContentLines 行号一致，用于回跳 */
  lineIndex?: number;
  createdAt: string;
};

/** 单日统计桶（`stats.daily[yyyy-MM-dd]`） */
export type AppStatsDayBucket = {
  practiceMarkCorrect: number;
  practiceMarkWrong: number;
  practiceMarkEasy: number;
  dwellLessonReaderSec: number;
  dwellPracticeSec: number;
};

/** 练习自报/自动判分累计 + 停留时长（Epic D，随数据导入导出） */
export type AppStatsCounters = {
  practiceMarkCorrect: number;
  practiceMarkWrong: number;
  practiceMarkEasy: number;
  /** 课文阅读全屏打开且标签页处于前台时的累计秒数（1s 粒度） */
  dwellLessonReaderSec?: number;
  /** 顶部「练习」标签且页面前台时的累计秒数 */
  dwellPracticeSec?: number;
  /** 按日历日聚合的过往明细（用于区间统计） */
  daily?: Record<string, AppStatsDayBucket>;
};

export type AppData = {
  lessons: Lesson[];
  vocabCards: VocabCard[];
  sentenceTasks: SentenceTask[];
  grammarTasks: GrammarTask[];
  chatSessions: ChatSession[];
  lessonNotes: LessonNote[];
  favoriteSentences: LessonFavoriteSentence[];
  stats?: AppStatsCounters;
  /** 大媒体按内容去重（i2-3）；课文通过 `*MediaKey` 引用 */
  mediaLibrary?: Record<string, AppMediaResource>;
};

