"use client";

// PRD and feature-spec actions: AI generation (with local fallbacks), the
// approve/reject review of AI proposals, and direct item editing.
import { josa } from "./josa";
import { z } from "zod";
import { answersText, ask, materialBlocks, materialNote, materialText, prdText, styleOf } from "./ai";
import { ai, aiEnabled, isBusy, withAi } from "./run";
import {
  approveAll, approveItem, blankItem, coreOf, counts, findItem, flatten, insertItem, pathTo, pendingItems,
  proposeEdit, rejectAll, rejectItem, removeItem, specText, updateItem,
} from "./spec-model";
import { cloneItem, localAnswer, localEnhance, localFill, localPrd, localSpec, type SpecPlan } from "./spec-local";
import { getProject, updateProject } from "./store";
import { saveToDrive } from "./sync";
import { SLOTS } from "./types";
import type { PrdProps, PrdSection, Project, SlotKey, SlotQuestion, SpecCore, SpecItem } from "./types";
import { autoVersion } from "./versions";

const SLOT_KEYS = SLOTS.map(([k]) => k) as [SlotKey, ...SlotKey[]];
const slotGuide = SLOTS.map(([k, l]) => `${k}=${l}`).join(", ");
const qid = () => `sq_${Math.random().toString(36).slice(2, 9)}`;
const clampP = (n: number) => (Math.min(3, Math.max(1, Math.round(n || 2))) as 1 | 2 | 3);

// --- PRD -------------------------------------------------------------------------------

const PrdSchema = z.object({
  oneLiner: z.string(), goal: z.string(), background: z.string(),
  problem: z.string(), solution: z.string(), differentiation: z.string(),
  target: z.string(), scenario: z.string(),
  metrics: z.string(), risks: z.string(),
  category: z.string(), roles: z.array(z.string()), devices: z.array(z.string()),
});

function prdFrom(o: z.infer<typeof PrdSchema>): { prd: PrdSection[]; props: PrdProps } {
  return {
    prd: [
      { id: "overview", title: "개요", blocks: [{ label: "한 줄 정의", body: o.oneLiner }, { label: "제품 목표", body: o.goal }, { label: "배경", body: o.background }] },
      { id: "problem", title: "문제 및 해결 방안", blocks: [{ label: "사용자 문제", body: o.problem }, { label: "해결 방안", body: o.solution }, { label: "차별점", body: o.differentiation }] },
      { id: "target", title: "타겟 및 시나리오", blocks: [{ label: "타겟 사용자", body: o.target }, { label: "사용자 시나리오", body: o.scenario }] },
      { id: "metrics", title: "성공·위험 요소", blocks: [{ label: "핵심 지표", body: o.metrics }, { label: "리스크", body: o.risks }] },
    ],
    props: { category: o.category, roles: o.roles.length ? o.roles : ["일반 사용자", "관리자"], devices: o.devices },
  };
}

function applyPrd(id: string, out: { prd: PrdSection[]; props: PrdProps }) {
  updateProject(id, (p) => ({
    ...p, prd: out.prd, prdProps: out.props,
    stale: p.spec ? { ...p.stale, flow: p.flows.length > 0, wire: p.wires.length > 0 } : p.stale,
    chat: [...p.chat, ai(`PRD 초안을 정리했어요. 오른쪽 문서에서 내용과 속성(카테고리·사용자 역할·기기)을 확인하고 고쳐 주세요.\n이 PRD와 역할(${out.props.roles.join(", ")})을 바탕으로 요구사항 → 기능 → 상세 기능까지 기능명세서를 이어서 만들 수 있어요.`, { actions: ["complete-spec"] })],
  }), "PRD를 만들었어요");
  autoVersion(id, "PRD 작성");
  saveToDrive();
}

// Resolves once p.prd is written (AI or local).
export async function generatePrd(id: string): Promise<void> {
  const p = getProject(id);
  if (!p || isBusy(p)) return;
  if (!aiEnabled()) return applyPrd(id, localPrd(p));
  await withAi(id, "PRD를 작성하고 있어요", async (x, step) => {
    step("아이디어와 답변 읽음");
    const o = await ask(PrdSchema, `아이디어: ${x.idea}${materialText(x)}
질문 답변:
${answersText(x)}
${materialNote(x)}
이 서비스의 PRD를 써 주세요. 각 필드는 2~4문장, 이 서비스에만 해당하는 구체적인 내용으로 씁니다.
- oneLiner: 한 줄 정의 / goal: 제품 목표(측정 가능한 목표 포함) / background: 배경
- problem: 사용자 문제 / solution: 해결 방안 / differentiation: 기존 방법과의 차별점
- target: 타겟 사용자(주·보조) / scenario: 대표 사용자 시나리오를 "1. … 2. …" 줄바꿈 목록으로
- metrics: 핵심 지표(숫자 목표) / risks: 리스크와 대응
- category: 서비스 카테고리 한 단어 / roles: 사용자 역할 2~4개(예: 일반 사용자, 운영자, 관리자) / devices: 지원 기기
${styleOf(x)}`, await materialBlocks(x));
    step("PRD 작성 완료");
    applyPrd(id, prdFrom(o));
  }, () => applyPrd(id, localPrd(getProject(id)!)));
}

// Direct PRD edits from the PRD tab.
const editPrd = (id: string, fn: (s: PrdSection[]) => PrdSection[]) => updateProject(id, (p) => (p.prd ? {
  ...p, prd: fn(p.prd), stale: p.spec ? { ...p.stale, flow: p.flows.length > 0, wire: p.wires.length > 0 } : p.stale,
} : p));
export function setPrdBlock(id: string, sid: string, idx: number, patch: Partial<{ label: string; body: string }>) {
  editPrd(id, (ss) => ss.map((s) => (s.id === sid ? { ...s, blocks: s.blocks.map((b, i) => (i === idx ? { ...b, ...patch } : b)) } : s)));
}
export function addPrdBlock(id: string, sid: string) {
  editPrd(id, (ss) => ss.map((s) => (s.id === sid ? { ...s, blocks: [...s.blocks, { label: "새 항목", body: "" }] } : s)));
}
export function deletePrdBlock(id: string, sid: string, idx: number) {
  editPrd(id, (ss) => ss.map((s) => (s.id === sid ? { ...s, blocks: s.blocks.filter((_, i) => i !== idx) } : s)));
}
export function setPrdProps(id: string, patch: Partial<PrdProps>) {
  updateProject(id, (p) => ({ ...p, prdProps: { category: "", roles: [], devices: [], ...p.prdProps, ...patch } }));
}

// --- Spec schemas ------------------------------------------------------------------------

const SlotsSchema = z.object(Object.fromEntries(SLOT_KEYS.map((k) => [k, z.array(z.string())])) as Record<SlotKey, z.ZodArray<z.ZodString>>);
const QSchema = z.object({ slot: z.enum(SLOT_KEYS), text: z.string(), options: z.array(z.string()), recommended: z.number() });
const DetailSchema = z.object({ title: z.string(), summary: z.string(), slots: SlotsSchema, questions: z.array(QSchema) });
const FeatureSchema = z.object({
  title: z.string(), summary: z.string(), roles: z.array(z.string()), priority: z.number(),
  rationale: z.string(), success: z.string(), slots: SlotsSchema, questions: z.array(QSchema), details: z.array(DetailSchema),
});
const ReqSchema = z.object({ title: z.string(), summary: z.string(), criteria: z.array(z.string()), priority: z.number(), features: z.array(FeatureSchema) });
const EditSchema = z.object({
  code: z.string(), reason: z.string(), summary: z.string(), rationale: z.string(), success: z.string(),
  criteria: z.array(z.string()), slots: SlotsSchema, questions: z.array(QSchema),
});
const SpecSchema = z.object({
  requirements: z.array(ReqSchema),
  newFeatures: z.array(z.object({ parentCode: z.string(), feature: FeatureSchema })),
  newDetails: z.array(z.object({ parentCode: z.string(), detail: DetailSchema })),
  edits: z.array(EditSchema),
});

const cleanSlots = (s: z.infer<typeof SlotsSchema>) => {
  const out: Partial<Record<SlotKey, string[]>> = {};
  for (const k of SLOT_KEYS) { const v = (s[k] ?? []).map((x) => x.trim()).filter(Boolean); if (v.length) out[k] = v; }
  return out;
};
const toQs = (qs: z.infer<typeof QSchema>[]): SlotQuestion[] | undefined => (qs.length ? qs.map((q) => ({
  id: qid(), slot: q.slot, text: q.text, options: q.options.slice(0, 4),
  recommended: q.recommended >= 0 && q.recommended < q.options.length ? Math.round(q.recommended) : undefined,
})) : undefined);
const fixRoles = (rs: string[], allowed: string[]) => {
  const ok = rs.filter((r) => !allowed.length || allowed.includes(r));
  return ok.length ? ok : allowed.slice(0, 1);
};

function detailItem(d: z.infer<typeof DetailSchema>, roles: string[]): SpecItem {
  return { ...blankItem(3, d.title, { kind: "new" }), summary: d.summary, roles, slots: cleanSlots(d.slots), questions: toQs(d.questions) };
}
function featureItem(f: z.infer<typeof FeatureSchema>, allowed: string[]): SpecItem {
  const roles = fixRoles(f.roles, allowed);
  return {
    ...blankItem(2, f.title, { kind: "new" }), summary: f.summary, roles, priority: clampP(f.priority),
    rationale: f.rationale, success: f.success, slots: cleanSlots(f.slots), questions: toQs(f.questions),
    children: f.details.map((d) => detailItem(d, roles)),
  };
}
function reqItem(r: z.infer<typeof ReqSchema>, allowed: string[]): SpecItem {
  const children = r.features.map((f) => featureItem(f, allowed));
  return { ...blankItem(1, r.title, { kind: "new" }), summary: r.summary, criteria: r.criteria, priority: clampP(r.priority), roles: [...new Set(children.flatMap((c) => c.roles))], children };
}

// --- Applying a plan ---------------------------------------------------------------------------

function applyPlan(id: string, plan: SpecPlan, step?: (s: string) => void) {
  updateProject(id, (p) => {
    let spec = p.spec ?? [];
    for (const e of plan.edits) if (findItem(spec, e.id)) spec = proposeEdit(spec, e.id, e.patch, e.reason);
    spec = [...spec, ...plan.roots];
    for (const u of plan.under) spec = insertItem(spec, u.parentId, u.item);
    return { ...p, spec };
  }, "기능명세서 제안을 추가했어요");
  const added = flatten([...plan.roots, ...plan.under.map((u) => u.item)]);
  if (step) {
    step("요구사항 작성 완료");
    step("기능 작성 완료");
    step("상세 기능 작성 완료");
  }
  const c = { req: added.filter((x) => x.level === 1).length, feat: added.filter((x) => x.level === 2).length, detail: added.filter((x) => x.level === 3).length };
  const qs = added.reduce((n, x) => n + (x.questions?.length ?? 0), 0);
  const examples = added.filter((x) => x.level === 2).slice(0, 3).map((x) => `'${x.title}'`).join(", ");
  const parts = [c.req && `요구사항 ${c.req}개`, c.feat && `기능 ${c.feat}개`, c.detail && `상세 기능 ${c.detail}개`].filter(Boolean).join(" · ");
  const text = !added.length && !plan.edits.length
    ? "지금 기능명세서에서 더 보탤 부분을 찾지 못했어요. 특정 항목을 고치고 싶다면 그 항목의 [보강]을 눌러 주세요."
    : [
      parts ? `기능명세서에 ${parts}를 새로 제안했어요.` : "",
      plan.edits.length ? `기존 항목 ${plan.edits.length}개도 보완하는 수정안을 만들었어요.` : "",
      examples ? `예: ${examples}` : "",
      qs ? `정하지 못한 부분은 질문 카드 ${qs}개로 슬롯 안에 남겨 두었어요.` : "",
      "모든 변경은 승인 대기 중이에요. 기능명세서 아래 검토 바에서 하나씩 또는 한꺼번에 승인·거절해 주세요.",
    ].filter(Boolean).join("\n");
  updateProject(id, (p) => ({ ...p, chat: [...p.chat, ai(text, { actions: ["goto-features"], steps: added.length ? ["문서 읽음", "요구사항 작성 완료", "기능 작성 완료", "상세 기능 작성 완료"] : undefined })] }));
  saveToDrive();
}

const coreBrief = (x: SpecItem) => JSON.stringify({ code: x.code, level: x.level, title: x.title, summary: x.summary, rationale: x.rationale, success: x.success, criteria: x.criteria, roles: x.roles, slots: x.slots, offSlots: x.offSlots });

// Resolves once the spec proposals are written (AI or local).
export async function completeSpec(id: string): Promise<void> {
  const p0 = getProject(id);
  if (!p0 || isBusy(p0)) return;
  if (!p0.prd) {
    updateProject(id, (p) => ({ ...p, chat: [...p.chat, ai("기능명세서는 PRD를 바탕으로 만들어요. 먼저 질문에 답하고 PRD를 만들어 주세요.")] }));
    return;
  }
  const local = () => applyPlan(id, localSpec(getProject(id)!));
  if (!aiEnabled()) return local();
  const has = !!p0.spec?.length;
  await withAi(id, has ? "기능명세서를 보완하고 있어요" : "기능명세서를 작성하고 있어요", async (p, step) => {
    step("문서 읽음");
    const roles = p.prdProps?.roles ?? [];
    const existing = has ? `\n지금 기능명세서(코드 포함, 슬롯 포함):\n${specText(p.spec, true)}\n
이미 있는 내용은 다시 만들지 말고 빠진 것만 더합니다.
- 빠진 요구사항은 requirements에, 기존 요구사항(R-코드) 아래 빠진 기능은 newFeatures(parentCode=R-코드)에, 기존 기능(F-코드) 아래 빠진 상세 기능은 newDetails(parentCode=F-코드)에 넣습니다.
- 기존 항목을 고쳐야 하면 edits에 그 code와 고친 전체 내용(바꾸지 않는 칸은 빈 문자열/빈 배열)과 reason을 넣습니다.` : "\n아직 기능명세서가 없어요. requirements에 전체를 쓰고 newFeatures, newDetails, edits는 빈 배열로 둡니다.";
    const out = await ask(SpecSchema, `아이디어: ${p.idea}${materialText(p)}
질문 답변:
${answersText(p)}
PRD:
${prdText(p)}
사용자 역할: ${roles.join(", ") || "일반 사용자, 관리자"}
${existing}
${materialNote(p)}
요구사항 → 기능 → 상세 기능 3단계 기능명세서를 써 주세요.
- 요구사항(5~8개): summary는 사용자가 이뤄야 할 것, criteria는 검증 가능한 수용 기준 3~5개, priority 1~3(3이 가장 중요).
- 기능(요구사항마다 2~3개): roles는 위 사용자 역할 중에서만 고릅니다. summary, rationale(이 기능이 필요한 근거), success(측정 가능한 성공 기준), priority.
- 상세 기능: 따로 검증할 수 있는 동작만 기능 아래에 0~3개 둡니다.
- slots는 개발 준비 슬롯입니다(${slotGuide}). 기능과 상세 기능의 9칸을 각 1~3문장, 개발자가 바로 구현할 수 있는 구체적인 문장(숫자·조건 포함)으로 채웁니다.
- 아직 정해지지 않아 사람이 골라야 하는 점은 해당 slot에 questions로 남깁니다: text는 "~할까요?" 질문, options 3~4개, recommended는 추천 보기의 0부터 시작하는 번호. 전체에서 4~8개 정도.
${styleOf(p)}`, await materialBlocks(p));
    const cur = getProject(id)!;
    const byCode = (code: string) => flatten(cur.spec).find((x) => x.code === code.trim());
    const plan: SpecPlan = { roots: out.requirements.map((r) => reqItem(r, roles)), under: [], edits: [] };
    for (const f of out.newFeatures) { const t = byCode(f.parentCode); if (t?.level === 1) plan.under.push({ parentId: t.id, item: featureItem(f.feature, roles) }); }
    for (const d of out.newDetails) { const t = byCode(d.parentCode); if (t?.level === 2) plan.under.push({ parentId: t.id, item: detailItem(d.detail, t.roles) }); }
    for (const e of out.edits) {
      const t = byCode(e.code);
      if (!t) continue;
      const patch: Partial<SpecCore> = {};
      if (e.summary.trim()) patch.summary = e.summary;
      if (e.rationale.trim()) patch.rationale = e.rationale;
      if (e.success.trim()) patch.success = e.success;
      if (e.criteria.length) patch.criteria = e.criteria;
      const s = cleanSlots(e.slots);
      if (Object.keys(s).length) patch.slots = { ...t.slots, ...s };
      const q = toQs(e.questions);
      if (q) patch.questions = [...(t.questions ?? []), ...q];
      if (Object.keys(patch).length) plan.edits.push({ id: t.id, patch, reason: e.reason });
    }
    applyPlan(id, plan, step);
  }, local);
}

// --- One item ------------------------------------------------------------------------------

const ItemSchema = z.object({
  reason: z.string(), title: z.string(), summary: z.string(), rationale: z.string(), success: z.string(),
  criteria: z.array(z.string()), slots: SlotsSchema, questions: z.array(QSchema), newChildren: z.array(DetailSchema),
});

function itemContext(p: Project, x: SpecItem) {
  const path = pathTo(p.spec ?? [], x.id).map((y) => `${y.code} ${y.title}`).join(" > ");
  return `아이디어: ${p.idea}\nPRD:\n${prdText(p)}\n사용자 역할: ${(p.prdProps?.roles ?? []).join(", ")}\n기능명세서 개요:\n${specText(p.spec)}\n\n대상 항목(${path}):\n${coreBrief(x)}`;
}

function proposeItem(id: string, itemId: string, patch: Partial<SpecCore>, children: SpecItem[], reason: string) {
  updateProject(id, (p) => {
    if (!p.spec || !findItem(p.spec, itemId)) return p;
    let spec = proposeEdit(p.spec, itemId, patch, reason);
    for (const c of children) spec = insertItem(spec, itemId, c);
    return { ...p, spec };
  }, "항목 수정안을 만들었어요");
  saveToDrive();
}

// Rewrites one item per a one-line request → pending edit (+ pending new children).
export async function enhanceItem(id: string, itemId: string, request: string): Promise<void> {
  const p0 = getProject(id);
  const x0 = p0 && findItem(p0.spec, itemId);
  if (!p0 || !x0 || isBusy(p0)) return;
  const local = () => {
    const p = getProject(id)!;
    const x = findItem(p.spec, itemId);
    if (!x) return;
    const r = localEnhance(p, x, request);
    proposeItem(id, itemId, r.patch, r.children, r.reason);
    updateProject(id, (q) => ({ ...q, chat: [...q.chat, ai(`'${x.title}' 수정안을 만들었어요. 바뀐 부분을 확인하고 승인해 주세요.`)] }));
  };
  if (!aiEnabled()) return local();
  await withAi(id, `'${x0.title}'${josa(x0.title, "을/를")} 보강하고 있어요`, async (p, step) => {
    const x = findItem(p.spec, itemId)!;
    step("항목 읽음");
    const o = await ask(ItemSchema, `${itemContext(p, x)}

요청: ${request}
이 항목만 요청에 맞게 고쳐 전체 내용을 다시 써 주세요. 바꿀 필요 없는 칸은 원래 내용을 그대로 씁니다.
- slots(${slotGuide})는 ${x.level === 1 ? "요구사항이라 빈 배열로 둡니다" : "켜진 칸을 구체적인 문장으로 씁니다"}. criteria는 ${x.level === 1 ? "수용 기준" : "빈 배열"}.
- 새로 정해야 할 점이 생기면 questions에 넣습니다(보기 3~4개, recommended 번호). 기존 질문은 다시 넣지 않습니다.
- 따로 검증할 동작이 새로 생기면 newChildren에 ${x.level === 1 ? "기능" : "상세 기능"}으로 넣습니다(${x.level === 3 ? "상세 기능은 자식을 둘 수 없으니 빈 배열" : "없으면 빈 배열"}).
- reason: 무엇을 왜 바꿨는지 한 문장.
${styleOf(p)}`);
    const patch: Partial<SpecCore> = { title: o.title || x.title, summary: o.summary };
    if (x.level === 1) patch.criteria = o.criteria;
    else {
      patch.slots = cleanSlots(o.slots);
      if (x.level === 2) { patch.rationale = o.rationale; patch.success = o.success; }
    }
    const q = toQs(o.questions);
    if (q) patch.questions = [...(x.questions ?? []), ...q];
    const kids = x.level === 3 ? [] : o.newChildren.map((d) => {
      const c = detailItem(d, x.roles);
      return x.level === 1 ? { ...c, level: 2 as const, code: blankItem(2).code } : c;
    });
    step("수정안 작성 완료");
    proposeItem(id, itemId, patch, kids, o.reason || `요청: ${request}`);
    updateProject(id, (q2) => ({ ...q2, chat: [...q2.chat, ai(`'${x.title}' 수정안을 만들었어요. ${o.reason}\n바뀐 부분을 확인하고 승인해 주세요.`)] }));
  }, local);
}

// Fills the enabled, empty slots of one item → pending edit.
export async function fillSlots(id: string, itemId: string): Promise<void> {
  const p0 = getProject(id);
  const x0 = p0 && findItem(p0.spec, itemId);
  if (!p0 || !x0 || isBusy(p0)) return;
  const local = () => {
    const p = getProject(id)!;
    const x = findItem(p.spec, itemId);
    if (x) proposeItem(id, itemId, { slots: localFill(p, x) }, [], "빈 슬롯 채우기");
  };
  if (!aiEnabled()) return local();
  await withAi(id, `'${x0.title}'의 개발 준비 슬롯을 채우고 있어요`, async (p, step) => {
    const x = findItem(p.spec, itemId)!;
    const empty = SLOT_KEYS.filter((k) => !x.offSlots?.includes(k) && !x.slots?.[k]?.some((s) => s.trim()));
    if (!empty.length) return;
    const o = await ask(z.object({ slots: SlotsSchema }), `${itemContext(p, x)}

이 항목의 개발 준비 슬롯 중 비어 있는 칸(${empty.join(", ")})만 채워 주세요. (${slotGuide})
각 칸 1~3문장, 숫자와 조건이 들어간 구체적인 문장으로 씁니다. 나머지 칸은 빈 배열로 둡니다.
${styleOf(p)}`);
    const add = cleanSlots(o.slots);
    const slots = { ...x.slots };
    for (const k of empty) if (add[k]) slots[k] = add[k];
    step("슬롯 채움");
    proposeItem(id, itemId, { slots }, [], "빈 슬롯 채우기");
  }, local);
}

// Picking an answer on a slot question rewrites that slot directly (no approval).
export async function answerSlotQuestion(id: string, itemId: string, questionId: string, answer: string): Promise<void> {
  const p0 = getProject(id);
  const x0 = p0 && findItem(p0.spec, itemId);
  const q = x0?.questions?.find((y) => y.id === questionId);
  if (!p0 || !x0 || !q || !answer.trim()) return;
  const apply = (sentences: string[]) => {
    updateProject(id, (p) => ({
      ...p, spec: p.spec && updateItem(p.spec, itemId, (x) => ({
        ...x, slots: { ...x.slots, [q.slot]: sentences }, questions: x.questions?.filter((y) => y.id !== questionId),
        // Keep a pending edit's "before" in sync so a reject doesn't bring the question back.
        pending: x.pending?.kind === "edit" && x.pending.prev ? { ...x.pending, prev: { ...x.pending.prev, questions: x.pending.prev.questions?.filter((y) => y.id !== questionId) } } : x.pending,
      })),
    }), `'${x0.title}'의 미결정 사항을 정했어요`);
    saveToDrive();
  };
  const local = () => { const x = findItem(getProject(id)!.spec, itemId); if (x) apply(localAnswer(x, q, answer)); };
  if (!aiEnabled() || isBusy(p0)) return local();
  await withAi(id, "결정한 내용을 반영하고 있어요", async (p) => {
    const x = findItem(p.spec, itemId)!;
    const label = SLOTS.find(([k]) => k === q.slot)?.[1];
    const o = await ask(z.object({ sentences: z.array(z.string()) }), `${itemContext(p, x)}

이 항목의 '${label}' 슬롯에 미결정 질문이 있었어요.
질문: ${q.text}
결정: ${answer}
지금 '${label}' 문장: ${(x.slots?.[q.slot] ?? []).join(" / ") || "(없음)"}
결정을 반영해 '${label}' 슬롯 문장 전체를 1~4문장으로 다시 써 주세요. 구체적인 숫자와 조건을 씁니다.
${styleOf(p)}`);
    apply(o.sentences.map((s) => s.trim()).filter(Boolean));
  }, local);
}

export function dismissSlotQuestion(id: string, itemId: string, questionId: string) {
  updateProject(id, (p) => ({ ...p, spec: p.spec && updateItem(p.spec, itemId, (x) => ({ ...x, questions: x.questions?.filter((y) => y.id !== questionId) })) }));
}

// --- Review: approve / reject ------------------------------------------------------------------

function summarize(items: SpecItem[]) {
  const n = (lv: number, k: string) => items.filter((x) => x.level === lv && x.pending?.kind === k).length;
  const parts: string[] = [];
  for (const [lv, name] of [[1, "요구사항"], [2, "기능"], [3, "상세 기능"]] as const) {
    if (n(lv, "new")) parts.push(`${name} ${n(lv, "new")}개 추가`);
    if (n(lv, "edit")) parts.push(`${name} ${n(lv, "edit")}개 수정`);
    if (n(lv, "delete")) parts.push(`${name} ${n(lv, "delete")}개 삭제`);
  }
  return parts.join(" · ");
}

function afterReview(id: string, approved: SpecItem[], summary: string) {
  if (approved.length) {
    updateProject(id, (p) => (p.flows.length ? { ...p, stale: { ...p.stale, flow: true, wire: p.wires.length > 0 } } : p));
  }
  if (summary) autoVersion(id, summary);
  saveToDrive();
}

// Items whose pending state changes when id is decided (a new parent takes its new children along).
const affected = (p: Project, id: string) => {
  const x = findItem(p.spec, id);
  return x ? flatten([x]).filter((y) => y.id === id || (x.pending?.kind === "new" && y.pending?.kind === "new")) : [];
};

export function approve(id: string, itemId: string) {
  const p = getProject(id);
  if (!p?.spec) return;
  const items = affected(p, itemId);
  updateProject(id, (x) => {
    let spec = x.spec!;
    for (const y of items) spec = approveItem(spec, y.id);
    return { ...x, spec };
  }, "AI 제안을 승인했어요");
  afterReview(id, items, summarize(items));
}
export function reject(id: string, itemId: string) {
  updateProject(id, (x) => (x.spec ? { ...x, spec: rejectItem(x.spec, itemId) } : x), "AI 제안을 거절했어요");
  saveToDrive();
}
export function approveAllPending(id: string) {
  const p = getProject(id);
  if (!p?.spec) return;
  const items = pendingItems(p.spec);
  updateProject(id, (x) => ({ ...x, spec: approveAll(x.spec!) }), `AI 제안 ${items.length}개를 모두 승인했어요`);
  afterReview(id, items, summarize(items));
}
export function rejectAllPending(id: string) {
  updateProject(id, (x) => (x.spec ? { ...x, spec: rejectAll(x.spec) } : x), "AI 제안을 모두 거절했어요");
  saveToDrive();
}

// --- Direct editing ------------------------------------------------------------------------------

const editSpec = (id: string, fn: (s: SpecItem[]) => SpecItem[], log?: string) =>
  updateProject(id, (p) => ({ ...p, spec: fn(p.spec ?? []) }), log);

export function updateSpecItem(id: string, itemId: string, patch: Partial<SpecItem>) {
  editSpec(id, (s) => updateItem(s, itemId, (x) => ({ ...x, ...patch })));
}
// Adds a blank child (or a requirement when parentId is null). Returns the new item's id.
export function addSpecItem(id: string, parentId: string | null, level: 1 | 2 | 3): string {
  const x = blankItem(level, `새 ${level === 1 ? "요구사항" : level === 2 ? "기능" : "상세 기능"}`);
  editSpec(id, (s) => insertItem(s, parentId, x), "항목을 추가했어요");
  return x.id;
}
export function duplicateSpecItem(id: string, itemId: string): string | undefined {
  const p = getProject(id);
  const x = findItem(p?.spec, itemId);
  if (!p?.spec || !x) return;
  const copy = { ...cloneItem(x), title: `${x.title} (복사본)` };
  const parent = pathTo(p.spec, itemId).slice(-2, -1)[0];
  editSpec(id, (s) => insertItem(s, parent?.id ?? null, copy, itemId), "항목을 복제했어요");
  return copy.id;
}
export function deleteSpecItem(id: string, itemId: string) {
  editSpec(id, (s) => removeItem(s, itemId), "항목을 삭제했어요");
}
export function toggleSlot(id: string, itemId: string, slot: SlotKey) {
  editSpec(id, (s) => updateItem(s, itemId, (x) => {
    const off = x.offSlots ?? [];
    return { ...x, offSlots: off.includes(slot) ? off.filter((k) => k !== slot) : [...off, slot] };
  }));
}
export function setStar(id: string, itemId: string, starred: boolean) {
  editSpec(id, (s) => updateItem(s, itemId, (x) => ({ ...x, starred })));
}
export function setSlotSentences(id: string, itemId: string, slot: SlotKey, sentences: string[]) {
  editSpec(id, (s) => updateItem(s, itemId, (x) => ({ ...x, slots: { ...x.slots, [slot]: sentences } })));
}

export { coreOf, counts };
