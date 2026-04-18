import type { ApiEnvOverrides } from "@/modules/ai/apiEnvOverrides";
import { pickEnv } from "@/modules/ai/apiEnvOverrides";

type ChatRole = "system" | "user" | "assistant";

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type ResolvedLlmEnv = {
  provider: "openai" | "doubao" | "none";
  apiKey: string;
  baseUrl: string;
  model: string;
};

type GenerateOpts = {
  systemPrompt: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 默认 resolveChatLlmEnv；质量任务可传 resolveChatLlmEnvPreferPro */
  resolveEnv?: () => ResolvedLlmEnv;
};

type RetryOpts = {
  retries?: number;
};

// Copied from 1Langue backend-node/src/services/index.js
export function resolveChatLlmEnv(overrides?: ApiEnvOverrides | null): ResolvedLlmEnv {
  const openaiKey = pickEnv("OPENAI_API_KEY", overrides);
  if (openaiKey) {
    return {
      provider: "openai",
      apiKey: openaiKey,
      baseUrl: (pickEnv("OPENAI_BASE_URL", overrides) || "https://api.openai.com/v1").replace(/\/$/, ""),
      model: (pickEnv("OPENAI_MODEL", overrides) || "gpt-4o-mini").trim(),
    };
  }

  const doubaoBase = (pickEnv("DOUBAO_BASE_URL", overrides) || "https://ark.cn-beijing.volces.com/api/v3").replace(
    /\/$/,
    "",
  );
  const liteKey = pickEnv("DOUBAO_LITE_API_KEY", overrides);
  const proKey =
    pickEnv("DOUBAO_PRO_API_KEY", overrides) ||
    pickEnv("ARK_API_KEY", overrides) ||
    pickEnv("DOUBAO_API_KEY", overrides);

  if (liteKey) {
    return {
      provider: "doubao",
      apiKey: liteKey,
      baseUrl: doubaoBase,
      model: (pickEnv("DOUBAO_LITE_MODEL", overrides) || "doubao-seed-2-0-lite-260215").trim(),
    };
  }
  if (proKey) {
    return {
      provider: "doubao",
      apiKey: proKey,
      baseUrl: doubaoBase,
      model: (pickEnv("DOUBAO_PRO_MODEL", overrides) || "doubao-seed-2-0-pro-260215").trim(),
    };
  }

  return { provider: "none", apiKey: "", baseUrl: doubaoBase, model: "" };
}

/**
 * 出题、词卡补全等「质量优先」调用：OpenAI 仍优先；否则 **Pro 密钥先于 Lite**，
 * 避免同时配置两者时永远走 Lite。
 */
export function resolveChatLlmEnvPreferPro(overrides?: ApiEnvOverrides | null): ResolvedLlmEnv {
  const openaiKey = pickEnv("OPENAI_API_KEY", overrides);
  if (openaiKey) {
    return {
      provider: "openai",
      apiKey: openaiKey,
      baseUrl: (pickEnv("OPENAI_BASE_URL", overrides) || "https://api.openai.com/v1").replace(/\/$/, ""),
      model: (pickEnv("OPENAI_MODEL", overrides) || "gpt-4o-mini").trim(),
    };
  }

  const doubaoBase = (pickEnv("DOUBAO_BASE_URL", overrides) || "https://ark.cn-beijing.volces.com/api/v3").replace(
    /\/$/,
    "",
  );
  const liteKey = pickEnv("DOUBAO_LITE_API_KEY", overrides);
  const proKey =
    pickEnv("DOUBAO_PRO_API_KEY", overrides) ||
    pickEnv("ARK_API_KEY", overrides) ||
    pickEnv("DOUBAO_API_KEY", overrides);

  if (proKey) {
    return {
      provider: "doubao",
      apiKey: proKey,
      baseUrl: doubaoBase,
      model: (pickEnv("DOUBAO_PRO_MODEL", overrides) || "doubao-seed-2-0-pro-260215").trim(),
    };
  }
  if (liteKey) {
    return {
      provider: "doubao",
      apiKey: liteKey,
      baseUrl: doubaoBase,
      model: (pickEnv("DOUBAO_LITE_MODEL", overrides) || "doubao-seed-2-0-lite-260215").trim(),
    };
  }

  return { provider: "none", apiKey: "", baseUrl: doubaoBase, model: "" };
}

export async function fetchWithRetry(url: string, options: RequestInit, { retries = 1 }: RetryOpts = {}) {
  const max = Math.max(0, Number(retries));
  const baseDelayMs = Number(process.env.LLM_FETCH_RETRY_DELAY_MS ?? 500);

  for (let attempt = 0; attempt <= max; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (err) {
      const msg = String((err as Error)?.message || "");
      const isLikelyNetworkFailure = msg.toLowerCase().includes("fetch failed");
      if (!isLikelyNetworkFailure || attempt === max) throw err;
      const delayMs = baseDelayMs * (attempt + 1);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("Unexpected retry flow");
}

// Copied from 1Langue backend-node/src/services/index.js
export async function generateChatWithHistoryOrThrow({
  systemPrompt,
  messages,
  temperature = 0.88,
  maxTokens = 900,
  resolveEnv = resolveChatLlmEnv,
}: GenerateOpts): Promise<string> {
  const { apiKey, baseUrl, model, provider } = resolveEnv();
  if (!apiKey) {
    const e = new Error("Clé LLM manquante");
    (e as Error & { code?: string }).code = "OPENAI_API_KEY_MISSING";
    throw e;
  }

  const payload = {
    model,
    temperature,
    top_p: 0.92,
    frequency_penalty: 0.2,
    presence_penalty: 0.06,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  };

  if (process.env.LLM_DEBUG === "1") {
    console.log("[llm] POST /chat/completions", {
      provider,
      baseUrl,
      model,
      historyTurns: messages.length,
      endsWith: messages[messages.length - 1]?.role,
    });
  }

  let response: Response;
  try {
    response = await fetchWithRetry(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      {
        retries: process.env.LLM_FETCH_RETRY_COUNT ? Number(process.env.LLM_FETCH_RETRY_COUNT) : 1,
      },
    );
  } catch (err) {
    const e = err as Error & { code?: string };
    e.code = e.code || "LLM_FETCH_FAILED";
    throw e;
  }

  const rawText = await response.text();
  type LlmResponse = {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  let data: LlmResponse | null = null;
  try {
    data = JSON.parse(rawText) as LlmResponse;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const e = new Error(data?.error?.message || rawText.slice(0, 200) || `HTTP ${response.status}`) as Error & {
      code?: string;
      status?: number;
      body?: string;
    };
    e.code = "OPENAI_HTTP_ERROR";
    e.status = response.status;
    e.body = rawText.slice(0, 1200);
    throw e;
  }

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    const e = new Error("Réponse vide du modèle") as Error & { code?: string };
    e.code = "OPENAI_EMPTY";
    throw e;
  }
  return text;
}

