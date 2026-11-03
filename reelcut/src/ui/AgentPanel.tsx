import { Bookmark, BookmarkPlus, LoaderCircle, Pencil, Plus, Send, Sparkles, Trash2, Undo2 } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ask, EFFORTS, MODELS, newChat, stopAgent, TOOL_LABEL } from "../agent";
import { ctxLimit, fmtK, newSession, sessionsNewestFirst } from "../chats";
import { draftDuration, fmtTC, overlays, starts } from "../edit";
import { activeChat, addPrompt, deletePrompt, mutate, mutateChat, promptName, set, setDrafts, st, toast, updatePrompt, useStore, type AiRun } from "../store";
import type { ChatBlock, ChatSession, Draft, SavedPrompt } from "../types";
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

/** Inline **bold** and `code` (the model writes Markdown; shown as styled text, never as HTML). */
function inline(t: string) {
  return t.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong>{part.slice(2, -2)}</strong>
      : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code>{part.slice(1, -1)}</code>
      : part);
}
/** Light Markdown for AI replies: headings, bullet and numbered lines, bold, code. */
export function Md({ text }: { text: string }) {
  return <>{text.split("\n").map((line) => {
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    if (h) return <div class="md-h">{inline(h[1])}</div>;
    const b = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (b) return <div class="md-li">{inline(b[1])}</div>;
    const n = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (n) return <div class="md-li md-num" data-n={n[1] + "."}>{inline(n[2])}</div>;
    return line.trim() ? <div>{inline(line)}</div> : <div class="md-gap" />;
  })}</>;
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

/** The unsent prompt, kept per project and conversation so it survives tab switches and restarts. */
const promptKey = (projectId: string, chatId: string) => `reelcut-ai-prompt-${projectId}-${chatId}`;
function loadPrompt(projectId: string, chatId: string): string {
  try { return localStorage.getItem(promptKey(projectId, chatId)) ?? localStorage.getItem(`reelcut-ai-prompt-${projectId}`) ?? ""; } catch { return ""; }
}
function savePrompt(projectId: string, chatId: string, text: string) {
  try {
    localStorage.removeItem(`reelcut-ai-prompt-${projectId}`); // the per-project key of 2.1.2
    if (text) localStorage.setItem(promptKey(projectId, chatId), text);
    else localStorage.removeItem(promptKey(projectId, chatId));
  } catch { /* storage unavailable: the text just isn't kept */ }
}

const when = (ms: number) => {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Context used by this conversation against its model's limit, with the compaction point. */
function Meter({ c }: { c: ChatSession }) {
  const s = st.settings;
  const limit = ctxLimit(c.model ?? s.model, s);
  const used = c.ctxTokens ?? 0;
  const pct = Math.min(100, (used / limit) * 100);
  const at = s.compactAt || 90;
  const cls = pct >= at ? "hot" : pct >= at - 15 ? "warm" : "";
  return (
    <div class={`ctx-meter ${cls}`} title={`이 대화의 컨텍스트: ${used.toLocaleString()} / ${limit.toLocaleString()} 토큰. ${at}%가 되면 자동으로 요약해 ${s.compactTo || 50}% 이하로 줄입니다.`}>
      <span class="ctx-num">{fmtK(used)} / {fmtK(limit)}</span>
      <span class="ctx-bar" role="meter" aria-label="컨텍스트 사용량" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <span class="ctx-fill" style={{ width: `${pct}%` }} />
        <span class="ctx-at" style={{ left: `${at}%` }} />
      </span>
    </div>
  );
}

/** One saved prompt in the list: insert, send now, rename/edit, delete. */
function PromptRow({ p, busy, onInsert, onSend }: { p: SavedPrompt; busy: boolean; onInsert: () => void; onSend: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [body, setBody] = useState(p.text);
  if (editing) {
    const save = () => { if (body.trim()) { updatePrompt(p.id, { name: name.trim() || promptName(body), text: body.trim() }); setEditing(false); } };
    return (
      <li class="prompt-row editing">
        <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label="프롬프트 이름" placeholder="이름" />
        <textarea rows={3} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} aria-label="프롬프트 내용" />
        <div class="row">
          <span class="spacer" />
          <button class="small" onClick={() => { setName(p.name); setBody(p.text); setEditing(false); }}>취소</button>
          <button class="small primary" disabled={!body.trim()} onClick={save}>저장</button>
        </div>
      </li>
    );
  }
  return (
    <li class="prompt-row">
      <button class="prompt-use" onClick={onInsert} title={`입력칸에 넣기\n\n${p.text}`}>
        <span class="prompt-name">{p.name}</span>
        <span class="prompt-text muted">{p.text}</span>
      </button>
      <button class="small" disabled={busy} onClick={onSend} title="입력칸을 거치지 않고 바로 보냅니다"><Send size={12} aria-hidden="true" /> 바로 보내기</button>
      <button class="icon-btn" onClick={() => setEditing(true)} aria-label={`${p.name} 고치기`} title="이름·내용 고치기"><Pencil size={13} /></button>
      <button class="icon-btn" onClick={() => { if (confirm(`저장한 프롬프트 "${p.name}"를 지울까요?`)) deletePrompt(p.id); }} aria-label={`${p.name} 지우기`} title="지우기"><Trash2 size={13} /></button>
    </li>
  );
}

/** Saved prompts (shared by every project): save the current text, insert or send one. */
function PromptLibrary({ text, busy, onInsert, onSend, onClose }: { text: string; busy: boolean; onInsert: (t: string) => void; onSend: (t: string) => void; onClose: () => void }) {
  const s = useStore();
  const [naming, setNaming] = useState<string | null>(null);
  const saveNow = () => { if (addPrompt(text, naming ?? undefined)) toast("프롬프트를 저장했습니다"); setNaming(null); };
  return (
    <div class="prompt-lib" role="dialog" aria-label="저장한 프롬프트" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div class="prompt-lib-head">
        <b>저장한 프롬프트</b><span class="muted"> {s.prompts.length}개 · 모든 프로젝트에서 씁니다</span>
        <span class="spacer" />
        {naming == null && <button class="small" disabled={!text.trim()} onClick={() => setNaming(promptName(text))} title="입력칸의 내용을 저장합니다"><BookmarkPlus size={13} aria-hidden="true" /> 현재 입력 저장</button>}
      </div>
      {naming != null && (
        <div class="row prompt-naming">
          <input autoFocus value={naming} onInput={(e) => setNaming((e.target as HTMLInputElement).value)} aria-label="저장할 이름"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); saveNow(); } if (e.key === "Escape") { e.stopPropagation(); setNaming(null); } }} />
          <button class="small" onClick={() => setNaming(null)}>취소</button>
          <button class="small primary" onClick={saveNow}>저장</button>
        </div>
      )}
      {!s.prompts.length ? <p class="muted prompt-empty">아직 없습니다. 잘 된 요청은 입력칸에서 "현재 입력 저장"으로, 보낸 요청은 말풍선의 "저장"으로 남겨 두세요.</p> : (
        <ul class="prompt-list">
          {s.prompts.map((p) => <PromptRow key={p.id} p={p} busy={busy} onInsert={() => onInsert(p.text)} onSend={() => onSend(p.text)} />)}
        </ul>
      )}
    </div>
  );
}

export function AgentPanel() {
  const s = useStore();
  const p = s.project!;
  const c = activeChat();
  const chat = c?.messages ?? [];
  const projectId = p.id, chatId = c?.id ?? "";
  const [text, setTextState] = useState(() => loadPrompt(projectId, chatId));
  const setText = (t: string) => { setTextState(t); savePrompt(projectId, chatId, t); };
  const [err, setErr] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [lib, setLib] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { list.current?.scrollTo(0, list.current.scrollHeight); }, [chat.length, s.agentStatus, s.aiRuns.length, chatId]);
  // Another project or conversation: show its own unsent prompt.
  useEffect(() => { setTextState(loadPrompt(projectId, chatId)); setErr(""); }, [projectId, chatId]);

  const send = async (t = text) => {
    if (!t.trim() || s.agentBusy) return;
    if (s.settings.aiMode === "api" && !s.settings.apiKey) { setErr("설정에서 Anthropic API 키를 먼저 넣어 주세요."); return; }
    setText(""); setErr("");
    // A request that fails gives the text back, so nothing typed is lost.
    try { await ask(t.trim()); } catch (e) { setErr(String((e as Error)?.message ?? e)); if (!loadPrompt(projectId, chatId)) setText(t); }
  };
  const open = (id: string) => { if (!s.agentBusy) mutate((x) => ({ ...x, activeChat: id })); };
  const remove = () => {
    if (!c || !confirm(`대화 "${c.title}"를 지울까요? 되돌릴 수 없습니다.`)) return;
    savePrompt(projectId, c.id, "");
    const rest = (p.chats ?? []).filter((x) => x.id !== c.id);
    if (!rest.length) rest.push(newSession());
    mutate((x) => ({ ...x, chats: rest, activeChat: rest.slice().sort((a, b) => b.updated - a.updated)[0].id }));
    set({ aiRuns: s.aiRuns.filter((r) => r.chat !== c.id) });
  };

  // Shown items, with a divider where earlier turns were compacted.
  type Item = { kind: "user" | "ai" | "tool" | "err" | "mark"; text: string };
  const items: Item[] = [];
  const marks = c?.marks ?? [];
  chat.forEach((m, i) => {
    for (const mk of marks) if (mk.at === i) items.push({ kind: "mark", text: `여기까지 요약됨 (${fmtK(mk.from)} → ${fmtK(mk.to)})` });
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
  });
  for (const mk of marks) if (mk.at >= chat.length) items.push({ kind: "mark", text: `여기까지 요약됨 (${fmtK(mk.from)} → ${fmtK(mk.to)})` });
  const model = MODELS.find((m) => m.id === s.settings.model)?.label ?? s.settings.model;
  const effort = EFFORTS.find((e) => e.id === s.settings.effort)?.label ?? "";
  const runs = s.aiRuns.filter((r) => r.done && r.chat === chatId);
  const all = sessionsNewestFirst(p);

  return (
    <div class="agent">
      <div class="agent-head">
        {renaming && c ? (
          <input class="chat-name" autoFocus defaultValue={c.title} aria-label="대화 이름"
            onKeyDown={(e) => {
              if (e.key === "Enter") { const v = (e.target as HTMLInputElement).value.trim(); if (v) mutateChat((x) => ({ ...x, title: v })); setRenaming(false); }
              if (e.key === "Escape") setRenaming(false);
            }} onBlur={() => setRenaming(false)} />
        ) : (
          <select class="chat-pick" value={chatId} disabled={s.agentBusy} onChange={(e) => open((e.target as HTMLSelectElement).value)} aria-label="대화 기록" title="이 프로젝트의 대화 (최근 순)">
            {all.map((x) => <option value={x.id}>{x.title} · {when(x.updated)}{x.messages.length ? "" : " (비어 있음)"}</option>)}
          </select>
        )}
        <button class="icon-btn" disabled={!c || s.agentBusy} onClick={() => setRenaming(true)} aria-label="대화 이름 바꾸기" title="대화 이름 바꾸기"><Pencil size={14} /></button>
        <button class="icon-btn" disabled={!c || s.agentBusy} onClick={remove} aria-label="대화 지우기" title="대화 지우기"><Trash2 size={14} /></button>
        <button class="small" disabled={s.agentBusy || !chat.length} onClick={() => { newChat(); toast("새 대화를 시작합니다. 이전 대화는 목록에 남아 있습니다"); }} title="새 대화 (이전 대화는 목록에 남음)"><Plus size={13} aria-hidden="true" /> 새 대화</button>
      </div>
      <div class="agent-sub">
        <button class="chip" onClick={() => set({ route: "settings" })} title="모델과 생각 깊이는 설정에서 바꿉니다">{model} · 생각 {effort}</button>
        <span class="muted conn">{s.settings.aiMode === "api" ? "API 키" : "Claude 계정"}</span>
        <span class="spacer" />
        {c && <Meter c={c} />}
      </div>
      <div class="chat" ref={list} aria-live="polite">
        {!items.length && (
          <div class="suggest">
            <p>무엇을 편집할까요? 대본과 화면을 보고 직접 편집합니다. 결과는 카드로 보여 드리고, 한 번에 되돌릴 수 있습니다.</p>
            {SUGGEST.map((t) => <button class="chip" onClick={() => send(t)}>{t}</button>)}
          </div>
        )}
        {items.map((it) => it.kind === "mark" ? <div class="compact-mark" role="separator"><span>{it.text}</span></div>
          : it.kind === "user" ? (
            <div class="msg user">{it.text}
              <button class="msg-save" onClick={() => { if (addPrompt(it.text)) toast("저장한 프롬프트에 넣었습니다"); }} title="이 요청을 저장한 프롬프트에 넣습니다" aria-label="이 요청 저장"><Bookmark size={11} aria-hidden="true" /> 저장</button>
            </div>
          )
          : <div class={`msg ${it.kind}`}>{it.kind === "ai" ? <Md text={it.text} /> : it.text}</div>)}
        {runs.length > 0 && <RunCard r={runs[runs.length - 1]} last={st.aiRuns[st.aiRuns.length - 1]?.id === runs[runs.length - 1].id} />}
        {s.agentBusy && <div class="msg status"><LoaderCircle size={13} class="spin-i" aria-hidden="true" /> {s.agentStatus}</div>}
        {err && <div class="msg err">{err} <a onClick={() => set({ route: "settings" })}>설정 열기</a></div>}
      </div>
      {lib && <PromptLibrary text={text} busy={s.agentBusy}
        onInsert={(t) => { setText(t); setLib(false); setTimeout(() => box.current?.focus(), 0); }}
        onSend={(t) => { setLib(false); send(t); }} onClose={() => setLib(false)} />}
      <div class="composer">
        <button class={`icon-btn ${lib ? "on" : ""}`} onClick={() => setLib(!lib)} aria-pressed={lib} aria-label="저장한 프롬프트" title="저장한 프롬프트"><Bookmark size={16} /></button>
        <textarea ref={box} rows={3} placeholder="예: 인트로를 짧게 줄이고 자막 넣어 줘 (Enter 보내기, Shift+Enter 줄바꿈)" value={text} aria-label="AI에게 편집 요청"
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }} />
        {s.agentBusy ? <button onClick={stopAgent}>멈추기</button> : <button class="primary" disabled={!text.trim()} onClick={() => send()}>보내기</button>}
      </div>
    </div>
  );
}
