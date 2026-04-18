import { NextResponse } from "next/server";
import { z } from "zod";
import { optionalEnvOverridesField, sanitizeApiEnvOverrides } from "@/modules/ai/apiEnvOverrides";
import { generateChatWithHistoryOrThrow, resolveChatLlmEnv } from "@/modules/ai/bytedanceProxy";

const schema = z.object({
  jp: z.string().min(1).max(500),
  zh: z.string().max(500).optional(),
  envOverrides: optionalEnvOverridesField,
});

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const { jp, zh } = parsed.data;
  const envOverrides = sanitizeApiEnvOverrides(parsed.data.envOverrides);
  const llm = resolveChatLlmEnv(envOverrides);
  if (!llm.apiKey) return NextResponse.json({ teachingNote: "暂无" });

  const systemPrompt =
    "你是日语老师。输出纯文本中文讲解，不要 Markdown。结构固定三段：1)知识点（2-4条）2)语感体会（为什么地道）3)口语/书面使用建议。总长度 120-260 字，语气温和具体。";
  const userPrompt = `请讲解这句日语，帮助初学者感受原汁原味表达。\n日语：${jp}\n中文参考：${zh?.trim() || "无"}`;
  try {
    const answer = await generateChatWithHistoryOrThrow({
      systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.35,
      maxTokens: 700,
      resolveEnv: () => resolveChatLlmEnv(envOverrides),
    });
    const teachingNote = answer.trim();
    return NextResponse.json({ teachingNote: teachingNote || "暂无" });
  } catch {
    return NextResponse.json({ teachingNote: "暂无" });
  }
}
