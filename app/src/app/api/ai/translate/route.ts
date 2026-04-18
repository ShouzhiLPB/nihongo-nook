import { NextResponse } from "next/server";
import { z } from "zod";
import { optionalEnvOverridesField, sanitizeApiEnvOverrides } from "@/modules/ai/apiEnvOverrides";
import { generateChatWithHistoryOrThrow, resolveChatLlmEnv } from "@/modules/ai/bytedanceProxy";

const schema = z.object({
  paragraph: z.string().min(1).max(8000),
  envOverrides: optionalEnvOverridesField,
});

export async function POST(req: Request) {
  const parse = schema.safeParse(await req.json());
  if (!parse.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { paragraph } = parse.data;
  const envOverrides = sanitizeApiEnvOverrides(parse.data.envOverrides);
  const llm = resolveChatLlmEnv(envOverrides);

  if (!llm.apiKey) {
    return NextResponse.json({
      zh: "（尚未配置模型密钥，无法翻译。配置后可逐段生成中文译文。）",
    });
  }

  try {
    const zh = await generateChatWithHistoryOrThrow({
      systemPrompt:
        "你是日语教材翻译助手。用户每次只给你一段课文（可能含多句）。请只输出流畅自然的中文译文，不要输出日文、不要复述原文、不要解释、不要加引号或标题。若原文已是中文则润色保留。",
      messages: [
        {
          role: "user",
          content: `请翻译下面这一段：\n\n${paragraph}`,
        },
      ],
      temperature: 0.25,
      maxTokens: 1200,
      resolveEnv: () => resolveChatLlmEnv(envOverrides),
    });

    return NextResponse.json({ zh: zh.trim() });
  } catch {
    return NextResponse.json({
      zh: "（本段翻译暂时失败，请稍后重试。）",
    });
  }
}
