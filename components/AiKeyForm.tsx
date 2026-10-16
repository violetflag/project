"use client";

import { useState } from "react";
import { MODEL_LABEL, setApiKey, useApiKey } from "@/lib/ai";

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 7)}…${k.slice(-4)}` : "저장됨");

export function AiKeyForm() {
  const key = useApiKey();
  const [draft, setDraft] = useState("");
  const save = () => {
    const k = draft.trim();
    if (!k) return;
    setApiKey(k);
    setDraft("");
  };
  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs leading-relaxed text-foreground-support">
        Anthropic API 키를 넣으면 질문, PRD, 기능명세서, 검토, 채팅 답변을 {MODEL_LABEL}가 아이디어에 맞춰 새로 만들어요.
        키는 이 브라우저에만 저장되고 Anthropic 서버로만 보내져요. 사용 요금은 키 주인의 Anthropic 계정에 청구돼요.
      </p>
      {key ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
          <span className="h-2 w-2 rounded-full bg-green-500" />
          <span className="flex-1 text-xs">연결됨 · {mask(key)}</span>
          <button onClick={() => setApiKey("")} className="text-xs text-foreground-muted hover:text-foreground">연결 해제</button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="sk-ant-…"
            onKeyDown={(e) => e.key === "Enter" && save()} autoComplete="off"
            className="min-w-0 flex-1 rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-primary" />
          <button onClick={save} disabled={!draft.trim()} className="rounded-md bg-primary px-3 text-white disabled:opacity-40">저장</button>
        </div>
      )}
      <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="block text-xs text-primary hover:underline">
        API 키 발급받기 →
      </a>
    </div>
  );
}

export function AiKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4" onClick={onClose}>
      <div className="w-full max-w-[420px] rounded-xl bg-background p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center">
          <h2 className="flex-1 font-semibold">AI 연결</h2>
          <button onClick={onClose} aria-label="닫기" className="text-foreground-muted hover:text-foreground">✕</button>
        </div>
        <AiKeyForm />
      </div>
    </div>
  );
}

export function AiBadge({ onClick }: { onClick: () => void }) {
  const key = useApiKey();
  return (
    <button onClick={onClick} title="AI 연결 설정"
      className={`rounded px-1.5 py-0.5 text-[11px] ${key ? "bg-primary-soft text-primary" : "bg-surface text-foreground-support hover:text-foreground"}`}>
      {key ? MODEL_LABEL : "로컬 생성기 · AI 연결하기"}
    </button>
  );
}
