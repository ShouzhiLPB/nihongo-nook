import { NextResponse } from "next/server";
import { z } from "zod";
import { optionalEnvOverridesField, sanitizeApiEnvOverrides } from "@/modules/ai/apiEnvOverrides";
import { generateChatWithHistoryOrThrow, resolveChatLlmEnvPreferPro } from "@/modules/ai/bytedanceProxy";
import { parseJsonObject } from "@/shared/utils";

const schema = z.object({
  term: z.string().min(1).max(200),
  exampleSegment: z.string().max(600),
  lessonTitle: z.string().max(200).optional(),
  lessonCategory: z.string().max(200).optional(),
  envOverrides: optionalEnvOverridesField,
});

export async function POST(req: Request) {
  const parse = schema.safeParse(await req.json());
  if (!parse.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { term, exampleSegment, lessonTitle, lessonCategory } = parse.data;
  const envOverrides = sanitizeApiEnvOverrides(parse.data.envOverrides);
  const llm = resolveChatLlmEnvPreferPro(envOverrides);

  if (!llm.apiKey) {
    return NextResponse.json({
      kana: "—",
      zh: "—",
      etymology: "（未配置模型密钥，无法自动补全。）",
      distractors: ["する", "なる", "ある"],
      zhDistractors: ["学习", "认识", "使用"],
    });
  }

  const meta = [lessonTitle && `课文标题：${lessonTitle}`, lessonCategory && `课文分类：${lessonCategory}`]
    .filter(Boolean)
    .join("\n");

  const userBlock = `${meta ? `${meta}\n` : ""}词条：${term}
课文例句片段（已由程序截取，可能略短）：
${exampleSegment || "（未在课文中找到含该词的句子，请仅凭词条推断读音与释义。）"}

请只输出一个 JSON 对象（不要 Markdown、不要解释），字段严格为：
{"kana":"读音字段","zh":"1～2个中文义项短表","etymology":"50～120字记忆提示或词源说明，不确定勿编造事实","exampleJp":"自然日语例句整句（可选但强烈建议）","distractors":["干扰日语词1","干扰2","干扰3"],"zhDistractors":["错误中文义项1","错误2","错误3"]}
要求：
- kana：先写该词在标准语中的**习惯読み**（平假名为主、外来语可用片假名），**半角空格后写东京式アクセント数字型**（0＝平板、1＝頭高、2 起为中高型中核拍位置习惯记法，与教材数字型一致即可）。例：「はし 2」「かぞく 0」。若该词多音/多义且例句可判断，按例句义项标型；**实在无法判断时只写假名、不写数字**，不要猜造。
- zh 用课堂用语、逗号分隔义项；etymology 可幽默但要诚实。
- distractors：长度**恰好为 3** 的数组，每项为**不同于词条**的日语词或短词组（2～12 字为宜），用于词卡练习四选一干扰项；难度与词性尽量接近、勿与例句片段逐字重复，勿彼此重复。
- zhDistractors：长度**恰好为 3** 的数组，每项为**与 zh 字段语义不同**的简短中文课堂义项（4～16 字），用于「见日语选中文」四选一；勿与 zh 逐字相同或包含关系，勿彼此重复。
- exampleJp：**自然日语一句**（8～48 字为宜），必须**包含词条的原形或合理活用形**，用于词卡「例句」展示；当课文片段过短、仅为词条本身、或明显不是完整句子时**必须给出**；若课文片段已是完整好句且含该词，可与片段相同或略润色。`;

  try {
    const raw = await generateChatWithHistoryOrThrow({
      systemPrompt:
        "你是日语教材编者助手。用户要求你只输出合法 JSON 对象，键仅限 kana、zh、etymology、exampleJp、distractors、zhDistractors（distractors 与 zhDistractors 均为恰好 3 个字符串的数组；exampleJp 为单句字符串，可空但词典场景应给出）。字符串值内双引号必须转义为 \"。不要输出任何 JSON 以外文字。",
      messages: [{ role: "user", content: userBlock }],
      temperature: 0.28,
      maxTokens: 640,
      resolveEnv: () => resolveChatLlmEnvPreferPro(envOverrides),
    });

    const obj = parseJsonObject(raw);
    if (!obj) {
      return NextResponse.json({
        kana: "—",
        zh: "—",
        etymology: "（模型未返回可解析 JSON，请手填或重试。）",
        distractors: ["する", "なる", "ある"],
        zhDistractors: ["学习", "认识", "使用"],
      });
    }
    const kana = typeof obj.kana === "string" ? obj.kana.trim() : "";
    const zh = typeof obj?.zh === "string" ? obj.zh.trim() : "";
    const etymology = typeof obj?.etymology === "string" ? obj.etymology.trim() : "";
    const rawDist = Array.isArray(obj?.distractors) ? obj.distractors : [];
    const distractors = rawDist
      .map((x: unknown) => (typeof x === "string" ? x.trim() : ""))
      .filter((s: string) => s.length > 0 && s !== term.trim());
    const rawZhDist = Array.isArray(obj?.zhDistractors) ? obj.zhDistractors : [];
    const zhDistractors = rawZhDist
      .map((x: unknown) => (typeof x === "string" ? x.trim() : ""))
      .filter((s: string) => s.length > 0 && s !== zh.trim());
    const exampleJpRaw = typeof obj.exampleJp === "string" ? obj.exampleJp.trim() : "";

    return NextResponse.json({
      kana: kana || "—",
      zh: zh || "—",
      etymology: etymology || "—",
      ...(exampleJpRaw.length > 0 ? { exampleJp: exampleJpRaw.slice(0, 240) } : {}),
      distractors: distractors.length >= 3 ? distractors.slice(0, 3) : ["する", "なる", "ある"],
      zhDistractors: zhDistractors.length >= 3 ? zhDistractors.slice(0, 3) : ["学习", "认识", "使用"],
    });
  } catch {
    return NextResponse.json({
      kana: "—",
      zh: "—",
      etymology: "（本请求暂时失败，可稍后重试或手填。）",
      distractors: ["する", "なる", "ある"],
      zhDistractors: ["学习", "认识", "使用"],
    });
  }
}
