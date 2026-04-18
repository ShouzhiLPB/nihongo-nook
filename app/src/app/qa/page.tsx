"use client";

import { useMemo } from "react";
import {
  I2_CLOUD_WEAKNET_ACCEPTANCE,
  I2_DEVICE_SWITCH_ACCEPTANCE,
  I2_LAYOUT_ACCEPTANCE,
  I2_PHONE_VIEWPORT_MATRIX_ACCEPTANCE,
  I22_ACCESSIBILITY_LAYOUT_ACCEPTANCE,
} from "@/modules/testing/i2AcceptanceChecklists";
import { runSelfChecks } from "@/modules/testing/selfChecks";

export default function QAPage() {
  const checks = useMemo(() => runSelfChecks(), []);
  const passedCount = checks.filter((item) => item.passed).length;

  return (
    <main className="min-h-screen bg-[#f8f7f2] px-4 py-6 pb-16 text-[#304846]">
      <section className="mx-auto max-w-3xl rounded-2xl bg-white p-5 shadow-sm">
        <h1 className="text-2xl font-bold">自检测试页面</h1>
        <p className="mt-1 text-sm text-[#607b77]">
          你不用终端，直接打开这个页面就能看到核心逻辑测试结果：<span className="font-mono text-[0.8rem]">/qa</span>
          。CI 与本地还可跑 Chromium 冒烟：<span className="font-mono text-[0.8rem]">npm run test:e2e</span>（会先{" "}
          <span className="font-mono text-[0.8rem]">build</span>；首次请在 <span className="font-mono text-[0.8rem]">app</span>{" "}
          目录执行 <span className="font-mono text-[0.8rem]">npx playwright install chromium</span> 装浏览器）。
          一键验收（单测 + build，在仓库<strong>根目录</strong>）：<span className="font-mono text-[0.8rem]">npm run verify</span>；若要再跑 ESLint：{" "}
          <span className="font-mono text-[0.8rem]">npm run verify:lint</span>（同上根目录）。仅在 <span className="font-mono text-[0.8rem]">app</span> 目录时可用{" "}
          <span className="font-mono text-[0.8rem]">npm test</span> + <span className="font-mono text-[0.8rem]">npm run build</span>。
        </p>
        <p className="mt-3 rounded bg-[#eef5f3] px-3 py-2 text-sm">
          通过 {passedCount} / {checks.length}
        </p>
        <div className="mt-3 space-y-2">
          {checks.map((check) => (
            <article key={check.name} className="rounded border border-[#d9e7e3] p-3 text-sm">
              <p className={check.passed ? "text-green-700" : "text-red-600"}>
                {check.passed ? "通过" : "失败"}：{check.name}
              </p>
              <p className="text-[#607b77]">{check.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto mt-8 max-w-3xl rounded-2xl border border-[#d4e4df] bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold text-[#1e3d38]">i2-6 全端验收 · 手动清单（可复制）</h2>
        <p className="mt-2 text-sm leading-relaxed text-[#607b77]">
          下面不是自动跑出来的结果，而是给你（或朋友）按顺序打勾用的<strong>回归脚本</strong>。云端配置步骤见仓库{" "}
          <span className="font-mono text-[0.75rem]">docs/CLOUD_SETUP.md</span>；产品迭代记录见{" "}
          <span className="font-mono text-[0.75rem]">docs/PROJECT_PLAN.md</span> 中「i 二代」表格。
        </p>
        <p className="mt-2 rounded border border-[#c5ddd4] bg-[#f4faf7] px-3 py-2 text-sm leading-relaxed text-[#304846]">
          <strong>进度怎么理解</strong>：自动化（Playwright / 单测）算「引擎室」——已在 CI 跑。你看到的<strong>手勾清单 + 下方主流宽度矩阵</strong>算「真机/仿真验收说明书」——
          本轮把<strong>矩阵与换机步骤写全</strong>；你实际在真机或 DevTools 上勾完一遍，i2-6 的「手勾部分」才算 100%。若某宽度发现问题，再按 bug 开<strong>0～若干次</strong>小迭代修 UI 即可，不绑死轮数。
        </p>

        <h3 className="mt-6 text-base font-bold text-[#1e3d38]">一、三档宽度（手机 / 平板 / 桌面）</h3>
        <p className="mt-1 text-xs text-[#607b77]">用浏览器窗口拖窄拖宽即可模拟；主应用入口在首页。</p>
        <div className="mt-3 space-y-5">
          {I2_LAYOUT_ACCEPTANCE.map((block) => (
            <div key={block.title}>
              <p className="text-sm font-bold text-[#304846]">{block.title}</p>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-[#304846]">
                {block.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>

        <h3 className="mt-8 text-base font-bold text-[#1e3d38]">一附、换设备前快验</h3>
        <p className="mt-1 text-xs text-[#607b77]">出门换手机、换电脑、清 Cookie 前扫一遍，减少「以为已同步」。</p>
        <div className="mt-3 space-y-5">
          {I2_DEVICE_SWITCH_ACCEPTANCE.map((block) => (
            <div key={block.title}>
              <p className="text-sm font-bold text-[#304846]">{block.title}</p>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-[#304846]">
                {block.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>

        <h3 className="mt-8 text-base font-bold text-[#1e3d38]">一附二、主流手机逻辑宽度矩阵（手勾）</h3>
        <p className="mt-1 text-xs text-[#607b77]">
          覆盖常见 CSS 逻辑宽度；不替代全机型农场。全部预设勾完约 <strong>10～20 分钟</strong>（熟手更短）。
        </p>
        <div className="mt-3 space-y-5">
          {I2_PHONE_VIEWPORT_MATRIX_ACCEPTANCE.map((block) => (
            <div key={block.title}>
              <p className="text-sm font-bold text-[#304846]">{block.title}</p>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-[#304846]">
                {block.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>

        <h3 className="mt-8 text-base font-bold text-[#1e3d38]">二、云端与弱网</h3>
        <p className="mt-1 text-xs text-[#607b77]">在<strong>数据</strong>标签完成登录、上传、恢复；弱网用 Chrome Network Throttling。</p>
        <div className="mt-3 space-y-5">
          {I2_CLOUD_WEAKNET_ACCEPTANCE.map((block) => (
            <div key={block.title}>
              <p className="text-sm font-bold text-[#304846]">{block.title}</p>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-[#304846]">
                {block.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto mt-8 max-w-3xl rounded-2xl border border-[#d4e4df] bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold text-[#1e3d38]">Iteration 22 · 打磨与无障碍（手动清单）</h2>
        <p className="mt-2 text-sm leading-relaxed text-[#607b77]">
          对应路线图 §15.2 <strong>Iter 22</strong>：动效收敛 + 三档宽度抽检。自动冒烟含「减少动态效果」配置见{" "}
          <span className="font-mono text-[0.75rem]">app/e2e/iter22-reduced-motion.spec.ts</span>。
        </p>
        <div className="mt-4 space-y-5">
          {I22_ACCESSIBILITY_LAYOUT_ACCEPTANCE.map((block) => (
            <div key={block.title}>
              <p className="text-sm font-bold text-[#304846]">{block.title}</p>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-[#304846]">
                {block.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

