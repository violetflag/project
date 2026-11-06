"use client";

import { useState } from "react";
import { answerQuestion, applyChoice, isBusy, MENTION } from "@/lib/actions";
import type { ChatMessage, Project, Question } from "@/lib/types";

// Renders @[title](id) tokens as small chips.
export function RichText({ text, className = "" }: { text: string; className?: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push(<span key={m.index} className="mx-0.5 inline-block rounded bg-primary-soft px-1 text-primary">@{m[1]}</span>);
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <p className={`whitespace-pre-line ${className}`}>{parts}</p>;
}

export function QuestionCard({ p, q, answered }: { p: Project; q: Question; answered?: string[] }) {
  const [sel, setSel] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const index = p.questions.findIndex((x) => x.id === q.id) + 1;
  if (answered) return <p className="text-sm text-foreground-support">Q{index}. {q.text}</p>;
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
            <button key={o} onClick={() => toggle(o)} aria-pressed={on}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${on ? "border-primary bg-primary-soft" : "border-border bg-background hover:border-border-strong"}`}>
              <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${on ? "border-primary bg-primary text-white" : "border-border-strong"}`}>
                {on && <span className="text-[9px]">✓</span>}
              </span>
              {o}
            </button>
          );
        })}
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="직접 입력" aria-label="직접 입력"
          className="rounded-md border border-dashed border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-foreground-assistive focus:border-primary" />
        {picked.length > 0 && (
          <button onClick={() => answerQuestion(p.id, q.id, picked)} aria-label="선택 완료" className="rounded-md bg-primary py-2 text-sm font-medium text-white">
            ✓ 선택 완료
          </button>
        )}
      </div>
    </div>
  );
}

const CUSTOM = "__custom__";

// Ways to resolve a review finding: pick one (or type a direction), preview it, then apply.
export function ChoiceCard({ p, m }: { p: Project; m: ChatMessage }) {
  const c = m.choices!;
  const [sel, setSel] = useState<string>("");
  const [custom, setCustom] = useState("");
  const busy = isBusy(p);
  const done = !!c.picked;
  const chosen = sel === CUSTOM ? custom.trim() : sel;
  const preview = sel === CUSTOM
    ? (custom.trim() ? `'${custom.trim()}' 방향으로 관련 기능과 상세 기능을 고쳐요.` : "")
    : c.options.find((o) => o.title === sel)?.detail;
  return (
    <div className="rounded-lg border border-border bg-background p-3" role="group" aria-label="해결 방법 선택">
      <p className="mb-2 text-sm font-medium">{c.question}</p>
      <div className="space-y-1.5">
        {c.options.map((o) => {
          const on = done ? c.picked === o.title : sel === o.title;
          return (
            <label key={o.title} className={`flex cursor-pointer gap-2 rounded-md border px-3 py-2 ${on ? "border-primary bg-primary-soft" : "border-border hover:border-border-strong"} ${done && !on ? "opacity-50" : ""}`}>
              <input type="radio" name={`ch_${m.id}`} checked={on} disabled={done} onChange={() => setSel(o.title)} className="mt-1 accent-[var(--color-primary)]" aria-label={o.title} />
              <span>
                <span className="block text-sm">{o.title}</span>
                <span className="block text-xs leading-relaxed text-foreground-muted">{o.detail}</span>
              </span>
            </label>
          );
        })}
        {!done && (
          <label className={`flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-2 ${sel === CUSTOM ? "border-primary" : "border-border"}`}>
            <input type="radio" name={`ch_${m.id}`} checked={sel === CUSTOM} onChange={() => setSel(CUSTOM)} className="accent-[var(--color-primary)]" aria-label="직접 입력 선택" />
            <input value={custom} onChange={(e) => { setCustom(e.target.value); setSel(CUSTOM); }} placeholder="직접 입력" aria-label="해결 방향 직접 입력"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-foreground-assistive" />
          </label>
        )}
        {done && !c.options.some((o) => o.title === c.picked) && (
          <p className="rounded-md border border-primary bg-primary-soft px-3 py-2 text-sm">{c.picked}</p>
        )}
      </div>
      {!done && preview && <p className="mt-2 rounded-md bg-surface px-3 py-2 text-xs leading-relaxed text-foreground-support">미리보기 · {preview}</p>}
      {done ? (
        <p className="mt-2 text-xs text-foreground-muted">선택함 · {c.picked}</p>
      ) : (
        <div className="mt-2 flex gap-1.5">
          <button disabled={busy} onClick={() => applyChoice(p.id, m.id)} aria-label="모두 AI가 알아서 진행"
            className="flex-1 rounded-md border border-border px-2 py-2 text-xs hover:border-border-strong disabled:opacity-50">모두 AI가 알아서 진행</button>
          <button disabled={busy || !chosen} onClick={() => applyChoice(p.id, m.id, chosen)} aria-label="해결 방법 완료"
            className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-white disabled:opacity-40">완료</button>
        </div>
      )}
    </div>
  );
}

// The AI's work in progress: finished steps get a check, the current one a spinner.
export function ThinkingBubble({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(true);
  const steps = m.steps ?? [];
  return (
    <div className="text-sm" aria-live="polite">
      {steps.length > 0 && (
        <button onClick={() => setOpen((o) => !o)} className="mb-1 text-xs text-foreground-muted hover:text-foreground">
          생각함 {open ? "⌄" : "›"}
        </button>
      )}
      {open && (
        <ul className="space-y-1">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-foreground-support">
              <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-primary text-[8px] text-white">✓</span>{s}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 flex items-center gap-2 text-foreground-muted">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        {m.text}
      </p>
    </div>
  );
}
