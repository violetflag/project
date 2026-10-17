"use client";

import { useEffect, useRef, useState } from "react";
import type { SpecItem, Status } from "@/lib/types";

// Click-to-edit text that saves on blur (Enter saves single-line fields, Esc cancels).
export function InlineText({
  value, onSave, multiline, placeholder = "내용을 입력하세요", className = "", ariaLabel, readOnly,
}: {
  value: string; onSave: (v: string) => void; multiline?: boolean; placeholder?: string; className?: string; ariaLabel?: string; readOnly?: boolean;
}) {
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!edit) setVal(value);
  }, [value, edit]);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
  }, [val, edit]);
  if (!edit || readOnly) {
    return (
      <span role={readOnly ? undefined : "button"} tabIndex={readOnly ? undefined : 0} aria-label={ariaLabel}
        onClick={() => !readOnly && setEdit(true)} onKeyDown={(e) => e.key === "Enter" && !readOnly && setEdit(true)}
        className={`block whitespace-pre-line rounded ${readOnly ? "" : "cursor-text hover:bg-surface"} ${value ? "" : "text-foreground-assistive"} ${className}`}>
        {value || placeholder}
      </span>
    );
  }
  const save = () => { setEdit(false); if (val !== value) onSave(val.trim()); };
  return (
    <textarea ref={ref} value={val} autoFocus rows={1} aria-label={ariaLabel} placeholder={placeholder}
      onChange={(e) => setVal(e.target.value)} onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Escape") { setVal(value); setEdit(false); }
        if (e.key === "Enter" && !multiline && !e.nativeEvent.isComposing) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
      }}
      className={`block w-full resize-none overflow-hidden rounded border border-primary/40 bg-background px-1 outline-none ${className}`} />
  );
}

export function PriorityBars({ value, onChange }: { value: 1 | 2 | 3; onChange?: (v: 1 | 2 | 3) => void }) {
  return (
    <span className="inline-flex items-end gap-0.5" aria-label={`중요도 ${value}`}>
      {([1, 2, 3] as const).map((n) => (
        <button key={n} type="button" disabled={!onChange} onClick={() => onChange?.(n)} aria-label={`중요도 ${n}로 설정`}
          className={`w-1.5 rounded-sm ${n <= value ? "bg-primary" : "bg-border-strong"} ${onChange ? "cursor-pointer hover:opacity-70" : ""}`}
          style={{ height: 5 + n * 3 }} />
      ))}
    </span>
  );
}

export function PendingBadge({ x }: { x: SpecItem }) {
  if (!x.pending) return null;
  const t = x.pending.kind === "new" ? "신규" : x.pending.kind === "edit" ? "수정" : "삭제";
  return <span className={`shrink-0 rounded px-1 text-[10px] font-medium ${x.pending.kind === "delete" ? "bg-red-50 text-red-500" : "bg-primary-soft text-primary"}`}>{t}</span>;
}

export const Star = ({ on, className = "" }: { on?: boolean; className?: string }) => (
  <span className={`${on ? "text-amber-400" : "text-foreground-assistive"} ${className}`}>{on ? "★" : "☆"}</span>
);

export interface Filter { status: Status | "all"; role: string; priority: number; starred: boolean }
export const NO_FILTER: Filter = { status: "all", role: "all", priority: 0, starred: false };
export const isFiltered = (f: Filter) => f.status !== "all" || f.role !== "all" || f.priority > 0 || f.starred;
export const matches = (x: SpecItem, f: Filter) =>
  (f.status === "all" || x.status === f.status) && (f.role === "all" || x.roles.includes(f.role)) &&
  (!f.priority || x.priority === f.priority) && (!f.starred || !!x.starred);

// Ids that stay visible: matching items plus their ancestors.
export function visibleIds(items: SpecItem[], ok: (x: SpecItem) => boolean): Set<string> {
  const out = new Set<string>();
  const walk = (x: SpecItem): boolean => {
    const kid = x.children.map(walk).some(Boolean);
    const hit = ok(x) || kid;
    if (hit) out.add(x.id);
    return hit;
  };
  items.forEach(walk);
  return out;
}

export function highlight(text: string, q: string) {
  if (!q.trim()) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return parts.map((s, i) => (i % 2 ? <mark key={i} data-hit="1" className="rounded-sm bg-amber-200 text-foreground">{s}</mark> : s));
}
