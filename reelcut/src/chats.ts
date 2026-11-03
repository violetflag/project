// AI conversations per session: migration from the single chat of older projects, titles,
// the context limit per model and the numbers of automatic compaction (pure, unit-tested).
import { uid } from "./edit";
import type { ChatBlock, ChatMsg, ChatSession, Project, Settings } from "./types";

export const CTX_DEFAULTS = { ctxHaiku: 90_000, ctxOther: 950_000, compactAt: 90, compactTo: 50 };

export function newSession(title = "새 대화"): ChatSession {
  const now = Date.now();
  return { id: uid(), title, created: now, updated: now, messages: [] };
}

/** Text the user typed in a message (without the project-state note). */
export function userText(m: ChatMsg): string {
  if (typeof m.content === "string") return m.content;
  return m.content.filter((b) => b.type === "text" && !String(b.text).startsWith("<project-state>") && !String(b.text).startsWith("<compacted")).map((b) => String(b.text)).join(" ").trim();
}

/** A session title from its first request (about 30 characters). */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 30 ? t.slice(0, 29) + "…" : t || "새 대화";
}

/** Older projects had one conversation in `chat`/`ccSession`; it becomes the first session. */
export function migrateChats(p: Project): Project {
  if (p.chats?.length) {
    const active = p.chats.some((c) => c.id === p.activeChat) ? p.activeChat : p.chats[0].id;
    return active === p.activeChat ? p : { ...p, activeChat: active };
  }
  const s = newSession();
  const old = p.chat ?? [];
  if (old.length) {
    const first = old.find((m) => m.role === "user" && userText(m));
    s.title = titleFrom(first ? userText(first) : "");
    s.messages = old;
    s.ccSession = p.ccSession;
    s.chatMode = p.chatMode;
    s.created = s.updated = p.updated;
  }
  const { chat: _c, ccSession: _s, chatMode: _m, ...rest } = p;
  return { ...rest, chats: [s], activeChat: s.id };
}

export const sessionsNewestFirst = (p: Project) => (p.chats ?? []).slice().sort((a, b) => b.updated - a.updated);

/** Context limit for a model: Haiku models get the small limit, everything else the large one. */
export function ctxLimit(model: string | undefined, s: Partial<Settings>): number {
  const haiku = /haiku/i.test(model ?? "");
  return haiku ? s.ctxHaiku || CTX_DEFAULTS.ctxHaiku : s.ctxOther || CTX_DEFAULTS.ctxOther;
}

/** True when the session must be compacted before its next request. */
export function needsCompaction(ctx: number | undefined, limit: number, s: Partial<Settings>): boolean {
  const at = (s.compactAt || CTX_DEFAULTS.compactAt) / 100;
  return !!ctx && ctx >= limit * at;
}

/** Token budget for the context after compaction (summary + recent turns). */
export const compactBudget = (limit: number, s: Partial<Settings>) => Math.floor((limit * (s.compactTo || CTX_DEFAULTS.compactTo)) / 100);

/** Rough token count of text (Korean and English mixed: about 1 token per 2.5 characters, rounded up). */
export const estTokens = (text: string) => Math.ceil(text.length / 2.5);

/** One message as plain text for a summary request or a seed. */
export function plainOf(m: ChatMsg): string {
  if (typeof m.content === "string") return `${m.role === "user" ? "사용자" : "AI"}: ${m.content}`;
  const parts: string[] = [];
  for (const b of m.content as ChatBlock[]) {
    if (b.type === "text") {
      const t = String(b.text);
      if (t.startsWith("<project-state>")) continue;
      parts.push(t);
    } else if (b.type === "tool_use") parts.push(`[도구 ${String(b.name).replace("mcp__reelcut__", "")} ${JSON.stringify(b.input ?? {}).slice(0, 300)}]`);
    else if (b.type === "tool_result") {
      const c = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as any[]).filter((x) => x.type === "text").map((x) => x.text).join(" ") : "";
      if (c) parts.push(`[결과${b.is_error ? " 오류" : ""}: ${c.slice(0, 400)}]`);
    }
  }
  const t = parts.join("\n").trim();
  return t ? `${m.role === "user" ? "사용자" : "AI"}: ${t}` : "";
}

/** The most recent turns, oldest first, as text that fits in `tokens`. */
export function recentWithin(messages: ChatMsg[], tokens: number): string {
  const out: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = plainOf(messages[i]);
    if (!t) continue;
    const n = estTokens(t);
    if (used + n > tokens) break;
    out.unshift(t);
    used += n;
  }
  return out.join("\n\n");
}

/** The request that asks the model to summarise the conversation (same wording in both modes). */
export const SUMMARY_REQUEST = `지금까지의 대화를 이어서 일할 수 있도록 빠짐없이 요약해 주세요. 도구는 쓰지 말고 요약만 답하세요.
다음을 꼭 포함하세요:
- 사용자의 목표와 요청
- 내린 결정과 그 이유
- 실제로 적용한 편집 (편집본 id, 클립 id, 시간 구간, 숫자)
- 아직 남은 일
- 사용자가 좋아하거나 싫어한 것, 말투·형식 같은 선호
한국어로, 사실만 정확하게 쓰세요.`;

/** The text a fresh context starts from: the summary plus the latest turns, within the budget. */
export function seedText(summary: string, messages: ChatMsg[], budget: number): string {
  const head = `<compacted-summary>\n${summary.trim()}\n</compacted-summary>`;
  const room = Math.max(0, budget - estTokens(head) - 200);
  const recent = recentWithin(messages, room);
  return recent ? `${head}\n\n<recent-turns>\n${recent}\n</recent-turns>` : head;
}

export const fmtK = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
