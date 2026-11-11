"use client";

import { useState } from "react";
import { isBusy, SYNC_NAME, syncDocs, type SyncDoc } from "@/lib/actions";
import type { Project } from "@/lib/types";

export const SyncIcon = ({ className = "h-3.5 w-3.5" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M20 11a8 8 0 0 0-14.9-3.5L3 10" />
    <path d="M3 4v6h6" />
    <path d="M4 13a8 8 0 0 0 14.9 3.5L21 14" />
    <path d="M21 20v-6h-6" />
  </svg>
);

export const filledDocs = (p: Project): Record<SyncDoc, boolean> => ({
  prd: !!p.prd,
  features: !!p.spec?.length,
  flow: p.flows.length > 0,
  wire: p.wires.length > 0,
});

const BASE: SyncDoc[] = ["prd", "features", "flow", "wire"];
// Wireframes follow the flow, so they are never a target.
const TARGET: SyncDoc[] = ["prd", "features", "flow"];

export function SyncDialog({ p, onClose }: { p: Project; onClose: () => void }) {
  const filled = filledDocs(p);
  const firstOther = (base: SyncDoc) => TARGET.find((t) => t !== base && filled[t]) ?? TARGET.find((t) => t !== base) ?? "features";
  const [base, setBase] = useState<SyncDoc>(filled.prd ? "prd" : BASE.find((b) => filled[b]) ?? "prd");
  const [target, setTarget] = useState<SyncDoc>(() => firstOther(base));
  const busy = isBusy(p);
  const canStart = !busy && base !== target && filled[base] && filled[target];

  const pickBase = (b: SyncDoc) => {
    setBase(b);
    if (target === b || !filled[target]) setTarget(firstOther(b));
  };
  const start = () => {
    if (!canStart) return;
    void syncDocs(p.id, base, target);
    window.dispatchEvent(new CustomEvent("planspace:goto", { detail: target }));
    onClose();
  };

  const row = (on: boolean, off: boolean) =>
    `flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ${on ? "bg-border font-medium text-foreground" : "text-foreground-support hover:bg-surface"} ${off ? "cursor-not-allowed opacity-40" : ""}`;
  const dot = (on: boolean) => <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full border ${on ? "border-primary bg-primary" : "border-border-strong"}`} />;

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden />
      <div role="dialog" aria-label="문서 동기화" className="absolute right-0 top-full z-40 mt-2 w-[min(92vw,360px)] rounded-xl border border-border bg-background p-4 shadow-xl">
        <p className="text-sm text-foreground-support">기준 문서에 맞춰 고칠 문서를 동기화해요.</p>
        <div className="mt-3 flex items-stretch gap-2">
          <div className="flex-1 rounded-lg bg-surface p-2">
            <p className="px-2 pb-1 text-xs text-foreground-muted">기준 문서</p>
            {BASE.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={base === k} aria-label={`기준 ${SYNC_NAME[k]}`} disabled={!filled[k]}
                onClick={() => pickBase(k)} className={row(base === k, !filled[k])}>
                {dot(base === k)}{SYNC_NAME[k]}
              </button>
            ))}
          </div>
          <div className="flex items-center text-foreground-muted" aria-hidden>→</div>
          <div className="flex-1 rounded-lg bg-surface p-2">
            <p className="px-2 pb-1 text-xs text-foreground-muted">고칠 문서</p>
            {TARGET.map((k) => {
              const off = k === base || !filled[k];
              return (
                <button key={k} type="button" role="radio" aria-checked={target === k} aria-label={`고칠 ${SYNC_NAME[k]}`} disabled={off}
                  onClick={() => setTarget(k)} className={row(target === k, off)}>
                  {dot(target === k)}{SYNC_NAME[k]}
                </button>
              );
            })}
          </div>
        </div>
        <p className="mt-3 rounded-lg bg-surface px-3 py-2 text-xs leading-relaxed text-foreground-muted">
          문서 전체를 읽고 비교하기 때문에 일반 메시지보다 크레딧을 더 사용할 수 있어요. 고친 내용은 채팅에 남아요.
        </p>
        <button type="button" onClick={start} disabled={!canStart}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-medium text-white disabled:opacity-40">
          <SyncIcon />동기화 시작
        </button>
      </div>
    </>
  );
}
