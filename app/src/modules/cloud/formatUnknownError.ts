/**
 * 将 `catch` 中的未知值转成可展示的短字符串（避免 `{ message: "…" }` 被 `String(e)` 变成 `[object Object]`）。
 */
export function formatUnknownError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || String(e);
  if (e != null && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim().length > 0) return o.message.trim();
    if (typeof o.error_description === "string" && o.error_description.trim().length > 0) {
      return o.error_description.trim();
    }
    if (typeof o.details === "string" && o.details.trim().length > 0) return o.details.trim();
    if (typeof o.hint === "string" && o.hint.trim().length > 0) return o.hint.trim();
    if (typeof o.code === "string" && o.code.trim().length > 0 && typeof o.message !== "string") {
      return o.code.trim();
    }
    try {
      const s = JSON.stringify(e);
      if (s.length > 600) return `${s.slice(0, 600)}…`;
      return s;
    } catch {
      /* fall through */
    }
  }
  return String(e);
}
