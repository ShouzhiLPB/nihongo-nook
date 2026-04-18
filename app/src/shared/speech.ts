/**
 * 使用浏览器内置 `speechSynthesis` 朗读日文（Web 标准 API）。
 * 实际音色由当前浏览器/OS 决定：Edge 常用微软语音，Safari 用苹果语音，Chrome 随平台变化。
 * 与 Python 版 KittenTTS 无关；用户无需安装 Kitten 即可在网页里听朗读。
 */
export function stopJapaneseSpeech(): void {
  if (typeof window === "undefined") return;
  window.speechSynthesis.cancel();
}

export function speakJapanese(text: string): void {
  if (typeof window === "undefined") return;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return;
  const utterance = new SpeechSynthesisUtterance(t.length > 400 ? `${t.slice(0, 400)}…` : t);
  utterance.lang = "ja-JP";
  utterance.rate = 0.92;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

/** 取课文中第一条含日文假名/汉字的非空行用于试读 */
export function firstJapaneseLineFromLesson(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const jp = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\u3400-\u4dbf]/;
  for (const raw of lines) {
    const line = raw.trim();
    if (line && jp.test(line)) return line;
  }
  return "";
}
