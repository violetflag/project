"use client";

import { useEffect, useRef, useState } from "react";
import { ACCEPT, binaryUrl } from "@/lib/files";
import { addMaterials, materialKey, removeMaterial, setMaterialOn } from "@/lib/materials";
import type { Project, ProjectMaterial } from "@/lib/types";
import { Paperclip } from "../icons";

const KIND: Record<ProjectMaterial["kind"], string> = { text: "글", pdf: "PDF", image: "이미지" };

function Item({ p, m, open, onToggle }: { p: Project; m: ProjectMaterial; open: boolean; onToggle: () => void }) {
  const key = materialKey(m);
  const [note, setNote] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const openOriginal = async () => {
    const url = await binaryUrl(p.id, m);
    if (!url) return setNote("이 기기에는 원본이 없어요. 처음 올린 기기에서 열 수 있어요.");
    window.open(url, "_blank", "noopener");
  };
  return (
    <div ref={ref} className={`rounded-lg border bg-background p-3 ${open ? "border-primary/50" : "border-border"}`}>
      <div className="flex items-start gap-2">
        <input type="checkbox" checked={!m.off} onChange={(e) => setMaterialOn(p.id, key, e.target.checked)}
          aria-label={`${m.name} AI가 참고`} title="AI가 참고" className="mt-0.5 accent-[var(--color-primary)]" />
        <div className="min-w-0 flex-1">
          <button onClick={onToggle} className="block max-w-full truncate text-left text-sm font-medium hover:text-primary" aria-expanded={open}>{m.name}</button>
          <p className="text-[11px] text-foreground-muted">
            {KIND[m.kind]}{m.text ? ` · ${m.text.length.toLocaleString()}자` : ""}{m.at ? ` · ${new Date(m.at).toLocaleDateString("ko-KR")}` : ""}{m.off ? " · AI가 참고 안 함" : ""}
          </p>
        </div>
        <button onClick={() => { if (confirm(`'${m.name}' 자료를 지울까요?`)) void removeMaterial(p.id, key); }} aria-label={`${m.name} 지우기`}
          className="shrink-0 text-xs text-foreground-muted hover:text-red-500">지우기</button>
      </div>
      {open && (
        <div className="mt-2 border-t border-border pt-2">
          {m.kind !== "text" && (
            <button onClick={openOriginal} className="mb-2 rounded border border-border px-2 py-1 text-xs hover:border-border-strong">원본 열기</button>
          )}
          {note && <p className="mb-2 text-[11px] text-amber-700">{note}</p>}
          {m.text
            ? <pre aria-label={`${m.name} 읽은 내용`} className="max-h-80 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap text-foreground-support">{m.text}</pre>
            : <p className="text-xs text-foreground-muted">{m.kind === "pdf" ? "PDF는 AI가 원본을 쪽 단위로 직접 읽어요." : "이미지는 AI가 그림을 직접 봐요."}</p>}
        </div>
      )}
    </div>
  );
}

// The 자료 panel: files the AI reads with every request (unless switched off).
export function MaterialsPanel({ p, focus }: { p: Project; focus?: string | null }) {
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) setOpen(focus);
  }, [focus]);
  const list = p.materials ?? [];
  const add = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    const r = await addMaterials(p.id, files);
    setBusy(false);
    setNote(r.note || (r.added.length ? `자료 ${r.added.length}개를 올렸어요.` : ""));
  };
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-border px-4 py-3">
        <p className="text-xs leading-relaxed text-foreground-support">올린 자료는 채팅과 문서 생성 때 AI가 함께 읽어요. 체크를 끄면 그 자료는 빼고 읽어요.</p>
        <div onClick={() => input.current?.click()} onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); void add(Array.from(e.dataTransfer.files)); }}
          role="button" aria-label="자료 올리기"
          className="cursor-pointer rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-foreground-support hover:border-primary hover:text-primary">
          <Paperclip className="mx-auto mb-1 h-4 w-4" />
          {busy ? "읽는 중이에요…" : "파일을 끌어다 놓거나 눌러서 올리기"}
          <p className="mt-0.5 text-[10px] text-foreground-assistive">PDF · Word · 엑셀 · 파워포인트 · 한글 · TXT · 이미지, 파일당 10MB</p>
        </div>
        <input ref={input} type="file" multiple hidden accept={ACCEPT} aria-label="자료 파일"
          onChange={(e) => { void add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        {note && <p className="text-[11px] text-foreground-muted">{note}</p>}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {!list.length && <p className="py-8 text-center text-xs text-foreground-muted">아직 올린 자료가 없어요.</p>}
        {list.map((m) => {
          const k = materialKey(m);
          return <Item key={k} p={p} m={m} open={open === k} onToggle={() => setOpen(open === k ? null : k)} />;
        })}
      </div>
    </div>
  );
}
