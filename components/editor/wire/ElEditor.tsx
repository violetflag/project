"use client";

// Small panel for editing the selected wireframe element: its text, linked page, order, delete.

import type { FlowNode, WireEl } from "@/lib/types";
import { Close, TrashIcon } from "../../icons";

const KIND: Record<WireEl["t"], string> = {
  bar: "상단 바", heading: "제목", text: "본문", image: "이미지", input: "입력칸", button: "버튼", chips: "칩",
  card: "카드", list: "목록", rows: "정보 행", tabs: "탭", nav: "하단 메뉴", divider: "구분선",
};

type Props = {
  el: WireEl;
  pages: FlowNode[];
  onChange: (patch: Partial<WireEl>) => void;
  onSnap: () => void; // remember the state before a change (for undo)
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  onClose: () => void;
};

const field = "mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary";

export function ElEditor({ el, pages, onChange, onSnap, onMove, onDelete, onClose }: Props) {
  const text = (label: string, value: string, set: (v: string) => void, rows = 1) => (
    <label className="block text-xs text-foreground-support">{label}
      {rows > 1
        ? <textarea aria-label={`요소 ${label}`} value={value} rows={rows} onFocus={onSnap} onChange={(e) => set(e.target.value)} className={field} />
        : <input aria-label={`요소 ${label}`} value={value} onFocus={onSnap} onChange={(e) => set(e.target.value)} className={field} />}
    </label>
  );
  const flag = (label: string, value: boolean | undefined, key: string) => (
    <label className="flex items-center gap-2 text-xs text-foreground-support">
      <input type="checkbox" checked={!!value} onChange={(e) => { onSnap(); onChange({ [key]: e.target.checked } as Partial<WireEl>); }} />{label}
    </label>
  );
  const lines = (v: string) => v.split("\n");
  const commas = (v: string) => v.split(",").map((s) => s.trimStart());

  let body: React.ReactNode = null;
  switch (el.t) {
    case "bar": body = <>{text("제목", el.title, (v) => onChange({ title: v }))}{flag("뒤로 가기 표시", el.back, "back")}</>; break;
    case "heading": body = text("글자", el.text, (v) => onChange({ text: v }), 2); break;
    case "text": body = <>{text("글자", el.text, (v) => onChange({ text: v }), 3)}{flag("흐린 글씨", el.muted, "muted")}</>; break;
    case "image": body = <>{text("설명", el.label, (v) => onChange({ label: v }))}{flag("크게", el.tall, "tall")}</>; break;
    case "input": body = <>{text("라벨", el.label, (v) => onChange({ label: v }))}{text("입력 예시", el.placeholder ?? "", (v) => onChange({ placeholder: v }))}</>; break;
    case "button": body = <>{text("글자", el.text, (v) => onChange({ text: v }))}{flag("주요 버튼", el.primary, "primary")}</>; break;
    case "chips": case "tabs": case "nav":
      body = text("항목 (쉼표로 구분)", el.items.join(", "), (v) => onChange({ items: commas(v) })); break;
    case "card": body = <>{text("제목", el.title, (v) => onChange({ title: v }))}{text("내용 (줄마다 한 줄)", el.lines.join("\n"), (v) => onChange({ lines: lines(v) }), 3)}{flag("썸네일", el.image, "image")}</>; break;
    case "list": body = text("항목 (줄마다 '제목 | 보조 문구')", el.items.map((i) => (i.sub ? `${i.title} | ${i.sub}` : i.title)).join("\n"),
      (v) => onChange({ items: lines(v).map((l) => { const [title, sub] = l.split("|").map((s) => s.trim()); return sub ? { title, sub } : { title: title ?? "" }; }) }), 5); break;
    case "rows": body = text("항목 (줄마다 '이름: 값')", el.items.map((i) => `${i.label}: ${i.value}`).join("\n"),
      (v) => onChange({ items: lines(v).map((l) => { const k = l.indexOf(":"); return k < 0 ? { label: l, value: "" } : { label: l.slice(0, k).trim(), value: l.slice(k + 1).trim() }; }) }), 4); break;
    case "divider": body = <p className="text-xs text-foreground-muted">구분선은 글자가 없어요.</p>; break;
  }

  return (
    <div role="dialog" aria-label="요소 편집" className="w-full space-y-3 rounded-xl border border-border bg-background p-3 shadow-lg md:w-72">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{KIND[el.t]}</span>
        <button aria-label="요소 위로" onClick={() => onMove(-1)} className="ml-auto rounded border border-border px-2 py-0.5 text-xs">↑</button>
        <button aria-label="요소 아래로" onClick={() => onMove(1)} className="rounded border border-border px-2 py-0.5 text-xs">↓</button>
        <button aria-label="요소 삭제" onClick={onDelete} className="rounded border border-border p-1 text-foreground-muted hover:text-red-500"><TrashIcon className="h-3.5 w-3.5" /></button>
        <button aria-label="요소 편집 닫기" onClick={onClose} className="p-1 text-foreground-muted"><Close className="h-4 w-4" /></button>
      </div>
      {body}
      <label className="block text-xs text-foreground-support">누르면 열리는 페이지
        <select aria-label="연결 페이지" value={el.to ?? ""} onChange={(e) => { onSnap(); onChange({ to: e.target.value || undefined }); }} className={field}>
          <option value="">연결 없음</option>
          {pages.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
        </select>
      </label>
    </div>
  );
}
