/** 练习轻音效（Web Audio）；尊重 prefers-reduced-motion */

let audioCtx: AudioContext | null = null;

function wantsReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

export function resumePracticeAudio(): void {
  if (typeof window === "undefined" || wantsReducedMotion()) return;
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
  } catch {
    /* ignore */
  }
}

function beep(freqStart: number, freqEnd: number, dur: number, vol: number) {
  if (typeof window === "undefined" || wantsReducedMotion()) return;
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const ctx = audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.connect(g);
    g.connect(ctx.destination);
    const t0 = ctx.currentTime;
    o.frequency.setValueAtTime(freqStart, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(80, freqEnd), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  } catch {
    /* ignore */
  }
}

export function playPracticeTap(): void {
  beep(640, 420, 0.07, 0.09);
}

export function playPracticeSuccess(): void {
  beep(520, 780, 0.06, 0.1);
  window.setTimeout(() => beep(780, 1040, 0.08, 0.08), 70);
}

export function playPracticeError(): void {
  beep(220, 140, 0.14, 0.11);
}

export function playPracticeSwoosh(): void {
  beep(380, 620, 0.1, 0.07);
}
