import { normalizeAppData } from "@/modules/storage/dataStore";
import type { AppData } from "@/shared/types";

/**
 * 浏览器下载云端 JSON 时的建议文件名（不含扩展名）。
 * 仅用于展示与落盘，避免路径分隔符等非法字符。
 */
export function buildCloudBackupDownloadBasename(remoteUpdatedAt: string, userId: string): string {
  const safeUser = userId.replace(/[^a-z0-9_-]/gi, "").slice(0, 20) || "user";
  const d = new Date(remoteUpdatedAt);
  const stamp = Number.isNaN(d.getTime())
    ? "unknown-time"
    : d.toISOString().replace(/:/g, "").replace(/\.\d{3}Z$/, "Z");
  return `jp-learn-cloud-backup_${safeUser}_${stamp}`;
}

/** 与本机导出一致：规范化后带缩进的 JSON（末尾换行）。 */
export function appDataToIndentedJsonDownload(payload: AppData): string {
  return `${JSON.stringify(normalizeAppData(payload), null, 2)}\n`;
}
