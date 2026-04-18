import type { ApiEnvOverrides } from "@/modules/ai/apiEnvOverrides";
import { pickEnv } from "@/modules/ai/apiEnvOverrides";
import { fetchWithRetry } from "@/modules/ai/bytedanceProxy";

type ImageEnv =
  | { provider: "openai"; apiKey: string; baseUrl: string; imageModel: string }
  | { provider: "doubao"; apiKey: string; baseUrl: string; imageModel: string }
  | { provider: "none"; apiKey: ""; baseUrl: string; imageModel: "" };

/**
 * 文生图：OpenAI 优先（DALL·E）。火山路径下 **只使用真实配置过的密钥串**：
 * DOUBAO_IMAGE_API_KEY 若已填则用其值；否则与 Pro（含 ARK/DOUBAO_API 别名）或 Lite **同一串**，不捏造占位符。
 */
export function resolveImageGenEnv(overrides?: ApiEnvOverrides | null): ImageEnv {
  const openaiKey = pickEnv("OPENAI_API_KEY", overrides);
  if (openaiKey) {
    const baseUrl = (pickEnv("OPENAI_BASE_URL", overrides) || "https://api.openai.com/v1").replace(/\/$/, "");
    return {
      provider: "openai",
      apiKey: openaiKey,
      baseUrl,
      imageModel: (pickEnv("OPENAI_IMAGE_MODEL", overrides) || "dall-e-3").trim(),
    };
  }

  const doubaoBase = (pickEnv("DOUBAO_BASE_URL", overrides) || "https://ark.cn-beijing.volces.com/api/v3").replace(
    /\/$/,
    "",
  );
  const imageOnlyKey = pickEnv("DOUBAO_IMAGE_API_KEY", overrides);
  const liteKey = pickEnv("DOUBAO_LITE_API_KEY", overrides);
  const proKey =
    pickEnv("DOUBAO_PRO_API_KEY", overrides) ||
    pickEnv("ARK_API_KEY", overrides) ||
    pickEnv("DOUBAO_API_KEY", overrides);
  const doubaoKey = imageOnlyKey || proKey || liteKey;
  if (doubaoKey) {
    return {
      provider: "doubao",
      apiKey: doubaoKey,
      baseUrl: doubaoBase,
      imageModel: (pickEnv("DOUBAO_IMAGE_MODEL", overrides) || "doubao-seedream-5-0-260128").trim(),
    };
  }

  return { provider: "none", apiKey: "", baseUrl: doubaoBase, imageModel: "" };
}

function buildTextbookStylePrompt(themeHint: string): string {
  const hint = themeHint.replace(/\s+/g, " ").trim().slice(0, 500);
  return [
    "Illustration in the style of classic Chinese primary-school language textbook art (语文课本插图):",
    "fresh, innocent, wholesome; clean gouache or soft colored pencil;",
    "bright but not harsh pastel palette, plenty of breathing room, simple composition;",
    "no readable text, no letters, no numbers, no logos, no watermark, no signatures;",
    "gentle daylight, calm mood, suitable for teenagers.",
    "Loosely visualize the atmosphere or setting suggested by this lesson theme (abstract or environmental; avoid depicting identifiable real persons):",
    hint || "a quiet everyday school-life moment in Japan or East Asia.",
  ].join(" ");
}

async function urlToDataUrl(imageUrl: string): Promise<string> {
  const res = await fetchWithRetry(
    imageUrl,
    { method: "GET" },
    { retries: process.env.LLM_FETCH_RETRY_COUNT ? Number(process.env.LLM_FETCH_RETRY_COUNT) : 1 },
  );
  if (!res.ok) {
    throw new Error(`Image download HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const b64 = buf.toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function generateOpenAiImageDataUrl(
  prompt: string,
  env: Extract<ImageEnv, { provider: "openai" }>,
  overrides?: ApiEnvOverrides | null,
): Promise<string> {
  const size = (pickEnv("OPENAI_IMAGE_SIZE", overrides) || "1024x1024").trim() as "1024x1024" | "1792x1024" | "1024x1792";
  const response = await fetchWithRetry(
    `${env.baseUrl}/images/generations`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.imageModel,
        prompt,
        n: 1,
        size,
        response_format: "b64_json",
      }),
    },
    { retries: process.env.LLM_FETCH_RETRY_COUNT ? Number(process.env.LLM_FETCH_RETRY_COUNT) : 1 },
  );
  const raw = await response.text();
  type OpenAiImgJson = { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } };
  let data: OpenAiImgJson | null = null;
  try {
    data = JSON.parse(raw) as OpenAiImgJson;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const errBody = data as OpenAiImgJson | null;
    throw new Error(errBody?.error?.message || raw.slice(0, 200));
  }
  const b64 = data?.data?.[0]?.b64_json;
  if (b64) {
    return `data:image/png;base64,${b64}`;
  }
  const url = data?.data?.[0]?.url;
  if (url) {
    return urlToDataUrl(url);
  }
  throw new Error("OpenAI image response empty");
}

async function generateDoubaoImageDataUrl(
  prompt: string,
  env: Extract<ImageEnv, { provider: "doubao" }>,
  overrides?: ApiEnvOverrides | null,
): Promise<string> {
  /**
   * Seedream 5.x 等要求总像素 ≥ 3686400（如 2560×1440）；512×512 会报 InvalidParameter。
   * 默认 2048×2048；也可用关键词 `2K`（见方舟文档）。
   */
  const size = (pickEnv("DOUBAO_IMAGE_SIZE", overrides) || "2048x2048").trim();
  const response = await fetchWithRetry(
    `${env.baseUrl}/images/generations`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.imageModel,
        prompt,
        size,
        response_format: "url",
        watermark: false,
        sequential_image_generation: "disabled",
        stream: false,
      }),
    },
    { retries: process.env.LLM_FETCH_RETRY_COUNT ? Number(process.env.LLM_FETCH_RETRY_COUNT) : 1 },
  );
  const raw = await response.text();
  type ArkErr = { message?: string; code?: string | number };
  type ArkRow = { url?: string; urls?: string[]; b64_json?: string };
  type ArkImgJson = { data?: ArkRow[]; error?: ArkErr | string; message?: string };
  let data: ArkImgJson | null = null;
  try {
    data = JSON.parse(raw) as ArkImgJson;
  } catch {
    data = null;
  }

  const arkErrMsg = (): string => {
    if (!data) return raw.slice(0, 280);
    if (typeof data.error === "string") return data.error.slice(0, 280);
    if (data.error && typeof data.error === "object") {
      const bits = [data.error.message, data.error.code != null ? String(data.error.code) : ""].filter(Boolean);
      if (bits.length) return bits.join(" ").slice(0, 280);
    }
    if (data.message) return String(data.message).slice(0, 280);
    return raw.slice(0, 280);
  };

  const pickUrl = (): string | undefined => {
    const row = data?.data?.[0];
    if (!row || typeof row !== "object") return undefined;
    if (typeof row.url === "string" && row.url.trim()) return row.url.trim();
    const urls = row.urls;
    if (Array.isArray(urls) && typeof urls[0] === "string" && urls[0].trim()) return urls[0].trim();
    return undefined;
  };

  if (!response.ok) {
    throw new Error(arkErrMsg());
  }
  if (data && data.error) {
    throw new Error(arkErrMsg());
  }
  const url = pickUrl();
  if (!url) {
    throw new Error(data?.data?.length ? `无图片 URL（返回片段：${raw.slice(0, 160)}）` : `空响应（${raw.slice(0, 200)}）`);
  }
  return urlToDataUrl(url);
}

const MAX_DATA_URL_CHARS = 2_400_000;

/**
 * 生成整课「语文课本」风格插图，返回 data URL（适合写入 localStorage）。
 */
export async function generateLessonCoverIllustrationDataUrl(
  themeHint: string,
  overrides?: ApiEnvOverrides | null,
): Promise<string> {
  const env = resolveImageGenEnv(overrides);
  if (env.provider === "none") {
    throw new Error("IMAGE_GEN_NO_KEY");
  }
  const prompt = buildTextbookStylePrompt(themeHint);
  let dataUrl: string;
  try {
    if (env.provider === "openai") {
      dataUrl = await generateOpenAiImageDataUrl(prompt, env, overrides);
    } else {
      dataUrl = await generateDoubaoImageDataUrl(prompt, env, overrides);
    }
  } catch (e) {
    const msg = String((e as Error)?.message || e || "unknown");
    const prov = env.provider === "openai" ? "OpenAI" : "火山方舟";
    throw new Error(`[${prov}] ${msg}`);
  }
  if (dataUrl.length > MAX_DATA_URL_CHARS) {
    throw new Error("IMAGE_TOO_LARGE");
  }
  return dataUrl;
}
