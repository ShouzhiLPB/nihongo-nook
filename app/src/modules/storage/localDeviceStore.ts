/**
 * 学习数据只存本机：IndexedDB + localStorage。
 * 换浏览器、换电脑、朋友零安装使用：请用「数据」页的导出 / 导入 JSON（浏览器无法在无运行时的情况下写你磁盘上的固定路径文件）。
 */

import { normalizeAppData } from "@/modules/storage/dataStore";
import type { AppData } from "@/shared/types";
import { appStorageKey } from "@/shared/utils";

const DB_NAME = "jpLearnLocalDevice";
const DB_VERSION = 1;
const STORE = "kv";
const RECORD_KEY = "appDataJson";

const defaultData: AppData = {
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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
  });
}

async function idbGet(key: string): Promise<unknown> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const rq = tx.objectStore(STORE).get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    if (value === null || value === undefined) {
      tx.objectStore(STORE).delete(key);
    } else {
      tx.objectStore(STORE).put(value, key);
    }
  });
}

async function idbReadJson(): Promise<string | null> {
  const v = await idbGet(RECORD_KEY);
  return v != null ? String(v) : null;
}

async function idbWriteJson(json: string): Promise<void> {
  await idbPut(RECORD_KEY, json);
}

/** 从本机读取：IndexedDB → localStorage 迁移 */
export async function loadLocalAppData(): Promise<AppData> {
  if (typeof window === "undefined") {
    return normalizeAppData(defaultData);
  }

  try {
    let raw: string | null = null;
    try {
      raw = await idbReadJson();
    } catch {
      raw = null;
    }

    if (!raw || !raw.trim()) {
      const ls = window.localStorage.getItem(appStorageKey);
      if (ls && ls.trim()) {
        raw = ls;
        try {
          await idbWriteJson(ls);
        } catch {
          /* ignore */
        }
      }
    }

    if (!raw || !raw.trim()) {
      return normalizeAppData(defaultData);
    }

    const parsed = JSON.parse(raw) as AppData;
    return normalizeAppData(parsed);
  } catch {
    return normalizeAppData(defaultData);
  }
}

/** 写入本机：IndexedDB + localStorage */
export async function saveLocalAppData(data: AppData): Promise<void> {
  if (typeof window === "undefined") return;

  const raw = JSON.stringify(normalizeAppData(data));
  try {
    await idbWriteJson(raw);
  } catch {
    /* ignore */
  }
  try {
    window.localStorage.setItem(appStorageKey, raw);
  } catch {
    /* ignore */
  }
}
