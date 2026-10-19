"use client";

import { useState } from "react";
import { download, exportCsv, exportDeliverables, exportJson, exportMarkdown, toMarkdown } from "@/lib/export";
import type { Project } from "@/lib/types";
import { printPdf, pdfHtmlFile } from "@/lib/pdf";
import { exportWirePng } from "@/lib/wire-png";
import { Close } from "../icons";

export function ShareDialog({ p, onClose }: { p: Project; onClose: () => void }) {
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const [mermaid, setMermaid] = useState(true);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(p, { mermaid }));
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    setTimeout(() => setCopied(""), 1800);
  };
  const items: [string, string, () => void][] = [
    ["Markdown 파일", "PRD, 3단계 기능명세서(개발 준비·수용 기준 포함), 유저플로우, 와이어프레임 화면별 구성", () => exportMarkdown(p, { mermaid })],
    ["PDF 문서", "인쇄 창이 열리면 'PDF로 저장'을 고르세요. 팝업이 막히면 HTML 파일로 받아요", () => {
      if (printPdf(p)) return;
      const f = pdfHtmlFile(p);
      download(f.name, f.text, "text/html");
    }],
    ["와이어프레임 PNG", "화면마다 한 칸씩 그린 이미지 한 장이에요", () => { void exportWirePng(p).then((ok) => { if (!ok) window.alert("아직 그린 와이어프레임이 없어요."); }); }],
    ["JSON 기획서", "결과물만 구조화해 담아요. 다른 도구나 AI 코딩 도구에 넘기기 좋아요", () => exportDeliverables(p)],
    ["엑셀(CSV) 기능명세서", "요구사항·기능·상세 기능을 한 줄씩 표로 받아요", () => exportCsv(p)],
    ["JSON 백업", "프로젝트 전체를 보관해요. [전체 프로젝트]에서 다시 불러올 수 있어요", () => exportJson(p)],
  ];
  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20 md:bg-transparent" onClick={onClose} />
      <div role="dialog" aria-label="내보내기"
        className="animate-fade-up fixed inset-x-0 bottom-0 z-40 max-h-[85dvh] overflow-y-auto rounded-t-2xl border border-border bg-background pb-[env(safe-area-inset-bottom)] shadow-xl md:absolute md:inset-x-auto md:top-11 md:right-3 md:bottom-auto md:w-80 md:rounded-lg">
        <div className="flex items-center justify-between px-4 pt-3">
          <p className="text-sm font-medium">내보내기</p>
          <button onClick={onClose} aria-label="닫기" className="p-1"><Close className="h-3.5 w-3.5 text-foreground-muted" /></button>
        </div>
        <div className="space-y-1.5 p-4">
          {items.map(([t, d, fn]) => (
            <button key={t} onClick={fn} aria-label={`${t} 내려받기`} className="block w-full rounded-md border border-border px-3 py-2.5 text-left hover:border-border-strong">
              <span className="block text-sm">{t}</span>
              <span className="block text-[11px] text-foreground-muted">{d}</span>
            </button>
          ))}
          <label className="flex items-center gap-2 px-1 py-1 text-xs text-foreground-support">
            <input type="checkbox" checked={mermaid} onChange={(e) => setMermaid(e.target.checked)} aria-label="유저플로우를 Mermaid로" />
            유저플로우를 Mermaid 다이어그램으로 (끄면 목록으로)
          </label>
          <button onClick={copy} className="w-full rounded-md bg-primary py-2.5 text-sm text-white">
            {copied === "ok" ? "복사했어요" : copied === "fail" ? "복사하지 못했어요. Markdown 파일로 받아 주세요" : "기획서 전체를 클립보드에 복사"}
          </button>
        </div>
      </div>
    </>
  );
}
