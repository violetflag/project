"use client";

import { useState } from "react";
import { applyFlowPlan, planFlowRevision, type FlowPlan } from "@/lib/flow";
import type { Flow } from "@/lib/types";
import { Close } from "@/components/icons";

// "수정본 생성": describe the change, optionally pick nodes on the canvas, review the plan, apply.
export function RevisionPanel({ pid, flow, picked, onUnpick, onClose }: {
  pid: string; flow: Flow; picked: string[]; onUnpick: (id: string) => void; onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<FlowPlan | null>(null);
  const [on, setOn] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);

  const makePlan = async () => {
    setLoading(true);
    try {
      const pl = await planFlowRevision(pid, text.trim(), picked);
      setPlan(pl);
      setOn(pl.ops.map((_, i) => i));
    } finally {
      setLoading(false);
    }
  };
  const apply = (asNew: boolean) => {
    if (!plan) return;
    applyFlowPlan(pid, plan, asNew, on);
    onClose();
  };

  return (
    <div data-ui role="dialog" aria-label="수정본 만들기"
      className="absolute right-2 bottom-2 left-2 z-30 flex max-h-[75%] flex-col rounded-xl border border-border bg-background shadow-xl md:left-auto md:w-[380px]">
      <div className="flex items-center border-b border-border px-4 py-2.5">
        <p className="text-sm font-medium">{plan ? "변경 계획" : "어떻게 바꿀까요?"}</p>
        <button onClick={onClose} aria-label="수정본 패널 닫기" className="ml-auto rounded p-1 text-foreground-muted hover:bg-surface"><Close className="h-4 w-4" /></button>
      </div>
      {!plan ? (
        <div className="min-h-0 overflow-y-auto px-4 py-3">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} aria-label="바꿀 내용"
            placeholder={"예) 모임 가입 신청 뒤에 운영자 승인을 기다리는 화면을 넣어 주세요\n예) 결제 실패하면 다시 시도할 수 있게 분기를 추가해 주세요"}
            className="w-full resize-none rounded-md border border-border p-2.5 text-sm leading-relaxed outline-none focus:border-primary" />
          <p className="mt-3 text-xs font-medium">주로 고칠 곳 <span className="font-normal text-foreground-muted">(선택)</span></p>
          <p className="mt-0.5 text-[11px] text-foreground-muted">캔버스에서 노드를 누르면 여기에 담겨요.</p>
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label="고칠 노드">
            {picked.length === 0 && <span className="text-[11px] text-foreground-assistive">고른 노드 없음</span>}
            {picked.map((id) => {
              const n = flow.nodes.find((x) => x.id === id);
              return n && (
                <button key={id} onClick={() => onUnpick(id)} aria-label={`고칠 노드 빼기: ${n.label}`}
                  className="flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-1 text-[11px] text-primary">
                  {n.label}<Close className="h-3 w-3" />
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="min-h-0 overflow-y-auto px-4 py-3">
          <p className="text-sm leading-relaxed text-foreground-support">{plan.summary}</p>
          {plan.ops.length === 0 && <p className="mt-3 text-xs text-foreground-muted">바꿀 것이 없어요. 요청을 조금 더 구체적으로 적어 보세요.</p>}
          <ul className="mt-3 space-y-1" aria-label="변경 목록">
            {plan.ops.map((o, i) => (
              <li key={i}>
                <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-xs hover:bg-surface">
                  <input type="checkbox" checked={on.includes(i)} className="mt-0.5 accent-[var(--color-primary)]"
                    onChange={(e) => setOn(e.target.checked ? [...on, i].sort((a, b) => a - b) : on.filter((x) => x !== i))} />
                  <span>{o.line}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-1.5 border-t border-border px-4 py-2.5 text-xs">
        <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 hover:bg-surface">닫기</button>
        {!plan ? (
          <button onClick={makePlan} disabled={!text.trim() || loading} aria-label="변경 계획 보기"
            className="rounded-md bg-primary px-3 py-1.5 font-medium text-white disabled:opacity-40">{loading ? "계획 세우는 중…" : "변경 계획 보기"}</button>
        ) : (
          <>
            <button onClick={() => apply(true)} disabled={!on.length} aria-label="새 버전으로 만들기"
              className="rounded-md border border-primary px-3 py-1.5 text-primary disabled:opacity-40">새 버전으로 만들기</button>
            <button onClick={() => apply(false)} disabled={!on.length} aria-label="적용하기"
              className="rounded-md bg-primary px-3 py-1.5 font-medium text-white disabled:opacity-40">적용하기</button>
          </>
        )}
      </div>
    </div>
  );
}
