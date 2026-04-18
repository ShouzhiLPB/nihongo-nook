"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export function readPrefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getServerSnapshot(): boolean {
  return false;
}

/** 客户端组件内用：随系统「减少动态效果」实时更新 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, readPrefersReducedMotion, getServerSnapshot);
}
