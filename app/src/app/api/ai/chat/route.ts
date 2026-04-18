import { NextResponse } from "next/server";
import { z } from "zod";
import { optionalEnvOverridesField, sanitizeApiEnvOverrides } from "@/modules/ai/apiEnvOverrides";
import { generateChatWithHistoryOrThrow, resolveChatLlmEnv } from "@/modules/ai/bytedanceProxy";

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const schema = z.object({
  mode: z.enum(["fast", "deep"]),
  lessonContent: z.string(),
  message: z.string().min(1),
  recentMessages: z.array(messageSchema).max(10),
  envOverrides: optionalEnvOverridesField,
});

export async function POST(req: Request) {
  const parse = schema.safeParse(await req.json());
  if (!parse.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { mode, message, lessonContent, recentMessages } = parse.data;
  const envOverrides = sanitizeApiEnvOverrides(parse.data.envOverrides);
  const llm = resolveChatLlmEnv(envOverrides);

  if (!llm.apiKey) {
    return NextResponse.json({
      answer:
        mode === "deep"
          ? `你当前使用思考模式。问题是：${message}。尚未配置字节模型密钥，建议先继续做题，之后再接入真实 API。`
          : `你当前使用快速模式。问题是：${message}。尚未配置字节模型密钥，建议先继续做题，之后再接入真实 API。`,
    });
  }

  try {
    const contextText =
      mode === "deep" && lessonContent.trim()
        ? `课文上下文如下：\n${lessonContent.slice(0, 4000)}`
        : "本轮是快速模式，不提供课文上下文。";

    const content = await generateChatWithHistoryOrThrow({
      systemPrompt:
        "你是耐心的日语学习教练。请给出结构清晰、鼓励式且严谨的中文回答，必要时附日语示例。必须使用纯文本，不要输出 Markdown 语法（不要使用 *, #, `, 列表标记等格式符号）。",
      messages: [
        {
          role: "user",
          content: `${contextText}\n历史对话：${JSON.stringify(recentMessages)}\n当前问题：${message}`,
        },
      ],
      temperature: mode === "deep" ? 0.4 : 0.6,
      maxTokens: 900,
      resolveEnv: () => resolveChatLlmEnv(envOverrides),
    });

    return NextResponse.json({ answer: content });
  } catch {
    return NextResponse.json({
      answer:
        "AI 暂时繁忙，我先给你一个稳妥建议：把问题拆成1个语法点+1个例句继续练，我会在服务恢复后继续详细讲解。",
    });
  }
}

