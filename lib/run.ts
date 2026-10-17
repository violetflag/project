"use client";

import { uid } from "./id";
import { getProject, updateProject } from "./store";
import { describeError, getApiKey } from "./ai";
import type { ChatMessage, Project } from "./types";

export const ai = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: uid("m_"), from: "ai", text, ...extra });
export const me = (text: string): ChatMessage => ({ id: uid("m_"), from: "user", text });

export const aiEnabled = () => !!getApiKey();
export const isBusy = (p: Project) => p.chat.some((m) => m.thinking);

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
  try {
    await run(getProject(id)!, step);
    drop();
  } catch (e) {
    drop();
    updateProject(id, (x) => ({ ...x, chat: [...x.chat, ai(`${describeError(e)} 이번에는 로컬 생성기로 대신 만들었어요.`, { error: true })] }));
    fallback();
  }
}
