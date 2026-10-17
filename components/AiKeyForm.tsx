"use client";

import { useCallback, useState } from "react";
import {
  CONTEXTS, EFFORTS, MODELS, modelLabel, setAiSettings, setApiKey, useAiSettings, useApiKey,
} from "@/lib/ai";
import { setAutoSave, useAutoSave, useSync } from "@/lib/sync";
import { useIsMobile } from "@/lib/useMedia";
import { useDismiss } from "./Popover";
import { ChevronDown, Close } from "./icons";

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 7)}…${k.slice(-4)}` : "저장됨");

function KeyField() {
  const key = useApiKey();
  const [draft, setDraft] = useState("");
  const save = () => {
    const k = draft.trim();
    if (!k) return;
    setApiKey(k);
    setDraft("");
  };
  if (key) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-green-500" />
        <span className="flex-1 text-xs">연결됨 · {mask(key)}</span>
        <button onClick={() => setApiKey("")} className="text-xs text-foreground-muted hover:text-foreground">연결 해제</button>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="sk-ant-…" aria-label="Anthropic API 키"
        onKeyDown={(e) => e.key === "Enter" && save()} autoComplete="off"
        className="min-w-0 flex-1 rounded-md border border-border px-2 py-2 text-sm outline-none focus:border-primary" />
      <button onClick={save} disabled={!draft.trim()} className="rounded-md bg-primary px-3 text-sm text-white disabled:opacity-40">저장</button>
    </div>
  );
}

function Select<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly { id: T; label: string; hint: string }[]; onChange: (v: T) => void;
}) {
  const hint = options.find((o) => o.id === value)?.hint;
  return (
    <label className="block">
      <span className="text-xs text-foreground-support">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}
        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-2 text-sm outline-none focus:border-primary">
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      {hint && <span className="mt-1 block text-[11px] text-foreground-muted">{hint}</span>}
    </label>
  );
}

// Full AI settings: key plus model, effort and context size.
export function AiKeyForm() {
  const s = useAiSettings();
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1.5">
        <p className="text-xs text-foreground-support">Anthropic API 키</p>
        <KeyField />
        <p className="text-[11px] leading-relaxed text-foreground-muted">
          키는 이 브라우저(구글 로그인 시 내 구글 드라이브의 PlanSpace 폴더)에만 저장되고 Anthropic으로만 보내져요. 키가 없으면 기본 생성기가 템플릿으로 만들어요.{" "}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="text-primary hover:underline">키 발급받기</a>
        </p>
      </div>
      <Select label="모델" value={s.model} options={MODELS} onChange={(model) => setAiSettings({ model })} />
      <Select label="노력 (생각하는 깊이)" value={s.effort} options={EFFORTS} onChange={(effort) => setAiSettings({ effort })} />
      <Select label="컨텍스트 크기" value={s.context} options={CONTEXTS} onChange={(context) => setAiSettings({ context })} />
      <AutoSaveToggle />
    </div>
  );
}

function AutoSaveToggle() {
  const sync = useSync();
  const on = useAutoSave();
  if (sync.status === "off") return null;
  return (
    <label className="flex cursor-pointer items-start gap-2 border-t border-border pt-3">
      <input type="checkbox" checked={on} onChange={(e) => setAutoSave(e.target.checked)} aria-label="드라이브 자동 저장" className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
      <span>
        <span className="block text-xs text-foreground-support">구글 드라이브 자동 저장</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-foreground-muted">
          켜면 고칠 때마다, 화면으로 돌아올 때, 1분마다 드라이브에 저장해요. 꺼도 결과물이 나올 때와 💾 버튼을 누를 때는 저장돼요. 이 기기에만 적용돼요.
        </span>
      </span>
    </label>
  );
}

export function AiKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:px-4" onClick={onClose}>
      <div className="animate-fade-up max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl bg-background p-5 shadow-xl sm:max-w-[420px] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()} role="dialog" aria-label="AI 설정">
        <div className="mb-4 flex items-center">
          <h2 className="flex-1 font-semibold">AI 설정</h2>
          <button onClick={onClose} aria-label="닫기" className="p-1 text-foreground-muted hover:text-foreground"><Close className="h-4 w-4" /></button>
        </div>
        <AiKeyForm />
        <button onClick={onClose} className="mt-5 w-full rounded-md bg-foreground py-2.5 text-sm text-background">완료</button>
      </div>
    </div>
  );
}

function Section<T extends string>({ title, value, options, onPick }: {
  title: string; value: T; options: readonly { id: T; label: string; hint: string }[]; onPick: (v: T) => void;
}) {
  return (
    <div className="py-1">
      <p className="px-2.5 pt-1 pb-0.5 text-[11px] text-foreground-muted">{title}</p>
      {options.map((o) => (
        <button key={o.id} onClick={() => onPick(o.id)}
          className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-surface ${value === o.id ? "bg-surface" : ""}`}>
          <span className="flex-1">
            <span className="block text-sm">{o.label}</span>
            <span className="block text-[11px] text-foreground-muted">{o.hint}</span>
          </span>
          {value === o.id && <span className="text-primary">✓</span>}
        </button>
      ))}
    </div>
  );
}

// Compact picker next to an input, like the model menu in Claude's apps.
export function AiPicker({ up = false }: { up?: boolean }) {
  const key = useApiKey();
  const s = useAiSettings();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  // Fixed to the viewport so a narrow or clipped parent (the chat panel) can't cut the menu off.
  const [pos, setPos] = useState<React.CSSProperties>({});
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const mobile = useIsMobile();
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const w = 288, gap = 8;
    const left = Math.max(gap, Math.min(r.left, window.innerWidth - w - gap));
    const roomUp = r.top - gap * 2, roomDown = window.innerHeight - r.bottom - gap * 2;
    const goUp = up ? roomUp > 240 || roomUp > roomDown : roomDown < 240 && roomUp > roomDown;
    setPos(goUp ? { left, bottom: window.innerHeight - r.top + 4, maxHeight: roomUp } : { left, top: r.bottom + 4, maxHeight: roomDown });
    setOpen((o) => !o);
  };
  if (!key) {
    return (
      <>
        <button type="button" onClick={() => setDialog(true)}
          className="inline-flex h-7 items-center gap-1 rounded-full bg-surface px-2.5 text-xs text-foreground-support hover:text-foreground">
          기본 생성기 · AI 연결하기
        </button>
        <AiKeyDialog open={dialog} onClose={() => setDialog(false)} />
      </>
    );
  }
  const effort = EFFORTS.find((e) => e.id === s.effort)?.label;
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={toggle} aria-label="AI 모델 선택"
        className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs text-foreground-support hover:bg-surface hover:text-foreground">
        {modelLabel(s.model)} <span className="text-foreground-muted">· {effort}</span> <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className={`animate-fade-up z-40 overflow-y-auto rounded-lg border border-border bg-background p-1 shadow-lg ${
          // On phones the menu is a bottom sheet so every section fits on screen.
          mobile ? "fixed inset-x-2 bottom-2 max-h-[80dvh] pb-[env(safe-area-inset-bottom)]" : "fixed w-72"}`} style={mobile ? undefined : pos}>
          <Section title="모델" value={s.model} options={MODELS} onPick={(model) => setAiSettings({ model })} />
          <div className="border-t border-border" />
          <Section title="노력" value={s.effort} options={EFFORTS} onPick={(effort) => setAiSettings({ effort })} />
          <div className="border-t border-border" />
          <Section title="컨텍스트 크기" value={s.context} options={CONTEXTS} onPick={(context) => setAiSettings({ context })} />
          <div className="border-t border-border" />
          <button onClick={() => { setOpen(false); setDialog(true); }} className="w-full rounded-md px-2.5 py-2 text-left text-xs text-foreground-support hover:bg-surface">
            API 키 관리…
          </button>
        </div>
      )}
      <AiKeyDialog open={dialog} onClose={() => setDialog(false)} />
    </div>
  );
}
