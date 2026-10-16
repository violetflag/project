import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import { ConnectorModalProvider } from "@/components/ConnectorModal";
import { Sidebar } from "@/components/Sidebar";
import { FloatingButtons } from "@/components/Floating";
import "./globals.css";

export const metadata: Metadata = {
  title: `${brand.name} | AI와 함께 기획하는 워크스페이스`,
  description: "아이디어를 기획 문서로 정리하는 팀 워크스페이스 데모",
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
        <ConnectorModalProvider>
          <div className="flex h-screen">
            <Sidebar />
            <main className="h-full min-h-0 w-full flex-1 p-2">{children}</main>
          </div>
          <FloatingButtons />
        </ConnectorModalProvider>
      </body>
    </html>
  );
}
