"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { slotFill } from "@/lib/spec-model";
import type { Project, SpecItem } from "@/lib/types";
import { PendingBadge, Star } from "./ui";

const COL = { 0: 0, 1: 270, 2: 560, 3: 880 } as const;
const W = { 0: 210, 1: 230, 2: 250, 3: 230 } as const;
const ROW = 62;
const COLORS = ["#78b08a", "#7ab7b9", "#83a3c4", "#9989b5", "#adbf6e", "#c7ab65", "#d18578"];

interface N { x: SpecItem; cx: number; cy: number; w: number; color: string; parent?: N }

function layout(items: SpecItem[], shown: Set<string> | null) {
  const nodes: N[] = [];
  let top = 20;
  const place = (x: SpecItem, color: string, parent?: N): N => {
    const kids = x.children.filter((c) => !shown || shown.has(c.id));
    const n: N = { x, cx: COL[x.level], cy: 0, w: W[x.level], color, parent };
    nodes.push(n);
    if (!kids.length) { n.cy = top + ROW / 2; top += ROW; return n; }
    const placed = kids.map((c) => place(c, color, n));
    n.cy = (placed[0].cy + placed[placed.length - 1].cy) / 2;
    return n;
  };
  const roots = items.filter((x) => !shown || shown.has(x.id)).map((x, i) => place(x, COLORS[i % COLORS.length]));
  const height = Math.max(top + 20, 200);
  const rootY = roots.length ? (roots[0].cy + roots[roots.length - 1].cy) / 2 : height / 2;
  return { nodes, roots, height, rootY };
}

export function Graph({ p, num, shown, dim, selected, onOpen, focus }: {
  p: Project; num: Record<string, string>; shown: Set<string> | null; dim: Set<string> | null;
  selected: string | null; onOpen: (id: string) => void; focus: string | null;
}) {
  const { nodes, height, rootY } = useMemo(() => layout(p.spec ?? [], shown), [p.spec, shown]);
  const [view, setView] = useState({ x: 24, y: 24, s: 0.9 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  // Narrow screens start zoomed out so the root and requirements fit across.
  useEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r?.width || r.width >= 1000) return;
    const s = Math.max(0.3, Math.min(0.9, (r.width - 24) / 900));
    setView({ x: 12, y: r.height / 2 - rootY * s, s });
  }, [rootY]);

  // Center the item the review bar or tree jumps to.
  useEffect(() => {
    if (!focus || !box.current) return;
    const n = nodes.find((m) => m.x.id === focus);
    if (!n) return;
    const r = box.current.getBoundingClientRect();
    if (!r.width) return;
    setView((v) => ({ ...v, x: r.width / 2 - (n.cx + n.w / 2) * v.s, y: r.height / 2 - n.cy * v.s }));
  }, [focus, nodes]);

  const blocks = p.prd?.flatMap((s) => s.blocks) ?? [];
  const pct = blocks.length ? Math.round((blocks.filter((b) => b.body.trim()).length / blocks.length) * 100) : 0;
  const zoom = (f: number) => setView((v) => {
    const r = box.current?.getBoundingClientRect();
    const s = Math.min(2, Math.max(0.3, v.s * f));
    const cx = (r?.width ?? 0) / 2, cy = (r?.height ?? 0) / 2;
    return { s, x: cx - ((cx - v.x) / v.s) * s, y: cy - ((cy - v.y) / v.s) * s };
  });
  const reqCount = (p.spec ?? []).length;

  return (
    <div ref={box} className="relative h-full w-full touch-none overflow-hidden select-none"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("[data-node],[data-ctl]")) return;
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
      }}
      onPointerUp={() => { drag.current = null; }}
      onWheel={(e) => {
        if (e.ctrlKey || e.metaKey) zoom(e.deltaY < 0 ? 1.1 : 0.9);
        else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }}
      style={{ cursor: drag.current ? "grabbing" : "grab" }} aria-label="기능 그래프">
      <div className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, width: 1140, height }}>
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={1140} height={height}>
          {nodes.map((n) => {
            const from = n.parent ? { x: n.parent.cx + n.parent.w, y: n.parent.cy } : { x: COL[0] + W[0], y: rootY };
            const to = { x: n.cx, y: n.cy };
            const mx = (from.x + to.x) / 2;
            return <path key={n.x.id} d={`M${from.x} ${from.y} C ${mx} ${from.y}, ${mx} ${to.y}, ${to.x} ${to.y}`} fill="none" stroke={n.color} strokeWidth={1.5}
              opacity={dim?.has(n.x.id) ? 0.25 : 1} />;
          })}
        </svg>
        <div data-node className="absolute rounded-xl border border-border bg-background p-3 shadow-sm" style={{ left: COL[0], top: rootY - 40, width: W[0] }}>
          <p className="text-sm font-semibold">PRD</p>
          <p className="mt-0.5 truncate text-xs text-foreground-muted">{p.name}</p>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-foreground-muted">
            <span className="h-1 flex-1 overflow-hidden rounded bg-border"><span className="block h-full bg-primary" style={{ width: `${pct}%` }} /></span>
            {pct}% · 요구사항 {reqCount}
          </div>
        </div>
        {nodes.map((n) => {
          const f = n.x.level > 1 ? slotFill(n.x) : null;
          return (
            <button key={n.x.id} data-node onClick={() => onOpen(n.x.id)} aria-label={`노드 ${n.x.title}`}
              className={`absolute flex flex-col justify-center rounded-lg border bg-background px-2.5 text-left shadow-sm transition-shadow hover:shadow-md ${selected === n.x.id ? "ring-2 ring-primary" : ""} ${n.x.pending ? "border-primary border-dashed" : n.x.level === 1 ? "border-2" : "border-border"} ${dim?.has(n.x.id) ? "opacity-30" : ""}`}
              style={{ left: n.cx, top: n.cy - (n.x.level === 3 ? 21 : 24), width: n.w, height: n.x.level === 3 ? 42 : 48, borderColor: n.x.level === 1 && !n.x.pending ? n.color : undefined }}>
              <span className="flex w-full items-center gap-1.5">
                <span className="shrink-0 text-[10px] text-foreground-muted">{num[n.x.id]}</span>
                <span className={`truncate text-xs ${n.x.level === 1 ? "font-semibold" : "font-medium"}`}>{n.x.title}</span>
                {n.x.starred && <Star on className="ml-auto text-[10px]" />}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-foreground-muted">
                <span>{n.x.code}</span>
                {n.x.pending ? <PendingBadge x={n.x} /> : f && <span className={f.filled === f.total ? "text-primary" : ""}>{f.filled}/{f.total}</span>}
                {n.x.questions?.length ? <span className="text-amber-500">?{n.x.questions.length}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      <div data-ctl className="absolute right-3 bottom-3 flex flex-col overflow-hidden rounded-lg border border-border bg-background text-sm shadow-sm">
        <button onClick={() => zoom(1.2)} aria-label="확대" className="h-8 w-8 hover:bg-surface">+</button>
        <button onClick={() => zoom(1 / 1.2)} aria-label="축소" className="h-8 w-8 border-t border-border hover:bg-surface">−</button>
        <button onClick={() => setView({ x: 24, y: 24, s: 0.9 })} aria-label="화면 맞춤" className="h-8 w-8 border-t border-border text-[10px] hover:bg-surface">{Math.round(view.s * 100)}%</button>
      </div>
    </div>
  );
}
