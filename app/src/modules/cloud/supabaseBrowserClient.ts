import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null | undefined;

/** 供 Vitest 或热更新时重置单例 */
export function resetSupabaseBrowserClientForTests(): void {
  browserClient = undefined;
}

export function readSupabasePublicEnv(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function isSupabaseBrowserConfigured(): boolean {
  return readSupabasePublicEnv() !== null;
}

/**
 * 浏览器端 Supabase 单例（anon key）。仅应在客户端调用；未配置环境变量时返回 null。
 */
export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (typeof window === "undefined") return null;
  const cfg = readSupabasePublicEnv();
  if (!cfg) return null;
  if (browserClient === undefined) {
    browserClient = createClient(cfg.url, cfg.anonKey);
  }
  return browserClient;
}
