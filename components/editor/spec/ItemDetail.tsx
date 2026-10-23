"use client";

import { useState } from "react";
import { approve, deleteSpecItem, duplicateSpecItem, enhanceItem, reject, setStar, updateSpecItem } from "@/lib/spec";
import { isBusy } from "@/lib/run";
import { LEVEL_LABEL, pathTo } from "@/lib/spec-model";
import { STATUS_LABEL } from "@/lib/types";
import type { Project, SpecCore, SpecItem, Status } from "@/lib/types";
import { useDismiss } from "../../Popover";
import { ArrowLeft, Close, Sparkle } from "../../icons";
import { DiffList, DiffText } from "./diff";
import { SlotsSection } from "./Slots";
import { InlineText, PendingBadge, PriorityBars, SourceBadge, Star } from "./ui";

type Mode = "panel" | "page" | "sheet";

// A text field that shows the AI's change as a diff while an edit waits for approval.
function Field({ label, x, k, onSave, placeholder }: {
  label?: string; x: SpecItem; k: "summary" | "rationale" | "success"; onSave: (v: string) => void; placeholder?: string;
}) {
  const prev = x.pending?.kind === "edit" ? x.pending.prev : undefined;
  const cur = x[k] ?? "";
  const before = prev ? prev[k] ?? "" : undefined;
  return (
    <div>
      {label && <p className="mb-1 text-xs font-medium text-foreground-support">{label}</p>}
      {before !== undefined && before !== cur
        ? <DiffText before={before} after={cur} className="text-sm leading-relaxed" />
        : <InlineText value={cur} onSave={onSave} multiline placeholder={placeholder} className="text-sm leading-relaxed text-foreground-support" ariaLabel={label ?? "설명"} />}
    </div>
  );
}

function Criteria({ p, x }: { p: Project; x: SpecItem }) {
  const list = x.criteria ?? [];
  const prev = x.pending?.kind === "edit" ? x.pending.prev?.criteria ?? [] : undefined;
  const set = (criteria: string[]) => updateSpecItem(p.id, x.id, { criteria });
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-foreground-support">수용 기준</p>
      {prev && prev.join("\n") !== list.join("\n") ? <DiffList before={prev} after={list} bullet="☐" /> : (
        <ul className="space-y-1">
          {list.map((c, i) => (
            <li key={i} className="group flex items-start gap-2 text-sm">
              <span className="mt-0.5 text-foreground-muted">☐</span>
              <InlineText value={c} onSave={(v) => set(v ? list.map((y, j) => (j === i ? v : y)) : list.filter((_, j) => j !== i))} className="flex-1" ariaLabel={`수용 기준 ${i + 1}`} />
              <button onClick={() => set(list.filter((_, j) => j !== i))} aria-label={`수용 기준 ${i + 1} 삭제`} className="text-xs text-foreground-muted md:opacity-0 md:group-hover:opacity-100">✕</button>
            </li>
          ))}
        </ul>
      )}
      <button onClick={() => set([...list, "새 기준"])} className="mt-1 text-xs text-primary" aria-label="수용 기준 추가">+ 기준 추가</button>
    </div>
  );
}

function Roles({ p, x }: { p: Project; x: SpecItem }) {
  const all = [...new Set([...(p.prdProps?.roles ?? []), ...x.roles])];
  const toggle = (r: string) => updateSpecItem(p.id, x.id, { roles: x.roles.includes(r) ? x.roles.filter((y) => y !== r) : [...x.roles, r] });
  return (
    <div className="flex flex-wrap gap-1">
      {all.length === 0 && <span className="text-xs text-foreground-assistive">PRD 속성에서 사용자 역할을 추가하세요</span>}
      {all.map((r) => (
        <button key={r} onClick={() => toggle(r)} aria-pressed={x.roles.includes(r)} aria-label={`역할 ${r}`}
          className={`rounded-full border px-2 py-0.5 text-xs ${x.roles.includes(r) ? "border-primary bg-primary-soft text-primary" : "border-border text-foreground-muted"}`}>{r}</button>
      ))}
    </div>
  );
}

function Enhance({ p, x }: { p: Project; x: SpecItem }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const ref = useDismiss(open, () => setOpen(false));
  const busy = isBusy(p);
  const go = () => {
    if (!text.trim()) return;
    void enhanceItem(p.id, x.id, text.trim());
    setText("");
    setOpen(false);
  };
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} disabled={busy} aria-label="보강"
        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:border-primary hover:text-primary disabled:opacity-40">
        <Sparkle className="h-3 w-3" /> 보강
      </button>
      {open && (
        <form onSubmit={(e) => { e.preventDefault(); go(); }} className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-background p-2 shadow-lg">
          <p className="mb-1.5 text-xs text-foreground-muted">어떻게 고칠까요?</p>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label="보강 요청"
            placeholder="예: 예외 상황을 더 자세히" className="w-full rounded border border-border px-2 py-1.5 text-sm outline-none focus:border-primary" />
          <button disabled={!text.trim()} className="mt-1.5 w-full rounded bg-primary py-1 text-xs text-white disabled:opacity-40" aria-label="보강 요청 보내기">수정안 만들기</button>
        </form>
      )}
    </div>
  );
}

function Menu({ p, x, onOpen, onDoc, onClose }: { p: Project; x: SpecItem; onOpen: (id: string) => void; onDoc: (id: string) => void; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const item = "block w-full px-3 py-1.5 text-left text-sm hover:bg-surface";
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label="항목 메뉴" className="rounded px-1.5 py-0.5 text-foreground-muted hover:bg-surface">⋮</button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-40 rounded-lg border border-border bg-background py-1 shadow-lg">
          <button className={item} onClick={() => { const n = duplicateSpecItem(p.id, x.id); setOpen(false); if (n) onOpen(n); }}>복제</button>
          <button className={item} onClick={() => { setOpen(false); onDoc(x.id); }}>도큐먼트에서 보기</button>
          <button className={`${item} text-red-500`} onClick={() => {
            if (!confirm(`'${x.title}'${x.children.length ? "과 하위 항목" : ""}을 삭제할까요?`)) return;
            deleteSpecItem(p.id, x.id); setOpen(false); onClose?.();
          }}>삭제</button>
        </div>
      )}
    </div>
  );
}

export function ItemDetail({ p, x, mode, onClose, onOpen, onDoc, nav }: {
  p: Project; x: SpecItem; mode: Mode; onClose?: () => void; onOpen: (id: string) => void; onDoc: (id: string) => void; nav?: React.ReactNode;
}) {
  const path = pathTo(p.spec ?? [], x.id);
  const set = (patch: Partial<SpecItem>) => updateSpecItem(p.id, x.id, patch);
  const prev: SpecCore | undefined = x.pending?.kind === "edit" ? x.pending.prev : undefined;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2 text-xs text-foreground-muted">
        {onClose && (
          <button onClick={onClose} aria-label={mode === "sheet" ? "뒤로" : "상세 닫기"} className="rounded p-1 hover:bg-surface">
            {mode === "sheet" ? <ArrowLeft className="h-4 w-4" /> : <Close className="h-4 w-4" />}
          </button>
        )}
        <nav className="flex min-w-0 flex-1 items-center gap-1 truncate" aria-label="위치">
          {path.map((y, i) => (
            <span key={y.id} className="flex min-w-0 items-center gap-1">
              {i > 0 && <span>/</span>}
              <button onClick={() => onOpen(y.id)} className={`truncate hover:text-foreground ${y.id === x.id ? "text-foreground-support" : ""}`}>{y.title}</button>
            </span>
          ))}
        </nav>
        {nav}
        <Enhance p={p} x={x} />
        <button onClick={() => setStar(p.id, x.id, !x.starred)} aria-label={x.starred ? "즐겨찾기 해제" : "즐겨찾기"} className="px-1 text-base"><Star on={x.starred} /></button>
        <Menu p={p} x={x} onOpen={onOpen} onDoc={onDoc} onClose={onClose} />
      </div>

      {x.pending && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-primary-soft px-4 py-2 text-xs">
          <PendingBadge x={x} />
          <span className="min-w-0 flex-1 text-foreground-support">
            {x.pending.kind === "new" ? "AI가 새로 제안한 항목이에요." : x.pending.kind === "delete" ? "AI가 삭제를 제안했어요." : `AI 수정안${x.pending.reason ? ` · ${x.pending.reason}` : ""}`}
          </span>
          <button onClick={() => reject(p.id, x.id)} aria-label="이 항목 거절" className="rounded border border-border bg-background px-2 py-1">거절</button>
          <button onClick={() => approve(p.id, x.id)} aria-label="이 항목 승인" className="rounded bg-primary px-2 py-1 text-white">승인</button>
        </div>
      )}

      <div className={`min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 ${mode === "page" ? "mx-auto w-full max-w-3xl" : ""}`}>
        <div>
          <p className="mb-1 flex items-center gap-2 text-xs text-foreground-muted">
            <span className="rounded bg-surface px-1.5 py-0.5 text-foreground-support">{LEVEL_LABEL[x.level]}</span>
            <span aria-label="ID 코드">{x.code}</span>
            <SourceBadge list={p.materials} src={x.src} />
          </p>
          {prev && prev.title !== x.title
            ? <DiffText before={prev.title} after={x.title} className="text-xl font-semibold" />
            : <InlineText value={x.title} onSave={(v) => v && set({ title: v })} className="text-xl font-semibold" ariaLabel="항목 제목" />}
        </div>

        <div className="grid grid-cols-[72px_1fr] items-center gap-x-3 gap-y-2.5 text-xs">
          <span className="text-foreground-muted">상태</span>
          <select value={x.status} onChange={(e) => set({ status: e.target.value as Status })} aria-label="상태" className="w-fit rounded border border-border bg-background px-1.5 py-1">
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="text-foreground-muted">중요도</span>
          <PriorityBars value={x.priority} onChange={(priority) => set({ priority })} />
          <span className="text-foreground-muted">역할</span>
          <Roles p={p} x={x} />
        </div>

        <Field label="설명" x={x} k="summary" onSave={(v) => set({ summary: v })} placeholder="이 항목이 무엇인지 한두 문장으로" />
        {x.level === 1 && <Criteria p={p} x={x} />}
        {(x.level === 2 || x.rationale) && <Field label="기능의 근거" x={x} k="rationale" onSave={(v) => set({ rationale: v })} placeholder="이 기능이 왜 필요한지" />}
        {(x.level === 2 || x.success) && <Field label="성공 기준" x={x} k="success" onSave={(v) => set({ success: v })} placeholder="잘 됐다고 판단할 기준" />}
        {x.level > 1 && <SlotsSection p={p} x={x} />}

        {x.level < 3 && x.children.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-foreground-support">하위 {LEVEL_LABEL[(x.level + 1) as 2 | 3]} {x.children.length}</p>
            {x.children.map((c) => (
              <button key={c.id} onClick={() => onOpen(c.id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface">
                <span className="text-[11px] text-foreground-muted">{c.code}</span>
                <span className="flex-1 truncate">{c.title}</span>
                <PendingBadge x={c} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
