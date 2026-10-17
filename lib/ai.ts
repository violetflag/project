"use client";

// Optional Claude backend. The site is static, so each visitor brings their
// own Anthropic API key; it is kept only in this browser's localStorage and
// sent straight to the Anthropic API. Without a key the local generator runs.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import { loadBinary } from "./files";
import type { FeatureGroup, Finding, PrdSection, Project, Question } from "./types";

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

function styleOf(p: Pick<Project, "settings">) {
  const lang = p.settings.language === "English" ? "Write every output string in English." : "모든 출력 문장은 한국어로 씁니다.";
  return `${lang} 문체: ${p.settings.tone}.`;
}

// Every call uses the model, effort and context size picked in AI settings.
// Streaming keeps long answers (up to 64K tokens) from hitting HTTP timeouts.
async function ask<T extends z.ZodType>(schema: T, prompt: string, files: Anthropic.Beta.BetaContentBlockParam[] = []): Promise<z.infer<T>> {
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

const answersText = (p: Pick<Project, "questions" | "answers">) =>
  p.questions.filter((q) => p.answers[q.id]).map((q) => `- ${q.text}: ${p.answers[q.id].join(", ")}`).join("\n") || "(답변 없음)";

// Attached material: text goes into the prompt, PDFs and images as content blocks.
type Src = Pick<Project, "id" | "materials">;
const materialText = (p: Src) => (p.materials ?? []).filter((m) => m.text)
  .map((m) => `\n[첨부 자료: ${m.name}]\n${m.text}`).join("\n");
async function materialBlocks(p: Src): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  if (!p.materials?.some((m) => m.kind !== "text")) return [];
  const bin = await loadBinary(p.id);
  return bin.map((m) => m.kind === "pdf"
    ? { type: "document" as const, title: m.name, source: { type: "base64" as const, media_type: "application/pdf" as const, data: m.data } }
    : { type: "image" as const, source: { type: "base64" as const, media_type: m.mediaType as "image/png", data: m.data } });
}
const materialNote = (p: Src) => (p.materials?.length ? "\n사용자가 첨부한 자료를 꼼꼼히 읽고, 자료에 있는 내용은 다시 묻지 말고 그대로 반영합니다." : "");

// --- Questions -------------------------------------------------------------

const QuestionsSchema = z.object({
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

// --- PRD and feature spec --------------------------------------------------

const FeatureSchema = z.object({
  title: z.string(),
  summary: z.string(),
  rationale: z.string(),
  success: z.string(),
  criteria: z.array(z.string()),
  roles: z.array(z.string()),
  priority: z.enum(["높음", "보통", "낮음"]),
});
const PlanSchema = z.object({
  prd: z.array(z.object({
    title: z.string(),
    blocks: z.array(z.object({ label: z.string(), body: z.string() })),
  })),
  groups: z.array(z.object({ title: z.string(), features: z.array(FeatureSchema) })),
});
type AiFeature = z.infer<typeof FeatureSchema>;

const PRIORITY = { 높음: 3, 보통: 2, 낮음: 1 } as const;
let seq = 0;
const nid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function toFeature(f: AiFeature, code: string) {
  return {
    id: nid("f_"), code, title: f.title, summary: f.summary, rationale: f.rationale, success: f.success,
    criteria: f.criteria, roles: f.roles.length ? f.roles : ["사용자"], status: "draft" as const, priority: PRIORITY[f.priority] as 1 | 2 | 3,
  };
}

export async function aiPlan(p: Project): Promise<{ prd: PrdSection[]; groups: FeatureGroup[] }> {
  const out = await ask(PlanSchema, `아이디어: ${p.idea}${materialText(p)}${materialNote(p)}
질문에 대한 답:
${answersText(p)}

이 서비스의 첫 출시(MVP) 기획서를 만들어 주세요.

1) prd: 다섯 섹션을 이 순서로 씁니다. 개요(한 줄 정의, 제품 목표, 배경) / 문제 및 해결 방안(문제 정의, 해결 방식, 비목표) / 타겟 및 시나리오(타겟 사용자, 사용 시나리오) / 성공 지표(핵심 지표, 보조 지표: 숫자 목표 포함) / 리스크와 범위(리스크, 수익 모델, 출시 형태). 각 블록 본문은 2~5문장이고, 시나리오는 번호 목록으로 씁니다.
2) groups: 기능 묶음 4~6개, 묶음마다 세부 기능 2~4개. 기능마다 한 줄 요약, 필요한 이유, 성공 기준, 테스트할 수 있는 수용 기준 2~4개, 쓰는 역할(예: 사용자, 운영자), 우선순위(높음/보통/낮음)를 씁니다.
${styleOf(p)}`, await materialBlocks(p));
  const ids = ["overview", "problem", "target", "metrics", "risk"];
  const prd = out.prd.map((s, i) => ({ id: ids[i] ?? nid("s_"), title: s.title, blocks: s.blocks }));
  const groups = out.groups.map((g, gi) => ({
    id: nid("g_"), code: String(gi + 1), title: g.title,
    features: g.features.map((f, fi) => toFeature(f, `${gi + 1}.${fi + 1}`)),
  }));
  return { prd, groups };
}

// --- Review ------------------------------------------------------------------

const ReviewSchema = z.object({
  findings: z.array(z.object({
    perspective: z.enum(["개발", "사업", "UX·디자인", "QA", "보안", "운영"]),
    level: z.enum(["주의", "제안"]),
    title: z.string(),
    body: z.string(),
    featureCode: z.string(),
  })),
});

// With the large context size the full PRD rides along with the spec.
const prdText = (p: Project) => (ctx().id === "large" && p.prd
  ? "\nPRD 전문:\n" + p.prd.map((s) => `## ${s.title}\n` + s.blocks.map((b) => `- ${b.label}: ${b.body}`).join("\n")).join("\n") + "\n"
  : "");

const specText = (groups: FeatureGroup[]) => groups.map((g) =>
  `${g.code}. ${g.title}\n` + g.features.map((f) =>
    `  ${f.code} ${f.title}: ${f.summary} [수용 기준: ${f.criteria.join(" / ")}]`).join("\n")).join("\n");

export async function aiReview(p: Project): Promise<Finding[]> {
  const groups = p.groups ?? [];
  const out = await ask(ReviewSchema, `아이디어: ${p.idea}
${prdText(p)}기능명세서:
${specText(groups)}

개발, 사업, UX·디자인, QA, 보안, 운영 여섯 관점에서 이 기능명세서의 빈틈을 찾아 주세요. 관점마다 1~2개, 실제로 이 명세에 빠져 있거나 모호한 점만 씁니다.
- title은 한 줄로 무엇이 빠졌는지, body는 왜 문제인지와 무엇을 정해야 하는지 2~3문장.
- 특정 기능에 대한 지적이면 featureCode에 그 기능 번호(예: 2.1)를, 전체에 대한 지적이면 빈 문자열을 넣습니다.
${styleOf(p)}`);
  const all = groups.flatMap((g) => g.features);
  return out.findings.map((f) => ({
    id: nid("r_"), perspective: f.perspective, level: f.level, title: f.title, body: f.body,
    featureId: all.find((x) => x.code === f.featureCode)?.id, state: "open" as const,
  }));
}

const ChoicesSchema = z.object({
  intro: z.string(),
  options: z.array(z.object({ title: z.string(), detail: z.string() })),
});

export async function aiChoices(p: Project, finding: Finding) {
  return ask(ChoicesSchema, `아이디어: ${p.idea}
기능명세서:
${specText(p.groups ?? [])}

검토 의견: ${finding.title}
${finding.body}

이 의견을 해결하는 서로 다른 방법 3개를 제안해 주세요. title은 방법을 한 줄로, detail은 장단점을 한두 문장으로 씁니다. intro는 사용자에게 하나를 고르라고 안내하는 한 문장입니다.
${styleOf(p)}`);
}

const EditSchema = z.object({
  summary: z.string(),
  criteria: z.array(z.string()),
});

export async function aiApplyChoice(p: Project, featureCode: string, issue: string, choice: string) {
  const f = (p.groups ?? []).flatMap((g) => g.features).find((x) => x.code === featureCode);
  return ask(EditSchema, `아이디어: ${p.idea}
고칠 기능: ${f?.code} ${f?.title}
현재 요약: ${f?.summary}
현재 수용 기준:
${f?.criteria.map((c) => `- ${c}`).join("\n")}

검토 의견 "${issue}"을(를) "${choice}" 방식으로 해결하도록 이 기능의 요약과 수용 기준 전체를 다시 써 주세요. 기존 기준 중 여전히 맞는 것은 유지합니다.
${styleOf(p)}`);
}

// --- Free-form chat ----------------------------------------------------------

const ChatSchema = z.object({
  reply: z.string(),
  action: z.enum(["none", "add_feature", "edit_feature", "review"]),
  groupCode: z.string(),
  featureCode: z.string(),
  feature: FeatureSchema,
});

export async function aiChat(p: Project, text: string) {
  const recent = p.chat.slice(-ctx().history).filter((m) => m.text).map((m) => `${m.from === "user" ? "사용자" : "AI"}: ${m.text}`).join("\n");
  return ask(ChatSchema, `아이디어: ${p.idea}
${prdText(p)}기능명세서:
${p.groups ? specText(p.groups) : "(아직 없음)"}

최근 대화:
${recent}

사용자의 새 메시지: ${text}

사용자에게 답하고, 기획서를 바꿔야 하면 바꿀 안을 함께 만들어 주세요.
- 새 기능을 원하면 action=add_feature, groupCode에 넣을 기능 묶음 번호, feature에 새 기능 전체를 씁니다.
- 기존 기능을 고치거나 구체화하길 원하면 action=edit_feature, featureCode에 그 기능 번호, feature에 고친 뒤의 기능 전체를 씁니다.
- 기획 검토를 원하면 action=review.
- 그 밖에는 action=none이고, groupCode와 featureCode는 빈 문자열, feature는 아무 값이나 채웁니다.
- 기획서가 아직 없으면 action=none으로 두고 질문에 먼저 답해 달라고 안내합니다.
- reply는 2~4문장. 수정안을 만들었다면 기능명세서에서 승인해야 반영된다고 알려 줍니다.
${styleOf(p)}`);
}
