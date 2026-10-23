"use client";

import { uid } from "./id";
import { getProject, updateProject } from "./store";
import { describeError, getApiKey } from "./ai";
import type { ChatMessage, Project } from "./types";

export const ai = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: uid("m_"), from: "ai", text, ...extra });
export const me = (text: string): ChatMessage => ({ id: uid("m_"), from: "user", text });

export const aiEnabled = () => !!getApiKey();
// Keeps the last AI failures (with the API's own message) for debugging.
function logAiError(label: string, e: unknown) {
  console.error(e);
  try {
    const list = JSON.parse(localStorage.getItem("planspace.aiErrors") || "[]");
    list.unshift({ at: new Date().toISOString(), label, message: e instanceof Error ? e.message.slice(0, 600) : String(e) });
    localStorage.setItem("planspace.aiErrors", JSON.stringify(list.slice(0, 10)));
  } catch {
    // Not critical.
  }
}

export const isBusy = (p: Project) => p.chat.some((m) => m.thinking);

// One abort switch per project with AI work running; the composer's stop button pulls it.
const running = new Map<string, AbortController>();
export const aiSignal = () => (running.size ? AbortSignal.any([...running.values()].map((c) => c.signal)) : undefined);
// With nothing running here (say the page was reloaded mid-task), it clears the stuck bubble.
export function stopAi(id: string) {
  const c = running.get(id);
  if (c) return c.abort();
  updateProject(id, (x) => ({ ...x, chat: x.chat.filter((m) => !m.thinking) }));
}

// Runs a Claude call behind a "thinking" chat bubble whose steps the caller can advance
// (step("기능 작성 완료")). On failure the bubble turns into an error note and the local
// generator does the job instead.
export async function withAi(
  id: string, label: string,
  run: (p: Project, step: (s: string) => void) => Promise<void>,
  fallback: () => void, prefix: ChatMessage[] = [],
) {
  const p = getProject(id);
  if (!p || isBusy(p)) return;
  const bubble = ai(label, { thinking: true, steps: [] });
  updateProject(id, (x) => ({ ...x, chat: [...x.chat, ...prefix, bubble] }));
  const step = (s: string) => updateProject(id, (x) => ({
    ...x, chat: x.chat.map((m) => (m.id === bubble.id ? { ...m, steps: [...(m.steps ?? []), s] } : m)),
  }));
  const drop = () => updateProject(id, (x) => ({ ...x, chat: x.chat.filter((m) => m.id !== bubble.id) }));
  const ctl = new AbortController();
  running.set(id, ctl);
  try {
    await run(getProject(id)!, step);
    drop();
  } catch (e) {
    drop();
    if (ctl.signal.aborted) {
      updateProject(id, (x) => ({ ...x, chat: [...x.chat, ai("작업을 멈췄어요. 멈추기 전에 끝난 부분만 남아 있어요.")] }), "AI 작업을 멈췄어요");
      return;
    }
    logAiError(label, e);
    updateProject(id, (x) => ({ ...x, chat: [...x.chat, ai(`${describeError(e)} 이번에는 로컬 생성기로 대신 만들었어요.`, { error: true })] }));
    fallback();
  } finally {
    if (running.get(id) === ctl) running.delete(id);
  }
}
