"use client";

import type { FutureChartRow, PastRangeChartRow } from "@/modules/stats/statsAggregation";
import { usePrefersReducedMotion } from "@/shared/motionPrefs";
import { calendarTodayLocal } from "@/shared/utils";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

function formatDwellSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

/** 与柱状图 Tooltip 完全一致的正文（折线图复用同一段） */
export function PastRangeTooltipBody({ row }: { row: PastRangeChartRow }) {
  return (
    <>
      <p className="font-black text-indigo-950">{row.day}</p>
      <p className="mt-1.5 font-bold text-slate-700">
        判对 {row.practiceMarkCorrect} · 判错 {row.practiceMarkWrong} · 太简单 {row.practiceMarkEasy}
        <span className="font-black text-indigo-900">（本日刷题 {row.marksTotal}）</span>
      </p>
      <p className="mt-1 text-slate-600">
        课文阅读 {formatDwellSec(row.dwellLessonReaderSec)} · 练习页 {formatDwellSec(row.dwellPracticeSec)}
      </p>
    </>
  );
}

function extractPastRowFromTooltipPayload(
  payload: ReadonlyArray<{ payload?: unknown }> | undefined,
): PastRangeChartRow | null {
  if (!payload?.length) return null;
  for (const item of payload) {
    const raw = item.payload;
    if (raw && typeof raw === "object" && "day" in raw && typeof (raw as PastRangeChartRow).day === "string") {
      return raw as PastRangeChartRow;
    }
  }
  return null;
}

function PastChartTooltip(props: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) {
  const row = extractPastRowFromTooltipPayload(props.payload);
  if (!props.active || !row) return null;
  return (
    <div className="z-[100] max-w-[260px] rounded-xl border border-indigo-200/80 bg-white/98 px-3 py-2 text-[0.7rem] leading-relaxed text-slate-800 shadow-xl">
      <PastRangeTooltipBody row={row} />
      <p className="mt-1.5 border-t border-slate-200/80 pt-1.5 text-[0.65rem] text-slate-500">
        当日停留（秒）：课文 {row.dwellLessonReaderSec} · 练习 {row.dwellPracticeSec}
      </p>
    </div>
  );
}

type FutureTipProps = {
  active?: boolean;
  payload?: { payload: FutureChartRow }[];
};

function FutureTooltip({ active, payload }: FutureTipProps) {
  if (!active || !payload?.[0]) return null;
  const row = payload[0].payload;
  const isTodayRow = row.day === calendarTodayLocal();
  return (
    <div className="max-w-[240px] rounded-xl border border-violet-200/80 bg-white/95 px-3 py-2 text-[0.7rem] leading-relaxed text-slate-800 shadow-lg">
      <p className="font-black text-violet-950">{row.day}</p>
      <p className="mt-1.5 font-bold text-slate-700">
        词 {row.vocab} · 句 {row.sentence} · 语法 {row.grammar}
        <span className="font-black text-violet-900">（当日合计 {row.total}）</span>
      </p>
      {isTodayRow && (
        <p className="mt-1 text-[0.65rem] text-slate-500">今日列含排期早于今天的未毕业条目，与「今日待刷」一致。</p>
      )}
      <p className="mt-1 text-slate-600">自今日（含）起至当日柱高累计：{row.cumulativeDue} 条</p>
    </div>
  );
}

/** 上下两块「三序列堆叠柱」共用色（未来=词/句/法；过往仅柱状=判对/判错/太简单） */
const STATS_STACK_THREE_COLORS = { a: "#6d28d9", b: "#1d4ed8", c: "#047857" } as const;

export function StatsPastRangeChart({
  data,
  variant = "full",
}: {
  data: PastRangeChartRow[];
  /** full：堆叠柱 + 停留折线；barsOnly：仅堆叠柱；timeOnly：仅停留折线（独立 LineChart，与柱状图同 Tooltip） */
  variant?: "full" | "barsOnly" | "timeOnly";
}) {
  const reduceMotion = usePrefersReducedMotion();

  if (data.length === 0) {
    return <p className="mt-4 text-sm text-[color:var(--sun-muted)]">暂无按日记录，练习或停留一段时间后会出现在图上。</p>;
  }

  const tooltipEl = <Tooltip content={(p) => <PastChartTooltip active={p.active} payload={p.payload} />} wrapperStyle={{ zIndex: 100 }} cursor={{ stroke: "#94a3b8", strokeWidth: 1 }} />;

  if (variant === "timeOnly") {
    const maxDwellSec = Math.max(
      60,
      ...data.map((d) => Math.max(d.dwellLessonReaderSec ?? 0, d.dwellPracticeSec ?? 0)),
    );
    const yMax = Math.ceil(maxDwellSec * 1.12);
    return (
      <div
        className="mt-4 h-[min(20rem,52vh)] min-h-[16rem] w-full sm:h-80 sm:min-h-[20rem]"
        role="figure"
        aria-label="按日停留时间折线图"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, left: 52, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--sun-muted) 35%, transparent)" />
            <XAxis dataKey="dayShort" tick={{ fontSize: 11, fill: "var(--sun-muted)" }} interval="preserveStartEnd" minTickGap={14} />
            <YAxis
              width={48}
              tick={{ fontSize: 11, fill: "var(--sun-muted)" }}
              domain={[0, yMax]}
              allowDecimals={false}
              label={{ value: "停留(秒)", angle: -90, position: "insideLeft", offset: 10, style: { fontSize: 11, fill: "var(--sun-muted)" } }}
            />
            {tooltipEl}
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line
              type="monotone"
              dataKey="dwellLessonReaderSec"
              name="课文阅读(秒)"
              stroke="#0f766e"
              strokeWidth={3}
              dot={{ r: 4, strokeWidth: 1, fill: "#fff" }}
              activeDot={{ r: 6 }}
              isAnimationActive={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="dwellPracticeSec"
              name="练习页(秒)"
              stroke="#b45309"
              strokeWidth={3}
              dot={{ r: 4, strokeWidth: 1, fill: "#fff" }}
              activeDot={{ r: 6 }}
              isAnimationActive={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const barsOnly = variant === "barsOnly";
  const marginRight = barsOnly ? 4 : 8;
  const stackId = barsOnly ? "due" : "marks";
  const c = barsOnly ? STATS_STACK_THREE_COLORS : { a: "#4f46e5", b: "#c026d3", c: "#a78bfa" };
  return (
    <div
      className="mt-4 h-[min(20rem,52vh)] min-h-[16rem] w-full sm:h-80 sm:min-h-[20rem]"
      role="figure"
      aria-label={barsOnly ? "按日刷题堆叠柱状图" : "按日刷题与停留组合图"}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: marginRight, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--sun-muted) 35%, transparent)" />
          <XAxis dataKey="dayShort" tick={{ fontSize: 10, fill: "var(--sun-muted)" }} interval="preserveStartEnd" minTickGap={16} />
          <YAxis
            yAxisId="marks"
            width={36}
            tick={{ fontSize: 10, fill: "var(--sun-muted)" }}
            allowDecimals={false}
            label={{ value: "题数", angle: -90, position: "insideLeft", offset: 10, style: { fontSize: 10, fill: "var(--sun-muted)" } }}
          />
          {!barsOnly && (
            <YAxis
              yAxisId="dwell"
              orientation="right"
              width={40}
              tick={{ fontSize: 10, fill: "var(--sun-muted)" }}
              label={{ value: "停留(分)", angle: 90, position: "insideRight", offset: 0, style: { fontSize: 10, fill: "var(--sun-muted)" } }}
            />
          )}
          {tooltipEl}
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar
            yAxisId="marks"
            dataKey="practiceMarkCorrect"
            name="判对"
            stackId={stackId}
            fill={c.a}
            radius={[0, 0, 0, 0]}
            isAnimationActive={!reduceMotion}
          />
          <Bar yAxisId="marks" dataKey="practiceMarkWrong" name="判错" stackId={stackId} fill={c.b} isAnimationActive={!reduceMotion} />
          <Bar yAxisId="marks" dataKey="practiceMarkEasy" name="太简单" stackId={stackId} fill={c.c} isAnimationActive={!reduceMotion} />
          {!barsOnly && (
            <>
              <Line
                yAxisId="dwell"
                type="monotone"
                dataKey="dwellLessonMin"
                name="课文阅读(分)"
                stroke="#0f766e"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                yAxisId="dwell"
                type="monotone"
                dataKey="dwellPracticeMin"
                name="练习页(分)"
                stroke="#b45309"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatsFutureDueChart({
  data,
  showCumulativeLine = true,
}: {
  data: FutureChartRow[];
  /** 为 false 时仅保留堆叠柱（当日词/句/法），隐藏右侧累计折线 */
  showCumulativeLine?: boolean;
}) {
  const reduceMotion = usePrefersReducedMotion();

  if (data.length === 0) {
    return <p className="mt-4 text-sm text-[color:var(--sun-muted)]">暂无未来排期数据。</p>;
  }
  const marginRight = showCumulativeLine ? 8 : 4;
  return (
    <div
      className="mt-4 h-[min(20rem,52vh)] min-h-[16rem] w-full sm:h-80 sm:min-h-[20rem]"
      role="figure"
      aria-label="未来到期题目堆叠图"
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: marginRight, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--sun-muted) 35%, transparent)" />
          <XAxis dataKey="dayShort" tick={{ fontSize: 10, fill: "var(--sun-muted)" }} interval="preserveStartEnd" minTickGap={12} />
          <YAxis
            yAxisId="day"
            width={36}
            tick={{ fontSize: 10, fill: "var(--sun-muted)" }}
            allowDecimals={false}
            label={{ value: "当日题数", angle: -90, position: "insideLeft", offset: 10, style: { fontSize: 10, fill: "var(--sun-muted)" } }}
          />
          {showCumulativeLine && (
            <YAxis
              yAxisId="cum"
              orientation="right"
              width={44}
              tick={{ fontSize: 10, fill: "var(--sun-muted)" }}
              allowDecimals={false}
              label={{ value: "累计条数", angle: 90, position: "insideRight", offset: 0, style: { fontSize: 10, fill: "var(--sun-muted)" } }}
            />
          )}
          <Tooltip content={<FutureTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar yAxisId="day" dataKey="vocab" name="词" stackId="due" fill={STATS_STACK_THREE_COLORS.a} isAnimationActive={!reduceMotion} />
          <Bar yAxisId="day" dataKey="sentence" name="句" stackId="due" fill={STATS_STACK_THREE_COLORS.b} isAnimationActive={!reduceMotion} />
          <Bar yAxisId="day" dataKey="grammar" name="语法" stackId="due" fill={STATS_STACK_THREE_COLORS.c} isAnimationActive={!reduceMotion} />
          {showCumulativeLine && (
            <Line
              yAxisId="cum"
              type="monotone"
              dataKey="cumulativeDue"
              name="累计到期"
              stroke="#ea580c"
              strokeWidth={2}
              dot={{ r: 2, strokeWidth: 1, fill: "#fff" }}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
