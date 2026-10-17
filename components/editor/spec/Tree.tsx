"use client";

import { useState } from "react";
import { addSpecItem } from "@/lib/spec";
import { counts } from "@/lib/spec-model";
import type { Project, SpecItem } from "@/lib/types";
import { Plus } from "../../icons";
import { PendingBadge, PriorityBars, Star } from "./ui";

// Left outline of the spec: search, expand/collapse, outline numbers, star filter, "+" to add a child.
export function Tree({ p, num, shown, dim, selected, onSelect, starOnly, setStarOnly, big }: {
  p: Project; num: Record<string, string>; shown: Set<string> | null; dim: Set<string> | null;
  selected: string | null; onSelect: (id: string) => void; starOnly: boolean; setStarOnly: (v: boolean) => void; big?: boolean;
}) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const spec = p.spec ?? [];
  const c = counts(spec);
  const query = q.trim().toLowerCase();
  const hit = (x: SpecItem): boolean => !query || `${x.title} ${x.code}`.toLowerCase().includes(query) || x.children.some(hit);
  const toggle = (id: string) => setClosed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const add = (parent: SpecItem | null) => {
    const id = addSpecItem(p.id, parent?.id ?? null, parent ? ((parent.level + 1) as 2 | 3) : 1);
    if (parent) setClosed((s) => { const n = new Set(s); n.delete(parent.id); return n; });
    onSelect(id);
  };

  const row = (x: SpecItem) => {
    if ((shown && !shown.has(x.id)) || !hit(x)) return null;
    const open = !closed.has(x.id) || !!query;
    return (
      <li key={x.id}>
        <div className={`group flex items-center gap-1 rounded pr-1 ${big ? "py-2" : "py-1"} ${selected === x.id ? "bg-primary-soft" : "hover:bg-surface"} ${dim?.has(x.id) ? "opacity-35" : ""}`}
          style={{ paddingLeft: (x.level - 1) * 14 + 2 }}>
          <button onClick={() => toggle(x.id)} aria-label={open ? "접기" : "펼치기"}
            className={`w-4 shrink-0 text-[10px] text-foreground-muted ${x.children.length ? "" : "invisible"}`}>{open ? "▾" : "▸"}</button>
          <button onClick={() => onSelect(x.id)} className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${big ? "text-sm" : "text-xs"}`} aria-label={`항목 ${x.title}`}>
            <span className="shrink-0 text-foreground-muted">{num[x.id]}</span>
            <span className={`truncate ${x.level === 1 ? "font-medium" : "text-foreground-support"}`}>{x.title}</span>
            <PendingBadge x={x} />
            {x.starred && <Star on className="text-[10px]" />}
          </button>
          {big && <PriorityBars value={x.priority} />}
          {x.level < 3 && (
            <button onClick={() => add(x)} aria-label={`${x.title}에 하위 항목 추가`}
              className={`shrink-0 rounded p-0.5 text-foreground-muted hover:bg-border hover:text-primary ${big ? "" : "md:opacity-0 md:group-hover:opacity-100"}`}>
              <Plus className="h-3 w-3" />
            </button>
          )}
        </div>
        {open && x.children.length > 0 && <ul>{x.children.map(row)}</ul>}
      </li>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <p className="text-xs font-medium text-foreground-support">기능 구조</p>
        <div className="flex items-center gap-1 text-[11px]">
          <button onClick={() => setStarOnly(!starOnly)} aria-pressed={starOnly} aria-label="즐겨찾기만 보기"
            className={`rounded px-1.5 py-0.5 ${starOnly ? "bg-amber-50 text-amber-500" : "text-foreground-muted hover:bg-surface"}`}>★</button>
          <button onClick={() => setClosed(new Set(spec.map((x) => x.id)))} className="rounded px-1 py-0.5 text-foreground-muted hover:bg-surface" aria-label="모두 접기">접기</button>
          <button onClick={() => setClosed(new Set())} className="rounded px-1 py-0.5 text-foreground-muted hover:bg-surface" aria-label="모두 펼치기">펼치기</button>
        </div>
      </div>
      <div className="px-3 pb-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="기능 검색" aria-label="기능 검색"
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary" />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {spec.map(row)}
        <li>
          <button onClick={() => add(null)} className="mt-1 flex items-center gap-1 px-2 py-1 text-xs text-foreground-muted hover:text-primary" aria-label="요구사항 추가">
            <Plus className="h-3 w-3" /> 요구사항 추가
          </button>
        </li>
      </ul>
      <p className="shrink-0 border-t border-border px-3 py-2 text-[11px] text-foreground-muted" aria-label="항목 개수">
        요구사항 {c.req} · 기능 {c.feat} · 상세 {c.detail}
      </p>
    </div>
  );
}
