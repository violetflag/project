"use client";

import { useMemo, useRef, useState } from "react";
import { chatTokenEstimate, isBusy, sendChat } from "@/lib/actions";
import { useAiSettings } from "@/lib/ai";
import { ACCEPT } from "@/lib/files";
import { addMaterials } from "@/lib/materials";
import { stopAi } from "@/lib/run";
import { flatten, LEVEL_LABEL } from "@/lib/spec-model";
import type { Project } from "@/lib/types";
import { AiPicker } from "../../AiKeyForm";
import { ArrowUp, Close, Paperclip } from "../../icons";

interface Target { id: string; title: string; group: string; code?: string }

function targetsOf(p: Project): Target[] {
  const out: Target[] = [];
  if (p.prd) {
    out.push({ id: "prd", title: "PRD 전체", group: "PRD" });
    p.prd.forEach((s) => out.push({ id: `prd:${s.id}`, title: s.title, group: "PRD" }));
  }
  flatten(p.spec).forEach((x) => out.push({ id: x.id, title: x.title, code: x.code, group: LEVEL_LABEL[x.level] }));
  return out;
}

const GROUPS = ["PRD", "요구사항", "기능", "상세 기능"];

// Text box with an "@" picker that attaches PRD sections and spec items as chips.
export function Composer({ p }: { p: Project }) {
  const [text, setText] = useState("");
  const [chips, setChips] = useState<Target[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Files attached to the next message; they join the project's 자료 as soon as they are picked.
  const [files, setFiles] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState("");
  const busy = isBusy(p);
  const all = useMemo(() => targetsOf(p), [p]);
  const shown = query === null ? [] : all.filter((t) => !chips.some((c) => c.id === t.id))
    .filter((t) => !query || t.title.toLowerCase().includes(query.toLowerCase()) || t.code?.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 40);

  // The "@word" right before the caret, if any.
  const atQuery = (value: string, caret: number) => {
    const m = value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/);
    return m ? m[1] : null;
  };
  const onChange = (value: string) => {
    setText(value);
    const q = atQuery(value, box.current?.selectionStart ?? value.length);
    setQuery(q);
    setActive(0);
  };
  const pick = (t: Target) => {
    const caret = box.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([^\s@]*)$/, "");
    setText(before + text.slice(caret));
    setChips((c) => [...c, t]);
    setQuery(null);
    box.current?.focus();
  };
  const attach = async (list: File[]) => {
    if (!list.length) return;
    setReading(true);
    const r = await addMaterials(p.id, list);
    setReading(false);
    setFiles((f) => [...f, ...r.added]);
    setNote(r.note);
  };
  const canSend = (!!text.trim() || chips.length > 0 || files.length > 0) && !busy && !reading;
  const send = () => {
    if (!canSend) return;
    const tokens = chips.map((c) => `@[${c.title}](${c.id})`).join(" ");
    const body = `${tokens}${tokens && text.trim() ? " " : ""}${text.trim()}`;
    const clip = files.length ? `📎 ${files.join(", ")}\n` : "";
    sendChat(p.id, `${clip}${body || "첨부한 자료를 읽고 기획에 참고할 점을 알려 주세요."}`);
    setText("");
    setChips([]);
    setFiles([]);
    setNote("");
    setQuery(null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (query !== null && shown.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % shown.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + shown.length) % shown.length); return; }
      if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); pick(shown[active]); return; }
    }
    if (e.key === "Escape") setQuery(null);
    if (e.key === "Backspace" && !text && chips.length) setChips((c) => c.slice(0, -1));
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  return (
    <div className="relative m-3 mt-1">
      {query !== null && (
        <div role="listbox" aria-label="멘션할 항목"
          className="animate-fade-up absolute inset-x-0 bottom-full z-30 mb-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-background p-1 shadow-lg">
          {!all.length && <p className="px-3 py-3 text-xs text-foreground-muted">PRD나 기능명세서가 생기면 @로 집어서 물어볼 수 있어요.</p>}
          {all.length > 0 && !shown.length && <p className="px-3 py-3 text-xs text-foreground-muted">맞는 항목이 없어요.</p>}
          {GROUPS.map((g) => {
            const list = shown.filter((t) => t.group === g);
            if (!list.length) return null;
            return (
              <div key={g}>
                <p className="px-2.5 pt-2 pb-1 text-[10px] font-medium text-foreground-muted">{g}</p>
                {list.map((t) => {
                  const i = shown.indexOf(t);
                  return (
                    <button key={t.id} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(t); }} onMouseEnter={() => setActive(i)}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${i === active ? "bg-surface" : ""}`}>
                      {t.code && <span className="shrink-0 font-mono text-[10px] text-foreground-muted">{t.code}</span>}
                      <span className="truncate">{t.title}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      <div className="rounded-lg border border-border bg-background p-2 focus-within:border-border-strong"
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void attach(Array.from(e.dataTransfer.files)); }}>
        {(files.length > 0 || reading) && (
          <div className="mb-1 flex flex-wrap gap-1 px-1" aria-label="첨부한 파일">
            {files.map((f) => (
              <span key={f} className="inline-flex max-w-full items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-xs">
                <Paperclip className="h-3 w-3 shrink-0" /><span className="truncate">{f}</span>
                <button onClick={() => setFiles((x) => x.filter((y) => y !== f))} aria-label={`${f} 첨부 빼기`}><Close className="h-3 w-3" /></button>
              </span>
            ))}
            {reading && <span className="text-xs text-foreground-muted">파일을 읽는 중이에요…</span>}
          </div>
        )}
        {chips.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1 px-1">
            {chips.map((c) => (
              <span key={c.id} className="inline-flex max-w-full items-center gap-1 rounded bg-primary-soft px-1.5 py-0.5 text-xs text-primary">
                <span className="truncate">@{c.title}</span>
                <button onClick={() => setChips((x) => x.filter((y) => y.id !== c.id))} aria-label={`${c.title} 멘션 빼기`}><Close className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
        )}
        <textarea ref={box} value={text} rows={2} aria-label="채팅 입력"
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onBlur={() => setTimeout(() => setQuery(null), 150)}
          placeholder={p.spec?.length ? "기능명세서, 유저플로우, 와이어프레임 무엇이든 고쳐 달라고 해 보세요 (@로 항목 집기)" : "궁금한 점이나 바꾸고 싶은 점을 적어 주세요"}
          className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-foreground-assistive" />
        <div className="flex items-center gap-1">
          <button onClick={() => fileInput.current?.click()} aria-label="파일 첨부" title="파일 첨부 (자료에 함께 저장돼요)"
            className="grid h-7 w-7 place-items-center rounded-full text-foreground-muted hover:bg-surface"><Paperclip className="h-3.5 w-3.5" /></button>
          <input ref={fileInput} type="file" multiple hidden accept={ACCEPT} aria-label="첨부 파일"
            onChange={(e) => { void attach(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => { setText((t) => (t && !t.endsWith(" ") ? t + " @" : t + "@")); setQuery(""); box.current?.focus(); }}
            aria-label="항목 멘션" className="grid h-7 w-7 place-items-center rounded-full text-sm text-foreground-muted hover:bg-surface">@</button>
          <AiPicker up />
          <ContextMeter p={p} />
          {busy ? (
            <button onClick={() => stopAi(p.id)} aria-label="중단" title="AI 작업 멈추기"
              className="ml-auto grid h-8 w-8 place-items-center rounded-full bg-foreground text-background">
              <span className="h-2.5 w-2.5 rounded-[2px] bg-background" />
            </button>
          ) : (
            <button onClick={send} disabled={!canSend} aria-label="보내기"
              className="ml-auto grid h-8 w-8 place-items-center rounded-full bg-foreground text-background disabled:bg-border-strong">
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {note && <p className="mt-1 px-1 text-[11px] text-amber-700">{note}</p>}
      {busy && <p className="mt-1 px-1 text-[11px] text-foreground-muted">AI가 작업하고 있어요. ■ 버튼으로 멈출 수 있어요.</p>}
    </div>
  );
}

const k = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${n < 10_000 ? +(n / 1000).toFixed(1) : Math.round(n / 1000)}k`);

// Estimated input tokens of the next chat request against the context size in AI settings.
// Haiku 5.5 bills a higher rate once a prompt passes 100K tokens, so that line is marked.
function ContextMeter({ p }: { p: Project }) {
  const { model } = useAiSettings();
  const { used, limit } = useMemo(() => chatTokenEstimate(p), [p]);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const pricey = model === "claude-haiku-5-5" && used > 100_000;
  const tone = pct >= 90 ? "text-red-600" : pricey ? "text-amber-600" : "text-foreground-muted";
  return (
    <span aria-label={`컨텍스트 ${k(used)} / ${k(limit)} 토큰`}
      title={`다음 채팅에 들어갈 입력 약 ${used.toLocaleString()} 토큰 / 한도 ${limit.toLocaleString()} 토큰 (${pct}%)${pricey ? "\nHaiku 5.5는 입력이 10만 토큰을 넘으면 단가가 5배예요" : ""}\n문서는 항상 다 넣고, 한도를 넘으면 오래된 대화부터 줄여요.`}
      className={`flex items-center gap-1 px-1 text-[11px] tabular-nums whitespace-nowrap ${tone}`}>
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 -rotate-90" aria-hidden>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={`${(pct / 100) * 37.7} 37.7`} />
      </svg>
      {k(used)} / {k(limit)}
    </span>
  );
}
