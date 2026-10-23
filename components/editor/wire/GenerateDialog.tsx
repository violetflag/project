"use client";

// "와이어프레임 만들기" dialog: pick a flow, a device and the pages to draw.

import { useEffect, useMemo, useRef, useState } from "react";
import { pageNodes } from "@/lib/wire";
import type { Project } from "@/lib/types";
import { Close } from "../../icons";

type Props = {
  p: Project;
  flowId: string;
  device: "mobile" | "desktop";
  preselect: string[];
  onClose: () => void;
  onSubmit: (o: { flowId: string; device: "mobile" | "desktop"; nodeIds: string[]; note?: string }) => void;
};

function SectionBox({ all, some, onChange, label }: { all: boolean; some: boolean; onChange: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some && !all;
  }, [some, all]);
  return <input ref={ref} type="checkbox" aria-label={`${label} 구역 전체 선택`} checked={all} onChange={onChange} className="accent-[#845dde]" />;
}

export function GenerateDialog({ p, flowId: initialFlow, device: initialDevice, preselect, onClose, onSubmit }: Props) {
  const [flowId, setFlowId] = useState(initialFlow);
  const [device, setDevice] = useState(initialDevice);
  const [picked, setPicked] = useState<Set<string>>(new Set(preselect));
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");
  const flow = p.flows.find((f) => f.id === flowId) ?? p.flows[0];
  const pages = useMemo(() => (flow ? pageNodes(flow) : []), [flow]);
  const shown = pages.filter((n) => !q.trim() || n.label.includes(q.trim()) || n.section.includes(q.trim()));
  const sections = flow ? flow.sections.filter((s) => shown.some((n) => n.section === s)) : [];
  const orphans = shown.filter((n) => !flow?.sections.includes(n.section));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const toggle = (ids: string[], on: boolean) => setPicked((s) => {
    const n = new Set(s);
    ids.forEach((id) => (on ? n.add(id) : n.delete(id)));
    return n;
  });
  const chosen = pages.filter((n) => picked.has(n.id));
  let no = 0;
  const group = (title: string, list: typeof pages) => {
    const ids = list.map((n) => n.id);
    const all = ids.every((id) => picked.has(id)), some = ids.some((id) => picked.has(id));
    return (
      <div key={title} className="mb-3">
        <label className="flex items-center gap-2 py-1 text-xs font-semibold text-foreground-support">
          <SectionBox all={all} some={some} label={title} onChange={() => toggle(ids, !all)} />{title}
          <span className="font-normal text-foreground-muted">{list.length}</span>
        </label>
        {list.map((n) => (
          <label key={n.id} className="ml-5 flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-surface">
            <input type="checkbox" aria-label={`${n.label} 선택`} checked={picked.has(n.id)} onChange={(e) => toggle([n.id], e.target.checked)} className="accent-[#845dde]" />
            <span className="w-5 text-[11px] text-foreground-muted">{++no}</span>
            <span className="truncate">{n.label}</span>
          </label>
        ))}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 md:items-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-label="와이어프레임 만들기" className="flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-background shadow-xl md:max-w-lg md:rounded-2xl">
        <div className="flex items-center border-b border-border px-5 py-3">
          <p className="font-semibold">와이어프레임 만들기</p>
          <button aria-label="닫기" onClick={onClose} className="ml-auto p-1 text-foreground-muted"><Close className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex-1 text-xs text-foreground-support">유저플로우
              <select aria-label="생성할 유저플로우" value={flow?.id} onChange={(e) => { setFlowId(e.target.value); setPicked(new Set()); }}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
                {p.flows.map((f) => <option key={f.id} value={f.id}>{f.name} · 페이지 {pageNodes(f).length}</option>)}
              </select>
            </label>
            <div className="text-xs text-foreground-support">기기
              <div className="mt-1 flex rounded-md border border-border p-0.5">
                {(["desktop", "mobile"] as const).map((d) => (
                  <button key={d} aria-pressed={device === d} onClick={() => setDevice(d)}
                    className={`flex-1 rounded px-3 py-1 text-sm ${device === d ? "bg-foreground text-background" : "text-foreground-support"}`}>
                    {d === "desktop" ? "데스크톱" : "모바일"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center gap-2">
              <input aria-label="페이지 검색" value={q} onChange={(e) => setQ(e.target.value)} placeholder="페이지 검색"
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary" />
              <button onClick={() => toggle(shown.map((n) => n.id), true)} className="shrink-0 text-xs text-primary">전체 선택</button>
              <button onClick={() => toggle(shown.map((n) => n.id), false)} className="shrink-0 text-xs text-foreground-muted">선택 해제</button>
            </div>
            <div className="max-h-[38vh] overflow-y-auto rounded-lg border border-border px-3 py-2">
              {sections.map((s) => group(s, shown.filter((n) => n.section === s)))}
              {orphans.length > 0 && group("기타", orphans)}
              {!shown.length && <p className="py-4 text-center text-sm text-foreground-muted">맞는 페이지가 없어요.</p>}
            </div>
            <p className="mt-1 text-xs text-foreground-muted">{chosen.length} / {pages.length} 페이지 선택</p>
          </div>
          <label className="block text-xs text-foreground-support">추가 요청 (선택)
            <textarea aria-label="추가 요청" value={note} onChange={(e) => setNote(e.target.value)} rows={2}
              placeholder="예: 카드형 목록 위주로, 첫 화면에 이번 주 일정을 크게"
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary" />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm">닫기</button>
          <button aria-label="페이지 생성" disabled={!chosen.length || !flow}
            onClick={() => flow && onSubmit({ flowId: flow.id, device, nodeIds: chosen.map((n) => n.id), note: note.trim() || undefined })}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
            {chosen.length}페이지 생성
          </button>
        </div>
      </div>
    </div>
  );
}
