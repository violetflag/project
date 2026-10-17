"use client";

import { useMemo, useRef, useState } from "react";
import { isBusy, sendChat } from "@/lib/actions";
import { flatten, LEVEL_LABEL } from "@/lib/spec-model";
import type { Project } from "@/lib/types";
import { AiPicker } from "../../AiKeyForm";
import { ArrowUp, Close } from "../../icons";

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
  const send = () => {
    if ((!text.trim() && !chips.length) || busy) return;
    const tokens = chips.map((c) => `@[${c.title}](${c.id})`).join(" ");
    sendChat(p.id, `${tokens}${tokens && text.trim() ? " " : ""}${text.trim()}`);
    setText("");
    setChips([]);
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
      <div className="rounded-lg border border-border bg-background p-2 focus-within:border-border-strong">
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
          placeholder={p.spec?.length ? "@로 항목을 집어 질문하거나 고쳐 달라고 해 보세요" : "궁금한 점이나 바꾸고 싶은 점을 적어 주세요"}
          className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-foreground-assistive" />
        <div className="flex items-center gap-1">
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => { setText((t) => (t && !t.endsWith(" ") ? t + " @" : t + "@")); setQuery(""); box.current?.focus(); }}
            aria-label="항목 멘션" className="grid h-7 w-7 place-items-center rounded-full text-sm text-foreground-muted hover:bg-surface">@</button>
          <AiPicker up />
          <button onClick={send} disabled={(!text.trim() && !chips.length) || busy} aria-label="보내기"
            className="ml-auto grid h-8 w-8 place-items-center rounded-full bg-foreground text-background disabled:bg-border-strong">
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {busy && <p className="mt-1 px-1 text-[11px] text-foreground-muted">AI가 작업하고 있어요. 끝나면 이어서 보낼 수 있어요.</p>}
    </div>
  );
}
