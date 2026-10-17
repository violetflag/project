"use client";

import { useState } from "react";
import { updatePrdBlock } from "@/lib/actions";
import type { Project } from "@/lib/types";

export function EmptyDoc({ title, hint, action }: { title: string; hint: string; action?: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="mx-4 w-full max-w-[420px] rounded-xl border border-border bg-background px-8 py-10 text-center shadow-sm">
        <div className="mx-auto mb-4 h-12 w-10 rounded-md bg-primary-soft" />
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-xs text-foreground-support">{hint}</p>
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}

function Block({ p, sid, idx, label, body }: { p: Project; sid: string; idx: number; label: string; body: string }) {
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState(body);
  return (
    <div className="group mb-5">
      <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
        <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {label}
        {!edit && <button onClick={() => { setVal(body); setEdit(true); }} className="ml-1 text-xs text-foreground-muted md:opacity-0 md:group-hover:opacity-100">편집</button>}
      </p>
      {edit ? (
        <div>
          <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={Math.max(3, val.split("\n").length + 1)}
            className="w-full rounded-md border border-primary/40 p-2 text-sm leading-relaxed outline-none" autoFocus />
          <div className="mt-1 flex gap-1.5 text-xs">
            <button onClick={() => { updatePrdBlock(p.id, sid, idx, val); setEdit(false); }} className="rounded bg-primary px-2 py-1 text-white">저장</button>
            <button onClick={() => setEdit(false)} className="rounded border border-border px-2 py-1">취소</button>
          </div>
        </div>
      ) : (
        <p className="text-sm leading-relaxed whitespace-pre-line text-foreground-support">{body}</p>
      )}
    </div>
  );
}

export function PrdView({ p }: { p: Project }) {
  if (!p.prd) return <EmptyDoc title="PRD가 여기에 생겨요" hint="왼쪽 채팅에서 질문에 답하면 PRD 초안을 만들어 드려요." />;
  const filled = p.prd.flatMap((s) => s.blocks).filter((b) => b.body.trim()).length;
  const total = p.prd.flatMap((s) => s.blocks).length;
  const pct = Math.round((filled / total) * 100);
  return (
    <div className="flex h-full">
      <aside className="hidden w-52 shrink-0 overflow-y-auto border-r border-border bg-background px-3 py-4 md:block">
        <p className="mb-2 px-2 text-xs text-foreground-muted">문서 구조</p>
        {p.prd.map((s) => (
          <div key={s.id} className="mb-2">
            <button onClick={() => document.getElementById(`prd-${s.id}`)?.scrollIntoView({ behavior: "smooth" })} className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-surface">{s.title}</button>
            {s.blocks.map((b) => <p key={b.label} className="truncate px-4 py-0.5 text-xs text-foreground-muted">{b.label}</p>)}
          </div>
        ))}
      </aside>
      <div className="flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background-canvas/90 px-4 py-2 text-xs backdrop-blur md:px-6">
          완성도
          <span className="h-1.5 w-32 overflow-hidden rounded-full bg-border"><span className="block h-full bg-primary" style={{ width: `${pct}%` }} /></span>
          {pct}%
        </div>
        <div className="mx-auto max-w-3xl space-y-4 px-3 py-4 md:px-6 md:py-6">
          {p.prd.map((s) => (
            <section key={s.id} id={`prd-${s.id}`} className="scroll-mt-12 rounded-xl border border-border bg-background px-5 py-6 md:px-8 md:py-7">
              <h2 className="mb-5 text-xl font-semibold">{s.title}</h2>
              {s.blocks.map((b, i) => <Block key={b.label + i} p={p} sid={s.id} idx={i} label={b.label} body={b.body} />)}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
