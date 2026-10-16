"use client";

import { uid } from "./id";
import { getProject, updateProject } from "./store";
import {
  interpret, makeFeatures, makeFlow, makePrd, makeQuestions, makeScreens, runReview, summarizeAnswers,
} from "./generator";
import {
  aiApplyChoice, aiChat, aiChoices, aiPlan, aiQuestions, aiReview, aiSummary, describeError, getApiKey, toFeature,
} from "./ai";
import type { ChatMessage, Decision, Feature, Project } from "./types";

const ai = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: uid("m_"), from: "ai", text, ...extra });
const me = (text: string): ChatMessage => ({ id: uid("m_"), from: "user", text });

export const aiEnabled = () => !!getApiKey();
export const isBusy = (p: Project) => p.chat.some((m) => m.thinking);

// Runs a Claude call behind a "thinking" chat bubble. On failure the bubble
// turns into an error note and the local generator does the job instead.
async function withAi(id: string, label: string, run: (p: Project) => Promise<void>, fallback: () => void, prefix: ChatMessage[] = []) {
  const p = getProject(id);
  if (!p || isBusy(p)) return;
  const bubble = ai(label, { thinking: true });
  updateProject(id, (x) => ({ ...x, chat: [...x.chat, ...prefix, bubble] }));
  const drop = () => updateProject(id, (x) => ({ ...x, chat: x.chat.filter((m) => m.id !== bubble.id) }));
  try {
    await run(getProject(id)!);
    drop();
  } catch (e) {
    drop();
    updateProject(id, (x) => ({ ...x, chat: [...x.chat, ai(`${describeError(e)} 이번에는 로컬 생성기로 대신 만들었어요.`, { error: true })] }));
    fallback();
  }
}

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

export function answerQuestion(id: string, qid: string, picked: string[]) {
  updateProject(id, (p) => {
    const answers = { ...p.answers, [qid]: picked };
    const chat = p.chat.map((m) => (m.question?.id === qid ? { ...m, answered: picked } : m));
    chat.push(me(picked.join(", ")));
    const next = p.questions.find((q) => !answers[q.id]);
    if (next) chat.push(ai("", { question: next }));
    else if (!aiEnabled()) chat.push(ai(summarizeAnswers(p.idea, answers), { actions: ["generate-prd", "more-questions"] }));
    return { ...p, answers, chat };
  });
  const p = getProject(id);
  if (p && aiEnabled() && p.questions.every((q) => p.answers[q.id])) {
    const local = () => updateProject(id, (x) => ({ ...x, chat: [...x.chat, ai(summarizeAnswers(x.idea, x.answers), { actions: ["generate-prd", "more-questions"] })] }));
    withAi(id, "답변을 정리하고 있어요…", async (x) => {
      const text = await aiSummary(x);
      updateProject(id, (y) => ({ ...y, chat: [...y.chat, ai(text, { actions: ["generate-prd", "more-questions"] })] }));
    }, local);
  }
}

export function editAnswer(id: string, qid: string) {
  updateProject(id, (p) => {
    const answers = { ...p.answers };
    delete answers[qid];
    const q = p.questions.find((x) => x.id === qid)!;
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

const planDone = (groups: { features: unknown[] }[]) =>
  `PRD 초안과 함께 기능명세서 초안을 만들었어요. 기능 묶음 ${groups.length}개, 세부 기능 ${groups.reduce((n, g) => n + g.features.length, 0)}개예요. 이어서 무엇을 할까요?`;

export function generatePrd(id: string) {
  if (aiEnabled()) {
    withAi(id, "PRD와 기능명세서를 쓰고 있어요. 1~2분 정도 걸릴 수 있어요…", async (p) => {
      const { prd, groups } = await aiPlan(p);
      updateProject(id, (x) => ({ ...x, prd, groups, chat: [...x.chat, ai(planDone(groups), { actions: ["goto-features", "run-review"] })] }),
        "AI가 PRD와 기능명세서 초안을 만들었어요");
    }, () => generatePrdLocal(id));
    return;
  }
  generatePrdLocal(id);
}

function generatePrdLocal(id: string) {
  updateProject(id, (p) => {
    const prd = makePrd(p.idea, p.answers);
    const groups = makeFeatures(p.idea, p.answers);
    const count = groups.reduce((n, g) => n + g.features.length, 0);
    return {
      ...p, prd, groups,
      chat: [...p.chat, ai(`PRD 초안과 함께 기능명세서 초안을 만들었어요. 기능 묶음 ${groups.length}개, 세부 기능 ${count}개예요. 이어서 무엇을 할까요?`,
        { actions: ["goto-features", "run-review"] })],
    };
  }, "PRD와 기능명세서 초안을 만들었어요");
}

export function generateFlow(id: string) {
  updateProject(id, (p) => (p.groups ? { ...p, flow: makeFlow(p.groups) } : p), "유저플로우를 만들었어요");
}

export function generateScreens(id: string) {
  updateProject(id, (p) => (p.groups ? { ...p, screens: makeScreens(p.groups) } : p), "와이어프레임을 만들었어요");
}

export function review(id: string) {
  const local = () => updateProject(id, (p) => (p.groups ? { ...p, findings: runReview(p.groups) } : p), "기획 검토를 실행했어요");
  if (!aiEnabled() || !getProject(id)?.groups) return local();
  withAi(id, "여섯 관점에서 기획서를 검토하고 있어요…", async (p) => {
    const findings = await aiReview(p);
    updateProject(id, (x) => ({ ...x, findings, chat: [...x.chat, ai(`검토를 마쳤어요. 의견 ${findings.length}개를 [검토] 패널에 정리했어요.`)] }), "AI가 기획 검토를 실행했어요");
  }, local);
}

export function setFinding(id: string, fid: string, state: "open" | "resolved" | "held") {
  updateProject(id, (p) => ({ ...p, findings: p.findings?.map((f) => (f.id === fid ? { ...f, state } : f)) ?? null }));
}

export function discussFinding(id: string, fid: string) {
  const f = getProject(id)?.findings?.find((x) => x.id === fid);
  if (f && aiEnabled()) {
    withAi(id, "해결 방법을 찾고 있어요…", async (p) => {
      const c = await aiChoices(p, f);
      updateProject(id, (x) => ({ ...x, chat: [...x.chat, ai(c.intro, { choices: { question: f.title, options: c.options.slice(0, 4) } })] }));
    }, () => discussFindingLocal(id, fid, false), [me(`검토 의견을 해결하고 싶어요: ${f.title}`)]);
    return;
  }
  discussFindingLocal(id, fid, true);
}

function discussFindingLocal(id: string, fid: string, withAsk: boolean) {
  updateProject(id, (p) => {
    const f = p.findings?.find((x) => x.id === fid);
    if (!f) return p;
    return {
      ...p,
      chat: [...p.chat, ...(withAsk ? [me(`검토 의견을 해결하고 싶어요: ${f.title}`)] : []), ai("해결 방법을 몇 가지로 정리했어요. 하나를 고르면 기능명세에 반영할 안을 만들게요.", {
        choices: { question: f.title, options: [
          { title: "가장 단순한 규칙으로 정하기", detail: "처음 출시는 한 가지 기준만 두고, 예외는 운영자가 직접 처리해요." },
          { title: "사용자가 직접 정하게 하기", detail: "설정 화면에서 기준을 바꿀 수 있게 해요. 대신 화면이 조금 늘어나요." },
          { title: "자동 처리와 알림 함께 쓰기", detail: "기준을 넘으면 자동으로 처리하고, 관련된 사람에게 알려요." },
        ] },
      })],
    };
  });
}

export function pickChoice(id: string, mid: string, title: string) {
  const p0 = getProject(id);
  const msg = p0?.chat.find((m) => m.id === mid);
  if (p0 && msg?.choices && p0.groups && aiEnabled()) {
    const finding = p0.findings?.find((f) => f.title === msg.choices!.question);
    const target = p0.groups.flatMap((g) => g.features).find((f) => f.id === finding?.featureId) ?? p0.groups[0].features[0];
    updateProject(id, (x) => ({ ...x, chat: x.chat.map((m) => (m.id === mid ? { ...m, choices: { ...m.choices!, picked: title } } : m)) }));
    withAi(id, `'${title}' 기준으로 수정안을 만들고 있어요…`, async (p) => {
      const after = await aiApplyChoice(p, target.code, msg.choices!.question, title);
      updateProject(id, (x) => ({
        ...x,
        chat: [...x.chat, ai(`'${title}' 기준으로 '${target.title}'을 고치는 안을 만들었어요. 기능명세서 아래쪽에서 승인해 주세요.`)],
        findings: x.findings?.map((f) => (f.id === finding?.id ? { ...f, state: "resolved" as const } : f)) ?? null,
        pending: [...x.pending, { id: uid("c_"), featureId: target.id, kind: "edit", before: { summary: target.summary, criteria: target.criteria }, after, reason: title }],
      }));
    }, () => pickChoiceLocal(id, mid, title));
    return;
  }
  pickChoiceLocal(id, mid, title);
}

function pickChoiceLocal(id: string, mid: string, title: string) {
  updateProject(id, (p) => {
    const msg = p.chat.find((m) => m.id === mid);
    if (!msg?.choices || !p.groups) return p;
    const finding = p.findings?.find((f) => f.title === msg.choices!.question);
    const target = p.groups.flatMap((g) => g.features).find((f) => f.id === finding?.featureId) ?? p.groups[0].features[0];
    const after: Partial<Feature> = {
      criteria: [...target.criteria, `${msg.choices.question}: ${title}`],
      summary: target.summary + ` (${title} 기준 적용)`,
    };
    return {
      ...p,
      chat: [...p.chat.map((m) => (m.id === mid ? { ...m, choices: { ...m.choices!, picked: title } } : m)),
        ai(`'${title}' 기준으로 '${target.title}'을 고치는 안을 만들었어요. 기능명세서 아래쪽에서 승인해 주세요.`)],
      findings: p.findings?.map((f) => (f.id === finding?.id ? { ...f, state: "resolved" as const } : f)) ?? null,
      pending: [...p.pending, { id: uid("c_"), featureId: target.id, kind: "edit", before: { summary: target.summary, criteria: target.criteria }, after, reason: title }],
    };
  });
}

export async function sendChat(id: string, text: string) {
  if (aiEnabled()) {
    let wantsReview = false;
    await withAi(id, "생각하고 있어요…", async (p) => {
      const r = await aiChat(p, text);
      updateProject(id, (x) => {
        const next: Project = { ...x, chat: [...x.chat, ai(r.reply)] };
        const groups = x.groups;
        if (groups && r.action === "add_feature") {
          const g = groups.find((y) => y.code === r.groupCode) ?? groups[groups.length - 1];
          const f = toFeature(r.feature, `${g.code}.${g.features.length + 1}`);
          next.pending = [...x.pending, { id: uid("c_"), featureId: f.id, kind: "add", groupId: g.id, after: f, reason: "기능 추가 요청" }];
        }
        if (groups && r.action === "edit_feature") {
          const t = groups.flatMap((y) => y.features).find((f) => f.code === r.featureCode);
          if (t) {
            const { id: _drop, code: _c, status: _s, ...after } = toFeature(r.feature, t.code);
            next.pending = [...x.pending, { id: uid("c_"), featureId: t.id, kind: "edit",
              before: { title: t.title, summary: t.summary, criteria: t.criteria }, after, reason: "수정 요청" }];
          }
        }
        return next;
      });
      wantsReview = r.action === "review";
    }, () => sendChatLocal(id, text, false), [me(text)]);
    if (wantsReview) review(id);
    return;
  }
  sendChatLocal(id, text, true);
}

function sendChatLocal(id: string, text: string, echo: boolean) {
  updateProject(id, (p) => {
    const r = interpret(text, p.groups);
    let next: Project = { ...p, chat: [...p.chat, ...(echo ? [me(text)] : []), ai(r.reply)] };
    if ("add" in r && r.add && p.groups) {
      const g = p.groups[1] ?? p.groups[0];
      const f: Feature = {
        id: uid("f_"), code: `${g.code}.${g.features.length + 1}`, title: r.add,
        summary: `${r.add}을(를) 할 수 있다.`, rationale: "채팅 요청으로 추가된 기능이다.", success: "사용자가 이 기능을 막힘없이 끝낸다.",
        criteria: ["기본 동작이 실패하면 이유를 알려 준다"], roles: ["사용자"], status: "draft", priority: 2,
      };
      next.pending = [...next.pending, { id: uid("c_"), featureId: f.id, kind: "add", groupId: g.id, after: f, reason: "기능 추가 요청" }];
    }
    if ("edit" in r && r.edit && p.groups) {
      const t = p.groups.flatMap((g) => g.features).find((f) => f.id === r.edit)!;
      next.pending = [...next.pending, { id: uid("c_"), featureId: t.id, kind: "edit", before: { summary: t.summary, criteria: t.criteria },
        after: { summary: t.summary + " 처리 과정의 각 단계와 실패했을 때의 안내를 함께 정의한다.", criteria: [...t.criteria, "처리 중 오류가 나면 다시 시도할 수 있다", "모든 변경은 기록으로 남는다"] },
        reason: "구체화 요청" }];
    }
    if ("review" in r && r.review && p.groups) next = { ...next, findings: runReview(p.groups) };
    return next;
  });
}

export function resolvePending(id: string, cid: string, accept: boolean) {
  updateProject(id, (p) => {
    const c = p.pending.find((x) => x.id === cid);
    if (!c || !p.groups) return p;
    let groups = p.groups;
    if (accept && c.kind === "edit") {
      groups = groups.map((g) => ({ ...g, features: g.features.map((f) => (f.id === c.featureId ? { ...f, ...c.after } : f)) }));
    }
    if (accept && c.kind === "add") {
      groups = groups.map((g) => (g.id === c.groupId ? { ...g, features: [...g.features, c.after as Feature] } : g));
    }
    return { ...p, groups, pending: p.pending.filter((x) => x.id !== cid) };
  }, accept ? "AI 수정안을 승인했어요" : "AI 수정안을 거절했어요");
}

export function updateFeature(id: string, fid: string, patch: Partial<Feature>) {
  updateProject(id, (p) => ({
    ...p, groups: p.groups?.map((g) => ({ ...g, features: g.features.map((f) => (f.id === fid ? { ...f, ...patch } : f)) })) ?? null,
  }));
}

export function addFeature(id: string, gid: string) {
  updateProject(id, (p) => ({
    ...p, groups: p.groups?.map((g) => g.id !== gid ? g : {
      ...g, features: [...g.features, {
        id: uid("f_"), code: `${g.code}.${g.features.length + 1}`, title: "새 기능", summary: "", rationale: "", success: "",
        criteria: [], roles: ["사용자"], status: "draft" as const, priority: 2 as const,
      }],
    }) ?? null,
  }), "기능을 추가했어요");
}

export function addGroup(id: string) {
  updateProject(id, (p) => {
    const groups = p.groups ?? [];
    const code = String(groups.length + 1);
    return { ...p, groups: [...groups, { id: uid("g_"), code, title: "새 기능 묶음", features: [] }] };
  }, "기능 묶음을 추가했어요");
}

export function deleteFeature(id: string, fid: string) {
  updateProject(id, (p) => ({ ...p, groups: p.groups?.map((g) => ({ ...g, features: g.features.filter((f) => f.id !== fid) })) ?? null }), "기능을 삭제했어요");
}

export function updatePrdBlock(id: string, sid: string, idx: number, body: string) {
  updateProject(id, (p) => ({
    ...p, prd: p.prd?.map((s) => s.id !== sid ? s : { ...s, blocks: s.blocks.map((b, i) => (i === idx ? { ...b, body } : b)) }) ?? null,
  }));
}

export function addComment(id: string, text: string, featureId?: string) {
  updateProject(id, (p) => ({ ...p, comments: [...p.comments, { id: uid("cm_"), featureId, author: "나", text, at: Date.now() }] }));
}
export function toggleComment(id: string, cid: string) {
  updateProject(id, (p) => ({ ...p, comments: p.comments.map((c) => (c.id === cid ? { ...c, resolved: !c.resolved } : c)) }));
}

const snapshotOf = (p: Project) => JSON.stringify({ prd: p.prd, groups: p.groups, flow: p.flow, screens: p.screens });

export function saveVersion(id: string, name: string) {
  updateProject(id, (p) => ({ ...p, versions: [{ id: uid("v_"), name, at: Date.now(), snapshot: snapshotOf(p) }, ...p.versions] }), `버전 '${name}'을 저장했어요`);
}
export function restoreVersion(id: string, vid: string) {
  updateProject(id, (p) => {
    const v = p.versions.find((x) => x.id === vid);
    return v ? { ...p, ...JSON.parse(v.snapshot) } : p;
  }, "이전 버전으로 되돌렸어요");
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

export function applyDecision(id: string, did: string) {
  updateProject(id, (p) => {
    const d = p.decisions.find((x) => x.id === did);
    if (!d || !p.prd) return p;
    const prd = p.prd.map((s) => s.id !== "risk" ? s : { ...s, blocks: [...s.blocks, { label: `결정 (${d.source})`, body: d.text }] });
    return { ...p, prd, decisions: p.decisions.map((x) => (x.id === did ? { ...x, applied: true } : x)) };
  }, "결정을 기획서에 반영했어요");
}

export function setSettings(id: string, settings: Project["settings"]) {
  updateProject(id, (p) => ({ ...p, settings }));
}
