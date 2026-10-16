"use client";

import { useRef, useState } from "react";
import { topicSuggestions } from "@/lib/mock";
import { ArrowUp, Close, Paperclip, Sparkle } from "./icons";

type Mode = "ask" | "files";
const MAX = 1000;

const hints: Record<Mode, { placeholder: string; tip: string; caption: string }> = {
  ask: {
    placeholder: "새로 시작할 프로젝트 아이디어나 정리하고 싶은 내용을 적어주세요.",
    tip: "아이디어가 있을 때",
    caption: "짧게 적어주시면 AI가 질문을 이어가며 첫 기획안을 만들어 드려요.",
  },
  files: {
    placeholder: "올린 자료에 대한 설명이나 원하는 결과를 적어주세요.",
    tip: "자료가 있을 때",
    caption: "자료를 올리면 핵심 내용을 읽어 하나의 기획 문서로 정리해 드려요.",
  },
};

function Chip({ active, onClick, onClear, children }: {
  active: boolean; onClick: () => void; onClear?: () => void; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors ${
        active ? "border-primary bg-primary-soft font-medium text-primary" : "border-border bg-background text-foreground-support hover:border-border-strong"
      }`}>
      {children}
      {active && onClear && (
        <span onClick={(e) => { e.stopPropagation(); onClear(); }} className="ml-0.5 opacity-70 hover:opacity-100">
          <Close className="h-3 w-3" />
        </span>
      )}
    </button>
  );
}

export function PromptBox() {
  const [mode, setMode] = useState<Mode>("ask");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [topicsOpen, setTopicsOpen] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const hint = hints[mode];
  const canSend = text.trim().length > 0 || (mode === "files" && files.length > 0);

  const submit = () => {
    if (!canSend) return;
    // No backend: show what would be sent instead of calling an API.
    setSent(text.trim() || `${files.length}개 자료`);
    setText("");
    setFiles([]);
  };

  return (
    <div className="w-full max-w-[720px]">
      <div className="rounded-xl border border-border bg-background p-2 shadow-sm focus-within:border-border-strong">
        {mode === "files" && (
          <div
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); setFiles([...files, ...Array.from(e.dataTransfer.files)].slice(0, 10)); }}
            className="animate-fade-up mb-1 cursor-pointer rounded-lg bg-surface px-4 py-5 text-center hover:bg-background-canvas"
          >
            <Paperclip className="mx-auto h-4 w-4 text-foreground-muted" />
            <p className="mt-2 text-xs text-foreground-support">
              {files.length ? files.map((f) => f.name).join(", ") : "파일을 끌어다 놓거나 눌러서 고르세요"}
            </p>
            <p className="mt-1 text-[11px] text-foreground-assistive">PDF · DOCX · PPTX · XLSX · 이미지 등, 최대 10개</p>
            <input ref={fileInput} type="file" multiple hidden
              onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 10))} />
          </div>
        )}
        <textarea
          value={text}
          maxLength={MAX}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
          placeholder={hint.placeholder}
          rows={3}
          className="w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-foreground-assistive"
        />
        <div className="flex items-center gap-1.5 px-1 pb-0.5">
          <div className="group relative">
            <Chip active={mode === "ask"} onClick={() => setMode("ask")}>
              {mode === "ask" ? <Sparkle className="h-3 w-3" /> : <span>?</span>} AI 질문으로 시작
            </Chip>
            <span className="pointer-events-none absolute top-full left-0 mt-1.5 hidden rounded border border-border bg-background px-1.5 py-0.5 text-[10px] whitespace-nowrap text-foreground-support shadow-sm group-hover:block">
              {hints.ask.tip}
            </span>
          </div>
          <div className="group relative">
            <Chip active={mode === "files"} onClick={() => setMode("files")} onClear={() => { setMode("ask"); setFiles([]); }}>
              <Paperclip className="h-3 w-3" /> 내 자료로 시작
            </Chip>
            <span className="pointer-events-none absolute top-full left-0 mt-1.5 hidden rounded border border-border bg-background px-1.5 py-0.5 text-[10px] whitespace-nowrap text-foreground-support shadow-sm group-hover:block">
              {hints.files.tip}
            </span>
          </div>
          {mode === "ask" && (
            <div className="relative">
              <button type="button" onClick={() => setTopicsOpen((o) => !o)}
                className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs text-foreground-support hover:bg-surface">
                <Sparkle className="h-3 w-3" /> 주제 추천
              </button>
              {topicsOpen && (
                <div className="animate-fade-up absolute top-full left-0 z-20 mt-1 w-64 rounded-lg border border-border bg-background p-1 shadow-lg">
                  {topicSuggestions.map((t) => (
                    <button key={t} onClick={() => { setText(t); setTopicsOpen(false); }}
                      className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-surface">
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <span className="ml-auto text-[11px] text-foreground-assistive">{text.length}/{MAX}</span>
          <button onClick={submit} disabled={!canSend} aria-label="보내기"
            className="grid h-8 w-8 place-items-center rounded-full bg-foreground text-background transition-colors disabled:bg-border-strong">
            <ArrowUp />
          </button>
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-foreground-muted">{hint.caption}</p>
      {sent && (
        <p className="animate-fade-up mt-4 text-center text-xs text-primary">
          데모 화면이라 실제로 전송되지는 않아요. 보낸 내용: “{sent}”
        </p>
      )}
    </div>
  );
}
