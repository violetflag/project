"use client";

import { useEffect, useState } from "react";
import { exportFlowPng, exportSpecPng } from "@/lib/diagram-png";
import { download, exportCsv, exportDeliverables, exportJson, exportMarkdown, exportXlsx, toMarkdown } from "@/lib/export";
import type { Project } from "@/lib/types";
import { printPdf, pdfHtmlFile } from "@/lib/pdf";
import { exportPrototype } from "@/lib/prototype";
import { exportWirePng } from "@/lib/wire-png";
import { Close } from "../icons";
import { EMPTY, ExportPreview, hasExport, type ExportKind } from "./ExportPreview";

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
  const [preview, setPreview] = useState<ExportKind | null>(null);
  const [note, setNote] = useState("");
  const png = (fn: (p: Project) => Promise<boolean>, k: ExportKind) => () => { void fn(p).then((ok) => { if (!ok) setNote(EMPTY[k] ?? "내보낼 내용이 없어요."); }); };
  const items: [ExportKind, string, string, () => void][] = [
    ["md", "Markdown 파일", "PRD, 3단계 기능명세서(개발 준비·수용 기준 포함), 유저플로우, 와이어프레임 화면별 구성", () => exportMarkdown(p, { mermaid })],
    ["pdf", "PDF 문서", "인쇄 창이 열리면 'PDF로 저장'을 고르세요. 팝업이 막히면 HTML 파일로 받아요", () => {
      if (printPdf(p)) return;
      const f = pdfHtmlFile(p);
      download(f.name, f.text, "text/html");
    }],
    ["xlsx", "엑셀(.xlsx) 기획서", "기능명세서·유저플로우·와이어프레임 화면을 시트별 표로 받아요", () => exportXlsx(p)],
    ["proto", "HTML 프로토타입", "와이어프레임을 눌러 보며 화면을 오가는 파일 하나예요", () => { if (!exportPrototype(p)) setNote(EMPTY.proto!); }],
    ["flow-png", "유저플로우 이미지(PNG)", "열려 있는 유저플로우 전체를 한 장으로", png(exportFlowPng, "flow-png")],
    ["spec-png", "기능명세서 그래프 이미지(PNG)", "요구사항 → 기능 → 상세 기능 그래프를 한 장으로", png(exportSpecPng, "spec-png")],
    ["wire-png", "와이어프레임 PNG", "화면마다 한 칸씩 그린 이미지 한 장이에요", png(exportWirePng, "wire-png")],
    ["json", "JSON 기획서", "결과물만 구조화해 담아요. 다른 도구나 AI 코딩 도구에 넘기기 좋아요", () => exportDeliverables(p)],
    ["csv", "CSV 기능명세서", "요구사항·기능·상세 기능을 한 줄씩 (다른 표 도구용)", () => exportCsv(p)],
    ["backup", "JSON 백업", "프로젝트 전체를 보관해요. [전체 프로젝트]에서 다시 불러올 수 있어요", () => exportJson(p)],
  ];
  const open = items.find((x) => x[0] === preview);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { if (preview) setPreview(null); else onClose(); } };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [preview, onClose]);
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
          {items.map(([k, t, d, fn]) => {
            const empty = !hasExport(p, k);
            return (
              <div key={k} className={`flex items-stretch rounded-md border border-border hover:border-border-strong ${empty ? "opacity-50" : ""}`}>
                <button onClick={() => setPreview(k)} aria-label={`${t} 미리보기`} className="min-w-0 flex-1 px-3 py-2.5 text-left">
                  <span className="block text-sm">{t}</span>
                  <span className="block text-[11px] text-foreground-muted">{empty ? EMPTY[k] : d}</span>
                </button>
                <button onClick={() => { setNote(""); fn(); }} disabled={empty} aria-label={`${t} 내려받기`} title="바로 내려받기"
                  className="shrink-0 border-l border-border px-3 text-foreground-muted hover:text-primary disabled:cursor-not-allowed">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></svg>
                </button>
              </div>
            );
          })}
          {note && <p role="status" className="px-1 text-xs text-amber-700">{note}</p>}
          <p className="px-1 text-[11px] text-foreground-muted">이름을 누르면 미리보기, 화살표를 누르면 바로 내려받아요.</p>
          <label className="flex items-center gap-2 px-1 py-1 text-xs text-foreground-support">
            <input type="checkbox" checked={mermaid} onChange={(e) => setMermaid(e.target.checked)} aria-label="유저플로우를 Mermaid로" />
            유저플로우를 Mermaid 다이어그램으로 (끄면 목록으로)
          </label>
          <button onClick={copy} className="w-full rounded-md bg-primary py-2.5 text-sm text-white">
            {copied === "ok" ? "복사했어요" : copied === "fail" ? "복사하지 못했어요. Markdown 파일로 받아 주세요" : "기획서 전체를 클립보드에 복사"}
          </button>
        </div>
      </div>
      {open && <ExportPreview p={p} kind={open[0]} title={open[1]} onDownload={() => { open[3](); }} onClose={() => setPreview(null)} />}
    </>
  );
}
