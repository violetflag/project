"use client";

import { useEffect, useMemo, useState } from "react";
import { completeSpec, specUndoKey, undoSpec } from "@/lib/spec";
import { undoKey, useUndo } from "@/lib/undo";
import { isBusy } from "@/lib/run";
import { findItem, flatten, numbering, pendingItems } from "@/lib/spec-model";
import { STATUS_LABEL } from "@/lib/types";
import type { Project, Status } from "@/lib/types";
import { useIsMobile } from "@/lib/useMedia";
import { Sparkle } from "../icons";
import { EmptyDoc } from "./PrdView";
import { BulkBar } from "./spec/BulkBar";
import { DocumentView } from "./spec/DocumentView";
import { Graph } from "./spec/Graph";
import { ItemDetail } from "./spec/ItemDetail";
import { ReviewBar } from "./spec/ReviewBar";
import { Tree } from "./spec/Tree";
import { isFiltered, matches, NO_FILTER, visibleIds, type Filter } from "./spec/ui";

type View = "graph" | "dir" | "doc";
const VIEWS: [View, string][] = [["graph", "그래프"], ["dir", "디렉토리"], ["doc", "도큐먼트"]];

function Filters({ f, setF, roles, hide, setHide }: { f: Filter; setF: (f: Filter) => void; roles: string[]; hide: boolean; setHide: (v: boolean) => void }) {
  const sel = "rounded border border-border bg-background px-1 py-0.5 text-xs";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Status | "all" })} aria-label="진행 상태 필터" className={sel}>
        <option value="all">진행 상태</option>
        {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} aria-label="사용자 역할 필터" className={sel}>
        <option value="all">사용자 역할</option>
        {roles.map((r) => <option key={r}>{r}</option>)}
      </select>
      <select value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })} aria-label="중요도 필터" className={sel}>
        <option value={0}>중요도</option><option value={3}>높음</option><option value={2}>보통</option><option value={1}>낮음</option>
      </select>
      {isFiltered(f) && (
        <>
          <button onClick={() => setHide(!hide)} aria-label="필터 표시 방식" className="rounded px-1.5 py-0.5 text-xs text-foreground-muted hover:bg-surface">{hide ? "숨기는 중" : "흐리게 표시"}</button>
          <button onClick={() => setF(NO_FILTER)} aria-label="필터 초기화" className="text-xs text-primary">전체 보기</button>
        </>
      )}
    </div>
  );
}

export function FeaturesView({ p }: { p: Project }) {
  const mobile = useIsMobile();
  const [view, setView] = useState<View>("graph");
  const [open, setOpen] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [docAt, setDocAt] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [hide, setHide] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const undo = useUndo(specUndoKey(p.id));
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const k = undoKey(e);
      if (k && undoSpec(p.id, k === "redo")) e.preventDefault();
      if (e.key === "Escape") setPicked(new Set());
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [p.id]);
  const pick = (ids: string[], mode: "toggle" | "add" | "set") => setPicked((cur) => {
    if (mode === "set") return new Set(ids);
    const n = new Set(cur);
    ids.forEach((id) => (mode === "toggle" && n.has(id) ? n.delete(id) : n.add(id)));
    return n;
  });

  const spec = p.spec;
  const num = useMemo(() => numbering(spec ?? []), [spec]);
  const filtered = isFiltered(filter);
  const { shown, dim } = useMemo(() => {
    if (!filtered || !spec) return { shown: null, dim: null };
    const ok = (x: Parameters<typeof matches>[0]) => matches(x, filter);
    return hide
      ? { shown: visibleIds(spec, ok), dim: null }
      : { shown: null, dim: new Set(flatten(spec).filter((x) => !ok(x)).map((x) => x.id)) };
  }, [spec, filter, hide, filtered]);

  if (!spec?.length) {
    const busy = isBusy(p);
    return (
      <EmptyDoc title="아직 기능명세서가 없어요"
        hint={p.prd ? "PRD와 사용자 역할을 바탕으로 요구사항 → 기능 → 상세 기능을 나눠 적고, 개발 준비 슬롯까지 채워 드려요. 만든 내용은 검토 후 승인해야 확정돼요." : "기능명세서는 PRD를 바탕으로 만들어요. 먼저 채팅에서 질문에 답하고 PRD를 만들어 주세요."}
        action={
          <button onClick={() => void completeSpec(p.id)} disabled={!p.prd || busy} aria-label="기능명세서 만들기"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
            <Sparkle className="h-3.5 w-3.5" /> {busy ? "AI가 작업 중이에요…" : "기능명세서 만들기"}
          </button>
        } />
    );
  }

  const all = flatten(spec);
  const pending = pendingItems(spec);
  const current = open ? findItem(spec, open) : undefined;
  const roles = [...new Set([...(p.prdProps?.roles ?? []), ...all.flatMap((x) => x.roles)])];
  const openItem = (id: string) => { setOpen(id); setFocus(id); };
  const toDoc = (id: string) => { setView("doc"); setDocAt(id); setOpen(mobile ? null : id); };
  const dirItem = current ?? all[0];
  const dirIdx = all.findIndex((x) => x.id === dirItem?.id);
  const step = (d: number) => openItem(all[(dirIdx + d + all.length) % all.length].id);
  const prevNext = (
    <span className="flex items-center gap-0.5">
      <button onClick={() => step(-1)} aria-label="이전 항목" className="rounded px-1.5 py-0.5 hover:bg-surface">‹</button>
      <span className="text-[11px] tabular-nums">{dirIdx + 1}/{all.length}</span>
      <button onClick={() => step(1)} aria-label="다음 항목" className="rounded px-1.5 py-0.5 hover:bg-surface">›</button>
    </span>
  );
  const switcher = (
    <div className="flex rounded-md bg-surface p-0.5" role="tablist" aria-label="보기 전환">
      {VIEWS.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}
          className={`rounded px-2.5 py-1 text-xs ${view === k ? "bg-background font-medium shadow-sm" : "text-foreground-support"}`}>
          {mobile && k === "dir" ? "목록" : l}
        </button>
      ))}
    </div>
  );
  const all_ids = new Set(all.map((x) => x.id));
  const pickedIds = [...picked].filter((id) => all_ids.has(id));
  const undoBtns = (
    <span className="flex items-center gap-0.5">
      <button onClick={() => undoSpec(p.id)} disabled={!undo.canUndo} aria-label="실행 취소" title="실행 취소 (⌘Z)"
        className="rounded px-1.5 py-0.5 text-sm text-foreground-support hover:bg-surface disabled:opacity-30">↶</button>
      <button onClick={() => undoSpec(p.id, true)} disabled={!undo.canRedo} aria-label="다시 실행" title="다시 실행 (⌘⇧Z)"
        className="rounded px-1.5 py-0.5 text-sm text-foreground-support hover:bg-surface disabled:opacity-30">↷</button>
    </span>
  );
  const bulk = <BulkBar pid={p.id} ids={pickedIds} onClear={() => setPicked(new Set())} />;
  const canvas = "bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px]";

  if (mobile) {
    const tree = <Tree p={p} num={num} shown={shown} dim={dim} selected={open} onSelect={openItem} big
      starOnly={filter.starred} setStarOnly={(starred) => setFilter({ ...filter, starred })} />;
    return (
      <div className="relative flex h-full flex-col">
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-background px-3 py-1.5">
          <div className="flex items-center justify-between">{switcher}{undoBtns}</div>
          <Filters f={filter} setF={setFilter} roles={roles} hide={hide} setHide={setHide} />
        </div>
        <div className={`relative min-h-0 flex-1 ${view === "graph" ? canvas : "bg-background"}`}>
          {view === "dir" && <div className="h-full pb-16">{tree}</div>}
          {view === "graph" && <Graph p={p} num={num} shown={shown} dim={dim} selected={open} onOpen={setOpen} focus={focus} picked={picked} onPick={pick} />}
          {view === "doc" && <DocumentView p={p} num={num} shown={shown} dim={dim} onOpen={setOpen} scrollTo={docAt} />}
          {view === "graph" && bulk}
        </div>
        <ReviewBar pid={p.id} pending={pending} current={open} onGo={openItem} />
        {current && (
          <div className="fixed inset-0 z-40 bg-background pb-[env(safe-area-inset-bottom)]" role="dialog" aria-label="항목 상세">
            <div className="relative h-full">
              <ItemDetail p={p} x={current} mode="sheet" onClose={() => setOpen(null)} onOpen={openItem} onDoc={toDoc} />
              <ReviewBar pid={p.id} pending={pending} current={open} onGo={openItem} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex h-full">
      <aside className="w-60 shrink-0 border-r border-border bg-background">
        <Tree p={p} num={num} shown={shown} dim={dim} selected={open} onSelect={(id) => { openItem(id); if (view === "doc") setDocAt(id); }}
          starOnly={filter.starred} setStarOnly={(starred) => setFilter({ ...filter, starred })} />
      </aside>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-1.5">
          {switcher}
          {undoBtns}
          <div className="ml-auto"><Filters f={filter} setF={setFilter} roles={roles} hide={hide} setHide={setHide} /></div>
        </div>
        <div className={`relative min-h-0 flex-1 ${view === "graph" ? canvas : ""}`}>
          {view === "graph" && <Graph p={p} num={num} shown={shown} dim={dim} selected={open} onOpen={setOpen} focus={focus} picked={picked} onPick={pick} />}
          {view === "graph" && bulk}
          {view === "doc" && <DocumentView p={p} num={num} shown={shown} dim={dim} onOpen={setOpen} scrollTo={docAt} />}
          {view === "dir" && dirItem && (
            <div className="h-full bg-background pb-16">
              <ItemDetail p={p} x={dirItem} mode="page" onOpen={openItem} onDoc={toDoc} nav={prevNext} />
            </div>
          )}
          {view !== "dir" && current && (
            <aside className="animate-fade-up absolute inset-y-0 right-0 z-20 w-[440px] max-w-full border-l border-border bg-background pb-16 shadow-xl" aria-label="항목 상세">
              <ItemDetail p={p} x={current} mode="panel" onClose={() => setOpen(null)} onOpen={openItem} onDoc={toDoc} />
            </aside>
          )}
        </div>
        <ReviewBar pid={p.id} pending={pending} current={open} onGo={openItem} />
      </div>
    </div>
  );
}
