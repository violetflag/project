import { useEffect, useRef, useState } from "preact/hooks";
import { ask, clearChat, EFFORTS, MODELS, stopAgent, TOOL_LABEL } from "../agent";
import { saveSettings, set, toast, useStore } from "../store";
import type { ChatBlock } from "../types";

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

export function AgentPanel() {
  const s = useStore();
  const chat = s.project!.chat;
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.scrollTo(0, list.current.scrollHeight); }, [chat.length, s.agentStatus]);

  const send = async (t = text) => {
    if (!t.trim() || s.agentBusy) return;
    if (!s.settings.apiKey) { setErr("설정에서 Anthropic API 키를 먼저 넣어 주세요."); return; }
    setText(""); setErr("");
    try { await ask(t.trim()); } catch (e) { setErr(String((e as Error)?.message ?? e)); }
  };

  // Shown items: user text, assistant text, and one chip per tool call.
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

  return (
    <div class="agent">
      <div class="agent-head">
        <select value={s.settings.model} onChange={(e) => saveSettings({ model: (e.target as HTMLSelectElement).value })} title="모델">
          {MODELS.map((m) => <option value={m.id}>{m.label}</option>)}
        </select>
        <select value={s.settings.effort} onChange={(e) => saveSettings({ effort: (e.target as HTMLSelectElement).value as any })} title="생각 깊이">
          {EFFORTS.map((m) => <option value={m.id}>생각 {m.label}</option>)}
        </select>
        <span class="spacer" />
        <button class="small" disabled={s.agentBusy || !chat.length} onClick={() => { clearChat(); toast("새 대화를 시작합니다"); }}>새 대화</button>
      </div>
      <div class="chat" ref={list}>
        {!items.length && (
          <div class="suggest">
            <p>무엇을 편집할까요? 대본과 화면을 보고 직접 편집합니다. 모든 편집은 되돌릴 수 있습니다.</p>
            {SUGGEST.map((t) => <button class="chip" onClick={() => send(t)}>{t}</button>)}
          </div>
        )}
        {items.map((it) => <div class={`msg ${it.kind}`}>{it.text}</div>)}
        {s.agentBusy && <div class="msg status"><span class="spin" /> {s.agentStatus}</div>}
        {err && <div class="msg err">{err}{!s.settings.apiKey && <> <a onClick={() => set({ route: "settings" })}>설정 열기</a></>}</div>}
      </div>
      <div class="composer">
        <textarea rows={3} placeholder="예: 인트로를 짧게 줄이고 자막 넣어 줘 (Enter 보내기, Shift+Enter 줄바꿈)" value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }} />
        {s.agentBusy ? <button onClick={stopAgent}>멈추기</button> : <button class="primary" disabled={!text.trim()} onClick={() => send()}>보내기</button>}
      </div>
    </div>
  );
}
