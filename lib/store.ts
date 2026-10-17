"use client";

import { useSyncExternalStore } from "react";
import { uid } from "./id";
import { makeQuestions, shortName } from "./generator";
import type { Project } from "./types";

// Projects live in localStorage so the app works on static hosting.
const KEY = "planspace.projects.v1";
let cache: Project[] | null = null;
const listeners = new Set<() => void>();

function load(): Project[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    cache = [];
  }
  return cache!;
}

function save(next: Project[]) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: keep working in memory.
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const EMPTY: Project[] = [];

export function useProjects() {
  return useSyncExternalStore(subscribe, load, () => EMPTY);
}

export function getProject(id: string) {
  return load().find((p) => p.id === id) ?? null;
}

export function useProject(id: string | null) {
  const all = useProjects();
  return all.find((p) => p.id === id) ?? null;
}

export function createProject(idea: string, startFrom: "ask" | "files" = "ask", withAi = false, materials: Project["materials"] = []): Project {
  const now = Date.now();
  // With AI on, questions arrive asynchronously (see initQuestions).
  const questions = withAi ? [] : makeQuestions();
  const p: Project = {
    id: uid("p_"),
    name: shortName(idea),
    idea,
    materials,
    createdAt: now,
    updatedAt: now,
    questions,
    answers: {},
    chat: [
      { id: uid("m_"), from: "ai", text: startFrom === "files"
        ? `올려 주신 자료(${materials.map((m) => m.name).join(", ") || "없음"})를 기준으로 기획을 시작할게요. 빠진 부분을 채우기 위해 몇 가지만 여쭤볼게요.`
        : "안녕하세요. 기획을 함께 정리할 AI 어시스턴트예요. 범위와 대상을 분명히 하기 위해 여섯 가지만 여쭤볼게요." },
      withAi
        ? { id: uid("m_"), from: "ai", text: "아이디어에 맞는 질문을 만들고 있어요…", thinking: true }
        : { id: uid("m_"), from: "ai", text: "", question: questions[0] },
    ],
    prd: null,
    groups: null,
    flow: null,
    screens: null,
    findings: null,
    pending: [],
    comments: [],
    decisions: [],
    notes: [],
    versions: [],
    log: [{ id: uid("l_"), at: now, text: "프로젝트를 만들었어요" }],
    settings: { language: "한국어", tone: "간결하게" },
  };
  save([p, ...load()]);
  return p;
}

export function updateProject(id: string, fn: (p: Project) => Project, logText?: string) {
  save(load().map((p) => {
    if (p.id !== id) return p;
    const next = fn(p);
    next.updatedAt = Date.now();
    if (logText) next.log = [{ id: uid("l_"), at: Date.now(), text: logText }, ...next.log].slice(0, 200);
    return next;
  }));
}

export function trashProject(id: string) {
  updateProject(id, (p) => ({ ...p, deletedAt: Date.now() }));
}
export function restoreProject(id: string) {
  updateProject(id, (p) => ({ ...p, deletedAt: undefined }));
}
export function purgeProject(id: string) {
  save(load().filter((p) => p.id !== id));
}

// Restores a project from a "JSON 백업" file. A clashing id gets a fresh one.
export function importProject(json: string): Project {
  const p = JSON.parse(json) as Project;
  if (!p || typeof p.idea !== "string" || !Array.isArray(p.chat)) throw new Error("Planspace 백업 파일이 아니에요.");
  const all = load();
  const next: Project = { ...p, id: all.some((x) => x.id === p.id) ? uid("p_") : p.id, deletedAt: undefined, updatedAt: Date.now() };
  save([next, ...all]);
  return next;
}
