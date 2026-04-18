import { z } from "zod";

/**
 * 各 /api/ai/* 仍可选接受请求体里的 envOverrides（白名单），当前前端已不再发送。
 * 密钥以部署环境变量（.env / 平台配置）为准。
 */

export type ApiEnvOverrides = Partial<Record<string, string>>;

/** 附加到各 /api/ai/* POST 的 JSON 上，由服务端 sanitize 后参与解析 */
export const optionalEnvOverridesField = z.record(z.string(), z.string()).optional();

const ALLOWED_OVERRIDE_KEYS = new Set([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_IMAGE_MODEL",
  "OPENAI_IMAGE_SIZE",
  "DOUBAO_BASE_URL",
  "DOUBAO_PRO_API_KEY",
  "DOUBAO_LITE_API_KEY",
  "DOUBAO_PRO_MODEL",
  "DOUBAO_LITE_MODEL",
  "ARK_API_KEY",
  "DOUBAO_API_KEY",
  "DOUBAO_IMAGE_API_KEY",
  "DOUBAO_IMAGE_MODEL",
  "DOUBAO_IMAGE_SIZE",
]);

/** 非空覆盖优先，否则读 process.env，均 trim */
export function pickEnv(name: string, overrides?: ApiEnvOverrides | null): string {
  const o = overrides?.[name];
  if (o !== undefined && o !== null && String(o).trim() !== "") return String(o).trim();
  return (process.env[name] || "").trim();
}

/** 从请求 JSON 中取出并白名单过滤，避免任意 process.env 键注入 */
export function sanitizeApiEnvOverrides(input: unknown): ApiEnvOverrides | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: ApiEnvOverrides = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!ALLOWED_OVERRIDE_KEYS.has(k)) continue;
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || t.length > 4096) continue;
    out[k] = t;
  }
  return Object.keys(out).length ? out : undefined;
}
