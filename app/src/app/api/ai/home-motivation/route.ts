import { NextResponse } from "next/server";
import { z } from "zod";
import { optionalEnvOverridesField, sanitizeApiEnvOverrides } from "@/modules/ai/apiEnvOverrides";
import { generateChatWithHistoryOrThrow, resolveChatLlmEnv } from "@/modules/ai/bytedanceProxy";

const schema = z.object({
  window: z.enum(["dawn", "night"]),
  /** 客户端传入，降低连续两次完全雷同的概率 */
  salt: z.string().max(160).optional(),
  envOverrides: optionalEnvOverridesField,
});

function sanitizeLine(raw: string): string {
  let s = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.replace(/[*#`_\[\]()]/g, "");
  s = s.replace(/\n+/g, " ");
  s = s.replace(/\s{2,}/g, " ").trim();
  if (s.length > 160) s = `${s.slice(0, 157)}…`;
  return s;
}

export async function POST(req: Request) {
  const parse = schema.safeParse(await req.json());
  if (!parse.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { window, salt } = parse.data;
  const envOverrides = sanitizeApiEnvOverrides(parse.data.envOverrides);
  const llm = resolveChatLlmEnv(envOverrides);

  if (!llm.apiKey) {
    return NextResponse.json({
      line: "月色在窗外慢慢走，心事像纸一样薄；等风也等你，再读一页日语也好。",
      fallback: true as const,
    });
  }

  const mood =
    window === "dawn"
      ? "拂晓：朝雾、晨光、鸟鸣、启程与清寂。"
      : "夜深：灯火、星月、静思、与己对坐、江天辽阔。";

  const userBlock = [
    `时段：${window === "dawn" ? "清晨" : "夜晚"}。${mood}`,
    salt ? `随机扰动（勿照抄字面）：${salt}` : "",
    "请写一段适合日语学习 App 首页展示的感性短句：散文诗笔调，可化用古典意境（如江畔月色、流水、孤舟、不知江月待何人之感），但不要整段照抄中小学课本常见全诗。",
    "禁止引用本应用内的课文、例句、单词卡、练习题或任何用户可能导入的教材原文；不要出现「背单词」「刷题」等工具化口号。",
    "约 60～110 字，纯中文为主，可夹少量文言。只输出正文一段，不要标题、不要引号包裹全段、不要 Markdown。",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const raw = await generateChatWithHistoryOrThrow({
      systemPrompt:
        "你是中文随笔作者，擅长留白与诗性。严格遵守用户指令中的禁止项。输出必须是单行或一段连续中文，不要分条、不要列表符号。",
      messages: [{ role: "user", content: userBlock }],
      temperature: 0.88,
      maxTokens: 320,
      resolveEnv: () => resolveChatLlmEnv(envOverrides),
    });
    const line = sanitizeLine(raw);
    if (!line) {
      return NextResponse.json({ line: "江月无言，只照有心人；今夜把字读轻一点，也就离静更近一点。", fallback: true });
    }
    return NextResponse.json({ line });
  } catch {
    return NextResponse.json({
      line: "灯影摇书页，像小船贴着水走；读不下去的时候，就抬头看看月亮还在不在。",
      fallback: true as const,
    });
  }
}
