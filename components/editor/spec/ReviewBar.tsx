"use client";

import { useState } from "react";
import { approve, approveAllPending, reject, rejectAllPending } from "@/lib/spec";
import type { SpecItem } from "@/lib/types";
import { PendingBadge } from "./ui";

// Bottom-center bar to walk through AI proposals one by one, or decide them all at once.
export function ReviewBar({ pid, pending, current, onGo }: { pid: string; pending: SpecItem[]; current: string | null; onGo: (id: string) => void }) {
  const [bulk, setBulk] = useState(false);
  if (!pending.length) return null;
  const at = Math.max(0, pending.findIndex((x) => x.id === current));
  const x = pending[at];
  const go = (i: number) => onGo(pending[(i + pending.length) % pending.length].id);
  // After deciding, move on to what is then the next proposal.
  const decide = (fn: (pid: string, id: string) => void) => {
    const nextId = pending.filter((y) => y.id !== x.id)[at % Math.max(1, pending.length - 1)]?.id;
    fn(pid, x.id);
    if (nextId) onGo(nextId);
  };
  return (
    <div className="animate-fade-up absolute inset-x-2 bottom-2 z-30 rounded-xl border border-border bg-background text-sm shadow-lg md:inset-x-auto md:bottom-4 md:left-1/2 md:w-[600px] md:-translate-x-1/2" aria-label="검토 바">
      {bulk && (
        <div className="flex items-center justify-end gap-2 border-b border-border px-3 py-2">
          <span className="mr-auto text-xs text-foreground-muted">AI 제안 {pending.length}개를 한 번에</span>
          <button onClick={() => { rejectAllPending(pid); setBulk(false); }} aria-label="전체 거절" className="rounded border border-border px-2.5 py-1 text-xs">전체 거절</button>
          <button onClick={() => { approveAllPending(pid); setBulk(false); }} aria-label="전체 승인" className="rounded bg-primary px-2.5 py-1 text-xs text-white">{pending.length}개 전체 승인</button>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => go(at - 1)} aria-label="이전 제안" className="px-1 text-foreground-muted hover:text-foreground">‹</button>
        <span className="text-xs tabular-nums" aria-label="제안 위치">{at + 1} / {pending.length}</span>
        <button onClick={() => go(at + 1)} aria-label="다음 제안" className="px-1 text-foreground-muted hover:text-foreground">›</button>
        <button onClick={() => onGo(x.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <PendingBadge x={x} /><span className="truncate">{x.title}</span>
        </button>
        <button onClick={() => decide(reject)} aria-label="거절" className="rounded border border-border px-2 py-1 text-xs">거절</button>
        <button onClick={() => decide(approve)} aria-label="승인" className="rounded bg-primary px-2 py-1 text-xs text-white">승인</button>
        <button onClick={() => setBulk((b) => !b)} aria-expanded={bulk} aria-label="일괄처리" className="text-xs text-primary whitespace-nowrap">일괄처리</button>
      </div>
    </div>
  );
}
