import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
/** npm workspace 仓库根（含根 package-lock.json） */
const monorepoRoot = path.resolve(appDir, "..");

/**
 * 不使用 next-pwa 包装：在部分环境下 Workbox / 预缓存与动态路由组合曾导致难以排查的问题。
 * 需要 PWA 时再单独接入并充分自测。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  /** 父目录也有 package-lock 时，避免把 workspace 根误判为 tracing 根导致路径混乱 */
  outputFileTracingRoot: monorepoRoot,
  /**
   * Monorepo 下 Turbopack 会误推断根目录；指向含 lockfile 的仓库根。
   * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory
   */
  turbopack: {
    root: monorepoRoot,
  },
};

/**
 * Vercel 构建环境会设置 VERCEL。Next 16 默认 `next build` 走 Turbopack；若此处保留自定义
 * `webpack`，默认构建会失败。本地仍用 webpack 分支 + `npm run build`（--webpack）规避 Windows 下 dev cache 问题。
 */
if (!process.env.VERCEL) {
  nextConfig.webpack = (config, { dev }) => {
    if (dev) {
      /** Windows 下持久化 cache 重命名失败曾导致 .next 半成品与 routes-manifest ENOENT */
      config.cache = false;
    }
    return config;
  };
}

export default nextConfig;
