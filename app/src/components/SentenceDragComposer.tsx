"use client";

import clsx from "clsx";
import { useEffect, useState } from "react";
import { playPracticeSwoosh, playPracticeTap } from "@/shared/practiceSfx";
import { uid } from "@/shared/utils";

type Slot = { id: string; token: string };

function slotsFromTokens(tokens: string[]): Slot[] {
  return tokens.map((token) => ({ id: uid("slot"), token }));
}

export function SentenceDragComposer({
  tokens,
  correctTokens,
  onAnswerChange,
  revealSolutionOrder = false,
}: {
  tokens: string[];
  correctTokens: string[];
  onAnswerChange: (value: string) => void;
  /** 自动判错后短时展示题库词序，便于对照改排 */
  revealSolutionOrder?: boolean;
}) {
  const [pool, setPool] = useState<Slot[]>(() => slotsFromTokens(tokens));
  const [selected, setSelected] = useState<Slot[]>([]);
  const [dragKey, setDragKey] = useState<string | null>(null);

  useEffect(() => {
    onAnswerChange(selected.map((s) => s.token).join(" "));
  }, [selected, onAnswerChange]);

  function movePoolToSelected(slot: Slot, insertIndex?: number) {
    setPool((p) => p.filter((s) => s.id !== slot.id));
    setSelected((s) => {
      const next = [...s];
      const at = insertIndex === undefined ? next.length : Math.max(0, Math.min(insertIndex, next.length));
      next.splice(at, 0, slot);
      return next;
    });
    playPracticeSwoosh();
  }

  function moveSelectedToPool(slot: Slot) {
    setSelected((s) => {
      return s.filter((x) => x.id !== slot.id);
    });
    setPool((p) => [...p, slot]);
    playPracticeTap();
  }

  function reorderSelected(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return;
    setSelected((s) => {
      const next = [...s];
      const [item] = next.splice(fromIdx, 1);
      if (!item) return s;
      let insert = toIdx;
      if (fromIdx < toIdx) insert = toIdx - 1;
      next.splice(insert, 0, item);
      return next;
    });
    playPracticeTap();
  }

  function clearAll() {
    setPool(slotsFromTokens(tokens));
    setSelected([]);
    playPracticeTap();
  }

  function slotDragStart(e: React.DragEvent, id: string) {
    e.dataTransfer.setData("text/sentence-slot", id);
    e.dataTransfer.effectAllowed = "move";
    setDragKey(id);
  }

  function slotDragEnd() {
    setDragKey(null);
  }

  function dropOnSelectedAt(e: React.DragEvent, targetIndex: number) {
    e.preventDefault();
    const dragId = e.dataTransfer.getData("text/sentence-slot");
    if (!dragId) return;
    const pIdx = pool.findIndex((s) => s.id === dragId);
    if (pIdx >= 0) {
      const slot = pool[pIdx]!;
      movePoolToSelected(slot, targetIndex);
      return;
    }
    const sIdx = selected.findIndex((s) => s.id === dragId);
    if (sIdx >= 0) reorderSelected(sIdx, targetIndex);
  }

  function dropOnPoolZone(e: React.DragEvent) {
    e.preventDefault();
    const dragId = e.dataTransfer.getData("text/sentence-slot");
    if (!dragId) return;
    const slot = selected.find((s) => s.id === dragId);
    if (slot) moveSelectedToPool(slot);
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-[color:var(--sun-muted)]">将词块拖入下方横条组成完整句子（亦可点击）；在句条内拖到词前可插入。</p>
      <div
        className="flex flex-wrap gap-2 rounded-2xl bg-amber-100/70 px-3 py-3 transition-[box-shadow] duration-200 motion-safe:transition-[box-shadow,transform]"
        onDragOver={(e) => e.preventDefault()}
        onDrop={dropOnPoolZone}
      >
        {pool.map((slot) => (
          <button
            key={slot.id}
            type="button"
            draggable
            onDragStart={(e) => slotDragStart(e, slot.id)}
            onDragEnd={slotDragEnd}
            onClick={() => movePoolToSelected(slot)}
            className={clsx(
              "chip !bg-white/90 motion-safe:transition motion-safe:duration-150 motion-safe:ease-out",
              "motion-safe:hover:scale-[1.02] motion-safe:active:scale-[0.97]",
              dragKey === slot.id && "ring-2 ring-amber-500/80",
            )}
          >
            {slot.token}
          </button>
        ))}
      </div>

      <div
        className="min-h-16 rounded-2xl border-2 border-dashed border-[color-mix(in_srgb,var(--sun-warm)_55%,transparent)] bg-white/85 px-2 py-3 motion-safe:transition-shadow motion-safe:duration-200"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const dragId = e.dataTransfer.getData("text/sentence-slot");
          if (!dragId) return;
          if (pool.some((s) => s.id === dragId)) {
            const slot = pool.find((s) => s.id === dragId)!;
            movePoolToSelected(slot, selected.length);
          }
        }}
      >
        {selected.length === 0 ? (
          <span className="block px-2 text-sm text-[color:var(--sun-muted)]">拖拽或点击词块到这里组句</span>
        ) : (
          <div className="flex flex-wrap items-stretch gap-1 sm:gap-2">
            {selected.map((slot, idx) => (
              <div key={slot.id} className="flex items-center gap-0.5">
                <div
                  className="w-1.5 shrink-0 self-stretch rounded-full bg-teal-200/50 motion-safe:transition-colors motion-safe:duration-200 hover:bg-teal-400/70"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => dropOnSelectedAt(e, idx)}
                  title="插在此词前"
                  aria-hidden
                />
                <div
                  draggable
                  onClick={() => moveSelectedToPool(slot)}
                  onDragStart={(e) => slotDragStart(e, slot.id)}
                  onDragEnd={slotDragEnd}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => dropOnSelectedAt(e, idx)}
                  className={clsx(
                    "cursor-grab rounded-xl border border-teal-200/90 bg-teal-50/95 px-3 py-2 text-sm font-semibold text-teal-950 shadow-sm",
                    "motion-safe:transition motion-safe:duration-150 motion-safe:ease-out",
                    "motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]",
                    dragKey === slot.id && "ring-2 ring-teal-500/90",
                  )}
                >
                  {slot.token}
                </div>
              </div>
            ))}
            <div
              className="min-h-10 min-w-6 flex-1 rounded-lg bg-teal-100/30 motion-safe:transition-colors motion-safe:duration-200 hover:bg-teal-100/60"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => dropOnSelectedAt(e, selected.length)}
              title="追加到句末"
            />
          </div>
        )}
      </div>

      {revealSolutionOrder && (
        <div
          className="rounded-2xl border-2 border-emerald-400/60 bg-emerald-50/95 px-3 py-3 shadow-sm motion-safe:transition motion-safe:duration-300"
          role="status"
          aria-live="polite"
        >
          <p className="text-xs font-black text-emerald-900">参考词序（与题库一致）</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {correctTokens.map((t, i) => (
              <span
                key={`sol_${i}_${t}`}
                className="rounded-xl border border-emerald-200/90 bg-emerald-100/90 px-3 py-1.5 text-sm font-bold text-emerald-950 shadow-sm"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="chip !bg-rose-100 !text-rose-900 motion-safe:active:scale-95" onClick={clearAll}>
            清空重组
          </button>
          <p className="text-xs font-semibold text-[color:var(--sun-muted)]">点已选词块可一键退回上方。</p>
        </div>
      )}
    </div>
  );
}
