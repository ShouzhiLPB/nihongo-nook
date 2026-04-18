import { NextResponse } from "next/server";
import { z } from "zod";
import { optionalEnvOverridesField, sanitizeApiEnvOverrides } from "@/modules/ai/apiEnvOverrides";
import { generateChatWithHistoryOrThrow, resolveChatLlmEnv } from "@/modules/ai/bytedanceProxy";

const schema = z.object({
  japanese: z.string().min(1).max(2000),
  envOverrides: optionalEnvOverridesField,
});

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const parse = schema.safeParse(await req.json());
  if (!parse.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { japanese } = parse.data;
  const envOverrides = sanitizeApiEnvOverrides(parse.data.envOverrides);
  const llm = resolveChatLlmEnv(envOverrides);

  if (!llm.apiKey) {
    const trimmed = japanese.trim().slice(0, 120);
    return NextResponse.json({
      zh: "（未配置模型密钥：请自行填写中文提示，下方日语可作参考答案。）",
      jpAnswer: trimmed,
    });
  }

  try {
    const raw = await generateChatWithHistoryOrThrow({
      systemPrompt:
        "你是日语教材编者。只输出合法 JSON，键仅为 zh 与 jpAnswer，不要 Markdown。jpAnswer 为与所选日文对应的参考答案，用**单个半角空格**在词块或意群之间断开，便于学习者拖拽组句；块数建议 4～14。zh 为简短中文提示（一句内），描述中译方向或提问方式。",
      messages: [
        {
          role: "user",
          content: `以下是从课文里划出的一段日文，请生成练习题用的 zh 与 jpAnswer：\n\n${japanese}`,
        },
      ],
      temperature: 0.35,
      maxTokens: 600,
      resolveEnv: () => resolveChatLlmEnv(envOverrides),
    });

    const obj = parseJsonObject(raw);
    if (!obj) {
      return NextResponse.json({
        zh: "（解析失败，请手填。）",
        jpAnswer: japanese.trim().slice(0, 200),
      });
    }
    const zh = typeof obj.zh === "string" ? obj.zh.trim() : "";
    const jpAnswer = typeof obj.jpAnswer === "string" ? obj.jpAnswer.trim() : "";
    return NextResponse.json({
      zh: zh || "（无中文提示）",
      jpAnswer: jpAnswer || japanese.trim(),
    });
  } catch {
    return NextResponse.json({
      zh: "（生成失败，请稍后重试或手填。）",
      jpAnswer: japanese.trim().slice(0, 200),
    });
  }
}
