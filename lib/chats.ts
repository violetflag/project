"use client";

// Several conversations per project: 새 채팅 puts the current one aside (chatArchive) and starts
// fresh; the list reopens any of them. Documents are shared by all conversations.
import { uid } from "./id";
import { ai, isBusy } from "./run";
import { getProject, updateProject } from "./store";
import type { ChatMessage, ChatThread, Project } from "./types";

const MENTION = /@\[([^\]]+)\]\([^)]+\)/g;
const titleOf = (chat: ChatMessage[]) => {
  const first = chat.find((m) => m.from === "user" && m.text.trim());
  const t = (first?.text ?? chat.find((m) => m.text.trim())?.text ?? "대화").replace(MENTION, "@$1").replace(/\s+/g, " ").trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
};
// Only conversations with something the user said are worth keeping.
const worthKeeping = (chat: ChatMessage[]) => chat.some((m) => m.from === "user");
const greeting = () => ai("새 대화를 시작했어요. 문서는 그대로 두고 대화만 새로 해요. 무엇을 도와드릴까요?");

function putAside(p: Project): ChatThread[] {
  const list = p.chatArchive ?? [];
  if (!worthKeeping(p.chat)) return list;
  return [{ id: uid("c_"), title: titleOf(p.chat), at: Date.now(), chat: p.chat }, ...list].slice(0, 50);
}

export function newChat(id: string) {
  const p = getProject(id);
  if (!p || isBusy(p)) return;
  updateProject(id, (x) => ({ ...x, chatArchive: putAside(x), chat: [greeting()] }));
}

export function openChat(id: string, threadId: string) {
  const p = getProject(id);
  if (!p || isBusy(p)) return;
  updateProject(id, (x) => {
    const t = x.chatArchive?.find((c) => c.id === threadId);
    if (!t) return x;
    const rest = putAside({ ...x, chatArchive: x.chatArchive?.filter((c) => c.id !== threadId) });
    return { ...x, chat: t.chat, chatArchive: rest };
  });
}

export function deleteChat(id: string, threadId: string) {
  updateProject(id, (x) => ({ ...x, chatArchive: x.chatArchive?.filter((c) => c.id !== threadId) }));
}

export const currentChatTitle = (p: Project) => (worthKeeping(p.chat) ? titleOf(p.chat) : "새 대화");
