"use client";

import { josa } from "./josa";
import { z } from "zod";
import { uid } from "./id";
import { getProject, updateProject } from "./store";
import { saveToDrive } from "./sync";
import { makeQuestions, shortName, summarizeAnswers } from "./generator";
import {
  aiQuestions, aiSummary, ask, describeError, historySize, materialText, prdText, styleOf,
} from "./ai";
import { ai, aiEnabled, me, withAi } from "./run";
import { generatePrd } from "./spec";
import {
  blankItem, findItem, flatten, insertItem, LEVEL_LABEL, pathTo, proposeEdit, specText,
} from "./spec-model";
import type { ChatOption, Decision, Finding, Perspective, PrdSection, Project, SpecCore, SpecItem } from "./types";

export { aiEnabled, isBusy } from "./run";

// --- Questions ---------------------------------------------------------------------

export function initQuestions(id: string) {
  // Called right after createProject(..., withAi=true); the store already shows a thinking bubble.
  const fill = (questions: Project["questions"], note?: string) => updateProject(id, (p) => ({
    ...p, questions,
    chat: [...p.chat.filter((m) => !m.thinking), ...(note ? [ai(note, { error: true })] : []), ai("", { question: questions[0] })],
  }));
  const p = getProject(id);
  if (!p) return;
  aiQuestions(p, 6).then((qs) => (qs.length ? fill(qs) : fill(makeQuestions())))
    .catch((e) => fill(makeQuestions(), `${describeError(e)} 기본 질문으로 시작할게요.`));
}

const READY_ACTIONS: ("generate-prd" | "more-questions")[] = ["generate-prd", "more-questions"];

// picked may hold several options and a typed-in answer.
export function answerQuestion(id: string, qid: string, picked: string[]) {
  updateProject(id, (p) => {
    const answers = { ...p.answers, [qid]: picked };
    const chat = p.chat.map((m) => (m.question?.id === qid && !m.answered ? { ...m, answered: picked } : m));
    chat.push(me(picked.join(", ")));
    const next = p.questions.find((q) => !answers[q.id]);
    if (next) chat.push(ai("", { question: next }));
    else if (!aiEnabled()) chat.push(ai(summarizeAnswers(p.idea, answers), { actions: READY_ACTIONS }));
    return { ...p, answers, chat };
  });
  const p = getProject(id);
  if (p && aiEnabled() && p.questions.every((q) => p.answers[q.id])) {
    const local = () => updateProject(id, (x) => ({ ...x, chat: [...x.chat, ai(summarizeAnswers(x.idea, x.answers), { actions: READY_ACTIONS })] }));
    withAi(id, "답변을 정리하고 있어요…", async (x) => {
      const text = await aiSummary(x);
      updateProject(id, (y) => ({ ...y, chat: [...y.chat, ai(text, { actions: READY_ACTIONS })] }));
    }, local);
  }
}

export function editAnswer(id: string, qid: string) {
  updateProject(id, (p) => {
    const q = p.questions.find((x) => x.id === qid);
    if (!q) return p;
    const answers = { ...p.answers };
    delete answers[qid];
    return { ...p, answers, chat: [...p.chat, ai("이 질문에 다시 답해 주세요.", { question: q })] };
  });
}

export function addMoreQuestions(id: string) {
  if (aiEnabled()) {
    withAi(id, "질문을 더 만들고 있어요…", async (p) => {
      const extra = await aiQuestions(p, 2);
      if (!extra.length) throw new Error("새 질문을 만들지 못했어요.");
      updateProject(id, (x) => ({ ...x, questions: [...x.questions, ...extra], chat: [...x.chat, ai("", { question: extra[0] })] }));
    }, () => addMoreQuestionsLocal(id));
    return;
  }
  addMoreQuestionsLocal(id);
}

function addMoreQuestionsLocal(id: string) {
  updateProject(id, (p) => {
    const extra = [
      { id: "scale", text: "첫 해에 예상하는 사용자 규모는 어느 정도인가요?", multi: false, options: ["수백 명", "수천 명", "수만 명 이상"] },
      { id: "must", text: "첫 출시에 꼭 들어가야 하는 것은 무엇인가요?", multi: true, options: ["알림", "결제", "채팅", "관리자 통계"] },
    ].filter((q) => !p.questions.some((x) => x.id === q.id));
    if (!extra.length) return { ...p, chat: [...p.chat, ai("이미 충분히 여쭤봤어요. 이제 PRD를 만들어도 좋아요.", { actions: ["generate-prd"] })] };
    return { ...p, questions: [...p.questions, ...extra], chat: [...p.chat, ai("", { question: extra[0] })] };
  });
}

// --- PRD ------------------------------------------------------------------------------

const LATER_ID = "later";

// Options the user didn't pick, kept at the end of the PRD so they can be planned later.
function laterSection(p: Project): PrdSection | null {
  const blocks = p.questions.flatMap((q) => {
    const picked = p.answers[q.id] ?? [];
    const rest = q.options.filter((o) => !picked.includes(o));
    return rest.length ? [{ label: q.text, body: rest.join(" / ") }] : [];
  });
  return blocks.length ? { id: LATER_ID, title: "다음 단계 후보 (이번에 고르지 않은 보기)", blocks } : null;
}

// The "PRD 만들기" button: lib/spec writes the PRD, then the unpicked options are listed under it.
export async function createPrd(id: string) {
  await generatePrd(id);
  updateProject(id, (p) => {
    if (!p.prd || p.prd.some((s) => s.id === LATER_ID)) return p;
    const later = laterSection(p);
    return later ? { ...p, prd: [...p.prd, later] } : p;
  });
}

export function updatePrdBlock(id: string, sid: string, idx: number, body: string) {
  updateProject(id, (p) => ({
    ...p, prd: p.prd?.map((s) => s.id !== sid ? s : { ...s, blocks: s.blocks.map((b, i) => (i === idx ? { ...b, body } : b)) }) ?? null,
  }));
}

// --- Review -----------------------------------------------------------------------------

const ReviewSchema = z.object({
  findings: z.array(z.object({
    perspective: z.enum(["개발", "사업", "UX", "디자인", "QA", "보안"]),
    level: z.enum(["주의", "제안"]),
    title: z.string(),
    body: z.string(),
    scenario: z.string(),
    evidence: z.string(),
    code: z.string(),
  })),
});

export function review(id: string) {
  const p = getProject(id);
  if (!p?.spec?.length) return;
  const local = () => {
    const findings = reviewLocal(getProject(id)!);
    updateProject(id, (x) => ({
      ...x, findings,
      chat: [...x.chat, ai(`검토를 마쳤어요. ${reviewSummary(findings)} [검토] 패널에서 하나씩 확인해 주세요.`)],
    }), "기획 검토를 실행했어요");
    saveToDrive();
  };
  if (!aiEnabled()) return local();
  withAi(id, "여섯 관점에서 기획서를 검토하고 있어요…", async (x, step) => {
    step("문서 읽음");
    const out = await ask(ReviewSchema, `아래 PRD와 기능명세서를 개발, 사업, UX, 디자인, QA, 보안 여섯 관점에서 검토해 주세요.
아이디어: ${x.idea}${materialText(x)}

[PRD]
${prdText(x)}

[기능명세서] (각 줄의 [R-…], [F-…], [S-…]가 항목 코드)
${specText(x.spec, true)}

규칙:
- 관점마다 1~3개, 전체 8~14개. 실제로 빠졌거나 모순되거나 위험한 것만 씁니다.
- level은 꼭 고쳐야 하면 "주의", 더 좋게 만들 아이디어면 "제안"입니다.
- title은 한 줄, body는 무엇이 문제이고 무엇을 정해야 하는지 2~3문장.
- scenario는 이 서비스에서 실제로 벌어질 수 있는 구체적 상황 하나를 사람과 행동으로 씁니다.
- evidence는 위 문서에서 근거가 되는 문장을 그대로 짧게 인용합니다. 빠진 것이 문제라면 가장 가까운 문장을 인용합니다.
- code는 가장 관련 있는 항목 코드(예: F-ABCDEF), 없으면 빈 문자열.
${styleOf(x)}`);
    step("검토 의견 정리 완료");
    const items = flatten(x.spec);
    const findings: Finding[] = out.findings.map((f) => ({
      id: uid("r_"), perspective: f.perspective, level: f.level, title: f.title, body: f.body,
      scenario: f.scenario || undefined, evidence: f.evidence || undefined,
      featureId: items.find((i) => i.code === f.code.trim())?.id, state: "open",
    }));
    updateProject(id, (y) => ({
      ...y, findings,
      chat: [...y.chat, ai(`검토를 마쳤어요. ${reviewSummary(findings)} [검토] 패널에서 하나씩 확인해 주세요.`)],
    }), "AI가 기획 검토를 실행했어요");
    saveToDrive();
  }, local);
}

export function reviewSummary(fs: Finding[]) {
  const warn = fs.filter((f) => f.level === "주의").length;
  return `의견 ${fs.length}개(주의 ${warn} · 제안 ${fs.length - warn})를 찾았어요.`;
}

// Rule-based review: looks at the actual items and words of this spec.
function reviewLocal(p: Project): Finding[] {
  const name = shortName(p.idea);
  const items = flatten(p.spec);
  const feats = items.filter((x) => x.level >= 2);
  const pool = feats.length ? feats : items;
  const find = (re: RegExp) => pool.find((x) => re.test(`${x.title} ${x.summary}`));
  const quote = (x?: SpecItem) => (x ? `${x.code} ${x.title}: ${x.summary || "(설명 없음)"}` : undefined);
  const out: Finding[] = [];
  const add = (perspective: Perspective, level: Finding["level"], x: SpecItem | undefined, title: string, body: string, scenario: string) =>
    out.push({ id: uid("r_"), perspective, level, title, body, scenario, evidence: quote(x), featureId: x?.id, state: "open" });
  const roleOf = (x?: SpecItem) => x?.roles[0] ?? "사용자";

  // 개발
  const flowy = find(/승인|신청|예약|결제|주문|요청/);
  if (flowy) add("개발", "주의", flowy, `'${flowy.title}'의 처리 상태가 정해지지 않았어요`,
    "요청이 들어온 뒤 대기·완료·취소 같은 상태와, 상태가 바뀌는 조건을 정해야 서버와 화면을 같은 기준으로 만들 수 있어요.",
    `${roleOf(flowy)}가 ${name}에서 '${flowy.title}'을 진행하던 중 앱을 닫았다가 다시 열었을 때, 진행 중이던 요청이 어떤 상태로 보여야 하는지 알 수 없어요.`);
  const empty = feats.find((x) => x.level === 2 && slotFillZero(x));
  if (empty) add("개발", "제안", empty, `'${empty.title}'의 개발 준비 항목이 비어 있어요`,
    "선행조건, 트리거, 예외, 데이터 같은 칸을 채우면 개발자가 질문 없이 바로 작업을 시작할 수 있어요.",
    `개발자가 '${empty.title}'을 맡았지만 실패했을 때 무엇을 보여 줄지 몰라 기획자에게 다시 묻게 돼요.`);
  // 사업
  const paid = find(/결제|구독|유료|요금|수수료|광고/);
  add("사업", paid ? "주의" : "제안", paid ?? pool[0], paid ? `'${paid.title}'의 환불·취소 정책이 없어요` : "돈을 버는 지점이 기능에 드러나지 않아요",
    paid ? "결제 이후 취소나 환불이 생기면 누가, 언제까지, 얼마를 돌려받는지 정해야 분쟁을 줄일 수 있어요."
      : "무료로 쓸 수 있는 범위와 유료로 넘어가는 지점을 기능에 표시하면 수익 모델을 일찍 검증할 수 있어요.",
    paid ? `${roleOf(paid)}가 결제 직후 마음을 바꿔 취소를 눌렀는데, 환불 기준이 없어 운영자가 직접 판단해야 해요.`
      : `${name}의 첫 달 사용자가 늘어도, 어느 시점에 돈을 내게 할지 정하지 않아 매출로 이어지지 않아요.`);
  // UX
  const list = find(/검색|목록|탐색|찾/);
  add("UX", "주의", list ?? pool[1] ?? pool[0], list ? `'${list.title}' 결과가 없을 때의 화면이 없어요` : "처음 쓰는 사람이 무엇부터 할지 안내가 없어요",
    list ? "결과가 0건일 때 보여 줄 안내 문구와 다음 행동(조건 바꾸기, 새로 만들기)을 정해야 해요."
      : "첫 화면에서 핵심 행동 하나를 바로 할 수 있도록 안내와 빈 화면 문구를 정해야 해요.",
    list ? `${roleOf(list)}가 조건을 좁혀 검색했더니 아무것도 나오지 않아, 빈 화면만 보고 앱을 닫아요.`
      : `처음 가입한 사용자가 빈 화면을 보고 무엇을 눌러야 할지 몰라 이탈해요.`);
  const noti = find(/알림|푸시|메시지/);
  if (noti) add("UX", "제안", noti, `'${noti.title}'의 빈도와 끄기 설정을 정해 주세요`,
    "어떤 일이 생길 때 알림이 가는지, 사용자가 종류별로 끌 수 있는지 정하면 알림 피로를 줄일 수 있어요.",
    `하루에 같은 종류의 알림이 여러 번 와서 사용자가 알림 전체를 꺼 버려요.`);
  // 디자인
  const media = find(/사진|이미지|프로필|업로드|파일/);
  add("디자인", "제안", media ?? pool[0], media ? `'${media.title}'에 이미지가 없을 때의 모습이 필요해요` : "로딩·오류 상태의 시각 규칙이 없어요",
    media ? "이미지를 아직 올리지 않았거나 불러오지 못했을 때 보여 줄 기본 모양과 비율을 정해 두세요."
      : "불러오는 중, 실패, 빈 상태를 화면마다 같은 모양으로 보여 주는 규칙을 정하면 디자인이 일관돼요.",
    media ? `프로필 사진이 없는 사용자가 많아 목록이 회색 상자로 가득 차 보여요.` : `네트워크가 느린 곳에서 화면이 하얗게 멈춘 것처럼 보여 사용자가 같은 버튼을 여러 번 눌러요.`);
  // QA
  const noCriteria = pool.find((x) => !x.criteria?.length);
  add("QA", "주의", noCriteria ?? pool[0], noCriteria ? `'${noCriteria.title}'에 수용 기준이 없어요` : "동시에 고칠 때의 기준이 없어요",
    noCriteria ? "언제 '완성'인지 확인할 수 있는 체크 항목이 없으면 테스트 범위를 정할 수 없어요. 정상·실패 경우를 하나씩 적어 주세요."
      : "두 사람이 같은 항목을 동시에 고치면 어떤 내용이 남는지 수용 기준에 넣어야 테스트할 수 있어요.",
    noCriteria ? `QA 담당자가 '${noCriteria.title}'을 확인하다가 입력값이 비었을 때의 동작을 버그로 볼지 판단하지 못해요.`
      : `두 사용자가 같은 내용을 동시에 저장했더니 한 사람의 수정이 말없이 사라져요.`);
  // 보안
  const auth = find(/가입|로그인|계정|인증|개인/);
  add("보안", "주의", auth ?? pool[0], auth ? `'${auth.title}'의 개인정보 보관 기간이 없어요` : "개인정보를 어디까지 모으는지 정해지지 않았어요",
    "어떤 개인정보를 모으고, 탈퇴하면 언제 지우며, 누가 열람할 수 있는지 정의해야 해요.",
    `탈퇴한 사용자가 자기 정보가 아직 남아 있는지 문의했는데, 지우는 기준이 없어 답하지 못해요.`);
  const admin = pool.find((x) => x.roles.some((r) => /관리|운영|호스트|모임장/.test(r)));
  if (admin) add("보안", "제안", admin, `'${admin.title}'의 권한 범위를 나눠 주세요`,
    `${admin.roles.join(", ")} 역할이 무엇을 보고 바꿀 수 있는지 구분하면 실수나 악용을 막을 수 있어요.`,
    `일반 사용자가 주소만 바꿔 관리 화면에 들어가 다른 사람의 정보를 봐요.`);
  return out;
}
const slotFillZero = (x: SpecItem) => !Object.values(x.slots ?? {}).some((v) => v?.some((s) => s.trim()));

export function setFinding(id: string, fid: string, state: Finding["state"]) {
  updateProject(id, (p) => ({ ...p, findings: p.findings?.map((f) => (f.id === fid ? { ...f, state } : f)) ?? null }));
}

// --- Applying AI proposals to the spec as pending items ------------------------------------

const EditSchema = z.object({
  code: z.string(),
  title: z.string(),
  summary: z.string(),
  criteria: z.array(z.string()),
  reason: z.string(),
});
const AddSchema = z.object({
  parentCode: z.string(),
  title: z.string(),
  summary: z.string(),
  criteria: z.array(z.string()),
  reason: z.string(),
});
type Edit = z.infer<typeof EditSchema>;
type Add = z.infer<typeof AddSchema>;

// Empty strings and empty lists mean "keep as is". Returns the new tree and lines describing what changed.
function applyProposals(spec: SpecItem[], edits: Edit[], adds: Add[]) {
  let next = spec;
  const lines: string[] = [];
  for (const e of edits) {
    const t = flatten(next).find((x) => x.code === e.code.trim());
    if (!t) continue;
    const patch: Partial<SpecCore> = {};
    if (e.title.trim()) patch.title = e.title.trim();
    if (e.summary.trim()) patch.summary = e.summary.trim();
    if (e.criteria.length) patch.criteria = e.criteria;
    if (!Object.keys(patch).length) continue;
    next = proposeEdit(next, t.id, patch, e.reason || undefined);
    lines.push(`수정 · ${LEVEL_LABEL[t.level]} ${t.code} ${patch.title ?? t.title}${e.reason ? ` — ${e.reason}` : ""}`);
  }
  for (const a of adds) {
    const parent = a.parentCode.trim() ? flatten(next).find((x) => x.code === a.parentCode.trim()) : undefined;
    const level = (parent ? Math.min(3, parent.level + 1) : 1) as 1 | 2 | 3;
    const item: SpecItem = {
      ...blankItem(level, a.title.trim() || "새 항목", { kind: "new", reason: a.reason || undefined }),
      summary: a.summary, criteria: a.criteria.length ? a.criteria : undefined, roles: parent?.roles ?? [],
    };
    const host = parent && parent.level === 3 ? pathTo(next, parent.id).at(-2) : parent;
    next = insertItem(next, host?.id ?? null, item, parent && parent.level === 3 ? parent.id : undefined);
    lines.push(`추가 · ${LEVEL_LABEL[item.level]} ${item.code} ${item.title}${host ? ` (${host.title} 아래)` : ""}`);
  }
  return { spec: next, lines };
}

const changedText = (lines: string[]) => (lines.length
  ? `\n\n바뀐 항목 (승인 대기 ${lines.length}개)\n${lines.map((l) => `• ${l}`).join("\n")}\n\n[기능명세서] 탭에서 항목별로 승인하거나 거절해 주세요.`
  : "");

// --- Resolving a review finding in chat --------------------------------------------------------

const OptionsSchema = z.object({
  intro: z.string(),
  options: z.array(z.object({ title: z.string(), detail: z.string() })),
});

const findingOf = (p: Project, question: string) => p.findings?.find((f) => f.title === question);
const relatedItem = (p: Project, f?: Finding) => findItem(p.spec, f?.featureId ?? "") ?? flatten(p.spec).find((x) => x.level === 2) ?? flatten(p.spec)[0];

export function resolveFindingInChat(id: string, fid: string) {
  const p = getProject(id);
  const f = p?.findings?.find((x) => x.id === fid);
  if (!p || !f) return;
  const ask1 = me(`검토 의견을 해결하고 싶어요: ${f.title}`);
  if (!aiEnabled()) return resolveOptionsLocal(id, f, [ask1]);
  withAi(id, "해결 방법을 찾고 있어요…", async (x, step) => {
    step("문서 읽음");
    const t = relatedItem(x, f);
    const out = await ask(OptionsSchema, `기획 검토에서 나온 의견을 해결할 방법 3가지를 제안해 주세요.
[의견] (${f.perspective} · ${f.level}) ${f.title}
${f.body}
예시 상황: ${f.scenario ?? "-"}
관련 항목: ${t ? `${t.code} ${t.title}: ${t.summary}` : "없음"}

[기능명세서]
${specText(x.spec)}

규칙:
- 세 방법은 서로 다른 방향이어야 합니다 (예: 단순한 규칙 / 사용자 선택 / 자동 처리).
- title은 한 줄, detail에는 어떤 항목(코드와 이름)이 어떻게 바뀌는지, 새로 생기는 기능이나 상세 기능이 있는지 구체적으로 씁니다.
- intro는 한 문장 안내입니다.
${styleOf(x)}`);
    const options = out.options.slice(0, 3);
    if (!options.length) throw new Error("해결 방법을 만들지 못했어요.");
    updateProject(id, (y) => ({ ...y, chat: [...y.chat, ai(out.intro, { choices: { question: f.title, options } })] }));
  }, () => resolveOptionsLocal(id, f, []), [ask1]);
}

function resolveOptionsLocal(id: string, f: Finding, prefix: ReturnType<typeof me>[]) {
  updateProject(id, (p) => {
    const t = relatedItem(p, f);
    const name = t ? `${t.code} '${t.title}'` : "관련 기능";
    const options: ChatOption[] = [
      { title: "가장 단순한 규칙으로 정하기", detail: `${name}의 설명에 기본 규칙 한 가지를 적고, 수용 기준에 정상·예외 경우를 하나씩 추가해요. 새 항목은 생기지 않아요.` },
      { title: "사용자가 직접 고르게 하기", detail: `${name}에 사용자가 기준을 바꾸는 설정을 넣고, 그 아래에 '${f.perspective} 기준 설정' 상세 기능을 새로 추가해요. 화면이 하나 늘어요.` },
      { title: "자동 처리와 알림을 함께 쓰기", detail: `${name}이 조건을 넘으면 자동으로 처리하도록 설명을 고치고, 관련된 사람에게 알리는 '처리 결과 알림' 상세 기능을 추가해요.` },
    ];
    return { ...p, chat: [...p.chat, ...prefix, ai("해결 방법을 세 가지로 정리했어요. 하나를 고르면 바뀔 내용을 미리 보여 드려요.", { choices: { question: f.title, options } })] };
  });
}

const ApplySchema = z.object({
  picked: z.string(),
  edits: z.array(EditSchema),
  additions: z.array(AddSchema),
  summary: z.string(),
});

// choice: the option title or typed direction; empty means the AI picks the best one.
export function applyChoice(id: string, mid: string, choice?: string) {
  const p0 = getProject(id);
  const msg = p0?.chat.find((m) => m.id === mid);
  if (!p0 || !msg?.choices || msg.choices.picked || !p0.spec) return;
  const finding = findingOf(p0, msg.choices.question);
  const options = msg.choices.options;
  const label = choice || "AI가 알아서 진행";
  const mark = (picked: string) => updateProject(id, (x) => ({
    ...x, chat: x.chat.map((m) => (m.id === mid ? { ...m, choices: { ...m.choices!, picked } } : m)),
  }));
  const finish = (spec: SpecItem[], lines: string[], text: string) => {
    updateProject(id, (x) => ({
      ...x, spec,
      findings: x.findings?.map((f) => (f.id === finding?.id ? { ...f, state: "resolved" as const } : f)) ?? null,
      chat: [...x.chat, ai(text + changedText(lines), { actions: lines.length ? ["goto-features"] : undefined })],
    }), "검토 의견을 채팅에서 해결했어요");
    saveToDrive();
  };
  const local = () => {
    const pick = choice || options[0]?.title || "가장 단순한 규칙으로 정하기";
    mark(pick);
    const x = getProject(id)!;
    const t = relatedItem(x, finding);
    if (!t) return finish(x.spec ?? [], [], "바꿀 항목을 찾지 못했어요.");
    const topic = finding?.title ?? msg.choices!.question;
    const opt = options.find((o) => o.title === pick);
    const edits: Edit[] = [{
      code: t.code, title: "", reason: `${topic} → ${pick}`,
      summary: `${t.summary ? t.summary.replace(/\s*$/, " ") : ""}(${pick}: ${topic}에 대한 기준을 이 항목에서 정한다.)`.trim(),
      criteria: [...(t.criteria ?? []), `${topic}: ${pick} 기준으로 처리된다`, "기준을 벗어나면 사용자에게 이유를 알려 준다"],
    }];
    const adds: Add[] = /추가|새로|상세 기능/.test(opt?.detail ?? pick) || !opt ? [{
      parentCode: t.code, title: /알림/.test(pick) ? "처리 결과 알림" : `${finding?.perspective ?? "운영"} 기준 설정`,
      summary: `${t.title}에서 '${pick}' 방식을 실제로 처리하는 단계`, criteria: ["처리 결과가 기록으로 남는다"], reason: topic,
    }] : [];
    const r = applyProposals(x.spec ?? [], edits, adds);
    finish(r.spec, r.lines, `'${pick}' 방향으로 관련 항목을 고쳤어요.`);
  };
  if (!aiEnabled()) return local();
  if (choice) mark(choice);
  withAi(id, `'${label}' 기준으로 기획서를 고치고 있어요…`, async (x, step) => {
    step("문서 읽음");
    const t = relatedItem(x, finding);
    const out = await ask(ApplySchema, `기획 검토 의견을 해결하도록 기능명세서를 고쳐 주세요.
[의견] ${finding ? `(${finding.perspective}) ${finding.title}\n${finding.body}` : msg.choices!.question}
[선택지]
${options.map((o, i) => `${i + 1}. ${o.title}: ${o.detail}`).join("\n")}
[사용자가 고른 방향] ${choice ? choice : "없음 — 선택지 중 이 서비스에 가장 알맞은 것을 직접 고르고 picked에 그 제목을 씁니다"}
관련 항목: ${t ? `${t.code} ${t.title}` : "없음"}

[기능명세서]
${specText(x.spec, true)}

규칙:
- edits: 바꿀 기존 항목. code는 위 코드 그대로, 바꾸지 않는 칸은 빈 문자열이나 빈 배열. criteria를 바꿀 때는 기존 기준을 포함한 전체 목록을 씁니다.
- additions: 새로 필요한 기능이나 상세 기능. parentCode는 부모 항목 코드(요구사항 아래 기능, 기능 아래 상세 기능).
- 꼭 필요한 항목만 바꿉니다. reason에는 왜 바꾸는지 한 줄.
- summary는 무엇을 바꿨는지 사용자에게 알려 주는 2~3문장.
${styleOf(x)}`);
    if (!choice) mark(out.picked || options[0]?.title || "AI 선택");
    step("기능 작성 완료");
    const r = applyProposals(getProject(id)!.spec ?? [], out.edits, out.additions);
    step("상세 기능 작성 완료");
    finish(r.spec, r.lines, out.summary);
  }, () => {
    // The fallback must not see the choice as already picked.
    updateProject(id, (x) => ({ ...x, chat: x.chat.map((m) => (m.id === mid ? { ...m, choices: { ...m.choices!, picked: undefined } } : m)) }));
    local();
  });
}

// --- Free chat -------------------------------------------------------------------------------

// Messages carry mentions as @[title](itemId); itemId is a spec item id, "prd" or "prd:<sectionId>".
export const MENTION = /@\[([^\]]+)\]\(([^)]+)\)/g;
export const plainText = (text: string) => text.replace(MENTION, "@$1");
export function mentionsOf(text: string) {
  return [...text.matchAll(MENTION)].map((m) => ({ title: m[1], id: m[2] }));
}

function chatContext(p: Project, text: string) {
  const ms = mentionsOf(text);
  if (!ms.length) return `[PRD]\n${prdText(p)}\n\n[기능명세서]\n${specText(p.spec, true) || "(아직 없음)"}`;
  const parts: string[] = [];
  for (const m of ms) {
    if (m.id === "prd") parts.push(`[PRD]\n${prdText(p)}`);
    else if (m.id.startsWith("prd:")) {
      const s = p.prd?.find((x) => x.id === m.id.slice(4));
      if (s) parts.push(`[PRD · ${s.title}]\n${s.blocks.map((b) => `- ${b.label}: ${b.body}`).join("\n")}`);
    } else {
      const it = findItem(p.spec, m.id);
      if (!it) continue;
      const path = pathTo(p.spec ?? [], it.id).slice(0, -1).map((x) => `${x.code} ${x.title}`).join(" > ");
      parts.push(`[${LEVEL_LABEL[it.level]}${path ? ` · ${path}` : ""}]\n${specText([it], true)}${it.criteria?.length ? `\n수용 기준: ${it.criteria.join(" / ")}` : ""}`);
    }
  }
  return `사용자가 다음 항목을 집어서 물었어요. 이 항목을 중심으로 답합니다.\n${parts.join("\n\n")}\n\n[기능명세서 목차]\n${specText(p.spec)}`;
}

const ChatSchema = z.object({
  reply: z.string(),
  edits: z.array(EditSchema),
  additions: z.array(AddSchema),
  review: z.boolean(),
});

export async function sendChat(id: string, text: string) {
  const p = getProject(id);
  if (!p) return;
  if (!aiEnabled()) return sendChatLocal(id, text);
  let wantsReview = false;
  await withAi(id, "생각하고 있어요…", async (x, step) => {
    const history = x.chat.filter((m) => m.text && !m.thinking && !m.error).slice(-historySize() - 1, -1)
      .map((m) => `${m.from === "user" ? "사용자" : "AI"}: ${plainText(m.text)}`).join("\n");
    step("문서 읽음");
    const out = await ask(ChatSchema, `서비스 기획을 함께 다듬는 대화입니다.
아이디어: ${x.idea}
${chatContext(x, text)}

[최근 대화]
${history || "(없음)"}

[사용자 메시지]
${plainText(text)}

규칙:
- 질문이면 reply에 답만 하고 edits/additions는 빈 배열로 둡니다.
- 기능을 고치거나 더해 달라는 요청이면 edits(기존 항목, code는 위 코드 그대로, 바꾸지 않는 칸은 빈 문자열/빈 배열)와 additions(parentCode는 부모 코드, 요구사항을 새로 만들 때만 빈 문자열)에 담고, reply에는 무엇을 바꿨는지 짧게 씁니다. 바뀐 내용은 사용자가 승인해야 반영됩니다.
- 기획 전체 검토를 원하면 review를 true로 합니다.
${styleOf(x)}`);
    let lines: string[] = [];
    if (x.spec && (out.edits.length || out.additions.length)) {
      const r = applyProposals(getProject(id)!.spec ?? [], out.edits, out.additions);
      lines = r.lines;
      step(r.lines.some((l) => l.includes("상세 기능")) ? "상세 기능 작성 완료" : "기능 작성 완료");
      updateProject(id, (y) => ({ ...y, spec: r.spec }), "채팅 요청으로 수정안을 만들었어요");
    }
    updateProject(id, (y) => ({ ...y, chat: [...y.chat, ai(out.reply + changedText(lines), { actions: lines.length ? ["goto-features"] : undefined })] }));
    if (lines.length) saveToDrive();
    wantsReview = out.review;
  }, () => sendChatLocal(id, text, false), [me(text)]);
  if (wantsReview) review(id);
}

// Rule-based chat: "OO 기능 추가해줘", "(항목) 더 구체화해줘", "검토해줘", or a question about a mentioned item.
function sendChatLocal(id: string, text: string, echo = true) {
  const p = getProject(id)!;
  const plain = plainText(text).trim();
  const ms = mentionsOf(text);
  const items = flatten(p.spec);
  const target = items.find((x) => ms.some((m) => m.id === x.id)) ?? items.find((x) => plain.includes(x.title));
  const say = (reply: string, extra: Partial<Project> = {}, lines: string[] = []) => updateProject(id, (x) => ({
    ...x, ...extra, chat: [...x.chat, ...(echo ? [me(text)] : []), ai(reply + changedText(lines), { actions: lines.length ? ["goto-features"] : undefined })],
  }));
  if (!p.spec?.length) {
    if (p.prd && ms.some((m) => m.id.startsWith("prd"))) return say(`PRD 기준으로 보면 이 서비스는 "${p.prd[0]?.blocks[0]?.body ?? p.idea}"를 목표로 해요. 기능명세서를 먼저 완성하면 항목 단위로 고칠 수 있어요.`, {}, []);
    return say("먼저 PRD와 기능명세서를 만들어야 그 내용에 맞춰 도와드릴 수 있어요. 질문에 답하고 [PRD 만들기]를 눌러 주세요.");
  }
  const bare = text.replace(MENTION, "").trim();
  const add = bare.match(/^(.*?)\s*(?:기능|항목)?\s*(?:을|를)?\s*(?:추가|넣어|만들어)/);
  if (add) {
    const title = add[1].replace(/["'“”]/g, "").replace(/\s*(기능|항목)$/, "").trim() || "새 기능";
    // "기능" next to a mentioned feature means a sibling feature, not a detail under it.
    const sibling = target?.level === 2 && /기능/.test(bare) && !/상세/.test(bare);
    const parent = (sibling ? pathTo(p.spec, target.id).at(-2) : target) ?? items.filter((x) => x.level === 1).at(-1);
    const r = applyProposals(p.spec, [], [{ parentCode: parent?.code ?? "", title, summary: `${title}${josa(title, "을/를")} 할 수 있다.`,
      criteria: ["기본 동작이 실패하면 이유를 알려 준다", "처리 결과가 바로 화면에 보인다"], reason: "채팅 요청으로 추가" }]);
    return say(`'${title}'${josa(title, "을/를")} 추가하는 안을 만들었어요.`, { spec: r.spec }, r.lines);
  }
  if (target && /(구체|자세|보강|수정|바꿔|고쳐|채워)/.test(plain)) {
    const r = applyProposals(p.spec, [{ code: target.code, title: "", reason: "구체화 요청",
      summary: `${target.summary || target.title} 처리 과정의 각 단계와 실패했을 때의 안내를 함께 정의한다.`,
      criteria: [...(target.criteria ?? []), "처리 중 오류가 나면 다시 시도할 수 있다", "모든 변경은 기록으로 남는다"] }], []);
    return say(`'${target.title}'의 설명과 수용 기준을 보강하는 안을 만들었어요.`, { spec: r.spec }, r.lines);
  }
  if (/검토|빈틈|리뷰/.test(plain)) {
    say("여섯 관점에서 기획서를 검토할게요.");
    return review(id);
  }
  if (target) {
    const kids = target.children.map((c) => `• ${c.code} ${c.title}`).join("\n");
    return say(`${target.code} '${target.title}'${josa(target.title, "은/는")} ${LEVEL_LABEL[target.level]}이에요.\n${target.summary || "아직 설명이 없어요."}` +
      `${target.criteria?.length ? `\n\n수용 기준\n${target.criteria.map((c) => `• ${c}`).join("\n")}` : ""}` +
      `${kids ? `\n\n하위 항목\n${kids}` : ""}\n\n"더 구체화해줘"나 "OO 추가해줘"라고 하면 수정안을 만들어 드려요.`);
  }
  say("요청을 이해했어요. @로 항목을 집은 뒤 \"더 구체화해줘\", \"OO 기능 추가해줘\", \"기획 검토해줘\"처럼 말씀해 주시면 기능명세서에 수정안으로 반영할게요. (AI를 연결하면 자유롭게 질문할 수 있어요.)");
}

// --- Comments, docs, settings --------------------------------------------------------------------

export function addComment(id: string, text: string, featureId?: string) {
  updateProject(id, (p) => ({ ...p, comments: [...p.comments, { id: uid("cm_"), featureId, author: "나", text, at: Date.now() }] }));
}
export function toggleComment(id: string, cid: string) {
  updateProject(id, (p) => ({ ...p, comments: p.comments.map((c) => (c.id === cid ? { ...c, resolved: !c.resolved } : c)) }));
}
export function deleteComment(id: string, cid: string) {
  updateProject(id, (p) => ({ ...p, comments: p.comments.filter((c) => c.id !== cid) }));
}

export function deleteVersion(id: string, vid: string) {
  updateProject(id, (p) => ({ ...p, versions: p.versions.filter((v) => v.id !== vid) }), "버전을 삭제했어요");
}

// Pulls decision-like lines out of pasted meeting notes.
export function extractDecisions(id: string, title: string, body: string) {
  const lines = body.split(/\n+/).map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim()).filter(Boolean);
  const decisions: Decision[] = lines.flatMap<Decision>((l) => {
    if (/(안 ?한다|하지 않|제외|기각|빼기로)/.test(l)) return [{ id: uid("d_"), state: "기각" as const, text: l, source: title }];
    if (/(한다|하기로|결정|확정|정함|통일)/.test(l)) return [{ id: uid("d_"), state: "확정" as const, text: l, source: title }];
    if (/(\?|검토|논의|미정|추후)/.test(l)) return [{ id: uid("d_"), state: "미정" as const, text: l, source: title }];
    return [];
  });
  updateProject(id, (p) => ({
    ...p,
    notes: [{ id: uid("n_"), title, body, at: Date.now() }, ...p.notes],
    decisions: [...decisions, ...p.decisions],
  }), `회의록 '${title}'에서 결정 ${decisions.length}개를 뽑았어요`);
  return decisions.length;
}

export function addNote(id: string, title: string, body: string) {
  updateProject(id, (p) => ({ ...p, notes: [{ id: uid("n_"), title, body, at: Date.now() }, ...p.notes] }), `노트 '${title}'을 추가했어요`);
}

// A confirmed decision goes into the PRD's last section (risk & scope) as a block.
export function applyDecision(id: string, did: string) {
  updateProject(id, (p) => {
    const d = p.decisions.find((x) => x.id === did);
    if (!d || !p.prd?.length) return p;
    const at = p.prd.findIndex((s) => s.id === "risk");
    const i = at >= 0 ? at : p.prd.filter((s) => s.id !== LATER_ID).length - 1;
    const prd = p.prd.map((s, k) => (k !== i ? s : { ...s, blocks: [...s.blocks, { label: `결정 (${d.source})`, body: d.text }] }));
    return { ...p, prd, decisions: p.decisions.map((x) => (x.id === did ? { ...x, applied: true } : x)) };
  }, "결정을 기획서에 반영했어요");
}

export function setSettings(id: string, settings: Project["settings"]) {
  updateProject(id, (p) => ({ ...p, settings }), "프로젝트 커스터마이징을 저장했어요");
  saveToDrive();
}
