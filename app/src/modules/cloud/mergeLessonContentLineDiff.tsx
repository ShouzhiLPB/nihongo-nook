"use client";

import clsx from "clsx";

/** 从合并摘要里「单行规范化课文 JSON」解析两侧 `content` 正文（失败则返回 null）。 */
export function tryLessonContentPairFromNormJson(localJson: string, remoteJson: string): { left: string; right: string } | null {
  let left: string | null = null;
  let right: string | null = null;
  try {
    const o = JSON.parse(localJson) as { content?: unknown };
    if (typeof o.content === "string") left = o.content;
  } catch {
    return null;
  }
  try {
    const o = JSON.parse(remoteJson) as { content?: unknown };
    if (typeof o.content === "string") right = o.content;
  } catch {
    return null;
  }
  if (left === null || right === null) return null;
  return { left, right };
}

/** 合并弹层内「课文正文」并排逐行对照（MVP：按行号对齐，非 Myers diff）。 */
export function MergeLessonContentLineDiff({ left, right }: { left: string; right: string }) {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const n = Math.max(leftLines.length, rightLines.length);
  return (
    <div className="mt-3 rounded-xl border border-violet-200/80 bg-violet-50/30 p-2">
      <p className="text-[0.65rem] font-black text-violet-950">课文正文 · 逐行对照（同序对齐；非全文算法 diff）</p>
      <div className="mt-1 grid max-h-56 grid-cols-2 gap-0 overflow-auto rounded-lg border border-violet-200/60 bg-white/95 font-mono text-[0.62rem] leading-snug text-[color:var(--sun-ink)]">
        {Array.from({ length: n }, (_, i) => {
          const L = leftLines[i] ?? "";
          const R = rightLines[i] ?? "";
          const same = L === R;
          return (
            <div key={`ld_${i}`} className="contents">
              <div
                className={clsx(
                  "border-b border-r border-violet-100/90 px-1.5 py-0.5 whitespace-pre-wrap break-words",
                  !same && "bg-rose-50/95",
                )}
              >
                {L.length > 0 ? L : "\u00a0"}
              </div>
              <div
                className={clsx(
                  "border-b border-violet-100/90 px-1.5 py-0.5 whitespace-pre-wrap break-words",
                  !same && "bg-emerald-50/95",
                )}
              >
                {R.length > 0 ? R : "\u00a0"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
