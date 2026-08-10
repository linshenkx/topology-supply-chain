import type { Metadata } from "next";
import "./globals.css";
import "./approval.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_BASE_URL ?? "https://scm.topologygz.com"),
  title: "拓扑供应链 · 进销存协同系统",
  description: "采购、工厂执行、物料、生产质检、发货与库存一体化协同。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "拓扑供应链 · 进销存协同系统",
    description: "采购、生产、质检、发货与库存一体化协同。",
    images: [{ url: "/og.png", width: 1536, height: 1024 }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
