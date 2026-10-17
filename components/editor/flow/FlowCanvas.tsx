"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addNodeAfter, addNodeBelow, deleteEdge, deleteNode, moveNodeSection, renameNode, renameSection, setEdgeLabel, setNodeKind } from "@/lib/flow";
import { FLOW_KINDS, KIND_LABEL } from "@/lib/flow-local";
import { LEFT, layoutFlow, routeEdge } from "@/lib/flow-layout";
import type { Flow, FlowKind } from "@/lib/types";
import { useDismiss } from "@/components/Popover";
import { Plus, TrashIcon } from "@/components/icons";
import { KIND_STYLE, LegendIcon, ShapePath } from "./shapes";

type Sel = { type: "node" | "edge"; id: string } | null;
interface View { x: number; y: number; z: number }

const clampZ = (z: number) => Math.min(2, Math.max(0.25, z));

export function FlowCanvas({ pid, flow, picking, picked, onPick, children }: {
  pid: string;
  flow: Flow;
  picking: boolean; // revision panel open: clicks pick focus nodes instead of selecting
  picked: string[];
  onPick: (nodeId: string) => void;
  children?: React.ReactNode;
}) {
  const L = useMemo(() => layoutFlow(flow), [flow]);
  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 16, y: 16, z: 0.8 });
  const [sel, setSel] = useState<Sel>(null);
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<"kind" | "section" | null>(null);
  const [sectionEdit, setSectionEdit] = useState<string | null>(null);

  const fit = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const z = clampZ(Math.min(1, (el.clientWidth - 32) / L.width, (el.clientHeight - 32) / L.height));
    setView({ x: 16, y: 16, z: Math.max(0.45, z) });
  }, [L.width, L.height]);

  // Fresh view whenever another flow is opened.
  useEffect(() => {
    fit();
    setSel(null);
  }, [flow.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (picking) setSel(null);
  }, [picking]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      const el = wrap.current;
      const px = cx ?? (el ? el.clientWidth / 2 : 0), py = cy ?? (el ? el.clientHeight / 2 : 0);
      const z = clampZ(v.z * factor);
      return { z, x: px - ((px - v.x) * z) / v.z, y: py - ((py - v.y) * z) / v.z };
    });
  }, []);

  // ctrl/⌘ + wheel zooms; a plain wheel pans. Native listener so preventDefault works.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [zoomAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setSel(null); setMenu(null); setRenaming(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Pan by dragging the background (mouse or one finger); pinch with two fingers.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; v: View; moved: boolean; pinch?: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("[data-node],[data-edge],[data-ui]")) return;
    wrap.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    drag.current = { x: e.clientX, y: e.clientY, v: view, moved: pts.length > 1, pinch: pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : undefined };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 2 && d.pinch) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const r = wrap.current!.getBoundingClientRect();
      const cx = (pts[0].x + pts[1].x) / 2 - r.left, cy = (pts[0].y + pts[1].y) / 2 - r.top;
      const z = clampZ(d.v.z * (dist / d.pinch));
      setView({ z, x: cx - ((cx - d.v.x) * z) / d.v.z, y: cy - ((cy - d.v.y) * z) / d.v.z });
      return;
    }
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) setView({ ...d.v, x: d.v.x + dx, y: d.v.y + dy });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (pointers.current.size) return;
    drag.current = null;
    if (d && !d.moved) { setSel(null); setMenu(null); setRenaming(false); setSectionEdit(null); }
  };

  const selNode = sel?.type === "node" ? flow.nodes.find((n) => n.id === sel.id) : undefined;
  const selEdge = sel?.type === "edge" ? flow.edges.find((e) => e.id === sel.id) : undefined;

  // The selected node's path: everything reachable forward and backward (returns excluded).
  const lit = useMemo(() => {
    if (!selNode) return null;
    const nodes = new Set([selNode.id]);
    const fwd = flow.edges.filter((e) => !L.back.has(e.id));
    const walk = (start: string, dir: "from" | "to") => {
      const q = [start];
      while (q.length) {
        const v = q.shift()!;
        for (const e of fwd) {
          const next = dir === "from" ? (e.from === v ? e.to : null) : (e.to === v ? e.from : null);
          if (next && !nodes.has(next)) { nodes.add(next); q.push(next); }
        }
      }
    };
    walk(selNode.id, "from");
    walk(selNode.id, "to");
    flow.edges.forEach((e) => { if (e.from === selNode.id) nodes.add(e.to); if (e.to === selNode.id) nodes.add(e.from); });
    const edges = new Set(flow.edges.filter((e) => e.from === selNode.id || e.to === selNode.id || (!L.back.has(e.id) && nodes.has(e.from) && nodes.has(e.to))).map((e) => e.id));
    return { nodes, edges };
  }, [selNode, flow.edges, L.back]);

  const screen = (x: number, y: number) => ({ left: x * view.z + view.x, top: y * view.z + view.y });

  const clickNode = (id: string) => {
    if (picking) return onPick(id);
    setSel({ type: "node", id });
    setMenu(null);
    setRenaming(false);
  };
  const add = (where: "after" | "below") => {
    if (!selNode) return;
    const nid = (where === "after" ? addNodeAfter : addNodeBelow)(pid, flow.id, selNode.id, "page");
    setSel({ type: "node", id: nid });
    setRenaming(true);
  };

  const lanes = new Map<string, number>();
  const box = selNode && L.boxes[selNode.id];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-background px-3 py-1.5 text-xs">
        <span className="max-w-[40%] truncate font-medium">{flow.name}</span>
        <span className="text-foreground-muted">노드 {flow.nodes.length} · 연결 {flow.edges.length}</span>
        <div className="flex items-center gap-2.5 text-foreground-support" aria-label="노드 종류 범례">
          {FLOW_KINDS.map((k) => <span key={k} className="flex items-center gap-1"><LegendIcon kind={k} />{KIND_LABEL[k]}</span>)}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => zoomAt(1 / 1.2)} aria-label="축소" className="h-6 w-6 rounded border border-border hover:bg-surface">−</button>
          <span className="w-10 text-center tabular-nums text-foreground-muted">{Math.round(view.z * 100)}%</span>
          <button onClick={() => zoomAt(1.2)} aria-label="확대" className="h-6 w-6 rounded border border-border hover:bg-surface">+</button>
          <button onClick={() => { setSel(null); fit(); }} aria-label="자동 정렬" className="ml-1 rounded border border-border px-2 py-0.5 hover:bg-surface">자동 정렬</button>
        </div>
      </div>

      <div ref={wrap} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        aria-label="유저플로우 캔버스" className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-background-canvas select-none active:cursor-grabbing">
        <div style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: "0 0" }} className="absolute top-0 left-0">
          <svg width={L.width} height={L.height} className="block overflow-visible">
            <defs>
              <marker id="fl-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" fill="#9b9b9b" /></marker>
              <marker id="fl-arr-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" fill="var(--color-primary)" /></marker>
            </defs>
            {L.bands.map((b, i) => (
              <g key={b.section}>
                <rect x={0} y={b.y} width={L.width} height={b.h} fill={i % 2 ? "#f6f5f5" : "#fbfbfb"} />
                <line x1={0} x2={L.width} y1={b.y} y2={b.y} stroke="#e4e2e2" />
                <foreignObject x={10} y={b.y + 10} width={LEFT - 28} height={Math.min(60, b.h - 12)}>
                  <button data-ui onClick={() => !picking && setSectionEdit(b.section)} aria-label={`구역 이름 바꾸기: ${b.section}`}
                    className="block w-full text-left text-[12px] leading-snug font-medium text-foreground-support hover:text-primary">{b.section}</button>
                </foreignObject>
              </g>
            ))}
            {flow.edges.map((e) => {
              const a = L.boxes[e.from], b = L.boxes[e.to];
              if (!a || !b) return null;
              // Loops into the same node get their own lane so they do not overlap.
              const lane = L.back.has(e.id) ? lanes.get(e.to) ?? 0 : 0;
              if (L.back.has(e.id)) lanes.set(e.to, lane + 1);
              const r = routeEdge(a, b, lane);
              const on = sel?.id === e.id || !!lit?.edges.has(e.id);
              const dim = (lit && !lit.edges.has(e.id)) || (selEdge && selEdge.id !== e.id);
              return (
                <g key={e.id} data-edge opacity={dim ? 0.18 : 1} onClick={() => { if (!picking) { setSel({ type: "edge", id: e.id }); setMenu(null); } }} className="cursor-pointer">
                  <path d={r.d} fill="none" stroke="transparent" strokeWidth={12} />
                  <path d={r.d} fill="none" stroke={on ? "var(--color-primary)" : "#a6a4a4"} strokeWidth={on ? 1.8 : 1.1}
                    strokeDasharray={L.back.has(e.id) ? "4 3" : undefined} markerEnd={`url(#${on ? "fl-arr-on" : "fl-arr"})`} />
                  {e.label && (
                    <text x={r.lx} y={r.ly - 4} textAnchor="middle" fontSize={10} fill={on ? "var(--color-primary)" : "#6f6d6d"}
                      stroke="var(--color-background-canvas)" strokeWidth={4} paintOrder="stroke">{e.label.length > 16 ? `${e.label.slice(0, 15)}…` : e.label}</text>
                  )}
                </g>
              );
            })}
            {flow.nodes.map((n) => {
              const b = L.boxes[n.id];
              if (!b) return null;
              const isPicked = picked.includes(n.id);
              const dim = lit && !lit.nodes.has(n.id);
              const inset = n.kind === "branch" ? b.w * 0.18 : n.kind === "data" ? 12 : 6;
              return (
                <g key={n.id} data-node aria-label={`노드: ${n.label}`} role="button" onClick={() => clickNode(n.id)} opacity={dim ? 0.25 : 1} className="cursor-pointer">
                  <ShapePath kind={n.kind} b={b} selected={sel?.id === n.id || isPicked} />
                  <foreignObject x={b.x + inset} y={b.y} width={b.w - inset * 2} height={b.h}>
                    <div className="flex h-full items-center justify-center text-center text-[11px] leading-tight" style={{ color: KIND_STYLE[n.kind].text }}>
                      <span className="line-clamp-2 break-keep">{n.label}</span>
                    </div>
                  </foreignObject>
                  {isPicked && <circle cx={b.x + b.w} cy={b.y} r={6} fill="var(--color-primary)" />}
                </g>
              );
            })}
          </svg>
        </div>

        {selNode && box && !picking && (
          <NodeTools key={selNode.id} style={screen(box.cx, box.y)} kind={selNode.kind} sections={L.bands.map((b) => b.section)} section={selNode.section}
            menu={menu} setMenu={setMenu}
            onKind={(k) => { setNodeKind(pid, flow.id, selNode.id, k); setMenu(null); }}
            onSection={(s) => { moveNodeSection(pid, flow.id, selNode.id, s); setMenu(null); }}
            onRename={() => { setRenaming(true); setMenu(null); }}
            onDelete={() => { deleteNode(pid, flow.id, selNode.id); setSel(null); }} />
        )}
        {selNode && box && !picking && !renaming && (
          <>
            <button data-ui onClick={() => add("after")} aria-label="오른쪽에 노드 추가" title="연결된 노드를 오른쪽에 추가"
              style={{ ...screen(box.x + box.w, box.cy), transform: "translate(8px, -50%)" }}
              className="absolute grid h-6 w-6 place-items-center rounded-full border border-primary bg-background text-primary shadow-sm hover:bg-primary hover:text-white"><Plus className="h-3.5 w-3.5" /></button>
            <button data-ui onClick={() => add("below")} aria-label="아래에 노드 추가" title="같은 단계의 노드를 아래에 추가"
              style={{ ...screen(box.cx, box.y + box.h), transform: "translate(-50%, 8px)" }}
              className="absolute grid h-6 w-6 place-items-center rounded-full border border-primary bg-background text-primary shadow-sm hover:bg-primary hover:text-white"><Plus className="h-3.5 w-3.5" /></button>
          </>
        )}
        {selNode && box && renaming && (
          <InlineInput key={`r${selNode.id}`} label="노드 이름" initial={selNode.label}
            style={{ ...screen(box.cx, box.cy), width: Math.max(160, box.w * view.z), transform: "translate(-50%, -50%)" }}
            onDone={(v) => { if (v !== null) renameNode(pid, flow.id, selNode.id, v); setRenaming(false); }} />
        )}
        {selEdge && (() => {
          const a = L.boxes[selEdge.from], b = L.boxes[selEdge.to];
          if (!a || !b) return null;
          const r = routeEdge(a, b);
          return <EdgeTools key={selEdge.id} style={screen(r.lx, r.ly)} label={selEdge.label ?? ""}
            onSave={(v) => { setEdgeLabel(pid, flow.id, selEdge.id, v); setSel(null); }}
            onDelete={() => { deleteEdge(pid, flow.id, selEdge.id); setSel(null); }} />;
        })()}
        {sectionEdit && (() => {
          const b = L.bands.find((x) => x.section === sectionEdit);
          if (!b) return null;
          return <InlineInput key={`s${sectionEdit}`} label="구역 이름" initial={sectionEdit}
            style={{ ...screen(10, b.y + 10), width: 180 }}
            onDone={(v) => { if (v !== null) renameSection(pid, flow.id, sectionEdit, v); setSectionEdit(null); }} />;
        })()}
        {children}
      </div>
    </div>
  );
}

function NodeTools({ style, kind, sections, section, menu, setMenu, onKind, onSection, onRename, onDelete }: {
  style: React.CSSProperties; kind: FlowKind; sections: string[]; section: string;
  menu: "kind" | "section" | null; setMenu: (m: "kind" | "section" | null) => void;
  onKind: (k: FlowKind) => void; onSection: (s: string) => void; onRename: () => void; onDelete: () => void;
}) {
  const ref = useDismiss(!!menu, () => setMenu(null));
  const btn = "whitespace-nowrap rounded px-2 py-1 hover:bg-surface";
  return (
    <div data-ui ref={ref} style={{ ...style, transform: "translate(-50%, calc(-100% - 10px))" }}
      className="absolute z-10 flex items-center gap-0.5 rounded-lg border border-border bg-background p-1 text-xs shadow-md" role="toolbar" aria-label="노드 도구">
      <button onClick={() => setMenu(menu === "kind" ? null : "kind")} aria-label="종류 바꾸기" className={btn}>종류 바꾸기</button>
      <button onClick={() => setMenu(menu === "section" ? null : "section")} aria-label="다른 구역으로 옮기기" className={btn}>구역 옮기기</button>
      <button onClick={onRename} aria-label="이름 바꾸기" className={btn}>이름 바꾸기</button>
      <button onClick={onDelete} aria-label="노드 삭제" className={`${btn} text-red-600`}><TrashIcon className="h-3.5 w-3.5" /></button>
      {menu && (
        <div className="absolute top-full left-0 mt-1 max-h-60 min-w-36 overflow-y-auto rounded-lg border border-border bg-background p-1 shadow-lg" role="menu">
          {menu === "kind" && FLOW_KINDS.map((k) => (
            <button key={k} role="menuitem" onClick={() => onKind(k)} aria-label={`종류: ${KIND_LABEL[k]}`}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface ${k === kind ? "font-medium text-primary" : ""}`}>
              <LegendIcon kind={k} />{KIND_LABEL[k]}
            </button>
          ))}
          {menu === "section" && sections.map((s) => (
            <button key={s} role="menuitem" disabled={s === section} onClick={() => onSection(s)} aria-label={`구역: ${s}`}
              className="block w-full truncate rounded px-2 py-1.5 text-left hover:bg-surface disabled:text-foreground-assistive">{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function InlineInput({ label, initial, style, onDone }: { label: string; initial: string; style: React.CSSProperties; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (x: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(x);
  };
  return (
    <input data-ui autoFocus value={v} aria-label={label} onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => { if (e.key === "Enter") finish(v); if (e.key === "Escape") finish(null); }}
      onBlur={() => finish(v)} style={style}
      className="absolute z-20 rounded-md border border-primary bg-background px-2 py-1.5 text-xs shadow-md outline-none" />
  );
}

function EdgeTools({ style, label, onSave, onDelete }: { style: React.CSSProperties; label: string; onSave: (v: string) => void; onDelete: () => void }) {
  const [v, setV] = useState(label);
  return (
    <div data-ui style={{ ...style, transform: "translate(-50%, calc(-100% - 8px))" }} role="dialog" aria-label="연결 편집"
      className="absolute z-10 flex items-center gap-1 rounded-lg border border-border bg-background p-1 text-xs shadow-md">
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onSave(v)}
        placeholder="사용자 행동 (예: 신청 제출)" aria-label="연결 이름" className="w-44 rounded border border-border px-2 py-1 outline-none focus:border-primary" />
      <button onClick={() => onSave(v)} aria-label="연결 이름 저장" className="rounded bg-primary px-2 py-1 text-white">저장</button>
      <button onClick={onDelete} aria-label="연결 삭제" className="rounded px-2 py-1 text-red-600 hover:bg-surface">삭제</button>
    </div>
  );
}
