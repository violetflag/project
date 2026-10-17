"use client";

import { useState } from "react";
import { exportCsv, exportJson, exportMarkdown, toMarkdown } from "@/lib/export";
import type { Project } from "@/lib/types";
import { Close } from "../icons";

export function ShareDialog({ p, onClose }: { p: Project; onClose: () => void }) {
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(p));
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    setTimeout(() => setCopied(""), 1800);
  };
  const items: [string, string, () => void][] = [
    ["Markdown 파일", "문서 도구, 메신저, AI 코딩 도구에 붙여 넣기 좋아요", () => exportMarkdown(p)],
    ["엑셀(CSV) 기능명세서", "기능 목록을 표로 정리해 내려받아요", () => exportCsv(p)],
    ["JSON 백업", "프로젝트 전체를 파일로 보관해요. [전체 프로젝트]에서 다시 불러올 수 있어요", () => exportJson(p)],
  ];
  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20 md:bg-transparent" onClick={onClose} />
      <div role="dialog" aria-label="내보내기"
        className="animate-fade-up fixed inset-x-0 bottom-0 z-40 rounded-t-2xl border border-border bg-background pb-[env(safe-area-inset-bottom)] shadow-xl md:absolute md:inset-x-auto md:top-11 md:right-3 md:bottom-auto md:w-80 md:rounded-lg">
        <div className="flex items-center justify-between px-4 pt-3">
          <p className="text-sm font-medium">내보내기</p>
          <button onClick={onClose} aria-label="닫기" className="p-1"><Close className="h-3.5 w-3.5 text-foreground-muted" /></button>
        </div>
        <div className="space-y-1.5 p-4">
          {items.map(([t, d, fn]) => (
            <button key={t} onClick={fn} className="block w-full rounded-md border border-border px-3 py-2.5 text-left hover:border-border-strong">
              <span className="block text-sm">{t}</span>
              <span className="block text-[11px] text-foreground-muted">{d}</span>
            </button>
          ))}
          <button onClick={copy} className="w-full rounded-md bg-primary py-2.5 text-sm text-white">
            {copied === "ok" ? "복사했어요" : copied === "fail" ? "복사하지 못했어요. Markdown 파일로 받아 주세요" : "기획서 전체를 클립보드에 복사"}
          </button>
        </div>
      </div>
    </>
  );
}
