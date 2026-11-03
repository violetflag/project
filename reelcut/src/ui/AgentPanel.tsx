import { LoaderCircle, Sparkles, Undo2 } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ask, clearChat, EFFORTS, MODELS, stopAgent, TOOL_LABEL } from "../agent";
import { draftDuration, fmtTC, overlays, starts } from "../edit";
import { set, setDrafts, st, toast, useStore, type AiRun } from "../store";
import type { ChatBlock, Draft } from "../types";
import { player } from "./Viewer";

const SUGGEST = [
  "무음을 정리해서 지루하지 않게 다듬어 줘",
  "핵심만 남겨서 1분짜리 세로 쇼츠 편집본을 새로 만들어 줘",
  "'음', '어' 같은 말을 지우고 자막을 넣어 줘",
  "360 영상에서 사람이 있는 방향으로 시점을 맞춰 줘",
  "고압축(균형)으로 내보내 줘",
];

function textOf(c: ChatBlock[] | string): string {
  if (typeof c === "string") return c;
  return c.filter((b) => b.type === "text" && !String(b.text).startsWith("<project-state>")).map((b) => String(b.text)).join("\n");
}

type Change = { draft: Draft; created: boolean; dur0: number; dur1: number; clips0: number; clips1: number; spots: number[]; notes: string[] };

/** What one AI request changed, draft by draft. */
function changes(r: AiRun): Change[] {
  const after = r.after ?? [];
  const out: Change[] = [];
  for (const d of after) {
    const b = r.before.find((x) => x.id === d.id);
    if (b && b.updated === d.updated) continue;
    const notes: string[] = [];
    if (b && b.captions !== d.captions) notes.push(d.captions ? "자막 켬" : "자막 끔");
    if (b && b.aspect !== d.aspect) notes.push(`비율 ${b.aspect}→${d.aspect}`);
    if (b && b.markers.length !== d.markers.length) notes.push(`마커 ${d.markers.length - b.markers.length > 0 ? "+" : ""}${d.markers.length - b.markers.length}`);
    if (b && b.music.length !== d.music.length) notes.push(`소리 클립 ${b.music.length}→${d.music.length}`);
    if (b && overlays(b).length !== overlays(d).length) notes.push(`V2·V3 ${overlays(b).length}→${overlays(d).length}`);
    // Where the main track changed: starts of clips that are new or different.
    const old = new Map((b?.clips ?? []).map((c) => [c.id, c]));
    const ss = starts(d);
    const spots = d.clips.flatMap((c, i) => { const o = old.get(c.id); return !o || o.start !== c.start || o.end !== c.end || o.speed !== c.speed ? [ss[i]] : []; });
    out.push({ draft: d, created: !b, dur0: b ? draftDuration(b) : 0, dur1: draftDuration(d), clips0: b?.clips.length ?? 0, clips1: d.clips.length, spots: [...new Set(spots.map((x) => Math.round(x * 10) / 10))].slice(0, 6), notes });
  }
  return out;
}

function RunCard({ r, last }: { r: AiRun; last: boolean }) {
  const cs = changes(r);
  if (!r.done) return null;
  const undoRun = () => {
    if (!last && !confirm("이 AI 편집 뒤에 한 편집도 함께 되돌아갑니다. 계속할까요?")) return;
    setDrafts("AI 편집 되돌리기", r.before, r.before.some((d) => d.id === st.draftId) ? st.draftId : r.draftId);
    set({ aiRuns: st.aiRuns.map((x) => (x.id === r.id ? { ...x, undone: true } : x)) });
    player.refresh();
    toast("이번 AI 편집을 되돌렸습니다");
  };
  return (
    <div class={`run-card ${r.undone ? "undone" : ""}`}>
      <div class="run-head"><Sparkles size={13} aria-hidden="true" /> <b>AI 편집 결과</b><span class="spacer" />
        {cs.length > 0 && !r.undone && <button class="small" onClick={undoRun} title="이 요청으로 바뀐 것을 한 번에 되돌립니다"><Undo2 size={12} aria-hidden="true" /> 이번 AI 편집 되돌리기</button>}
        {r.undone && <span class="muted">되돌림</span>}
      </div>
      {!cs.length && <p class="muted">편집본은 바뀌지 않았습니다.</p>}
      {cs.map((c) => (
        <div class="run-row">
          <a onClick={() => set({ draftId: c.draft.id, sourceId: null })}>{c.draft.name}</a>
          {c.created ? <span> 새로 만듦 · {fmtTC(c.dur1)} · 클립 {c.clips1}개</span>
            : <span> {fmtTC(c.dur0)} → <b>{fmtTC(c.dur1)}</b>{c.dur1 < c.dur0 ? ` (${(c.dur0 - c.dur1).toFixed(1)}초 줄임)` : ""} · 클립 {c.clips0}→{c.clips1}</span>}
          {c.notes.length > 0 && <span class="muted"> · {c.notes.join(" · ")}</span>}
          {c.spots.length > 0 && (
            <div class="spots">바뀐 곳: {c.spots.map((t) => <button class="chip" onClick={() => { set({ draftId: c.draft.id, sourceId: null }); setTimeout(() => player.seek(t), 50); }}>{fmtTC(t)}</button>)}</div>
          )}
        </div>
      ))}
    </div>
  );
}

export function AgentPanel() {
  const s = useStore();
  const chat = s.project!.chat;
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.scrollTo(0, list.current.scrollHeight); }, [chat.length, s.agentStatus, s.aiRuns.length]);

  const send = async (t = text) => {
    if (!t.trim() || s.agentBusy) return;
    if (s.settings.aiMode === "api" && !s.settings.apiKey) { setErr("설정에서 Anthropic API 키를 먼저 넣어 주세요."); return; }
    setText(""); setErr("");
    try { await ask(t.trim()); } catch (e) { setErr(String((e as Error)?.message ?? e)); }
  };

  const items: { kind: "user" | "ai" | "tool" | "err"; text: string }[] = [];
  for (const m of chat) {
    if (m.role === "user") {
      const t = textOf(m.content);
      if (t) items.push({ kind: "user", text: t });
      if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result" && b.is_error) items.push({ kind: "err", text: String(typeof b.content === "string" ? b.content : "도구 오류") });
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "text" && String(b.text).trim()) items.push({ kind: "ai", text: String(b.text) });
        if (b.type === "tool_use") items.push({ kind: "tool", text: TOOL_LABEL[String(b.name)] ?? String(b.name) });
      }
    }
  }
  const model = MODELS.find((m) => m.id === s.settings.model)?.label ?? s.settings.model;
  const effort = EFFORTS.find((e) => e.id === s.settings.effort)?.label ?? "";
  const runs = s.aiRuns.filter((r) => r.done);

  return (
    <div class="agent">
      <div class="agent-head">
        <button class="chip" onClick={() => set({ route: "settings" })} title="모델과 생각 깊이는 설정에서 바꿉니다">{model} · 생각 {effort}</button>
        <span class="muted conn">{s.settings.aiMode === "api" ? "API 키" : "Claude 계정"}</span>
        <span class="spacer" />
        <button class="small" disabled={s.agentBusy || !chat.length} onClick={() => { clearChat(); set({ aiRuns: [] }); toast("새 대화를 시작합니다"); }}>새 대화</button>
      </div>
      <div class="chat" ref={list} aria-live="polite">
        {!items.length && (
          <div class="suggest">
            <p>무엇을 편집할까요? 대본과 화면을 보고 직접 편집합니다. 결과는 카드로 보여 드리고, 한 번에 되돌릴 수 있습니다.</p>
            {SUGGEST.map((t) => <button class="chip" onClick={() => send(t)}>{t}</button>)}
          </div>
        )}
        {items.map((it) => <div class={`msg ${it.kind}`}>{it.text}</div>)}
        {runs.length > 0 && <RunCard r={runs[runs.length - 1]} last={st.aiRuns[st.aiRuns.length - 1]?.id === runs[runs.length - 1].id} />}
        {s.agentBusy && <div class="msg status"><LoaderCircle size={13} class="spin-i" aria-hidden="true" /> {s.agentStatus}</div>}
        {err && <div class="msg err">{err} <a onClick={() => set({ route: "settings" })}>설정 열기</a></div>}
      </div>
      <div class="composer">
        <textarea rows={3} placeholder="예: 인트로를 짧게 줄이고 자막 넣어 줘 (Enter 보내기, Shift+Enter 줄바꿈)" value={text} aria-label="AI에게 편집 요청"
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }} />
        {s.agentBusy ? <button onClick={stopAgent}>멈추기</button> : <button class="primary" disabled={!text.trim()} onClick={() => send()}>보내기</button>}
      </div>
    </div>
  );
}
