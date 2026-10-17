import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import { AppWatch } from "@/components/AppWatch";
import "./globals.css";

export const metadata: Metadata = {
  title: `${brand.name} | AI와 함께 기획하는 워크스페이스`,
  description: "아이디어를 PRD, 기능명세서, 유저플로우, 와이어프레임으로 정리하는 기획 워크스페이스",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body>
        <AppWatch />
        {children}
      </body>
    </html>
  );
}
