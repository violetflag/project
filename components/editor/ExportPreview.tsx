"use client";

import { useEffect, useState } from "react";
import { currentFlow, currentWires, toDeliverablesJson, toMarkdown, workbook } from "@/lib/export";
import { flowSvg, specSvg } from "@/lib/diagram-png";
import { pdfHtmlFile } from "@/lib/pdf";
import { prototypeHtml } from "@/lib/prototype";
import { wireSvg } from "@/lib/wire-png";
import type { Project } from "@/lib/types";
import { Close } from "../icons";

export type ExportKind = "md" | "pdf" | "xlsx" | "csv" | "proto" | "wire-png" | "flow-png" | "spec-png" | "json" | "backup";

// What a format would contain, or null when the project has nothing for it yet.
export function previewOf(p: Project, k: ExportKind):
  | { t: "text"; text: string } | { t: "html"; html: string } | { t: "svg"; svg: string } | { t: "sheets"; sheets: ReturnType<typeof workbook> } | null {
  switch (k) {
    case "md": return { t: "text", text: toMarkdown(p) };
    case "pdf": return { t: "html", html: pdfHtmlFile(p).text };
    case "xlsx": case "csv": return p.spec?.length ? { t: "sheets", sheets: k === "csv" ? workbook(p).slice(0, 1) : workbook(p) } : null;
    case "proto": { const w = currentWires(p); return w?.pages.length ? { t: "html", html: prototypeHtml(p, w) } : null; }
    case "wire-png": { const s = wireSvg(p); return s ? { t: "svg", svg: s } : null; }
    case "flow-png": { const f = currentFlow(p); return f ? { t: "svg", svg: flowSvg(f) } : null; }
    case "spec-png": { const s = specSvg(p); return s ? { t: "svg", svg: s } : null; }
    case "json": return { t: "text", text: toDeliverablesJson(p) };
    case "backup": return { t: "text", text: JSON.stringify(p, null, 2) };
  }
}

// Cheap check used by the list (previewOf builds the whole file).
export function hasExport(p: Project, k: ExportKind) {
  if (k === "xlsx" || k === "csv" || k === "spec-png") return !!p.spec?.length;
  if (k === "proto" || k === "wire-png") return !!currentWires(p)?.pages.length;
  if (k === "flow-png") return !!currentFlow(p);
  return true;
}

export const EMPTY: Partial<Record<ExportKind, string>> = {
  xlsx: "기능명세서가 아직 없어요.", csv: "기능명세서가 아직 없어요.", "spec-png": "기능명세서가 아직 없어요.",
  proto: "와이어프레임이 아직 없어요.", "wire-png": "와이어프레임이 아직 없어요.", "flow-png": "유저플로우가 아직 없어요.",
};

function Sheets({ sheets }: { sheets: ReturnType<typeof workbook> }) {
  const [i, setI] = useState(0);
  const sh = sheets[Math.min(i, sheets.length - 1)];
  return (
    <div className="flex h-full flex-col">
      {sheets.length > 1 && (
        <div role="tablist" aria-label="시트" className="flex gap-1 border-b border-border px-3 pt-2">
          {sheets.map((s, j) => (
            <button key={s.name} role="tab" aria-selected={j === i} onClick={() => setI(j)}
              className={`rounded-t-md px-3 py-1.5 text-xs ${j === i ? "bg-surface font-medium" : "text-foreground-muted"}`}>{s.name} <span className="text-foreground-assistive">{s.rows.length - 1}</span></button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="text-xs">
          <tbody>
            {sh.rows.slice(0, 300).map((r, ri) => (
              <tr key={ri} className={ri === 0 ? "sticky top-0 bg-primary-soft font-medium backdrop-blur" : ""}>
                {r.map((c, ci) => <td key={ci} className="max-w-[320px] min-w-[80px] border border-border px-2 py-1 align-top whitespace-pre-wrap">{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {sh.rows.length > 301 && <p className="p-3 text-xs text-foreground-muted">미리보기는 300줄까지 보여요. 파일에는 전부 들어가요.</p>}
      </div>
    </div>
  );
}

function SvgImage({ svg }: { svg: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    setUrl(u);
    return () => { URL.revokeObjectURL(u); };
  }, [svg]);
  return <div className="h-full overflow-auto bg-background-canvas p-4">{url && <img src={url} alt="내보낼 이미지 미리보기" className="mx-auto max-w-none bg-white shadow-sm" />}</div>;
}

export function ExportPreview({ p, kind, title, onDownload, onClose }: {
  p: Project; kind: ExportKind; title: string; onDownload: () => void; onClose: () => void;
}) {
  const v = previewOf(p, kind);
  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 p-0 md:p-6" onClick={onClose}>
      <div role="dialog" aria-label={`${title} 미리보기`} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        className="flex w-full max-w-5xl flex-col overflow-hidden bg-background shadow-2xl md:rounded-xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{title} 미리보기</p>
          <button onClick={onDownload} disabled={!v} aria-label={`${title} 내려받기`}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">{kind === "pdf" ? "인쇄·PDF 저장" : "내려받기"}</button>
          <button onClick={onClose} aria-label="미리보기 닫기" className="p-1.5 text-foreground-muted hover:text-foreground"><Close className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1">
          {!v ? <p className="grid h-full place-items-center p-8 text-sm text-foreground-muted">{EMPTY[kind] ?? "내보낼 내용이 없어요."}</p>
            : v.t === "text" ? <pre aria-label="미리보기 내용" className="h-full overflow-auto p-4 text-xs leading-relaxed whitespace-pre-wrap text-foreground-support">{v.text}</pre>
            : v.t === "html" ? <iframe title="미리보기" srcDoc={v.html} sandbox="allow-scripts" className="h-full w-full bg-white" />
            : v.t === "svg" ? <SvgImage svg={v.svg} />
            : <Sheets sheets={v.sheets} />}
        </div>
      </div>
    </div>
  );
}
