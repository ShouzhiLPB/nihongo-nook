/**
 * 将 YouTube 观看页 / Shorts / youtu.be 转为可嵌入的 embed URL（不含 query，便于拼接 enablejsapi）。
 */
export function toYoutubeEmbedBaseUrl(url: string | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    if (host === "youtu.be") {
      const id = parsed.pathname.replace(/^\//, "").split("/")[0]?.trim();
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host === "www.youtube.com" || host === "youtube.com" || host === "m.youtube.com") {
      if (parsed.pathname.startsWith("/embed/")) {
        const rest = parsed.pathname.slice("/embed/".length).split("/")[0];
        return rest ? `https://www.youtube.com/embed/${rest}` : null;
      }
      const v = parsed.searchParams.get("v")?.trim();
      if (v) return `https://www.youtube.com/embed/${v}`;
      const shorts = parsed.pathname.match(/^\/shorts\/([^/?]+)/);
      if (shorts?.[1]) return `https://www.youtube.com/embed/${shorts[1]}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** 供 iframe.src：带 enablejsapi 便于 postMessage 控制播放位置 */
export function toYoutubeIframeSrc(url: string | undefined): string | null {
  const base = toYoutubeEmbedBaseUrl(url);
  if (!base) return null;
  const q = new URLSearchParams({ enablejsapi: "1", rel: "0" });
  return `${base}?${q.toString()}`;
}

/** 向 YouTube embed iframe 发 command（需 enablejsapi=1） */
export function postYoutubeIframeCommand(iframe: HTMLIFrameElement | null, func: string, args: unknown[] = []): void {
  if (!iframe?.contentWindow) return;
  iframe.contentWindow.postMessage(JSON.stringify({ event: "command", func, args }), "*");
}
