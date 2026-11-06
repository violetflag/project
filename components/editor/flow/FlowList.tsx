"use client";

import { useState } from "react";
import { deleteFlow, renameFlow, requestFlowDialog, selectFlow } from "@/lib/flow";
import type { Project } from "@/lib/types";
import { useDismiss } from "@/components/Popover";
import { Plus } from "@/components/icons";

function FlowMenu({ pid, flowId, onRename }: { pid: string; flowId: string; onRename: () => void }) {
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState(false);
  const close = () => { setOpen(false); setSure(false); };
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className="relative">
      <button onClick={(e) => { e.stopPropagation(); setOpen(!open); }} aria-label="유저플로우 메뉴"
        className="rounded px-1.5 py-0.5 text-foreground-muted hover:bg-border">⋮</button>
      {open && (
        <div role="menu" className="absolute top-full right-0 z-20 mt-1 w-32 rounded-lg border border-border bg-background p-1 text-xs shadow-lg">
          <button role="menuitem" onClick={() => { close(); onRename(); }} className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface">이름 바꾸기</button>
          <button role="menuitem" onClick={() => (sure ? (close(), deleteFlow(pid, flowId)) : setSure(true))} aria-label={sure ? "삭제 확인" : "유저플로우 삭제"}
            className="block w-full rounded px-2 py-1.5 text-left text-red-600 hover:bg-surface">{sure ? "한 번 더 누르면 삭제" : "삭제"}</button>
        </div>
      )}
    </div>
  );
}

function NameInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  return (
    <input autoFocus value={v} onChange={(e) => setV(e.target.value)} aria-label="유저플로우 이름" onFocus={(e) => e.target.select()}
      onKeyDown={(e) => { if (e.key === "Enter") onDone(v); if (e.key === "Escape") onDone(null); }} onBlur={() => onDone(v)}
      className="min-w-0 flex-1 rounded border border-primary bg-background px-1.5 py-0.5 text-xs outline-none" />
  );
}

export function FlowList({ p, busy }: { p: Project; busy: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const cur = p.flows.find((f) => f.id === p.flowId) ?? p.flows[p.flows.length - 1];
  const done = (fid: string) => (v: string | null) => {
    if (v !== null && editing === fid) renameFlow(p.id, fid, v);
    setEditing(null);
  };
  return (
    <>
      {/* Phone: a select on top */}
      <div className="flex items-center gap-2 border-b border-border bg-background px-3 py-2 md:hidden">
        {editing && cur && editing === cur.id ? <NameInput initial={cur.name} onDone={done(cur.id)} /> : (
          <select value={cur?.id} onChange={(e) => selectFlow(p.id, e.target.value)} aria-label="유저플로우 선택"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm">
            {p.flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
        {cur && <FlowMenu pid={p.id} flowId={cur.id} onRename={() => setEditing(cur.id)} />}
        <button onClick={requestFlowDialog} disabled={busy} aria-label="새 유저플로우 생성"
          className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-primary disabled:opacity-40"><Plus className="h-3.5 w-3.5" />새로 만들기</button>
      </div>
      {/* Desktop: list on the left */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-background md:flex">
        <p className="px-4 pt-3 pb-2 text-xs font-medium text-foreground-muted">플로우 목록</p>
        <div className="min-h-0 flex-1 overflow-y-auto px-2" role="list" aria-label="플로우 목록">
          {p.flows.map((f) => (
            <div key={f.id} role="listitem"
              className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-xs ${f.id === cur?.id ? "bg-surface font-medium" : "text-foreground-support hover:bg-surface"}`}>
              {editing === f.id ? <NameInput initial={f.name} onDone={done(f.id)} /> : (
                <button onClick={() => selectFlow(p.id, f.id)} className="min-w-0 flex-1 truncate text-left" title={f.name}>
                  {f.name}<span className="ml-1 font-normal text-foreground-assistive">{f.nodes.length}</span>
                </button>
              )}
              <FlowMenu pid={p.id} flowId={f.id} onRename={() => setEditing(f.id)} />
            </div>
          ))}
        </div>
        <div className="border-t border-border p-2">
          <button onClick={requestFlowDialog} disabled={busy} aria-label="새 유저플로우 생성"
            className="flex w-full items-center justify-center gap-1 rounded-md border border-border py-2 text-xs text-primary hover:bg-surface disabled:opacity-40">
            <Plus className="h-3.5 w-3.5" />새 유저플로우 생성
          </button>
        </div>
      </aside>
    </>
  );
}
