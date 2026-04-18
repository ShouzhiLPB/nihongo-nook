/**
 * 统计页：将当前图中数据导出为 CSV（UTF-8，供 Excel / 表格软件打开）。
 */
import type { FutureChartRow, PastRangeChartRow } from "./statsAggregation";
import type { GlobalDueCounts } from "./statsDueBreakdown";

function csvCell(v: string | number): string {
  const s = String(v);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 区间内过往（与当前趋势图 / 卡片一致的一行行数据） */
export function buildPastRangeCsv(rows: PastRangeChartRow[]): string {
  const header = [
    "date",
    "practiceMarkCorrect",
    "practiceMarkWrong",
    "practiceMarkEasy",
    "dwellLessonReaderSec",
    "dwellPracticeSec",
    "marksTotal",
    "dwellLessonMinutes",
    "dwellPracticeMinutes",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.day),
        r.practiceMarkCorrect,
        r.practiceMarkWrong,
        r.practiceMarkEasy,
        r.dwellLessonReaderSec,
        r.dwellPracticeSec,
        r.marksTotal,
        r.dwellLessonMin,
        r.dwellPracticeMin,
      ].join(","),
    );
  }
  return lines.join("\r\n");
}

/** 未来刷题计划（与当前图一致） */
export function buildFutureDueCsv(rows: FutureChartRow[]): string {
  const header = ["date", "vocab", "sentence", "grammar", "dayTotal", "cumulativeDue"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [csvCell(r.day), r.vocab, r.sentence, r.grammar, r.total, r.cumulativeDue].join(","),
    );
  }
  return lines.join("\r\n");
}

export type StatsSummaryLessonCsvRow = {
  lessonName: string;
  category: string;
  vocab: number;
  sentence: number;
  grammar: number;
  total: number;
};

/** 统计页「汇总 + 按课文待刷」单文件导出（UTF-8 CRLF） */
export function buildStatsSummaryCsv(args: {
  exportedAt: string;
  practiceMarkCorrect: number;
  practiceMarkWrong: number;
  practiceMarkEasy: number;
  dwellLessonReaderSec: number;
  dwellPracticeSec: number;
  globalDue: GlobalDueCounts;
  inventory: {
    lessons: number;
    vocabCards: number;
    sentenceTasks: number;
    grammarTasks: number;
    lessonNotes: number;
    favoriteSentences: number;
  };
  lessonDue: StatsSummaryLessonCsvRow[];
}): string {
  const lines: string[] = [];
  lines.push("section,key,value");
  lines.push(["summary", "exportedAt", csvCell(args.exportedAt)].join(","));
  lines.push(["summary", "practiceMarkCorrect", args.practiceMarkCorrect].join(","));
  lines.push(["summary", "practiceMarkWrong", args.practiceMarkWrong].join(","));
  lines.push(["summary", "practiceMarkEasy", args.practiceMarkEasy].join(","));
  lines.push(["summary", "dwellLessonReaderSec", args.dwellLessonReaderSec].join(","));
  lines.push(["summary", "dwellPracticeSec", args.dwellPracticeSec].join(","));
  lines.push(["summary", "dueVocabGlobal", args.globalDue.vocab].join(","));
  lines.push(["summary", "dueSentenceGlobal", args.globalDue.sentence].join(","));
  lines.push(["summary", "dueGrammarGlobal", args.globalDue.grammar].join(","));
  lines.push(["summary", "lessonsCount", args.inventory.lessons].join(","));
  lines.push(["summary", "vocabCardsCount", args.inventory.vocabCards].join(","));
  lines.push(["summary", "sentenceTasksCount", args.inventory.sentenceTasks].join(","));
  lines.push(["summary", "grammarTasksCount", args.inventory.grammarTasks].join(","));
  lines.push(["summary", "lessonNotesCount", args.inventory.lessonNotes].join(","));
  lines.push(["summary", "favoriteSentencesCount", args.inventory.favoriteSentences].join(","));
  lines.push("");
  lines.push(["lessonDue", "lessonName", "category", "dueVocab", "dueSentence", "dueGrammar", "dueTotal"].join(","));
  for (const r of args.lessonDue) {
    lines.push(
      [
        "lessonDue",
        csvCell(r.lessonName),
        csvCell(r.category),
        r.vocab,
        r.sentence,
        r.grammar,
        r.total,
      ].join(","),
    );
  }
  return lines.join("\r\n");
}
