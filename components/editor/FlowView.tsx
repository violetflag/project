"use client";

import { useEffect, useState } from "react";
import { FLOW_BUSY, addSection, openFlow, requestFlowDialog, syncFlow, takeFlowDialog } from "@/lib/flow";
import { isBusy } from "@/lib/run";
import type { Project } from "@/lib/types";
import { Plus, Sparkle } from "@/components/icons";
import { FlowCanvas } from "./flow/FlowCanvas";
import { FlowList } from "./flow/FlowList";
import { NewFlowDialog } from "./flow/NewFlowDialog";
import { RevisionPanel } from "./flow/RevisionPanel";

function Empty({ p, busy }: { p: Project; busy: boolean }) {
  const hasSpec = !!p.spec?.length;
  return (
    <div className="grid h-full place-items-center bg-background-canvas">
      <div className="mx-4 w-full max-w-[420px] rounded-xl border border-border bg-background px-8 py-10 text-center shadow-sm">
        <svg viewBox="0 0 48 32" className="mx-auto mb-4 h-10 w-14" aria-hidden>
          <rect x="1" y="11" width="12" height="10" rx="5" fill="var(--color-primary)" />
          <path d="M13 16h6m10 0h6" stroke="#bbb" />
          <rect x="19" y="10" width="10" height="12" rx="1.5" fill="none" stroke="#bbb" />
          <path d="M41 9l6 7-6 7-6-7z" fill="#fdf3df" stroke="#dcae55" />
        </svg>
        <p className="font-medium">아직 유저플로우가 없어요</p>
        <p className="mt-1 text-xs leading-relaxed text-foreground-support">
          {hasSpec ? "기능명세서를 읽고 사용자가 지나가는 화면과 판단 지점을 구역별로 이어 드려요."
            : "유저플로우는 기능명세서를 바탕으로 그려요. 기능명세서 탭에서 먼저 명세를 만들어 주세요."}
        </p>
        <button onClick={requestFlowDialog} disabled={!hasSpec || busy} aria-label="유저플로우 만들기"
          className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">유저플로우 만들기</button>
      </div>
    </div>
  );
}

function SectionAdder({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState("");
  const submit = () => { if (v.trim()) onAdd(v.trim()); setV(""); setOpen(false); };
  if (!open) return (
    <button onClick={() => setOpen(true)} aria-label="섹션 추가"
      className="flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs shadow-sm hover:bg-surface"><Plus className="h-3.5 w-3.5" />섹션 추가</button>
  );
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-background p-1 shadow-sm">
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="새 구역 이름" aria-label="새 구역 이름"
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setOpen(false); }}
        className="w-32 rounded px-2 py-1 text-xs outline-none" />
      <button onClick={submit} aria-label="섹션 추가 확인" className="rounded bg-primary px-2 py-1 text-xs text-white">추가</button>
      <button onClick={() => setOpen(false)} className="rounded px-2 py-1 text-xs text-foreground-muted">취소</button>
    </div>
  );
}

export function FlowView({ p }: { p: Project }) {
  const [revising, setRevising] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [asking, setAsking] = useState(takeFlowDialog);
  useEffect(() => {
    const on = () => { takeFlowDialog(); setAsking(true); };
    window.addEventListener("planspace:flow-new", on);
    return () => window.removeEventListener("planspace:flow-new", on);
  }, []);
  const busy = isBusy(p);
  const dialog = asking && <NewFlowDialog p={p} onClose={() => setAsking(false)} />;
  const running = p.chat.find((m) => m.thinking && Object.values(FLOW_BUSY).includes(m.text));
  const flow = openFlow(p);

  const progress = running && (
    <div role="status" aria-label="유저플로우 진행 상황"
      className="absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-xs shadow-lg">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <span>{running.steps?.[running.steps.length - 1] ?? running.text}</span>
      {!!running.steps?.length && <span className="text-foreground-muted">{running.steps.length}단계</span>}
    </div>
  );

  if (!flow) return <div className="relative h-full"><Empty p={p} busy={busy} />{progress}{dialog}</div>;

  const closeRevision = () => { setRevising(false); setPicked([]); };
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <FlowList p={p} busy={busy} />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {p.stale?.flow && (
          <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span className="font-medium">기능명세서가 바뀌었어요.</span>
            <span className="text-amber-800">바뀐 기능을 이 유저플로우에도 반영할까요?</span>
            <button onClick={() => syncFlow(p.id)} disabled={busy} aria-label="유저플로우 동기화"
              className="ml-auto rounded-md bg-amber-500 px-2.5 py-1 font-medium text-white disabled:opacity-50">반영하기</button>
          </div>
        )}
        <FlowCanvas pid={p.id} flow={flow} picking={revising} picked={picked}
          onPick={(id) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]))}>
          {revising ? (
            <RevisionPanel key={flow.id} pid={p.id} flow={flow} picked={picked} onUnpick={(id) => setPicked((x) => x.filter((y) => y !== id))} onClose={closeRevision} />
          ) : (
            <div data-ui className="absolute right-3 bottom-3 z-30 flex items-center gap-1.5">
              <SectionAdder onAdd={(name) => addSection(p.id, flow.id, name)} />
              <button onClick={() => setRevising(true)} disabled={busy} aria-label="수정본 생성"
                className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm disabled:opacity-40">
                <Sparkle className="h-3.5 w-3.5" />수정본 생성
              </button>
            </div>
          )}
          {revising && (
            <div data-ui className="absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-foreground/80 px-3 py-1 text-[11px] text-background">
              고칠 노드를 눌러 담아 보세요
            </div>
          )}
        </FlowCanvas>
        {progress}
      </div>
      {dialog}
    </div>
  );
}
