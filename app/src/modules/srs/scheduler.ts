import { addCalendarDaysLocal, calendarDayFromIso, calendarTodayLocal } from "@/shared/utils";

export type ReviewFeedback = "correct" | "wrong" | "easy";

/** 在 stage 上答对后，到「下一档」复习的间隔（天）；stage 4 答对则毕业 */
export const DAYS_AFTER_SUCCESS_FROM_STAGE: Record<number, number> = {
  0: 1,
  1: 3,
  2: 7,
  3: 14,
};

export type ReviewSortable = {
  mastery: number;
  createdAt: string;
  reviewStage?: number;
  nextReviewDay?: string;
  reviewGraduated?: boolean;
};

/** 防脏数据：reviewStage 统一收敛到 0..4 */
export function normalizeReviewStage(stage: number | undefined): number {
  if (!Number.isFinite(stage)) return 0;
  return Math.min(4, Math.max(0, Math.floor(stage ?? 0)));
}

/** 退回 stage 后，按「上一档应有的间隔」排下次出现日（从今日 0 点起算日历天） */
export function daysAfterWrongForStage(stage: number): number {
  if (stage <= 0) return 0;
  return DAYS_AFTER_SUCCESS_FROM_STAGE[stage - 1] ?? 0;
}

export function filterDueReviewItems<T extends ReviewSortable>(items: T[], today: string = calendarTodayLocal()): T[] {
  return items.filter((x) => {
    return isReviewDue(x, today);
  });
}

export function isReviewDue(item: ReviewSortable, today: string = calendarTodayLocal()): boolean {
  if (item.reviewGraduated) return false;
  const day = item.nextReviewDay ?? calendarDayFromIso(item.createdAt);
  return day <= today;
}

/** 今日待刷：未毕业且 nextReviewDay≤今天；同日按 createdAt 升序（先建的词卡先刷） */
export function sortByReviewPriority<T extends ReviewSortable>(items: T[]): T[] {
  const due = filterDueReviewItems(items);
  return [...due].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** 兼容旧逻辑：熟练度加减（新 SRS 以 reviewStage / nextReviewDay 为准，本函数仅作兜底） */
export function updateMastery(current: number, feedback: ReviewFeedback): number {
  if (feedback === "easy") {
    return Math.min(100, current + 20);
  }
  if (feedback === "correct") {
    return Math.min(100, current + 10);
  }
  return Math.max(0, current - 25);
}

function masteryForStage(stage: number, graduated: boolean): number {
  if (graduated) return 100;
  return Math.min(100, Math.max(0, stage) * 25);
}

export type SrsPatch = {
  reviewStage: number;
  nextReviewDay: string;
  mastery: number;
  reviewGraduated: boolean;
  updatedAt?: string;
};

/** 「太简单」直接毕业；「答对」则推进一档并按间隔排下次出现日；stage 4 再答对亦毕业 */
export function patchAfterCorrect(item: ReviewSortable, feedback: ReviewFeedback): SrsPatch | null {
  if (item.reviewGraduated) return null;
  if (feedback === "wrong") return null;

  const today = calendarTodayLocal();
  if (!isReviewDue(item, today)) return null;

  if (feedback === "easy") {
    return {
      reviewStage: 4,
      nextReviewDay: item.nextReviewDay ?? today,
      mastery: 100,
      reviewGraduated: true,
    };
  }

  if (feedback !== "correct") return null;

  const stage = normalizeReviewStage(item.reviewStage);

  if (stage >= 4) {
    return {
      reviewStage: 4,
      nextReviewDay: item.nextReviewDay ?? today,
      mastery: 100,
      reviewGraduated: true,
    };
  }

  const newStage = stage + 1;
  const add = DAYS_AFTER_SUCCESS_FROM_STAGE[stage];
  if (add === undefined) {
    return {
      reviewStage: 4,
      nextReviewDay: today,
      mastery: 100,
      reviewGraduated: true,
    };
  }
  const nextReviewDay = addCalendarDaysLocal(today, add);
  return {
    reviewStage: newStage,
    nextReviewDay,
    mastery: masteryForStage(newStage, false),
    reviewGraduated: false,
  };
}

/** 答错：降一档，按上一档间隔从今日起排下次日历日 */
export function patchAfterWrong(item: ReviewSortable): SrsPatch {
  const today = calendarTodayLocal();
  if (item.reviewGraduated) {
    return {
      reviewStage: 4,
      nextReviewDay: item.nextReviewDay ?? today,
      mastery: 100,
      reviewGraduated: true,
    };
  }
  const stage = normalizeReviewStage(item.reviewStage);
  const newStage = Math.max(0, stage - 1);
  const add = daysAfterWrongForStage(newStage);
  const nextReviewDay = addCalendarDaysLocal(today, add);
  return {
    reviewStage: newStage,
    nextReviewDay,
    mastery: masteryForStage(newStage, false),
    reviewGraduated: false,
  };
}

/** 新建条目默认 SRS 字段（今日即入队，按本地日历日） */
export function defaultSrsForNewItem(): Pick<ReviewSortable, "reviewStage" | "nextReviewDay" | "reviewGraduated" | "mastery"> {
  return {
    reviewStage: 0,
    nextReviewDay: calendarTodayLocal(),
    reviewGraduated: false,
    mastery: 0,
  };
}

/** 从旧数据推断 SRS 缺省（无 nextReviewDay 时） */
export function inferSrsDefaults(item: ReviewSortable): SrsPatch {
  const day = item.nextReviewDay ?? calendarDayFromIso(item.createdAt);
  if (item.reviewGraduated || (item.mastery ?? 0) >= 100) {
    return {
      reviewStage: 4,
      nextReviewDay: day,
      mastery: 100,
      reviewGraduated: true,
    };
  }
  const stage = Math.min(4, Math.max(0, Math.floor((item.mastery ?? 0) / 25)));
  return {
    reviewStage: stage,
    nextReviewDay: day,
    mastery: masteryForStage(stage, false),
    reviewGraduated: false,
  };
}
