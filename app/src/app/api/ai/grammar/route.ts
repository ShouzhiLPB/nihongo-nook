import { NextResponse } from "next/server";
import { z } from "zod";
import { optionalEnvOverridesField, sanitizeApiEnvOverrides } from "@/modules/ai/apiEnvOverrides";
import { generateChatWithHistoryOrThrow, resolveChatLlmEnvPreferPro } from "@/modules/ai/bytedanceProxy";
import { parseJsonObject } from "@/shared/utils";

const schema = z.object({
  prompt: z.string().min(1),
  knowledgePoint: z.string().optional(),
  envOverrides: optionalEnvOverridesField,
});

function normalizeWrongReasons(choices: string[], answerIndex: number, wrongReasons: string[] | undefined): string[] {
  const out = [...(wrongReasons ?? [])].slice(0, 4);
  while (out.length < 4) out.push("");
  for (let i = 0; i < 4; i++) {
    if (i === answerIndex) {
      out[i] = "";
      continue;
    }
    let t = (out[i] ?? "").trim();
    const opt = choices[i] ?? "";
    if (t.length < 28) {
      const pad = `结合本题题干，把「${opt}」填入 ___ 处会使该分句的助词/活用/呼应关系或语义角色与前后成分不协调；请对照正确答案所要求的句法功能理解排除理由。`;
      t = t ? `${t} ${pad}` : pad;
    }
    out[i] = t;
  }
  return out;
}

const grammarResultSchema = z.object({
  choices: z.array(z.string()).length(4),
  answerIndex: z.number().int().min(0).max(3),
  zhPrompt: z.string().min(6).optional(),
  explanation: z.string().min(20),
  wrongReasons: z.array(z.string()).length(4).optional(),
});

export async function POST(req: Request) {
  const parse = schema.safeParse(await req.json());
  if (!parse.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { prompt, knowledgePoint } = parse.data;
  const envOverrides = sanitizeApiEnvOverrides(parse.data.envOverrides);
  const llm = resolveChatLlmEnvPreferPro(envOverrides);

  if (!llm.apiKey) {
    return NextResponse.json({
      choices: ["は", "が", "を", "に"],
      answerIndex: 0,
      explanation: `题干：${prompt}\n当前未配置模型环境变量，已返回默认题目。${
        knowledgePoint ? `知识点：${knowledgePoint}` : ""
      }`,
      wrongReasons: ["", "该选项与主语主题用法不符。", "该选项通常用于宾语而非此处语义。", "该选项语义角色不匹配。"],
    });
  }

  const systemPrompt = `你是严谨的日语语法教授。只输出一个 JSON 对象，不要 Markdown、不要代码围栏、不要任何 JSON 外文字。
格式严格为：
{"choices":["A","B","C","D"],"answerIndex":0,"zhPrompt":"...","explanation":"...","wrongReasons":["r0","r1","r2","r3"]}

字段规则：
- choices：4 个选项，须与题干 ___ 处语法层级一致，干扰项要有迷惑性但不得与正确答案同形。
- answerIndex：0～3，唯一正确项下标。
- zhPrompt：把题干准确翻译成中文，保留 ___ 空位，长度 8～60 字。
- explanation：用**中文**写 100～400 字。先点明考点（可结合用户给出的知识点），再说明**正确答案代入后**句法与语义为何成立，可简要对比易混点。
- wrongReasons：长度必须与 choices 相同、下标一一对应。**answerIndex 对应位置必须是空字符串 ""。** 其余三个位置：各写 **45～140 字中文**，必须**点名该下标选项的文字**，结合本题题干中 ___ 前后的词语，具体写出：代入后会造成何种句法错误、语义不通、搭配习惯不成立或文体不当；禁止仅用「不对」「不匹配」等空话。`;

  const userContent = `请根据以下信息生成四选一语法题 JSON。

题干（___ 为填空位置）：
${prompt}

用户标注的语法知识点（若无则写「无」）：
${knowledgePoint?.trim() || "无"}

务必返回合法 JSON；wrongReasons 四个元素缺一不可，且仅正确项下标处为空字符串。`;

  try {
    const raw = await generateChatWithHistoryOrThrow({
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
      temperature: 0.22,
      maxTokens: 1600,
      resolveEnv: () => resolveChatLlmEnvPreferPro(envOverrides),
    });

    const obj = parseJsonObject(raw);
    if (!obj) {
      throw new Error("Unparseable AI grammar JSON");
    }

    const parsed = grammarResultSchema.safeParse({
      choices: obj.choices,
      answerIndex: obj.answerIndex,
      zhPrompt: obj.zhPrompt,
      explanation: obj.explanation,
      wrongReasons: obj.wrongReasons,
    });

    if (!parsed.success) {
      throw new Error("Invalid AI grammar payload");
    }

    const { choices, answerIndex, explanation, zhPrompt } = parsed.data;
    const wrongReasons = normalizeWrongReasons(choices, answerIndex, parsed.data.wrongReasons);

    return NextResponse.json({
      choices,
      answerIndex,
      zhPrompt: zhPrompt?.trim(),
      explanation: explanation.trim(),
      wrongReasons,
    });
  } catch {
    return NextResponse.json({
      choices: ["は", "が", "を", "に"],
      answerIndex: 0,
      zhPrompt: "我每天早上___学习日语。",
      explanation:
        "AI 生成暂不可用，已切换稳定兜底题目。建议稍后重试；若已配置 DOUBAO_PRO_API_KEY，将优先使用 Pro 模型出题。",
      wrongReasons: ["", "该助词位置与句法不一致。", "该助词语义角色不匹配。", "该助词常用于其他语法环境。"],
    });
  }
}
