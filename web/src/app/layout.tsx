import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "车场 · ccop",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
