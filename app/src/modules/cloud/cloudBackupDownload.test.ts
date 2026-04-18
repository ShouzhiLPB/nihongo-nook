import { describe, expect, it } from "vitest";
import { normalizeAppData } from "@/modules/storage/dataStore";
import type { AppData } from "@/shared/types";
import { appDataToIndentedJsonDownload, buildCloudBackupDownloadBasename } from "./cloudBackupDownload";

const empty: AppData = {
  lessons: [],
  vocabCards: [],
  sentenceTasks: [],
  grammarTasks: [],
  chatSessions: [],
  lessonNotes: [],
  favoriteSentences: [],
};

describe("buildCloudBackupDownloadBasename", () => {
  it("uses ISO-like stamp and strips odd chars from user id", () => {
    const b = buildCloudBackupDownloadBasename("2026-04-17T12:34:56.789Z", "user|abc/12");
    expect(b).toBe("jp-learn-cloud-backup_userabc12_2026-04-17T123456Z");
  });

  it("falls back when updatedAt is invalid", () => {
    const b = buildCloudBackupDownloadBasename("not-a-date", "!!!");
    expect(b).toBe("jp-learn-cloud-backup_user_unknown-time");
  });
});

describe("appDataToIndentedJsonDownload", () => {
  it("ends with newline and parses back", () => {
    const n = normalizeAppData({ ...empty, lessons: [] });
    const s = appDataToIndentedJsonDownload(n);
    expect(s.endsWith("\n")).toBe(true);
    expect(JSON.parse(s)).toEqual(JSON.parse(JSON.stringify(n)));
  });
});
