"use client";

import type { Session, User } from "@supabase/supabase-js";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appDataToIndentedJsonDownload, buildCloudBackupDownloadBasename } from "@/modules/cloud/cloudBackupDownload";
import { humanMergeConflictHints } from "@/modules/cloud/cloudMergeHumanDiff";
import { mergeAppDataLocalAndRemote, type MergeConflictPicks } from "@/modules/cloud/cloudAppDataMerge";
import {
  filterIdsBySubstring,
  getMergeRowNormalizedJsonPair,
  getMergeStatsJsonPair,
  summarizeAppDataMerge,
  type MergeSliceKey,
} from "@/modules/cloud/cloudMergePreview";
import {
  BARE_SHELL_WOULD_WIPE_REMOTE_MESSAGE,
  cloudRestoreScenarioHints,
  fetchUserAppDataFromCloud,
  fetchUserAppRemoteUpdatedAt,
  fingerprintAppData,
  getCloudRestoreScenario,
  learningCoreEntryCount,
  persistCloudSyncFingerprints,
  persistLastSeenRemoteUpdatedAt,
  readCloudSyncFingerprintPkg,
  shouldBlockSyncThatWouldWipeRemoteCore,
  upsertUserAppDataToCloud,
} from "@/modules/cloud/cloudUserAppData";
import { formatUnknownError } from "@/modules/cloud/formatUnknownError";
import { MergeLessonContentLineDiff, tryLessonContentPairFromNormJson } from "@/modules/cloud/mergeLessonContentLineDiff";
import { getSupabaseBrowserClient, isSupabaseBrowserConfigured } from "@/modules/cloud/supabaseBrowserClient";
import type { AppData } from "@/shared/types";

export type CloudAuthPanelProps = {
  /** 当前本机学习数据（与 IndexedDB 一致） */
  localAppData: AppData;
  /** 用云端快照覆盖本机（会先经 `normalizeAppData`） */
  onApplyCloudPayload: (data: AppData) => void;
  /** 上传/恢复/防抖上云成功后通知宿主（如清「云端有更新」横幅） */
  onCloudSyncSuccess?: () => void;
  /** authOnly: 仅登录注册；full: 含上传/恢复等完整云端操作 */
  mode?: "full" | "authOnly";
  /** full 时：syncOnly 仅保留登录与「同步数据」，隐藏下载副本与对齐向导（设置页简化） */
  cloudToolbar?: "full" | "syncOnly";
  /** 透传给最外层容器，便于在弹窗中复用 */
  className?: string;
};

function userLabel(user: User | null): string {
  if (!user) return "";
  return user.email ?? user.id;
}

type RemoteState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; updatedAt: string | null }
  | { kind: "error"; message: string };

type SyncState =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "ok"; at: string }
  | { kind: "error"; message: string };

type CloudPanelOp = "idle" | "upload" | "align_fetch" | "download_cloud" | "apply";

function formatCloudTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
}

const MERGE_PREVIEW_ID_CAP = 14;
const MERGE_JSON_DIFF_MAX = 12_000;
/** 合并弹层内「同 id 冲突」逐条控件最多展示条数（其余请用筛选缩小） */
const MERGE_CONFLICT_PICK_UI_CAP = 48;

function clampJsonText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（已截断，共 ${s.length} 字符）`;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function formatIdSnippet(ids: string[], cap: number): { text: string; rest: number } {
  if (ids.length === 0) return { text: "", rest: 0 };
  if (ids.length <= cap) return { text: ids.join("、"), rest: 0 };
  return { text: ids.slice(0, cap).join("、"), rest: ids.length - cap };
}

export function CloudAuthPanel({
  localAppData,
  onApplyCloudPayload,
  onCloudSyncSuccess,
  mode = "full",
  cloudToolbar = "full",
  className = "",
}: CloudAuthPanelProps) {
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [cloudOp, setCloudOp] = useState<CloudPanelOp>("idle");
  const [cloudPhaseHint, setCloudPhaseHint] = useState("");
  const [mergeSummaryFilter, setMergeSummaryFilter] = useState("");
  const [mergeConflictPicks, setMergeConflictPicks] = useState<MergeConflictPicks>({});
  const cloudBusy = cloudOp !== "idle";
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [remote, setRemote] = useState<RemoteState>({ kind: "idle" });
  const [syncState, setSyncState] = useState<SyncState>({ kind: "idle" });
  const autosyncTimerRef = useRef<number | null>(null);
  const [restoreDialog, setRestoreDialog] = useState<null | {
    remotePayload: AppData;
    remoteUpdatedAt: string;
    remoteRowFetchedAt: string | null;
  }>(null);
  useEffect(() => {
    setMergeSummaryFilter("");
    setMergeConflictPicks({});
  }, [restoreDialog]);

  const patchMergeConflictPick = useCallback((sliceKey: MergeSliceKey, id: string, side: "local" | "remote" | "auto") => {
    setMergeConflictPicks((prev) => {
      const next: MergeConflictPicks = { ...prev };
      const cur = { ...(next[sliceKey] ?? {}) };
      if (side === "auto") delete cur[id];
      else cur[id] = side;
      if (Object.keys(cur).length === 0) delete next[sliceKey];
      else next[sliceKey] = cur;
      return next;
    });
  }, []);
  const [normJsonDiff, setNormJsonDiff] = useState<null | {
    title: string;
    leftLabel: string;
    rightLabel: string;
    left: string;
    right: string;
    rawLeft: string;
    rawRight: string;
    /** 课文子树冲突时附加「正文逐行」视图（§17.6 轮次 3） */
    lessonBodyLineDiff?: { left: string; right: string };
  }>(null);

  const configured = mounted && isSupabaseBrowserConfigured();

  const refreshSession = useCallback(async () => {
    const sb = getSupabaseBrowserClient();
    if (!sb) {
      setSession(null);
      return;
    }
    const { data } = await sb.auth.getSession();
    setSession(data.session);
  }, []);

  const refreshRemoteMeta = useCallback(async () => {
    const sb = getSupabaseBrowserClient();
    if (!sb) return;
    setRemote({ kind: "loading" });
    try {
      const updatedAt = await fetchUserAppRemoteUpdatedAt(sb);
      setRemote({ kind: "ok", updatedAt });
    } catch (e) {
      setRemote({ kind: "error", message: formatUnknownError(e) });
    }
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || !isSupabaseBrowserConfigured()) return;
    void refreshSession();
    const sb = getSupabaseBrowserClient();
    if (!sb) return;
    const { data: sub } = sb.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => {
      sub.subscription.unsubscribe();
    };
  }, [mounted, refreshSession]);

  const user = session?.user ?? null;

  useEffect(() => {
    if (!user) {
      setRemote({ kind: "idle" });
      setSyncState({ kind: "idle" });
      return;
    }
    void refreshRemoteMeta();
  }, [user?.id, refreshRemoteMeta]);

  useEffect(() => {
    if (mode !== "full" || !user || !configured) return;
    if (cloudBusy || busy) return;
    if (autosyncTimerRef.current !== null) {
      window.clearTimeout(autosyncTimerRef.current);
    }
    autosyncTimerRef.current = window.setTimeout(() => {
      const sb = getSupabaseBrowserClient();
      if (!sb) return;
      const fpNow = fingerprintAppData(localAppData);
      const fpPkg = readCloudSyncFingerprintPkg(user.id);
      if (fpPkg.full !== "" && fpNow === fpPkg.full) {
        setSyncState((s) => (s.kind === "error" ? { kind: "idle" } : s));
        return;
      }
      setSyncState({ kind: "syncing" });
      void (async () => {
        try {
          if (await shouldBlockSyncThatWouldWipeRemoteCore(sb, localAppData)) {
            setSyncState({ kind: "error", message: BARE_SHELL_WOULD_WIPE_REMOTE_MESSAGE });
            return;
          }
          const at = await upsertUserAppDataToCloud(sb, user.id, localAppData);
          persistCloudSyncFingerprints(user.id, localAppData);
          const serverAt = await fetchUserAppRemoteUpdatedAt(sb);
          if (serverAt) persistLastSeenRemoteUpdatedAt(user.id, serverAt);
          setSyncState({ kind: "ok", at });
          setRemote((prev) => (prev.kind === "ok" ? { kind: "ok", updatedAt: serverAt ?? at } : prev));
          try {
            onCloudSyncSuccess?.();
          } catch (cbErr) {
            console.warn("[CloudAuthPanel] onCloudSyncSuccess", cbErr);
          }
        } catch (e) {
          setSyncState({ kind: "error", message: formatUnknownError(e) });
        }
      })();
    }, 1200);
    return () => {
      if (autosyncTimerRef.current !== null) {
        window.clearTimeout(autosyncTimerRef.current);
        autosyncTimerRef.current = null;
      }
    };
  }, [configured, localAppData, user?.id, mode, cloudBusy, busy, onCloudSyncSuccess]);

  useEffect(() => {
    if (restoreDialog == null && normJsonDiff == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (normJsonDiff != null) setNormJsonDiff(null);
      else setRestoreDialog(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [restoreDialog, normJsonDiff]);

  const mergePreview = useMemo(() => {
    if (restoreDialog == null) return null;
    return summarizeAppDataMerge(localAppData, restoreDialog.remotePayload);
  }, [restoreDialog, localAppData]);

  const hadMergeColDiffs = useMemo(() => {
    if (mergePreview == null) return false;
    return mergePreview.collections.some(
      (c) => c.localOnly.length + c.remoteOnly.length + c.conflicting.length > 0,
    );
  }, [mergePreview]);

  const filteredMergeBusyCols = useMemo(() => {
    if (mergePreview == null) return [];
    const q = mergeSummaryFilter;
    return mergePreview.collections
      .map((c) => ({
        ...c,
        localOnly: filterIdsBySubstring(c.localOnly, q),
        remoteOnly: filterIdsBySubstring(c.remoteOnly, q),
        conflicting: filterIdsBySubstring(c.conflicting, q),
      }))
      .filter((c) => c.localOnly.length + c.remoteOnly.length + c.conflicting.length > 0);
  }, [mergePreview, mergeSummaryFilter]);

  async function onSignUp() {
    setNotice(null);
    const sb = getSupabaseBrowserClient();
    if (!sb) return;
    setBusy(true);
    const { error } = await sb.auth.signUp({ email: email.trim(), password });
    setBusy(false);
    if (error) setNotice({ kind: "err", text: error.message });
    else setNotice({ kind: "ok", text: "已提交注册。若项目开启邮箱验证，请查收邮件后再登录。" });
  }

  async function onSignIn() {
    setNotice(null);
    const sb = getSupabaseBrowserClient();
    if (!sb) return;
    setBusy(true);
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setNotice({ kind: "err", text: error.message });
    else setNotice({ kind: "ok", text: "已登录。" });
  }

  async function onSignOut() {
    setNotice(null);
    const sb = getSupabaseBrowserClient();
    if (!sb) return;
    setBusy(true);
    const { error } = await sb.auth.signOut();
    setBusy(false);
    if (error) setNotice({ kind: "err", text: error.message });
    else setNotice({ kind: "ok", text: "已退出。" });
  }

  async function onUploadToCloud() {
    setNotice(null);
    const sb = getSupabaseBrowserClient();
    if (!sb || !user) return;
    setCloudOp("upload");
    setCloudPhaseHint("正在同步…");
    try {
      if (await shouldBlockSyncThatWouldWipeRemoteCore(sb, localAppData)) {
        setNotice({ kind: "err", text: BARE_SHELL_WOULD_WIPE_REMOTE_MESSAGE });
        return;
      }
      const t = await upsertUserAppDataToCloud(sb, user.id, localAppData);
      persistCloudSyncFingerprints(user.id, localAppData);
      const serverAt = await fetchUserAppRemoteUpdatedAt(sb);
      if (serverAt) persistLastSeenRemoteUpdatedAt(user.id, serverAt);
      setNotice({ kind: "ok", text: `同步成功（${formatCloudTime(serverAt ?? t)}）～` });
      await refreshRemoteMeta();
      onCloudSyncSuccess?.();
    } catch (e) {
      const msg = formatUnknownError(e);
      const hint =
        msg.includes("user_app_data") || msg.includes("relation") || msg.includes("does not exist")
          ? " 若仍失败，请让维护者检查托管端数据库是否已按说明文档初始化。"
          : "";
      setNotice({ kind: "err", text: `${msg}${hint}` });
    } finally {
      setCloudOp("idle");
      setCloudPhaseHint("");
    }
  }

  async function onDownloadCloudBackupJson() {
    setNotice(null);
    const sb = getSupabaseBrowserClient();
    if (!sb || !user) return;
    setCloudOp("download_cloud");
    setCloudPhaseHint("正在拉取云端快照…");
    try {
      const snap = await fetchUserAppDataFromCloud(sb);
      if (!snap) {
        setNotice({ kind: "err", text: "云端尚无备份，请先上传。" });
        return;
      }
      setCloudPhaseHint("正在生成下载文件…");
      const base = buildCloudBackupDownloadBasename(snap.updatedAt, user.id);
      const body = appDataToIndentedJsonDownload(snap.payload);
      const blob = new Blob([body], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${base}.json`;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice({ kind: "ok", text: `已下载云端备份副本（${base}.json）。未改本机数据，可与「导出 json」对照留档。` });
    } catch (e) {
      setNotice({ kind: "err", text: formatUnknownError(e) });
    } finally {
      setCloudOp("idle");
      setCloudPhaseHint("");
    }
  }

  async function onRestoreFromCloud() {
    setNotice(null);
    const sb = getSupabaseBrowserClient();
    if (!sb || !user) return;
    setCloudOp("align_fetch");
    setCloudPhaseHint("正在拉取云端数据…");
    let remoteRowFetchedAt: string | null = null;
    try {
      remoteRowFetchedAt = await fetchUserAppRemoteUpdatedAt(sb);
    } catch {
      remoteRowFetchedAt = null;
    }
    try {
      const snap = await fetchUserAppDataFromCloud(sb);
      if (!snap) {
        setNotice({ kind: "err", text: "云端尚无备份，请先上传。" });
        return;
      }
      setRestoreDialog({
        remotePayload: snap.payload,
        remoteUpdatedAt: snap.updatedAt,
        remoteRowFetchedAt,
      });
    } catch (e) {
      setNotice({ kind: "err", text: formatUnknownError(e) });
    } finally {
      setCloudOp("idle");
      setCloudPhaseHint("");
    }
  }

  async function applyCloudRestoreChoice(choice: "cloud" | "local" | "merge") {
    const sb = getSupabaseBrowserClient();
    if (!sb || !user || restoreDialog == null) return;
    const { remotePayload, remoteUpdatedAt } = restoreDialog;

    if (choice === "local") {
      if (learningCoreEntryCount(localAppData) === 0 && learningCoreEntryCount(remotePayload) > 0) {
        if (
          !window.confirm(
            "【重要】你在这个网址（当前浏览器）里的课文 / 词卡 / 题库等是空的，但云端备份里还有内容。\n\n若继续「以本机为准覆盖云端」，会把云端上的这些资料全部删掉，只留下空壳，且网页端无法撤销。\n\n建议先点「取消」，回到当初录入数据的那台电脑或浏览器（例如本机 http://localhost:3000），在数据页导出 JSON，再上传；或选「以云端为准」把资料拉回这个浏览器。\n\n仍要清空云端吗？",
          )
        ) {
          return;
        }
      }
      if (
        !window.confirm(
          "再次确认：要用本机这份学习数据覆盖云端吗？此账号在其它设备上的备份将被替换，且无法从网页端撤销。",
        )
      ) {
        return;
      }
      setRestoreDialog(null);
      setCloudOp("apply");
      setCloudPhaseHint("正在用本机覆盖云端…");
      try {
        const at = await upsertUserAppDataToCloud(sb, user.id, localAppData);
        persistCloudSyncFingerprints(user.id, localAppData);
        const serverAt = await fetchUserAppRemoteUpdatedAt(sb);
        if (serverAt) persistLastSeenRemoteUpdatedAt(user.id, serverAt);
        setNotice({ kind: "ok", text: `已用本机覆盖云端（服务器时间 ${formatCloudTime(serverAt ?? at)}）。` });
        await refreshRemoteMeta();
        onCloudSyncSuccess?.();
      } catch (e) {
        setNotice({ kind: "err", text: formatUnknownError(e) });
      } finally {
        setCloudOp("idle");
        setCloudPhaseHint("");
      }
      return;
    }

    if (choice === "cloud") {
      setRestoreDialog(null);
      setCloudOp("apply");
      setCloudPhaseHint("正在用云端覆盖本机…");
      try {
        onApplyCloudPayload(remotePayload);
        persistCloudSyncFingerprints(user.id, remotePayload);
        if (remoteUpdatedAt) persistLastSeenRemoteUpdatedAt(user.id, remoteUpdatedAt);
        setNotice({ kind: "ok", text: "已用云端快照覆盖本机（已规范化）。建议再导出一次留档。" });
        await refreshRemoteMeta();
        onCloudSyncSuccess?.();
      } catch (e) {
        setNotice({ kind: "err", text: formatUnknownError(e) });
      } finally {
        setCloudOp("idle");
        setCloudPhaseHint("");
      }
      return;
    }

    if (choice === "merge") {
      setRestoreDialog(null);
      setCloudOp("apply");
      setCloudPhaseHint("正在合并到本机…");
      try {
        const merged = mergeAppDataLocalAndRemote(localAppData, remotePayload, mergeConflictPicks);
        onApplyCloudPayload(merged);
        persistCloudSyncFingerprints(user.id, merged);
        if (remoteUpdatedAt) persistLastSeenRemoteUpdatedAt(user.id, remoteUpdatedAt);
        setNotice({
          kind: "ok",
          text: "已把两边的学习记录合在本机啦，记得再点一次「同步数据」写回账号哦～",
        });
        await refreshRemoteMeta();
        onCloudSyncSuccess?.();
      } catch (e) {
        setNotice({ kind: "err", text: formatUnknownError(e) });
      } finally {
        setCloudOp("idle");
        setCloudPhaseHint("");
      }
    }
  }

  const authForm = (
    <form
      className="mt-4 grid max-w-md gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void onSignIn();
      }}
    >
      <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
        邮箱
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] bg-white/90 px-3 py-2 text-sm text-[color:var(--sun-ink)]"
          placeholder="you@example.com"
        />
      </label>
      <label className="block text-xs font-bold text-[color:var(--sun-muted)]">
        密码
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] bg-white/90 px-3 py-2 text-sm text-[color:var(--sun-ink)]"
          placeholder="至少 6 位"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="sun-btn" disabled={busy}>
          登录
        </button>
        <button type="button" className="sun-btn sun-btn--ghost" disabled={busy} onClick={() => void onSignUp()}>
          注册
        </button>
      </div>
    </form>
  );

  if (!mounted) {
    return (
      <section className={mode === "full" ? `float-card float-card--delay p-5 md:p-6 ${className}` : className}>
        <h3 className="text-base font-black">账号同步</h3>
        <p className="mt-2 text-sm text-[color:var(--sun-muted)]">加载中…</p>
      </section>
    );
  }

  if (!configured) {
    return (
      <section className={mode === "full" ? `float-card float-card--delay p-5 md:p-6 ${className}` : className}>
        <h3 className="text-base font-black">账号同步（可选）</h3>
        <p className="mt-2 text-sm leading-relaxed text-[color:var(--sun-muted)]">
          多设备同步需要托管方配置环境变量，详见仓库内 <span className="font-mono text-[0.7rem]">docs/CLOUD_SETUP.md</span>。
        </p>
        <p className="mt-2 text-xs text-[color:var(--sun-muted)]">配置完成前可仅在本机学习，进度保存在当前浏览器。</p>
      </section>
    );
  }

  if (mode === "authOnly") {
    return (
      <section className={className}>
        <h3 className="text-base font-black">登录 / 注册账号</h3>
        <p className="mt-1 text-xs leading-relaxed text-[color:var(--sun-muted)]">
          登录后自动把学习数据同步到云端；不登录也可先本地学习。
        </p>
        {user ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-[color:var(--sun-ink)]">
              当前已登录：<span className="font-black">{userLabel(user)}</span>
            </p>
            <button type="button" className="sun-btn sun-btn--ghost" disabled={busy} onClick={() => void onSignOut()}>
              退出登录
            </button>
          </div>
        ) : (
          authForm
        )}
        {notice && (
          <p
            className={
              notice.kind === "err" ? "mt-3 text-sm font-semibold text-red-700" : "mt-3 text-sm font-semibold text-emerald-800"
            }
          >
            {notice.text}
          </p>
        )}
      </section>
    );
  }

  const restoreHintLines =
    restoreDialog != null && user
      ? cloudRestoreScenarioHints(getCloudRestoreScenario(user.id, localAppData, restoreDialog.remoteRowFetchedAt))
      : [];

  const restorePortal =
    restoreDialog != null && user ? (
      createPortal(
        <div
          className="fixed inset-0 z-[280] flex items-end justify-center bg-black/40 p-3 sm:items-center"
          role="presentation"
          onClick={() => setRestoreDialog(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cloud-restore-merge-title"
            className="max-h-[min(90vh,720px)] w-full max-w-lg overflow-y-auto rounded-2xl border border-[color-mix(in_srgb,var(--sun-warm)_45%,transparent)] bg-[color-mix(in_srgb,var(--sun-surface)_96%,white)] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="cloud-restore-merge-title" className="text-base font-black text-[color:var(--sun-ink)]">
              与云端对齐（三选一）
            </h4>
            <p className="mt-2 text-sm leading-relaxed text-[color:var(--sun-muted)]">
              下面任选一种方式处理<strong className="text-[color:var(--sun-ink)]">本机</strong>与
              <strong className="text-[color:var(--sun-ink)]">当前云端备份</strong>的关系。操作前建议先在本页导出 JSON 备份。
            </p>
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-[color:var(--sun-muted)]">
              {restoreHintLines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
            {mergePreview &&
              (() => {
                const showBox = hadMergeColDiffs || mergePreview.statsWillSum;
                const filterHidesAllCols =
                  mergeSummaryFilter.trim().length > 0 && filteredMergeBusyCols.length === 0 && hadMergeColDiffs;
                if (!showBox) {
                  return (
                    <p className="mt-3 text-xs leading-relaxed text-[color:var(--sun-muted)]">
                      合并摘要：各列表在规范化后<strong className="text-[color:var(--sun-ink)]">未发现 id 级内容差异</strong>
                      （不含统计）。若仍选合并，结果应与当前本机一致。
                    </p>
                  );
                }
                return (
                  <details className="mt-3 rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] bg-white/65 p-3" open>
                    <summary className="cursor-pointer text-sm font-black text-[color:var(--sun-ink)]">
                      合并前摘要（按 id；可筛选；同 id 可 JSON 对比 + 本机/自动/云端逐条取舍）
                    </summary>
                    {hadMergeColDiffs ? (
                      <label
                        className="mt-2 block rounded-lg border border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] bg-white/80 px-2 py-2"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <span className="text-[0.65rem] font-bold text-[color:var(--sun-muted)]">筛选 id（大小写不敏感）</span>
                        <input
                          type="search"
                          value={mergeSummaryFilter}
                          onChange={(e) => setMergeSummaryFilter(e.target.value)}
                          placeholder="例如课文 id、词卡前缀…"
                          className="mt-1 w-full rounded-md border border-[color-mix(in_srgb,var(--sun-warm)_40%,transparent)] bg-white px-2 py-1.5 font-mono text-[0.7rem] text-[color:var(--sun-ink)]"
                        />
                      </label>
                    ) : null}
                    {filterHidesAllCols ? (
                      <p className="mt-2 text-xs font-semibold text-amber-900/90">
                        当前关键词下没有匹配的 id，请改短一点或清空筛选。
                      </p>
                    ) : null}
                    {mergePreview.statsWillSum && restoreDialog && (
                      <div className="mt-2 rounded-lg border border-amber-200/80 bg-amber-50/80 px-2 py-2 text-xs leading-relaxed text-amber-950/90">
                        <p>
                          两侧「练习统计」在规范化后<strong>不完全相同</strong>：选「合并两边」时会<strong>相加</strong>计数与按日桶。
                        </p>
                        <button
                          type="button"
                          className="mt-1.5 text-left text-[0.7rem] font-black text-amber-950 underline decoration-2 underline-offset-2"
                          onClick={(e) => {
                            e.stopPropagation();
                            const { localJson, remoteJson } = getMergeStatsJsonPair(localAppData, restoreDialog.remotePayload);
                            setNormJsonDiff({
                              title: "练习统计 stats（JSON）",
                              leftLabel: "本机",
                              rightLabel: "云端",
                              left: clampJsonText(localJson, MERGE_JSON_DIFF_MAX),
                              right: clampJsonText(remoteJson, MERGE_JSON_DIFF_MAX),
                              rawLeft: localJson,
                              rawRight: remoteJson,
                            });
                          }}
                        >
                          对比两侧 stats JSON
                        </button>
                      </div>
                    )}
                    <div className="mt-2 space-y-3 text-xs leading-relaxed text-[color:var(--sun-muted)]">
                      {filteredMergeBusyCols.map((col) => {
                        const onlyL = formatIdSnippet(col.localOnly, MERGE_PREVIEW_ID_CAP);
                        const onlyR = formatIdSnippet(col.remoteOnly, MERGE_PREVIEW_ID_CAP);
                        const both = formatIdSnippet(col.conflicting, MERGE_PREVIEW_ID_CAP);
                        return (
                          <div key={col.sliceKey} className="border-b border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] pb-2 last:border-b-0 last:pb-0">
                            <div className="font-bold text-[color:var(--sun-ink)]">{col.label}</div>
                            <div>
                              仅本机 <span className="font-black text-[color:var(--sun-ink)]">{col.localOnly.length}</span> · 仅云端{" "}
                              <span className="font-black text-[color:var(--sun-ink)]">{col.remoteOnly.length}</span> · 同 id 内容不同{" "}
                              <span className="font-black text-[color:var(--sun-ink)]">{col.conflicting.length}</span>
                            </div>
                            {onlyL.text ? (
                              <p className="mt-1 break-all font-mono text-[0.65rem] text-[color:var(--sun-ink)]">
                                仅本机 id：{onlyL.text}
                                {onlyL.rest > 0 ? ` …另有 ${onlyL.rest} 条` : ""}
                              </p>
                            ) : null}
                            {restoreDialog && col.localOnly.length > 0 ? (
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                <span className="w-full text-[0.58rem] font-bold text-sky-900">仅本机 · 看规范化 JSON</span>
                                {col.localOnly.slice(0, 10).map((id) => (
                                  <button
                                    key={`${col.sliceKey}_local_${id}`}
                                    type="button"
                                    className="rounded-lg border border-sky-300/90 bg-sky-50/95 px-2 py-0.5 font-mono text-[0.62rem] font-bold text-sky-950 shadow-sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const { localJson, remoteJson } = getMergeRowNormalizedJsonPair(
                                        localAppData,
                                        restoreDialog.remotePayload,
                                        col.sliceKey,
                                        id,
                                      );
                                      setNormJsonDiff({
                                        title: `${col.label} · 仅本机 · ${id}`,
                                        leftLabel: "本机（规范化单行 JSON）",
                                        rightLabel: "云端（无此 id，空）",
                                        left: clampJsonText(localJson, MERGE_JSON_DIFF_MAX),
                                        right: clampJsonText(remoteJson, MERGE_JSON_DIFF_MAX),
                                        rawLeft: localJson,
                                        rawRight: remoteJson,
                                      });
                                    }}
                                  >
                                    本机 {id.length > 12 ? `${id.slice(0, 10)}…` : id}
                                  </button>
                                ))}
                                {col.localOnly.length > 10 ? (
                                  <span className="text-[0.62rem] text-[color:var(--sun-muted)]">另有 {col.localOnly.length - 10} 条</span>
                                ) : null}
                              </div>
                            ) : null}
                            {onlyR.text ? (
                              <p className="mt-1 break-all font-mono text-[0.65rem] text-[color:var(--sun-ink)]">
                                仅云端 id：{onlyR.text}
                                {onlyR.rest > 0 ? ` …另有 ${onlyR.rest} 条` : ""}
                              </p>
                            ) : null}
                            {restoreDialog && col.remoteOnly.length > 0 ? (
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                <span className="w-full text-[0.58rem] font-bold text-teal-900">仅云端 · 看规范化 JSON</span>
                                {col.remoteOnly.slice(0, 10).map((id) => (
                                  <button
                                    key={`${col.sliceKey}_remote_${id}`}
                                    type="button"
                                    className="rounded-lg border border-teal-300/90 bg-teal-50/95 px-2 py-0.5 font-mono text-[0.62rem] font-bold text-teal-950 shadow-sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const { localJson, remoteJson } = getMergeRowNormalizedJsonPair(
                                        localAppData,
                                        restoreDialog.remotePayload,
                                        col.sliceKey,
                                        id,
                                      );
                                      setNormJsonDiff({
                                        title: `${col.label} · 仅云端 · ${id}`,
                                        leftLabel: "本机（无此 id，空）",
                                        rightLabel: "云端（规范化单行 JSON）",
                                        left: clampJsonText(localJson, MERGE_JSON_DIFF_MAX),
                                        right: clampJsonText(remoteJson, MERGE_JSON_DIFF_MAX),
                                        rawLeft: localJson,
                                        rawRight: remoteJson,
                                      });
                                    }}
                                  >
                                    云端 {id.length > 12 ? `${id.slice(0, 10)}…` : id}
                                  </button>
                                ))}
                                {col.remoteOnly.length > 10 ? (
                                  <span className="text-[0.62rem] text-[color:var(--sun-muted)]">另有 {col.remoteOnly.length - 10} 条</span>
                                ) : null}
                              </div>
                            ) : null}
                            {both.text ? (
                              <p className="mt-1 break-all font-mono text-[0.65rem] text-violet-950">
                                内容不同 id：{both.text}
                                {both.rest > 0 ? ` …另有 ${both.rest} 条` : ""}
                              </p>
                            ) : null}
                            {restoreDialog && col.conflicting.length > 0 ? (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {col.conflicting.slice(0, 14).map((id) => (
                                  <button
                                    key={`${col.sliceKey}_${id}`}
                                    type="button"
                                    className="rounded-lg border border-violet-300/90 bg-violet-50/95 px-2 py-0.5 font-mono text-[0.62rem] font-bold text-violet-950 shadow-sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const { localJson, remoteJson } = getMergeRowNormalizedJsonPair(
                                        localAppData,
                                        restoreDialog.remotePayload,
                                        col.sliceKey,
                                        id,
                                      );
                                      setNormJsonDiff({
                                        title: `${col.label} · ${id}`,
                                        leftLabel: "本机（规范化单行 JSON）",
                                        rightLabel: "云端（规范化单行 JSON）",
                                        left: clampJsonText(localJson, MERGE_JSON_DIFF_MAX),
                                        right: clampJsonText(remoteJson, MERGE_JSON_DIFF_MAX),
                                        rawLeft: localJson,
                                        rawRight: remoteJson,
                                        lessonBodyLineDiff:
                                          col.sliceKey === "lessons"
                                            ? tryLessonContentPairFromNormJson(localJson, remoteJson) ?? undefined
                                            : undefined,
                                      });
                                    }}
                                  >
                                    JSON {id.length > 14 ? `${id.slice(0, 12)}…` : id}
                                  </button>
                                ))}
                                {col.conflicting.length > 14 ? (
                                  <span className="self-center text-[0.62rem] text-[color:var(--sun-muted)]">
                                    另有 {col.conflicting.length - 14} 条未展示按钮
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                            {restoreDialog && col.conflicting.length > 0 ? (
                              <div
                                className="mt-2 rounded-lg border border-violet-200/80 bg-violet-50/40 p-2"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <p className="text-[0.62rem] font-bold text-violet-950">
                                  同 id 冲突逐条取舍（默认「自动」= 时间戳较新整行胜出）
                                </p>
                                {col.conflicting.length > MERGE_CONFLICT_PICK_UI_CAP ? (
                                  <p className="mt-1 text-[0.6rem] text-violet-900/90">
                                    本类共 {col.conflicting.length} 条，下列控件最多展示 {MERGE_CONFLICT_PICK_UI_CAP}{" "}
                                    条，请用上方筛选缩小 id 范围。
                                  </p>
                                ) : null}
                                <div className="mt-1.5 max-h-52 space-y-1 overflow-y-auto pr-0.5">
                                  {col.conflicting.slice(0, MERGE_CONFLICT_PICK_UI_CAP).map((id) => {
                                    const pick = mergeConflictPicks[col.sliceKey]?.[id];
                                    const btnBase =
                                      "rounded-md border px-1.5 py-0.5 text-[0.58rem] font-black transition-colors";
                                    const idle = "border-violet-200/90 bg-white/90 text-violet-900/80 hover:bg-violet-100/80";
                                    const on = "border-violet-600 bg-violet-200/95 text-violet-950 shadow-sm";
                                    const humanHints =
                                      restoreDialog != null
                                        ? humanMergeConflictHints(
                                            localAppData,
                                            restoreDialog.remotePayload,
                                            col.sliceKey,
                                            id,
                                          )
                                        : [];
                                    return (
                                      <div
                                        key={`${col.sliceKey}_pick_${id}`}
                                        className="border-b border-violet-100/80 py-1.5 last:border-b-0"
                                      >
                                        <div className="flex flex-wrap items-center gap-1">
                                        <span
                                          className="min-w-0 max-w-[55%] truncate font-mono text-[0.6rem] text-violet-950"
                                          title={id}
                                        >
                                          {id}
                                        </span>
                                        <div className="ml-auto flex shrink-0 gap-0.5">
                                          <button
                                            type="button"
                                            className={`${btnBase} ${pick === "local" ? on : idle}`}
                                            onClick={() => patchMergeConflictPick(col.sliceKey, id, "local")}
                                          >
                                            本机
                                          </button>
                                          <button
                                            type="button"
                                            className={`${btnBase} ${pick == null ? on : idle}`}
                                            onClick={() => patchMergeConflictPick(col.sliceKey, id, "auto")}
                                          >
                                            自动
                                          </button>
                                          <button
                                            type="button"
                                            className={`${btnBase} ${pick === "remote" ? on : idle}`}
                                            onClick={() => patchMergeConflictPick(col.sliceKey, id, "remote")}
                                          >
                                            云端
                                          </button>
                                        </div>
                                        </div>
                                        {humanHints.length > 0 ? (
                                          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[0.58rem] leading-snug text-violet-900/85">
                                            {humanHints.map((line, hi) => (
                                              <li key={hi}>{line}</li>
                                            ))}
                                          </ul>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                );
              })()}
            <div className="mt-4 space-y-2 rounded-xl bg-white/70 p-3 text-xs leading-relaxed text-[color:var(--sun-muted)]">
              <p>
                <strong className="text-[color:var(--sun-ink)]">合并两边</strong>
                ：课文 / 词卡 / 题库 / 聊天 / 笔记 / 收藏等<strong>同一条 id</strong>默认保留
                <strong className="text-[color:var(--sun-ink)]">时间戳较新</strong>的那一整条；你可在摘要里对「同 id 内容不同」逐条改为<strong>本机</strong>或<strong>云端</strong>整行锁定后再合并。练习统计会<strong className="text-[color:var(--sun-ink)]">相加</strong>（适合两台设备各练了一部分）；媒体库同键以本机为准。
              </p>
            </div>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                className="sun-btn"
                disabled={cloudBusy}
                onClick={() => void applyCloudRestoreChoice("merge")}
              >
                合并两边（写回本机）
              </button>
              <button
                type="button"
                className="sun-btn sun-btn--ghost"
                disabled={cloudBusy}
                onClick={() => void applyCloudRestoreChoice("cloud")}
              >
                以云端为准（覆盖本机）
              </button>
              <button
                type="button"
                className="sun-btn sun-btn--ghost"
                disabled={cloudBusy}
                onClick={() => void applyCloudRestoreChoice("local")}
              >
                以本机为准（覆盖云端）
              </button>
              <button type="button" className="sun-btn sun-btn--ghost" disabled={cloudBusy} onClick={() => setRestoreDialog(null)}>
                取消
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    ) : null;

  const normJsonDiffPortal =
    normJsonDiff != null
      ? createPortal(
          <div
            className="fixed inset-0 z-[290] flex items-end justify-center bg-black/45 p-3 sm:items-center"
            role="presentation"
            onClick={() => setNormJsonDiff(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="cloud-norm-json-diff-title"
              className="max-h-[min(92vh,800px)] w-full max-w-4xl overflow-hidden rounded-2xl border border-violet-200/90 bg-[color-mix(in_srgb,var(--sun-surface)_96%,white)] shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-2 border-b border-violet-200/70 px-4 py-3">
                <h4 id="cloud-norm-json-diff-title" className="text-sm font-black leading-snug text-violet-950">
                  {normJsonDiff.title}
                </h4>
                <button type="button" className="sun-btn sun-btn--ghost shrink-0 !min-h-8 !px-2 !py-1 text-xs" onClick={() => setNormJsonDiff(null)}>
                  关闭
                </button>
              </div>
              <div className="flex flex-wrap gap-2 border-b border-violet-100/90 px-4 py-2">
                <button
                  type="button"
                  className="sun-btn sun-btn--ghost !min-h-8 !px-2 !py-1 text-[0.65rem]"
                  onClick={() =>
                    void copyTextToClipboard(normJsonDiff.rawLeft).then((ok) =>
                      setNotice(
                        ok ? { kind: "ok", text: "已复制左侧全文到剪贴板。" } : { kind: "err", text: "复制失败（浏览器可能禁止剪贴板）。" },
                      ),
                    )
                  }
                >
                  复制左侧全文
                </button>
                <button
                  type="button"
                  className="sun-btn sun-btn--ghost !min-h-8 !px-2 !py-1 text-[0.65rem]"
                  onClick={() =>
                    void copyTextToClipboard(normJsonDiff.rawRight).then((ok) =>
                      setNotice(
                        ok ? { kind: "ok", text: "已复制右侧全文到剪贴板。" } : { kind: "err", text: "复制失败（浏览器可能禁止剪贴板）。" },
                      ),
                    )
                  }
                >
                  复制右侧全文
                </button>
              </div>
              <div className="max-h-[min(78vh,680px)] overflow-auto p-3">
                <div className="grid gap-2 md:grid-cols-2">
                  <div className="flex min-h-0 flex-col rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] bg-white/90 p-2">
                    <p className="text-[0.65rem] font-bold text-[color:var(--sun-muted)]">{normJsonDiff.leftLabel}</p>
                    <pre className="mt-1 max-h-[min(52vh,420px)] overflow-auto whitespace-pre-wrap break-all font-mono text-[0.62rem] leading-relaxed text-[color:var(--sun-ink)]">
                      {normJsonDiff.left || "（空）"}
                    </pre>
                  </div>
                  <div className="flex min-h-0 flex-col rounded-xl border border-[color-mix(in_srgb,var(--sun-warm)_35%,transparent)] bg-white/90 p-2">
                    <p className="text-[0.65rem] font-bold text-[color:var(--sun-muted)]">{normJsonDiff.rightLabel}</p>
                    <pre className="mt-1 max-h-[min(52vh,420px)] overflow-auto whitespace-pre-wrap break-all font-mono text-[0.62rem] leading-relaxed text-[color:var(--sun-ink)]">
                      {normJsonDiff.right || "（空）"}
                    </pre>
                  </div>
                </div>
                {normJsonDiff.lessonBodyLineDiff ? (
                  <MergeLessonContentLineDiff left={normJsonDiff.lessonBodyLineDiff.left} right={normJsonDiff.lessonBodyLineDiff.right} />
                ) : null}
              </div>
              <p className="border-t border-violet-100/90 px-4 py-2 text-[0.62rem] leading-relaxed text-[color:var(--sun-muted)]">
                与合并摘要使用同一套规范化规则（单行子树 JSON）。展示区可能截断；「复制全文」为未截断原文。Esc 或点背景关闭。
              </p>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <section className={`float-card float-card--delay p-5 md:p-6 ${className}`}>
      <h3 className="text-base font-black">账号同步</h3>
      <p className="mt-1 text-xs leading-relaxed text-[color:var(--sun-muted)]">
        用邮箱登录后，学习记录会在联网时自动备份到账号，换设备也能接上～
      </p>
      {user && (
        <p className="mt-2 text-xs leading-relaxed text-[color:var(--sun-muted)]">
          同步状态：
          {syncState.kind === "idle" && <span className="font-semibold text-[color:var(--sun-muted)]"> 正常</span>}
          {syncState.kind === "syncing" && <span className="font-semibold text-violet-900"> 正在同步…</span>}
          {syncState.kind === "ok" && (
            <span className="font-semibold text-emerald-800"> 已同步（{formatCloudTime(syncState.at)}）</span>
          )}
          {syncState.kind === "error" && <span className="font-semibold text-red-700"> 失败：{syncState.message}</span>}
        </p>
      )}
      {user ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-[color:var(--sun-ink)]">
            已登录：<span className="font-black">{userLabel(user)}</span>
          </p>
          {remote.kind === "loading" && (
            <p className="text-xs text-[color:var(--sun-muted)]">正在查询云端备份…</p>
          )}
          {remote.kind === "error" && (
            <p className="text-xs font-semibold text-red-700">云端状态：{remote.message}</p>
          )}
          {remote.kind === "ok" && (
            <p className="text-xs text-[color:var(--sun-muted)]">
              最近同步：
              {remote.updatedAt ? (
                <span className="font-black text-[color:var(--sun-ink)]"> {formatCloudTime(remote.updatedAt)}</span>
              ) : (
                <span className="font-black text-amber-800"> 尚无</span>
              )}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="sun-btn" disabled={busy || cloudBusy} onClick={() => void onUploadToCloud()}>
              {cloudOp === "upload" ? cloudPhaseHint : "同步数据"}
            </button>
            {cloudToolbar === "full" ? (
              <>
                <button
                  type="button"
                  className="sun-btn sun-btn--ghost"
                  disabled={busy || cloudBusy}
                  onClick={() => void onDownloadCloudBackupJson()}
                >
                  {cloudOp === "download_cloud" ? cloudPhaseHint : "下载学习包副本"}
                </button>
                <button
                  type="button"
                  className="sun-btn sun-btn--ghost"
                  disabled={busy || cloudBusy}
                  onClick={() => void onRestoreFromCloud()}
                >
                  {cloudOp === "align_fetch" ? cloudPhaseHint : "对齐学习记录…"}
                </button>
              </>
            ) : null}
            <button type="button" className="sun-btn sun-btn--ghost" disabled={busy || cloudBusy} onClick={() => void onSignOut()}>
              退出登录
            </button>
          </div>
        </div>
      ) : authForm}
      {notice && (
        <p
          className={
            notice.kind === "err"
              ? "mt-3 text-sm font-semibold text-red-700"
              : "mt-3 text-sm font-semibold text-emerald-800"
          }
        >
          {notice.text}
        </p>
      )}
      </section>
      {restorePortal}
      {normJsonDiffPortal}
    </>
  );
}
