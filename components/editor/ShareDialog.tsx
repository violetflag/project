"use client";

import { useState } from "react";
import { brand } from "@/lib/brand";
import { exportCsv, exportJson, exportMarkdown, toMarkdown } from "@/lib/export";
import type { Project } from "@/lib/types";
import { Close } from "../icons";

export function ShareDialog({ p, onClose }: { p: Project; onClose: () => void }) {
  const [tab, setTab] = useState<"멤버" | "내보내기">("내보내기");
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(p));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="animate-fade-up absolute top-11 right-3 z-40 w-80 rounded-lg border border-border bg-background shadow-xl">
      <div className="flex items-center justify-between px-4 pt-3">
        <p className="text-sm font-medium">프로젝트 공유</p>
        <button onClick={onClose} aria-label="닫기"><Close className="h-3.5 w-3.5 text-foreground-muted" /></button>
      </div>
      <div className="flex gap-1 border-b border-border px-4 pt-2">
        {(["멤버", "내보내기"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`border-b-2 px-2 pb-1.5 text-xs ${tab === t ? "border-foreground font-medium" : "border-transparent text-foreground-muted"}`}>{t}</button>
        ))}
      </div>
      {tab === "멤버" ? (
        <div className="space-y-2 p-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-foreground-support text-[10px] text-white">{brand.user[0]}</span>
            <span className="flex-1">{brand.user} (나)</span><span className="text-xs text-foreground-muted">소유자</span>
          </div>
          <p className="pt-2 text-xs text-foreground-muted">이 버전은 브라우저에만 저장돼서 다른 사람을 초대할 수 없어요. 내보내기로 파일을 전달하세요.</p>
        </div>
      ) : (
        <div className="space-y-1.5 p-4">
          {[
            ["Markdown 파일", "문서 도구, 메신저, AI 코딩 도구에 붙여 넣기 좋아요", () => exportMarkdown(p)],
            ["엑셀(CSV) 기능명세서", "기능 목록을 표로 정리해 내려받아요", () => exportCsv(p)],
            ["JSON 백업", "프로젝트 전체를 파일로 보관해요", () => exportJson(p)],
          ].map(([t, d, fn]) => (
            <button key={t as string} onClick={fn as () => void} className="block w-full rounded-md border border-border px-3 py-2 text-left hover:border-border-strong">
              <span className="block text-sm">{t as string}</span>
              <span className="block text-[11px] text-foreground-muted">{d as string}</span>
            </button>
          ))}
          <button onClick={copy} className="w-full rounded-md bg-primary py-2 text-sm text-white">{copied ? "복사했어요" : "기획서 전체를 클립보드에 복사"}</button>
        </div>
      )}
    </div>
  );
}
