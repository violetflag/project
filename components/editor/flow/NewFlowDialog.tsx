"use client";

import { useState } from "react";
import { DEFAULT_FLOW, generateFlow, type FlowOptions } from "@/lib/flow";
import type { Project } from "@/lib/types";
import { Sparkle } from "@/components/icons";

const SCOPES: [FlowOptions["scope"], string, string][] = [
  ["all", "전체 흐름", "가입부터 마이페이지까지 서비스 전체"],
  ["core", "핵심 여정만", "목적을 이루는 가장 중요한 길 하나"],
  ["role", "특정 역할만", "한 역할이 보는 화면만"],
];
const DETAILS: [FlowOptions["detail"], string][] = [["simple", "간단히"], ["normal", "보통"], ["detailed", "자세히"]];

// Options asked before a new user flow is drawn: 범위, 디테일, 추가 요청.
export function NewFlowDialog({ p, onClose }: { p: Project; onClose: () => void }) {
  const roles = p.prdProps?.roles?.filter(Boolean) ?? [];
  const [o, setO] = useState<FlowOptions>({ ...DEFAULT_FLOW, role: roles[0] ?? "" });
  const set = (x: Partial<FlowOptions>) => setO((v) => ({ ...v, ...x }));
  const ok = o.scope !== "role" || !!o.role?.trim();
  const start = () => {
    if (!ok) return;
    void generateFlow(p.id, { ...o, role: o.role?.trim(), extra: o.extra?.trim() });
    onClose();
  };
  const pill = (on: boolean) => `rounded-md border px-3 py-2 text-left text-sm ${on ? "border-primary bg-primary/5 font-medium" : "border-border hover:bg-surface"}`;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <div role="dialog" aria-label="새 유저플로우" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        className="w-full max-w-[440px] rounded-xl border border-border bg-background p-5 shadow-xl">
        <p className="font-medium">새 유저플로우</p>
        <p className="mt-1 text-xs text-foreground-support">기능명세서를 읽고 그려요. 어떤 흐름을 얼마나 자세히 그릴지 골라 주세요.</p>

        <p className="mt-4 mb-1.5 text-xs font-medium text-foreground-muted">범위</p>
        <div className="grid gap-1.5" role="radiogroup" aria-label="범위">
          {SCOPES.map(([k, label, hint]) => (
            <button key={k} type="button" role="radio" aria-checked={o.scope === k} onClick={() => set({ scope: k })} className={pill(o.scope === k)}>
              {label}<span className="ml-2 text-xs font-normal text-foreground-muted">{hint}</span>
            </button>
          ))}
        </div>
        {o.scope === "role" && (
          <div className="mt-2">
            <input value={o.role ?? ""} onChange={(e) => set({ role: e.target.value })} list="flow-roles" placeholder="역할 이름 (예: 관리자)" aria-label="역할 이름"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary" />
            <datalist id="flow-roles">{roles.map((r) => <option key={r} value={r} />)}</datalist>
            {!!roles.length && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {roles.map((r) => (
                  <button key={r} type="button" onClick={() => set({ role: r })}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${o.role === r ? "border-primary text-primary" : "border-border text-foreground-support"}`}>{r}</button>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="mt-4 mb-1.5 text-xs font-medium text-foreground-muted">디테일</p>
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="디테일">
          {DETAILS.map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={o.detail === k} onClick={() => set({ detail: k })} className={`${pill(o.detail === k)} text-center`}>{label}</button>
          ))}
        </div>

        <p className="mt-4 mb-1.5 text-xs font-medium text-foreground-muted">추가 요청 <span className="font-normal">(선택)</span></p>
        <textarea value={o.extra ?? ""} onChange={(e) => set({ extra: e.target.value })} rows={2} aria-label="추가 요청"
          placeholder="예: 결제 실패와 환불 흐름을 꼭 넣어 주세요"
          className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary" />

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm text-foreground-support hover:bg-surface">취소</button>
          <button type="button" onClick={start} disabled={!ok} aria-label="유저플로우 그리기"
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
            <Sparkle className="h-3.5 w-3.5" />그리기
          </button>
        </div>
      </div>
    </div>
  );
}
