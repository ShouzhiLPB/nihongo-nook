import { describe, expect, it } from "vitest";
import { addCalendarDaysLocal, calendarTodayLocal } from "@/shared/utils";
import {
  daysAfterWrongForStage,
  filterDueReviewItems,
  isReviewDue,
  normalizeReviewStage,
  patchAfterCorrect,
  patchAfterWrong,
  sortByReviewPriority,
} from "./scheduler";

describe("scheduler SRS", () => {
  it("daysAfterWrongForStage matches上一档间隔", () => {
    expect(daysAfterWrongForStage(0)).toBe(0);
    expect(daysAfterWrongForStage(1)).toBe(1);
    expect(daysAfterWrongForStage(2)).toBe(3);
    expect(daysAfterWrongForStage(3)).toBe(7);
    expect(daysAfterWrongForStage(4)).toBe(14);
  });

  it("答错降档并按上一档间隔排日历日", () => {
    const today = calendarTodayLocal();
    const base = { mastery: 75, createdAt: "2026-01-01T00:00:00.000Z", reviewStage: 3, nextReviewDay: today, reviewGraduated: false };
    const p = patchAfterWrong(base);
    expect(p.reviewStage).toBe(2);
    expect(p.nextReviewDay).toBe(addCalendarDaysLocal(today, 3));
    expect(p.reviewGraduated).toBe(false);
  });

  it("答对推进档并设置下次出现日", () => {
    const today = calendarTodayLocal();
    const base = { mastery: 0, createdAt: "2026-01-01T00:00:00.000Z", reviewStage: 0, nextReviewDay: today, reviewGraduated: false };
    const p = patchAfterCorrect(base, "correct");
    expect(p?.reviewStage).toBe(1);
    expect(p?.nextReviewDay).toBe(addCalendarDaysLocal(today, 1));
  });

  it("太简单直接毕业", () => {
    const today = calendarTodayLocal();
    const base = { mastery: 25, createdAt: "2026-01-01T00:00:00.000Z", reviewStage: 1, nextReviewDay: today, reviewGraduated: false };
    const p = patchAfterCorrect(base, "easy");
    expect(p?.reviewGraduated).toBe(true);
    expect(p?.mastery).toBe(100);
    expect(p?.reviewStage).toBe(4);
  });

  it("stage4 再答对则毕业", () => {
    const today = calendarTodayLocal();
    const base = { mastery: 100, createdAt: "2026-01-01T00:00:00.000Z", reviewStage: 4, nextReviewDay: today, reviewGraduated: false };
    const p = patchAfterCorrect(base, "correct");
    expect(p?.reviewGraduated).toBe(true);
    expect(p?.mastery).toBe(100);
  });

  it("已毕业不再 patch", () => {
    const today = calendarTodayLocal();
    const base = { mastery: 100, createdAt: "2026-01-01T00:00:00.000Z", reviewStage: 4, nextReviewDay: today, reviewGraduated: true };
    expect(patchAfterCorrect(base, "correct")).toBeNull();
  });

  it("sortByReviewPriority：仅今日到期且按 createdAt 升序", () => {
    const today = calendarTodayLocal();
    const a = { mastery: 10, createdAt: "2026-01-01T00:00:00.000Z", reviewStage: 0, nextReviewDay: today, reviewGraduated: false };
    const b = { mastery: 50, createdAt: "2026-02-01T00:00:00.000Z", reviewStage: 1, nextReviewDay: today, reviewGraduated: false };
    const sorted = sortByReviewPriority([b, a]);
    expect(sorted[0]?.createdAt).toBe(a.createdAt);
  });

  it("filterDueReviewItems 排除未到期与已毕业", () => {
    const today = calendarTodayLocal();
    const future = addCalendarDaysLocal(today, 99);
    const items = [
      { mastery: 0, createdAt: "2026-01-01T00:00:00.000Z", reviewStage: 0, nextReviewDay: today, reviewGraduated: false },
      { mastery: 0, createdAt: "2026-02-01T00:00:00.000Z", reviewStage: 0, nextReviewDay: future, reviewGraduated: false },
      { mastery: 100, createdAt: "2026-03-01T00:00:00.000Z", reviewStage: 4, nextReviewDay: today, reviewGraduated: true },
    ];
    const due = filterDueReviewItems(items, today);
    expect(due).toHaveLength(1);
  });

  it("未到期时 patchAfterCorrect 返回 null（防误操作）", () => {
    const today = calendarTodayLocal();
    const future = addCalendarDaysLocal(today, 3);
    const base = { mastery: 0, createdAt: "2026-01-01T00:00:00.000Z", reviewStage: 0, nextReviewDay: future, reviewGraduated: false };
    expect(patchAfterCorrect(base, "correct")).toBeNull();
    expect(patchAfterCorrect(base, "easy")).toBeNull();
  });

  it("patchAfterWrong 不会把已毕业条目复活", () => {
    const today = calendarTodayLocal();
    const p = patchAfterWrong({
      mastery: 100,
      createdAt: "2026-01-01T00:00:00.000Z",
      reviewStage: 4,
      nextReviewDay: today,
      reviewGraduated: true,
    });
    expect(p.reviewGraduated).toBe(true);
    expect(p.mastery).toBe(100);
    expect(p.reviewStage).toBe(4);
  });

  it("normalizeReviewStage 将越界值收敛到 0..4", () => {
    expect(normalizeReviewStage(undefined)).toBe(0);
    expect(normalizeReviewStage(-2)).toBe(0);
    expect(normalizeReviewStage(2.9)).toBe(2);
    expect(normalizeReviewStage(99)).toBe(4);
  });

  it("isReviewDue 与 filterDueReviewItems 单项口径一致", () => {
    const today = calendarTodayLocal();
    const item = { mastery: 0, createdAt: "2026-01-01T00:00:00.000Z", reviewStage: 0, nextReviewDay: today, reviewGraduated: false };
    expect(isReviewDue(item, today)).toBe(true);
    expect(filterDueReviewItems([item], today)).toHaveLength(1);
  });
});
