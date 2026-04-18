import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * 不使用 next-pwa 包装：在部分环境下 Workbox / 预缓存与动态路由组合曾导致难以排查的问题。
 * 需要 PWA 时再单独接入并充分自测。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  /** 父目录也有 package-lock 时，避免把 workspace 根误判为 tracing 根导致路径混乱 */
  outputFileTracingRoot: appDir,
  webpack: (config, { dev }) => {
    if (dev) {
      /** Windows 下持久化 cache 重命名失败曾导致 .next 半成品与 routes-manifest ENOENT */
      config.cache = false;
    }
    return config;
  },
};

export default nextConfig;
