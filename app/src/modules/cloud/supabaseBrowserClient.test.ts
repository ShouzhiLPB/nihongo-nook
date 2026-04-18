import { afterEach, describe, expect, it, vi } from "vitest";
import { isSupabaseBrowserConfigured, readSupabasePublicEnv, resetSupabaseBrowserClientForTests } from "./supabaseBrowserClient";

describe("readSupabasePublicEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetSupabaseBrowserClientForTests();
  });

  it("returns null when vars missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect(readSupabasePublicEnv()).toBeNull();
    expect(isSupabaseBrowserConfigured()).toBe(false);
  });

  it("returns config when both set", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "eyJhbGciOiJIUzI1NiJ9.fake");
    expect(readSupabasePublicEnv()).toEqual({
      url: "https://abc.supabase.co",
      anonKey: "eyJhbGciOiJIUzI1NiJ9.fake",
    });
    expect(isSupabaseBrowserConfigured()).toBe(true);
  });

  it("trims whitespace", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "  https://x.supabase.co  ");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "  key  ");
    expect(readSupabasePublicEnv()).toEqual({ url: "https://x.supabase.co", anonKey: "key" });
  });
});
