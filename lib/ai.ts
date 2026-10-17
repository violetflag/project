"use client";

// Optional Claude backend. The site is static, so each visitor brings their
// own Anthropic API key; it is kept only in this browser's localStorage and
// sent straight to the Anthropic API. Without a key the local generator runs.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import { loadBinary } from "./files";
import type { Project, Question } from "./types";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5", hint: "기본 추천. 깊이 있게 기획해요", fallback: true },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "빠르고 똑똑해요. 비용은 Opus의 절반", fallback: true },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", hint: "가장 빠르고 저렴해요", fallback: false },
  { id: "claude-fable-5-1", label: "Fable 5.1", hint: "가장 강력해요. 비용이 가장 높아요", fallback: true },
] as const;
export type ModelId = (typeof MODELS)[number]["id"];

export const EFFORTS = [
  { id: "low", label: "낮음", hint: "빠르게 답해요" },
  { id: "medium", label: "보통", hint: "속도와 품질의 균형" },
  { id: "high", label: "높음", hint: "더 꼼꼼하게 생각해요" },
  { id: "xhigh", label: "매우 높음", hint: "어려운 기획에 좋아요" },
  { id: "max", label: "최대", hint: "가장 오래, 가장 깊게 생각해요" },
] as const;
export type Effort = (typeof EFFORTS)[number]["id"];

// How much of the project goes to the model, and how long an answer may be.
export const CONTEXTS = [
  { id: "small", label: "작게", hint: "최근 대화 6개 · 답변 최대 16K 토큰", history: 6, maxTokens: 16000 },
  { id: "medium", label: "보통", hint: "최근 대화 20개 · 답변 최대 32K 토큰", history: 20, maxTokens: 32000 },
  { id: "large", label: "크게", hint: "대화 전체와 PRD 전문 · 답변 최대 64K 토큰", history: 1000, maxTokens: 64000 },
] as const;
export type ContextSize = (typeof CONTEXTS)[number]["id"];

export interface AiSettings { model: ModelId; effort: Effort; context: ContextSize }
const DEFAULTS: AiSettings = { model: "claude-opus-5-5", effort: "medium", context: "medium" };

const KEY = "planspace.anthropic.key";
const SETTINGS = "planspace.ai.settings";

const listeners = new Set<() => void>();
const PREFS_AT = "planspace.ai.updatedAt";
const localListeners = new Set<() => void>();
export const onLocalAiChange = (l: () => void) => {
  localListeners.add(l);
  return () => localListeners.delete(l);
};
// A change made on this device: remember when, so the newest wins when syncing.
const emit = (fromSync = false) => {
  if (!fromSync) {
    try {
      localStorage.setItem(PREFS_AT, String(Date.now()));
    } catch {
      // Not critical.
    }
    localListeners.forEach((l) => l());
  }
  listeners.forEach((l) => l());
};
export function getAiUpdatedAt() {
  try {
    return Number(localStorage.getItem(PREFS_AT) || 0);
  } catch {
    return 0;
  }
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function readKey(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}
export function getApiKey() {
  return readKey();
}
export function setApiKey(key: string) {
  try {
    if (key) localStorage.setItem(KEY, key);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: nothing to persist.
  }
  emit();
}
export function useApiKey() {
  return useSyncExternalStore(subscribe, readKey, () => "");
}

let settingsCache: AiSettings | null = null;
export function getAiSettings(): AiSettings {
  if (settingsCache) return settingsCache;
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS) || "{}");
    settingsCache = {
      model: MODELS.some((m) => m.id === raw.model) ? raw.model : DEFAULTS.model,
      effort: EFFORTS.some((e) => e.id === raw.effort) ? raw.effort : DEFAULTS.effort,
      context: CONTEXTS.some((c) => c.id === raw.context) ? raw.context : DEFAULTS.context,
    };
  } catch {
    settingsCache = DEFAULTS;
  }
  return settingsCache;
}
export function setAiSettings(patch: Partial<AiSettings>) {
  settingsCache = { ...getAiSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS, JSON.stringify(settingsCache));
  } catch {
    // Keep the in-memory choice.
  }
  emit();
}
// Apply the key and settings saved from another device.
export function applySyncedAi(key: string, settings: AiSettings, at: number) {
  try {
    if (key) localStorage.setItem(KEY, key);
    else localStorage.removeItem(KEY);
    localStorage.setItem(SETTINGS, JSON.stringify(settings));
    localStorage.setItem(PREFS_AT, String(at));
  } catch {
    // Storage blocked.
  }
  settingsCache = null;
  emit(true);
}

export function useAiSettings() {
  return useSyncExternalStore(subscribe, getAiSettings, () => DEFAULTS);
}
export const modelLabel = (id: ModelId) => MODELS.find((m) => m.id === id)?.label ?? id;
const ctx = () => CONTEXTS.find((c) => c.id === getAiSettings().context) ?? CONTEXTS[1];

function client() {
  const apiKey = readKey();
  if (!apiKey) throw new Error("API 키가 없어요.");
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

const SYSTEM = `당신은 서비스 기획을 돕는 시니어 프로덕트 매니저입니다.
사용자가 준 아이디어와 답변에 맞춰, 그 서비스에만 해당하는 구체적인 내용을 씁니다. 어느 서비스에나 붙일 수 있는 일반론은 피합니다.
기획 용어는 쉬운 말로 풀고, 개발자와 디자이너가 바로 일을 시작할 수 있을 만큼 구체적으로 씁니다.`;

// Project customizing (language, tone, house style, terms, don'ts) goes into every prompt.
export function styleOf(p: Pick<Project, "settings">) {
  const s = p.settings;
  const lang = s.language === "English" ? "Write every output string in English." : "모든 출력 문장은 한국어로 씁니다.";
  return [
    `${lang} 문체: ${s.tone}.`,
    s.style && `기획서 문체: ${s.style}.`,
    s.format && `기능 설명 양식: ${s.format}.`,
    s.terms && `반드시 쓸 팀 용어: ${s.terms}.`,
    s.avoid && `하지 말아야 할 것: ${s.avoid}.`,
    s.extra && `참고: ${s.extra}.`,
  ].filter(Boolean).join(" ");
}

// Every call uses the model, effort and context size picked in AI settings.
// Streaming keeps long answers (up to 64K tokens) from hitting HTTP timeouts.
export async function ask<T extends z.ZodType>(schema: T, prompt: string, files: Anthropic.Beta.BetaContentBlockParam[] = []): Promise<z.infer<T>> {
  const { model, effort } = getAiSettings();
  const withFallback = MODELS.find((m) => m.id === model)?.fallback;
  const res = await client().beta.messages.stream({
    model,
    max_tokens: ctx().maxTokens,
    ...(withFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    system: SYSTEM,
    output_config: { effort, format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content: [...files, { type: "text", text: prompt }] }],
  }).finalMessage();
  if (res.stop_reason === "refusal") throw new Error("AI가 이 요청에는 답하지 않았어요.");
  if (res.stop_reason === "max_tokens") throw new Error("답이 너무 길어 중간에 끊겼어요. AI 설정에서 컨텍스트 크기를 키워 보세요.");
  if (!res.parsed_output) throw new Error("AI 응답을 읽지 못했어요.");
  return res.parsed_output as z.infer<T>;
}

export function describeError(e: unknown) {
  if (e instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않아요. 설정에서 키를 다시 확인해 주세요.";
  if (e instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 해당 모델을 쓸 수 없어요.";
  if (e instanceof Anthropic.RateLimitError) return "요청이 많아 잠시 막혔어요. 조금 뒤에 다시 시도해 주세요.";
  if (e instanceof Anthropic.APIConnectionError) return "Anthropic 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.";
  if (e instanceof Anthropic.APIError) return `AI 호출이 실패했어요 (${e.status ?? "오류"}).`;
  return e instanceof Error ? e.message : "알 수 없는 오류가 났어요.";
}

export const answersText = (p: Pick<Project, "questions" | "answers">) =>
  p.questions.filter((q) => p.answers[q.id]).map((q) => `- ${q.text}: ${p.answers[q.id].join(", ")}`).join("\n") || "(답변 없음)";

// Attached material: text goes into the prompt, PDFs and images as content blocks.
type Src = Pick<Project, "id" | "materials">;
export const materialText = (p: Src) => (p.materials ?? []).filter((m) => m.text)
  .map((m) => `\n[첨부 자료: ${m.name}]\n${m.text}`).join("\n");
export async function materialBlocks(p: Src): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  if (!p.materials?.some((m) => m.kind !== "text")) return [];
  const bin = await loadBinary(p.id);
  return bin.map((m) => m.kind === "pdf"
    ? { type: "document" as const, title: m.name, source: { type: "base64" as const, media_type: "application/pdf" as const, data: m.data } }
    : { type: "image" as const, source: { type: "base64" as const, media_type: m.mediaType as "image/png", data: m.data } });
}
export const materialNote = (p: Src) => (p.materials?.length ? "\n사용자가 첨부한 자료를 꼼꼼히 읽고, 자료에 있는 내용은 다시 묻지 말고 그대로 반영합니다." : "");

// --- Questions -------------------------------------------------------------

export const QuestionsSchema = z.object({
  questions: z.array(z.object({
    text: z.string(),
    multi: z.boolean(),
    options: z.array(z.string()),
  })),
});

export async function aiQuestions(p: Pick<Project, "id" | "materials" | "idea" | "settings" | "questions" | "answers">, count: number): Promise<Question[]> {
  const asked = p.questions.length ? `\n이미 한 질문과 답:\n${answersText(p)}\n위와 겹치지 않는 새 질문만 만듭니다.` : "";
  const out = await ask(QuestionsSchema, `아이디어: ${p.idea}${materialText(p)}
${asked}${materialNote(p)}
이 아이디어로 PRD를 쓰기 전에 범위를 좁히기 위한 객관식 질문 ${count}개를 만들어 주세요.
- 대상 사용자, 핵심 문제, 꼭 필요한 기능, 출시 형태, 수익 방식처럼 기획에 큰 영향을 주는 것부터 묻습니다.
- 각 질문의 선택지는 3~5개, 이 아이디어에 맞춘 구체적인 문장으로 씁니다.
- 여러 개를 고를 수 있는 질문이면 multi를 true로 합니다.
${styleOf(p)}`, await materialBlocks(p));
  return out.questions.slice(0, count).map((q, i) => ({
    id: `q${Date.now().toString(36)}${i}`, text: q.text, multi: q.multi, options: q.options.slice(0, 5),
  }));
}

export async function aiSummary(p: Project): Promise<string> {
  const out = await ask(z.object({ summary: z.string() }), `아이디어: ${p.idea}
답변:
${answersText(p)}
지금까지의 답을 2~3문장으로 정리하고, 이 내용으로 PRD 초안을 만들 수 있다고 안내하는 문장을 써 주세요. ${styleOf(p)}`);
  return out.summary;
}

// Context helpers for the feature modules (spec, flow, wireframe, assistant).
export const historySize = () => ctx().history;
export const largeContext = () => ctx().id === "large";
export const prdText = (p: Pick<Project, "prd">) => (p.prd
  ? p.prd.map((s) => `## ${s.title}\n` + s.blocks.map((b) => `- ${b.label}: ${b.body}`).join("\n")).join("\n")
  : "(PRD 없음)");
