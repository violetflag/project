"use client";

import { useState } from "react";
import { answerSlotQuestion, dismissSlotQuestion, fillSlots, setSlotSentences, toggleSlot } from "@/lib/spec";
import { isBusy } from "@/lib/run";
import { slotFill } from "@/lib/spec-model";
import { SLOTS } from "@/lib/types";
import type { Project, SlotKey, SlotQuestion, SpecItem } from "@/lib/types";
import { Sparkle } from "../../icons";
import { DiffList } from "./diff";
import { InlineText } from "./ui";

// An undecided point inside a slot: pick an option (✦ = AI's pick) or type your own.
function QuestionCard({ p, x, q }: { p: Project; x: SpecItem; q: SlotQuestion }) {
  const [own, setOwn] = useState("");
  const busy = isBusy(p);
  const pick = (a: string) => void answerSlotQuestion(p.id, x.id, q.id, a);
  return (
    <div className="mt-2 rounded-lg border border-primary/30 bg-primary-soft/60 p-3" aria-label="미결정 질문">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm font-medium">{q.text}</p>
        <button onClick={() => dismissSlotQuestion(p.id, x.id, q.id)} aria-label="질문 닫기" className="text-xs text-foreground-muted hover:text-foreground">✕</button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {q.options.map((o, i) => (
          <button key={o} disabled={busy} onClick={() => pick(o)} aria-label={`답 선택: ${o}`}
            className={`rounded-full border px-2.5 py-1 text-xs disabled:opacity-50 ${i === q.recommended ? "border-primary bg-background text-primary" : "border-border bg-background hover:border-border-strong"}`}>
            {i === q.recommended && <span className="mr-0.5">✦</span>}{o}
          </button>
        ))}
      </div>
      <form className="mt-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (own.trim()) { pick(own.trim()); setOwn(""); } }}>
        <input value={own} onChange={(e) => setOwn(e.target.value)} placeholder="직접 입력" aria-label="직접 입력"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary" />
        <button disabled={!own.trim() || busy} className="rounded bg-primary px-2 text-xs text-white disabled:opacity-40">적용</button>
      </form>
    </div>
  );
}

function SlotRow({ p, x, k, label, prev }: { p: Project; x: SpecItem; k: SlotKey; label: string; prev?: string[] }) {
  const off = x.offSlots?.includes(k);
  const lines = x.slots?.[k] ?? [];
  const qs = x.questions?.filter((q) => q.slot === k) ?? [];
  const changed = prev !== undefined && prev.join("\n") !== lines.join("\n");
  const save = (i: number, v: string) => setSlotSentences(p.id, x.id, k, v ? lines.map((s, j) => (j === i ? v : s)) : lines.filter((_, j) => j !== i));
  return (
    <div className={`border-t border-border py-2.5 first:border-t-0 ${off ? "opacity-50" : ""}`}>
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${off ? "bg-border-strong" : lines.some((s) => s.trim()) ? "bg-primary" : "bg-border-strong"}`} />
        <p className="text-xs font-medium text-foreground-support">{label}</p>
        {qs.length > 0 && <span className="rounded bg-amber-50 px-1 text-[10px] text-amber-600">미결정 {qs.length}</span>}
        <label className="ml-auto flex cursor-pointer items-center gap-1 text-[11px] text-foreground-muted">
          <input type="checkbox" checked={!!off} onChange={() => toggleSlot(p.id, x.id, k)} aria-label={`${label} 사용 안 함`} className="accent-[var(--color-primary)]" />
          사용 안 함
        </label>
      </div>
      {!off && (
        <div className="mt-1.5 pl-3.5">
          {changed ? <DiffList before={prev!} after={lines} /> : (
            <ul className="space-y-0.5">
              {lines.map((s, i) => (
                <li key={i} className="flex gap-2 text-sm leading-relaxed">
                  <span className="text-foreground-muted">•</span>
                  <InlineText value={s} onSave={(v) => save(i, v)} className="flex-1" ariaLabel={`${label} 문장 ${i + 1}`} />
                </li>
              ))}
            </ul>
          )}
          <button onClick={() => setSlotSentences(p.id, x.id, k, [...lines, "새 문장"])} className="mt-0.5 text-[11px] text-foreground-muted hover:text-primary" aria-label={`${label} 문장 추가`}>+ 문장</button>
          {qs.map((q) => <QuestionCard key={q.id} p={p} x={x} q={q} />)}
        </div>
      )}
    </div>
  );
}

export function SlotsSection({ p, x }: { p: Project; x: SpecItem }) {
  const fill = slotFill(x);
  const [open, setOpen] = useState(true);
  const prev = x.pending?.kind === "edit" ? x.pending.prev : undefined;
  const busy = isBusy(p);
  return (
    <section className="rounded-lg border border-border bg-background">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-sm font-medium" aria-expanded={open}>
          <span className="text-[10px] text-foreground-muted">{open ? "▾" : "▸"}</span>
          개발 준비 슬롯 <span className="text-xs font-normal text-foreground-muted">· {fill.filled}/{fill.total}</span>
        </button>
        <button onClick={() => void fillSlots(p.id, x.id)} disabled={busy || fill.filled === fill.total} aria-label="AI로 채우기"
          className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-primary hover:border-primary disabled:opacity-40">
          <Sparkle className="h-3 w-3" /> AI로 채우기
        </button>
      </div>
      {open && (
        <div className="px-3 pb-1">
          {SLOTS.map(([k, label]) => <SlotRow key={k} p={p} x={x} k={k} label={label} prev={prev ? prev.slots?.[k] ?? [] : undefined} />)}
        </div>
      )}
    </section>
  );
}
