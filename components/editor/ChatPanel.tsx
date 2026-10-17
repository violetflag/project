"use client";

import { useEffect, useRef, useState } from "react";
import {
  addMoreQuestions, answerQuestion, editAnswer, generatePrd, isBusy, pickChoice, review, sendChat,
} from "@/lib/actions";
import { AiPicker } from "../AiKeyForm";
import type { ChatMessage, Project, Question } from "@/lib/types";
import { ArrowUp, Sparkle } from "../icons";

function QuestionCard({ p, q, answered }: { p: Project; q: Question; answered?: string[] }) {
  const [sel, setSel] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const index = p.questions.findIndex((x) => x.id === q.id) + 1;
  if (answered) {
    return <p className="text-sm text-foreground-support">Q{index}. {q.text}</p>;
  }
  // Every question allows several picks; options left out are kept as later candidates in the PRD.
  const toggle = (o: string) => setSel((s) => (s.includes(o) ? s.filter((x) => x !== o) : [...s, o]));
  const picked = custom.trim() ? [...sel, custom.trim()] : sel;
  return (
    <div className="animate-fade-up">
      <p className="mb-2 text-sm">Q{index}. {q.text} <span className="text-foreground-muted">(여러 개 선택 가능)</span></p>
      <div className="flex flex-col gap-1.5">
        {q.options.map((o) => {
          const on = sel.includes(o);
          return (
            <button key={o} onClick={() => toggle(o)}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${on ? "border-primary bg-primary-soft" : "border-border bg-background hover:border-border-strong"}`}>
              <span className={`grid h-4 w-4 place-items-center border rounded ${on ? "border-primary bg-primary text-white" : "border-border-strong"}`}>
                {on && <span className="text-[9px]">✓</span>}
              </span>
              {o}
            </button>
          );
        })}
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="직접 입력"
          className="rounded-md border border-dashed border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-foreground-assistive focus:border-primary" />
        {picked.length > 0 && (
          <button onClick={() => answerQuestion(p.id, q.id, picked)} className="rounded-md bg-primary py-2 text-sm font-medium text-white">
            ✓ 선택 완료
          </button>
        )}
      </div>
    </div>
  );
}

function Message({ p, m, onGoto }: { p: Project; m: ChatMessage; onGoto: (tab: string) => void }) {
  if (m.from === "user") {
    const qid = p.questions.find((q) => p.answers[q.id]?.join(", ") === m.text)?.id;
    return (
      <div className="flex justify-end gap-1.5">
        {qid && !p.prd && <button onClick={() => editAnswer(p.id, qid)} className="text-xs text-foreground-muted hover:text-foreground" title="답 고치기">✎</button>}
        <p className="max-w-[80%] rounded-lg bg-surface px-3 py-2 text-sm whitespace-pre-line">{m.text}</p>
      </div>
    );
  }
  if (m.thinking) {
    return (
      <p className="flex items-center gap-2 text-sm text-foreground-muted">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        {m.text}
      </p>
    );
  }
  const busy = isBusy(p);
  return (
    <div className="flex flex-col gap-2">
      {m.text && <p className={`text-sm leading-relaxed whitespace-pre-line ${m.error ? "rounded-md bg-surface px-3 py-2 text-foreground-support" : ""}`}>{m.text}</p>}
      {m.question && <QuestionCard p={p} q={m.question} answered={m.answered} />}
      {m.choices && (
        <div className="rounded-lg border border-border bg-background p-3">
          <p className="mb-2 text-sm font-medium">{m.choices.question}</p>
          {m.choices.options.map((o) => (
            <button key={o.title} disabled={!!m.choices!.picked || busy} onClick={() => pickChoice(p.id, m.id, o.title)}
              className={`mb-1.5 block w-full rounded-md border px-3 py-2 text-left ${m.choices!.picked === o.title ? "border-primary bg-primary-soft" : "border-border hover:border-border-strong disabled:opacity-50"}`}>
              <span className="block text-sm">{o.title}</span>
              <span className="block text-xs text-foreground-muted">{o.detail}</span>
            </button>
          ))}
        </div>
      )}
      {m.actions && (
        <div className="flex flex-col gap-1.5">
          {m.actions.includes("generate-prd") && !p.prd && (
            <button disabled={busy} onClick={() => generatePrd(p.id)} className="flex items-center justify-center gap-1.5 rounded-md bg-primary py-2 text-sm font-medium text-white disabled:opacity-50">
              <Sparkle className="h-3.5 w-3.5" /> 바로 PRD 만들기
            </button>
          )}
          {m.actions.includes("more-questions") && !p.prd && (
            <button disabled={busy} onClick={() => addMoreQuestions(p.id)} className="disabled:opacity-50 rounded-md border border-border py-2 text-sm hover:border-border-strong">
              + 질문 더 받고 더 정확하게 만들기
            </button>
          )}
          {m.actions.includes("goto-features") && (
            <button onClick={() => onGoto("features")} className="rounded-md border border-border px-3 py-2 text-left text-sm hover:border-border-strong">→ 기능명세서 보러 가기</button>
          )}
          {m.actions.includes("run-review") && (
            <button disabled={busy} onClick={() => { review(p.id); onGoto("review"); }} className="disabled:opacity-50 rounded-md border border-border px-3 py-2 text-left text-sm hover:border-border-strong">→ 기획서 전체 검토하기</button>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatPanel({ p, onGoto }: { p: Project; onGoto: (tab: string) => void }) {
  const [text, setText] = useState("");
  const busy = isBusy(p);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [p.chat.length]);
  const send = () => {
    if (!text.trim() || busy) return;
    sendChat(p.id, text.trim());
    setText("");
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {p.chat.map((m) => <Message key={m.id} p={p} m={m} onGoto={onGoto} />)}
        <div ref={end} />
      </div>
      <div className="m-3 rounded-lg border border-border bg-background p-2 focus-within:border-border-strong">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          placeholder="예: 리뷰 기능 추가해줘 / 회원가입과 로그인 더 구체화해줘"
          className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-foreground-assistive" />
        <div className="flex items-center gap-2">
          <AiPicker up />
          <button onClick={send} disabled={!text.trim() || busy} aria-label="보내기"
            className="ml-auto grid h-8 w-8 place-items-center rounded-full bg-foreground text-background disabled:bg-border-strong">
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
