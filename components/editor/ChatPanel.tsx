"use client";

import { useEffect, useRef } from "react";
import { addMoreQuestions, checkPrdChanges, createPrd, dismissPrdChanges, editAnswer, isBusy, review } from "@/lib/actions";
import { approveAllPending, completeSpec, rejectAllPending } from "@/lib/spec";
import { pendingItems } from "@/lib/spec-model";
import { generateFlow, setChatFlowPlan } from "@/lib/flow";
import { generateAllWires } from "@/lib/wire";
import type { ChatMessage, Project } from "@/lib/types";
import { Sparkle } from "../icons";
import { ChoiceCard, QuestionCard, RichText, ThinkingBubble } from "./assist/cards";
import { Composer } from "./assist/Composer";

const btn = "rounded-md border border-border px-3 py-2 text-left text-sm hover:border-border-strong disabled:opacity-50";

function Actions({ p, m, onGoto }: { p: Project; m: ChatMessage; onGoto: (tab: string) => void }) {
  const busy = isBusy(p);
  const a = m.actions ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      {a.includes("generate-prd") && !p.prd && (
        <button disabled={busy} onClick={() => createPrd(p.id)} aria-label="PRD 만들기"
          className="flex items-center justify-center gap-1.5 rounded-md bg-primary py-2 text-sm font-medium text-white disabled:opacity-50">
          <Sparkle className="h-3.5 w-3.5" /> PRD 만들기
        </button>
      )}
      {a.includes("more-questions") && !p.prd && (
        <button disabled={busy} onClick={() => addMoreQuestions(p.id)} aria-label="질문 더 받기" className={`${btn} text-center`}>
          + 질문 더 받고 더 정확하게 만들기
        </button>
      )}
      {a.includes("complete-spec") && (
        <button disabled={busy} onClick={() => { completeSpec(p.id); onGoto("features"); }} aria-label="기능명세서 완성하기"
          className="flex items-center justify-center gap-1.5 rounded-md bg-primary py-2 text-sm font-medium text-white disabled:opacity-50">
          <Sparkle className="h-3.5 w-3.5" /> 기능명세서 완성하기
        </button>
      )}
      {a.includes("goto-features") && (
        <button onClick={() => onGoto("features")} className={btn}>→ 기능명세서에서 확인하기</button>
      )}
      {a.includes("make-flow") && (
        <button disabled={busy || !p.spec?.length} onClick={() => { generateFlow(p.id); onGoto("flow"); }} aria-label="다음 단계: 유저플로우 만들기"
          className="flex items-center justify-center gap-1.5 rounded-md bg-primary py-2 text-sm font-medium text-white disabled:opacity-50">
          <Sparkle className="h-3.5 w-3.5" /> 유저플로우 만들기
        </button>
      )}
      {a.includes("make-wire") && (
        <button disabled={busy || !p.flows.length} onClick={() => { generateAllWires(p.id); onGoto("wire"); }} aria-label="다음 단계: 와이어프레임 전체 만들기"
          className="flex items-center justify-center gap-1.5 rounded-md bg-primary py-2 text-sm font-medium text-white disabled:opacity-50">
          <Sparkle className="h-3.5 w-3.5" /> 와이어프레임 전체 만들기
        </button>
      )}
      {a.includes("goto-flow") && (
        <button onClick={() => onGoto("flow")} className={btn}>→ 유저플로우에서 확인하기</button>
      )}
      {a.includes("goto-wire") && (
        <button onClick={() => onGoto("wire")} className={btn}>→ 와이어프레임에서 확인하기</button>
      )}
      {a.includes("run-review") && (
        <button disabled={busy || !p.spec?.length} onClick={() => { review(p.id); onGoto("review"); }} className={btn}>→ 기획서 전체 검토하기</button>
      )}
    </div>
  );
}

function FlowPlanCard({ p, m, onGoto }: { p: Project; m: ChatMessage; onGoto: (tab: string) => void }) {
  const plan = m.flowPlan!;
  const busy = isBusy(p);
  const run = (done: "applied" | "copied" | "dismissed") => {
    setChatFlowPlan(p.id, m.id, done);
    if (done !== "dismissed") onGoto("flow");
  };
  return (
    <div className="rounded-lg border border-border px-3 py-2.5" aria-label="유저플로우 변경 계획">
      <ul className="space-y-1 text-xs text-foreground-support">
        {plan.ops.map((o, i) => <li key={i}>• {o.line}</li>)}
      </ul>
      {plan.done ? (
        <p className="mt-2 text-xs text-foreground-muted">
          {plan.done === "applied" ? "유저플로우에 적용했어요" : plan.done === "copied" ? "수정본으로 만들었어요" : "적용하지 않았어요"}
        </p>
      ) : (
        <div className="mt-2.5 flex flex-wrap gap-1.5 text-xs">
          <button disabled={busy} onClick={() => run("applied")} aria-label="변경 계획 적용" className="rounded bg-primary px-2.5 py-1 text-white disabled:opacity-50">적용</button>
          <button disabled={busy} onClick={() => run("copied")} aria-label="변경 계획을 새 버전으로" className="rounded border border-border px-2.5 py-1 disabled:opacity-50">새 버전으로</button>
          <button onClick={() => run("dismissed")} aria-label="변경 계획 취소" className="rounded border border-border px-2.5 py-1">취소</button>
        </div>
      )}
    </div>
  );
}

function Message({ p, m, onGoto }: { p: Project; m: ChatMessage; onGoto: (tab: string) => void }) {
  if (m.from === "user") {
    const qid = !p.prd ? p.questions.find((q) => p.answers[q.id]?.join(", ") === m.text)?.id : undefined;
    return (
      <div className="flex justify-end gap-1.5">
        {qid && <button onClick={() => editAnswer(p.id, qid)} aria-label="답 고치기" className="text-xs text-foreground-muted hover:text-foreground" title="답 고치기">✎</button>}
        <RichText text={m.text} className="max-w-[85%] rounded-lg bg-surface px-3 py-2 text-sm break-words" />
      </div>
    );
  }
  if (m.thinking) return <ThinkingBubble m={m} />;
  return (
    <div className="flex flex-col gap-2">
      {m.steps && m.steps.length > 0 && (
        <details className="text-xs text-foreground-muted">
          <summary className="cursor-pointer">생각함 ›</summary>
          <ul className="mt-1 space-y-0.5">{m.steps.map((s, i) => <li key={i}>✓ {s}</li>)}</ul>
        </details>
      )}
      {m.text && <RichText text={m.text} className={`text-sm leading-relaxed break-words ${m.error ? "rounded-md bg-surface px-3 py-2 text-foreground-support" : ""}`} />}
      {m.question && <QuestionCard p={p} q={m.question} answered={m.answered} />}
      {m.choices && <ChoiceCard p={p} m={m} />}
      {m.flowPlan && <FlowPlanCard p={p} m={m} onGoto={onGoto} />}
      {m.actions && <Actions p={p} m={m} onGoto={onGoto} />}
    </div>
  );
}

function PendingBar({ p, onGoto }: { p: Project; onGoto: (tab: string) => void }) {
  const n = pendingItems(p.spec).length;
  if (!n) return null;
  const busy = isBusy(p);
  return (
    <div className="mx-3 flex flex-wrap items-center gap-1.5 rounded-lg border border-primary/30 bg-primary-soft px-3 py-2 text-xs">
      <span className="mr-auto text-primary">승인 대기 제안 {n}개</span>
      <button onClick={() => onGoto("features")} className="rounded border border-border bg-background px-2 py-1">확인하기</button>
      <button disabled={busy} onClick={() => rejectAllPending(p.id)} aria-label="제안 모두 거절" className="rounded border border-border bg-background px-2 py-1 disabled:opacity-50">모두 거절</button>
      <button disabled={busy} onClick={() => approveAllPending(p.id)} aria-label="제안 모두 승인" className="rounded bg-primary px-2 py-1 text-white disabled:opacity-50">모두 승인</button>
    </div>
  );
}

export function PrdChangeBar({ p }: { p: Project }) {
  const n = p.stale?.prd?.length ?? 0;
  if (!n) return null;
  const busy = isBusy(p);
  return (
    <div className="mx-3 mb-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <span className="mr-auto">PRD를 {n}곳 고쳤어요. 기능명세서·유저플로우·와이어프레임에도 반영할 게 있는지 AI가 확인할까요?</span>
      <button onClick={() => dismissPrdChanges(p.id)} aria-label="PRD 변경 확인 안 함" className="rounded border border-amber-300 bg-white px-2 py-1">괜찮아요</button>
      <button disabled={busy} onClick={() => checkPrdChanges(p.id)} aria-label="PRD 변경 반영 확인" className="rounded bg-primary px-2 py-1 text-white disabled:opacity-50">확인하기</button>
    </div>
  );
}

export function ChatPanel({ p, onGoto }: { p: Project; onGoto: (tab: string) => void }) {
  const end = useRef<HTMLDivElement>(null);
  const last = p.chat.at(-1);
  const steps = last?.steps?.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [p.chat.length, steps]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {p.chat.map((m) => <Message key={m.id} p={p} m={m} onGoto={onGoto} />)}
        <div ref={end} />
      </div>
      <PrdChangeBar p={p} />
      <PendingBar p={p} onGoto={onGoto} />
      <Composer p={p} />
    </div>
  );
}
