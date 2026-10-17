"use client";

import { josa } from "@/lib/josa";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDismiss } from "../Popover";
import { aiEnabled, isBusy } from "@/lib/run";
import type { Project, WireEl } from "@/lib/types";
import { useIsMobile } from "@/lib/useMedia";
import {
  deleteEl, deleteSet, finishEditing, generateWires, isDrawing, moveEl, openSet, pageNodes, regeneratePage,
  setPageEls, syncWires, updateEl, useDrawing,
} from "@/lib/wire";
import { TrashIcon } from "../icons";
import { ElEditor } from "./wire/ElEditor";
import { GenerateDialog } from "./wire/GenerateDialog";
import { Intro } from "./wire/Intro";
import { FRAME, Screen } from "./wire/Screen";

const Spinner = () => <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-primary border-t-transparent" />;
const tool = "rounded-md border border-border bg-background px-2.5 py-1 text-xs hover:bg-surface disabled:opacity-40";

function defaultDevice(p: Project): "mobile" | "desktop" {
  const d = (p.prdProps?.devices ?? []).join(" ");
  if (/모바일|앱|iOS|Android|휴대폰/i.test(d)) return "mobile";
  if (/웹|데스크톱|PC/i.test(d)) return "desktop";
  return "mobile";
}

const fmt = (t: number) => new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Regenerate({ disabled, onRun }: { disabled: boolean; onRun: (req: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className="relative">
      <button aria-label="재생성" disabled={disabled} onClick={() => setOpen(!open)} className={tool}>재생성</button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-xl border border-border bg-background p-3 shadow-lg">
          <p className="mb-1.5 text-xs text-foreground-support">이 페이지를 어떻게 바꿔 그릴까요?</p>
          <textarea aria-label="재생성 요청" value={text} onChange={(e) => setText(e.target.value)} rows={2} autoFocus
            placeholder="예: 일정 카드를 더 크게, 참여 버튼은 아래에 고정"
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary" />
          <button aria-label="이 페이지 재생성" onClick={() => { onRun(text); setText(""); setOpen(false); }}
            className="mt-2 w-full rounded-md bg-primary py-1.5 text-sm font-medium text-white">재생성</button>
        </div>
      )}
    </div>
  );
}

export function WireframeView({ p }: { p: Project }) {
  const mobile = useIsMobile();
  const drawing = useDrawing();
  const [flowSel, setFlowSel] = useState<string>();
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<string[] | null>(null);
  const [overview, setOverview] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const [undo, setUndo] = useState<Record<string, WireEl[][]>>({});
  const edited = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  const cur = p.wires.find((s) => s.id === p.wireId);
  const flow = p.flows.find((f) => f.id === (flowSel ?? cur?.flowId ?? p.flowId)) ?? p.flows[0];
  const sets = flow ? p.wires.filter((s) => s.flowId === flow.id) : [];
  const set = cur && cur.flowId === flow?.id ? cur : sets[0];
  const nodes = flow ? pageNodes(flow) : [];
  const drawn = set?.pages ?? [];
  const page = nodeId ? drawn.find((x) => x.nodeId === nodeId) : drawn[0];
  const node = nodes.find((n) => n.id === (nodeId ?? page?.nodeId));
  const idx = page ? drawn.indexOf(page) : -1;
  const device = set?.device ?? defaultDevice(p);
  const busy = aiEnabled() && isBusy(p);
  const anyDrawing = !!set && nodes.some((n) => isDrawing(drawing, set.id, n.id));
  const sel = editing && page ? page.els.find((e) => e.id === selected) : undefined;

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { setWidth(el.clientWidth); });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, [overview, full, !!set, p.flows.length]);
  const fit = Math.min(1, Math.max(0.3, (width - 32) / FRAME[device].w));
  const z = zoom ?? fit;

  const snap = () => {
    if (!page) return;
    edited.current = true;
    const els = page.els;
    setUndo((u) => ({ ...u, [page.id]: [...(u[page.id] ?? []), els].slice(-50) }));
  };
  const doUndo = useCallback(() => {
    if (!set || !page) return;
    const st = undo[page.id];
    if (!st?.length) return;
    setPageEls(p.id, set.id, page.id, st[st.length - 1]);
    setUndo((u) => ({ ...u, [page.id]: st.slice(0, -1) }));
  }, [p.id, set, page, undo]);
  const stopEditing = () => {
    setEditing(false);
    setSelected(null);
    if (edited.current && page) finishEditing(p.id, page.name);
    edited.current = false;
  };

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, [editing, doUndo]);

  const go = (id: string | null) => {
    if (editing) stopEditing();
    setNodeId(id);
    setOverview(false);
  };
  const pickFlow = (fid: string) => {
    setFlowSel(fid);
    openSet(p.id, p.wires.find((s) => s.flowId === fid)?.id);
    go(null);
  };
  const openDialog = () => setDialog(nodes.filter((n) => !drawn.some((x) => x.nodeId === n.id)).map((n) => n.id));
  const removeSet = () => {
    if (set && confirm("이 와이어프레임을 지울까요? 그려진 페이지가 모두 사라져요.")) { deleteSet(p.id, set.id); go(null); }
  };

  if (!p.flows.length || !flow) return (
    <div className="flex h-full items-center justify-center bg-background-canvas p-6">
      <div className="max-w-sm rounded-2xl border border-border bg-background p-8 text-center">
        <p className="mb-1 text-lg font-semibold">유저플로우를 먼저 만들어 주세요</p>
        <p className="text-sm text-foreground-muted">와이어프레임은 유저플로우의 페이지를 바탕으로 한 장씩 그려져요. 유저플로우 탭에서 흐름을 만든 뒤 다시 와 주세요.</p>
      </div>
    </div>
  );

  const sections = [...flow.sections, ...(nodes.some((n) => !flow.sections.includes(n.section)) ? ["기타"] : [])];
  const inSection = (s: string) => nodes.filter((n) => (s === "기타" ? !flow.sections.includes(n.section) : n.section === s));
  const usedSections = sections.filter((s) => inSection(s).length);
  let num = 0;

  const flowSelect = (
    <select aria-label="유저플로우 선택" value={flow.id} onChange={(e) => pickFlow(e.target.value)}
      className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm">
      {p.flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
    </select>
  );
  const setSelect = sets.length > 1 && (
    <select aria-label="와이어프레임 버전" value={set?.id} onChange={(e) => { openSet(p.id, e.target.value); go(null); }}
      className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs">
      {sets.map((s) => <option key={s.id} value={s.id}>{s.device === "mobile" ? "모바일" : "데스크톱"} · {fmt(s.at)} · {s.pages.length}페이지</option>)}
    </select>
  );
  const moreBtn = (
    <button aria-label="이어서 생성" onClick={openDialog} disabled={busy} className="shrink-0 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40">
      {set ? "이어서 생성" : "만들기"}
    </button>
  );
  const trash = set && (
    <button aria-label="와이어프레임 삭제" onClick={removeSet} className="shrink-0 rounded p-1.5 text-foreground-muted hover:text-red-500"><TrashIcon /></button>
  );

  // --- Left: page list ---
  const aside = (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-background">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex items-center gap-1.5">{flowSelect}{trash}</div>
        {setSelect && <div className="flex">{setSelect}</div>}
        <div className="flex items-center gap-2">
          <span className="truncate text-xs text-foreground-muted">{set ? `${set.device === "mobile" ? "모바일" : "데스크톱"} 와이어프레임` : "아직 그린 페이지가 없어요"}</span>
          <span className="ml-auto">{moreBtn}</span>
        </div>
      </div>
      <nav aria-label="페이지 목록" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {usedSections.map((s) => (
          <div key={s} className="mb-2">
            <p className="px-2 py-1 text-[11px] font-semibold text-foreground-muted">{s}</p>
            {inSection(s).map((n) => {
              const has = drawn.some((x) => x.nodeId === n.id);
              const spin = set && isDrawing(drawing, set.id, n.id);
              const on = node?.id === n.id && !overview;
              return (
                <button key={n.id} aria-label={`페이지 ${n.label}`} onClick={() => go(n.id)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] ${on ? "bg-surface" : "hover:bg-surface"} ${has ? "font-medium text-foreground" : "text-foreground-assistive"}`}>
                  <span className="w-5 shrink-0 text-[11px] text-foreground-muted">{++num}</span>
                  <span className="min-w-0 flex-1 truncate">{n.label}</span>
                  {spin && <Spinner />}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <p className="border-t border-border px-3 py-2 text-[11px] text-foreground-muted">
        섹션 {usedSections.length} · 페이지 {nodes.length} · 생성 {drawn.length}/{nodes.length}
      </p>
    </aside>
  );

  // --- Mobile: selects above the canvas ---
  const top = (
    <div className="space-y-2 border-b border-border bg-background px-3 py-2">
      <div className="flex items-center gap-1.5">{flowSelect}{moreBtn}{trash}</div>
      {setSelect && <div className="flex">{setSelect}</div>}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]" aria-label="페이지 목록">
        {nodes.map((n, i) => {
          const has = drawn.some((x) => x.nodeId === n.id);
          const on = node?.id === n.id && !overview;
          return (
            <button key={n.id} aria-label={`페이지 ${n.label}`} onClick={() => go(n.id)}
              className={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${on ? "border-foreground bg-foreground text-background" : has ? "border-border-strong text-foreground" : "border-border text-foreground-assistive"}`}>
              {i + 1}. {n.label}{set && isDrawing(drawing, set.id, n.id) && <Spinner />}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-foreground-muted">섹션 {usedSections.length} · 페이지 {nodes.length} · 생성 {drawn.length}/{nodes.length}</p>
    </div>
  );

  // --- Canvas content ---
  let content: React.ReactNode;
  if (!set) content = (
    <div className="flex h-full items-center justify-center p-4">
      <div className="max-w-sm rounded-2xl border border-border bg-background p-8 text-center">
        <p className="mb-1 text-lg font-semibold">아직 와이어프레임이 없어요</p>
        <p className="mb-5 text-sm text-foreground-muted">&lsquo;{flow.name}&rsquo;의 페이지 {nodes.length}개 중 원하는 것만 골라 실제 앱 화면처럼 그려 드려요. 버튼을 누르면 다음 화면으로 넘어가요.</p>
        <button aria-label="와이어프레임 만들기" onClick={openDialog} disabled={busy || !nodes.length}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">와이어프레임 만들기</button>
        {!nodes.length && <p className="mt-3 text-xs text-foreground-muted">이 유저플로우에는 페이지 노드가 없어요.</p>}
      </div>
    </div>
  );
  else if (!drawn.length && anyDrawing) content = <div className="flex h-full items-center justify-center p-4"><Intro /></div>;
  else if (overview) content = (
    <div className="space-y-6 p-4 md:p-6">
      {usedSections.map((s) => {
        const list = drawn.filter((x) => inSection(s).some((n) => n.id === x.nodeId));
        if (!list.length) return null;
        return (
          <section key={s}>
            <p className="mb-2 text-sm font-semibold text-foreground-support">{s} <span className="font-normal text-foreground-muted">{list.length}</span></p>
            <div className="flex flex-wrap gap-4">
              {list.map((x) => (
                <button key={x.id} aria-label={`${x.name} 열기`} onClick={() => go(x.nodeId)} className="group text-left">
                  <div className="pointer-events-none rounded-[20px] transition group-hover:ring-2 group-hover:ring-primary">
                    <Screen els={x.els} device={set.device} pages={nodes} zoom={set.device === "mobile" ? (mobile ? 0.4 : 0.45) : (mobile ? 0.3 : 0.26)} still />
                  </div>
                  <p className="mt-1.5 max-w-[160px] truncate text-xs text-foreground-support">{x.name}</p>
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {!drawn.length && <p className="text-center text-sm text-foreground-muted">아직 그려진 페이지가 없어요.</p>}
    </div>
  );
  else if (!page) content = (
    <div className="flex h-full items-center justify-center p-4">
      <div className="max-w-sm rounded-2xl border border-border bg-background p-6 text-center">
        {node && isDrawing(drawing, set.id, node.id) ? (
          <><Spinner /><p className="mt-2 text-sm text-foreground-support">&lsquo;{node.label}&rsquo; 페이지를 그리고 있어요…</p></>
        ) : (
          <>
            <p className="mb-1 font-semibold">{node ? `'${node.label}'${josa(node.label, "은/는")} 아직 그리지 않았어요` : "페이지를 골라 주세요"}</p>
            <p className="mb-4 text-sm text-foreground-muted">버튼이 이 페이지로 이어져 있어요. 지금 바로 그려 볼까요?</p>
            {node && <button aria-label="이 페이지 그리기" disabled={busy} onClick={() => generateWires(p.id, { flowId: flow.id, device: set.device, nodeIds: [node.id], note: set.note })}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">이 페이지 그리기</button>}
          </>
        )}
      </div>
    </div>
  );
  else content = (
    <div className="flex min-h-full justify-center p-4" onClick={() => setSelected(null)}>
      <div className="relative">
        <Screen els={page.els} device={set.device} pages={nodes} zoom={z} editing={editing} selected={selected}
          onSelect={setSelected} onOpen={(id) => go(id)} />
        {isDrawing(drawing, set.id, page.nodeId) && (
          <div className="absolute inset-0 flex items-center justify-center rounded-[34px] bg-white/60"><Spinner /></div>
        )}
      </div>
    </div>
  );

  const pageTools = set && page && !overview && (
    <>
      <div className="flex items-center gap-1">
        <button aria-label="이전 페이지" disabled={idx <= 0} onClick={() => go(drawn[idx - 1].nodeId)} className={tool}>‹</button>
        <span className="min-w-[3rem] text-center text-xs tabular-nums text-foreground-support">{idx + 1}/{drawn.length}</span>
        <button aria-label="다음 페이지" disabled={idx >= drawn.length - 1} onClick={() => go(drawn[idx + 1].nodeId)} className={tool}>›</button>
      </div>
      <div className="flex items-center gap-1">
        <button aria-label="축소" onClick={() => setZoom(Math.max(0.3, Math.round((z - 0.1) * 10) / 10))} className={tool}>−</button>
        <button aria-label="화면에 맞추기" onClick={() => setZoom(null)} className="min-w-[3rem] text-center text-xs tabular-nums text-foreground-support">{Math.round(z * 100)}%</button>
        <button aria-label="확대" onClick={() => setZoom(Math.min(2, Math.round((z + 0.1) * 10) / 10))} className={tool}>+</button>
      </div>
    </>
  );

  const toolbar = set && (drawn.length > 0 || !anyDrawing) && (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-2">
      <p className="mr-auto min-w-0 truncate text-sm font-medium">
        {overview ? "전체 보기" : node?.label ?? "와이어프레임"}
        {!overview && node && <span className="ml-2 text-xs font-normal text-foreground-muted">{node.section}</span>}
      </p>
      {pageTools}
      <button aria-label="전체 보기" aria-pressed={overview} onClick={() => { if (editing) stopEditing(); setOverview(!overview); }}
        className={`${tool} ${overview ? "border-foreground bg-foreground text-background hover:bg-foreground" : ""}`}>전체 보기</button>
      {page && !overview && (editing ? (
        <>
          <button aria-label="되돌리기" title="되돌리기 (Ctrl/⌘+Z)" disabled={!undo[page.id]?.length} onClick={doUndo} className={tool}>되돌리기</button>
          <button aria-label="편집 완료" onClick={stopEditing} className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-white">편집 완료</button>
        </>
      ) : (
        <>
          <button aria-label="직접 편집" onClick={() => { setEditing(true); setSelected(null); }} className={tool}>직접 편집</button>
          <Regenerate disabled={busy || isDrawing(drawing, set.id, page.nodeId)} onRun={(req) => regeneratePage(p.id, set.id, page.id, req)} />
        </>
      ))}
      <button aria-label={full ? "전체 화면 끝내기" : "전체 화면"} onClick={() => setFull(!full)} className={tool}>{full ? "⤡" : "⤢"}</button>
    </div>
  );

  const editor = sel && set && page && (
    <div className={mobile ? "fixed inset-x-0 bottom-0 z-50 p-2" : "absolute right-4 top-16 z-30"}>
      <ElEditor el={sel} pages={nodes} onSnap={snap}
        onChange={(patch) => updateEl(p.id, set.id, page.id, sel.id, patch)}
        onMove={(d) => { snap(); moveEl(p.id, set.id, page.id, sel.id, d); }}
        onDelete={() => { snap(); deleteEl(p.id, set.id, page.id, sel.id); setSelected(null); }}
        onClose={() => setSelected(null)} />
    </div>
  );

  const stale = p.stale?.wire && p.wires.length > 0 && (
    <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
      유저플로우가 바뀌었어요. 와이어프레임에도 반영할까요?
      <button aria-label="와이어프레임 동기화" disabled={busy} onClick={() => syncWires(p.id)} className="ml-auto rounded border border-amber-300 bg-white px-2 py-0.5 disabled:opacity-40">동기화</button>
    </div>
  );

  return (
    <div className="flex h-full flex-col md:flex-row">
      {mobile ? top : aside}
      <div className={`${full ? "fixed inset-0 z-40" : "relative min-h-0 flex-1"} flex min-w-0 flex-col bg-background-canvas`}>
        {stale}
        {toolbar}
        {editing && !mobile && !sel && page && !overview && (
          <p className="absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-full bg-foreground px-3 py-1 text-xs text-background">바꿀 요소를 눌러 주세요</p>
        )}
        <div ref={canvasRef} className="min-h-0 flex-1 overflow-auto">{content}</div>
        {editor}
      </div>
      {dialog && (
        <GenerateDialog p={p} flowId={flow.id} device={device} preselect={dialog} onClose={() => setDialog(null)}
          onSubmit={(o) => {
            setDialog(null);
            setFlowSel(o.flowId);
            setNodeId(o.nodeIds[0]);
            setOverview(false);
            generateWires(p.id, o);
          }} />
      )}
    </div>
  );
}
