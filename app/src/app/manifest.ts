import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "日语学习助手",
    short_name: "日语学习",
    description: "平板优先的日语学习应用，支持词卡、句译、语法与课文聊天。",
    start_url: "/",
    display: "standalone",
    background_color: "#fffbf0",
    theme_color: "#e8a838",
    icons: [
      {
        src: "/icon.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}

