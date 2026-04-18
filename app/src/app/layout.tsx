import type { Metadata, Viewport } from "next";
import "./globals.css";

/** 正式站域名：优先环境变量，其次 Vercel 自动域名，本地为 localhost */
function resolveSiteOrigin(): string {
  const explicit = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  const vercel = (process.env.VERCEL_URL ?? "").trim().replace(/\/$/, "");
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

const siteOrigin = resolveSiteOrigin();

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: "日语学习助手",
  description: "平板优先、跨端可用的日语学习应用",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: "/",
    siteName: "日语学习小窝",
    title: "日语学习助手",
    description: "平板优先、跨端可用的日语学习应用",
  },
  twitter: {
    card: "summary_large_image",
    title: "日语学习助手",
    description: "平板优先、跨端可用的日语学习应用",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
