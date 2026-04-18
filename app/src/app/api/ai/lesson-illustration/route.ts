import { NextResponse } from "next/server";
import { z } from "zod";
import { optionalEnvOverridesField, sanitizeApiEnvOverrides } from "@/modules/ai/apiEnvOverrides";
import { generateLessonCoverIllustrationDataUrl, resolveImageGenEnv } from "@/modules/ai/imageGenProxy";

const schema = z.object({
  /** 课文标题 */
  title: z.string().max(200).optional(),
  /** 若干行原文 + 译文摘要，供构图联想（勿过长） */
  themeHint: z.string().min(1).max(1200),
  envOverrides: optionalEnvOverridesField,
});

export async function POST(req: Request) {
  const parse = schema.safeParse(await req.json());
  if (!parse.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { title, themeHint } = parse.data;
  const envOverrides = sanitizeApiEnvOverrides(parse.data.envOverrides);
  const env = resolveImageGenEnv(envOverrides);
  if (env.provider === "none") {
    return NextResponse.json({
      skipped: true,
      message: "未配置文生图：请至少配置 OPENAI_API_KEY，或配置火山 Pro/Lite（未单独写配图 key 时会自动用同一串）。",
    });
  }

  const hint = [title?.trim(), themeHint.trim()].filter(Boolean).join("\n");

  try {
    const dataUrl = await generateLessonCoverIllustrationDataUrl(hint, envOverrides);
    return NextResponse.json({ dataUrl });
  } catch (e) {
    const code = (e as Error)?.message || "";
    if (code === "IMAGE_GEN_NO_KEY") {
      return NextResponse.json({ skipped: true, message: "未配置文生图密钥。" });
    }
    return NextResponse.json(
      { error: "IMAGE_GEN_FAILED", detail: String((e as Error)?.message || "").slice(0, 400) },
      { status: 502 },
    );
  }
}
