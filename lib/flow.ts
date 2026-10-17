"use client";

import { josa } from "./josa";
import { z } from "zod";
import { ask, materialText, prdText, styleOf } from "./ai";
import { applyOps, edgeId, localFlow, localPlan, localSyncPlan, nodeId, opsSummary, type FlowBody, type FlowPlan, type FlowPlanOp } from "./flow-local";
import { uid } from "./id";
import { ai, aiEnabled, isBusy, withAi } from "./run";
import { specText } from "./spec-model";
import { getProject, updateProject } from "./store";
import { saveToDrive } from "./sync";
import type { Flow, FlowEdge, FlowKind, Project } from "./types";
import { autoVersion } from "./versions";

export type { FlowOp, FlowPlan, FlowPlanOp } from "./flow-local";

// Labels of the busy bubbles this module shows; the flow tab shows a progress chip for them.
export const FLOW_BUSY = {
  generate: "유저플로우를 그리고 있어요…",
  plan: "유저플로우 변경 계획을 세우고 있어요…",
  sync: "기능명세서 변경을 유저플로우에 반영하고 있어요…",
};

const KINDS = ["start", "page", "data", "branch", "action"] as const;

export const openFlow = (p: Pick<Project, "flows" | "flowId">) => p.flows.find((f) => f.id === p.flowId) ?? p.flows[p.flows.length - 1];

function nextName(p: Project) {
  let n = p.flows.length + 1;
  while (p.flows.some((f) => f.name === `유저플로우 ${n}`)) n++;
  return `유저플로우 ${n}`;
}

function context(p: Project) {
  const props = p.prdProps ? `\n카테고리: ${p.prdProps.category} / 사용자 역할: ${p.prdProps.roles.join(", ")} / 기기: ${p.prdProps.devices.join(", ")}` : "";
  return `아이디어: ${p.idea}${props}${materialText(p)}
PRD:
${prdText(p)}
기능명세서:
${specText(p.spec) || "(기능명세서 없음)"}`;
}

const flowText = (f: FlowBody) => `구역: ${f.sections.join(", ")}
노드 (id | 구역 | 종류 | 이름):
${f.nodes.map((n) => `${n.id} | ${n.section} | ${n.kind} | ${n.label}`).join("\n")}
연결 (id | 출발 → 도착 | 라벨):
${f.edges.map((e) => `${e.id} | ${e.from} → ${e.to} | ${e.label ?? ""}`).join("\n")}`;

// --- Generate -------------------------------------------------------------------------

export const FlowSchema = z.object({
  sections: z.array(z.string()),
  nodes: z.array(z.object({ key: z.string(), section: z.string(), kind: z.enum(KINDS), label: z.string() })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
});

async function aiFlow(p: Project, step: (s: string) => void): Promise<FlowBody> {
  step("화면 찾는 중");
  const out = await ask(FlowSchema, `${context(p)}

위 서비스의 유저플로우를 하나 그립니다. 사용자가 앱을 열고 목적을 이룰 때까지 지나가는 화면과 판단을 빠짐없이 담습니다.
- 구역(sections) 4~8개: 서비스의 큰 흐름 단위입니다(예: 인증 및 온보딩, 탐색, 참여, 마이페이지). 이 서비스에 맞는 이름을 씁니다.
- 노드 30~60개. 각 노드는 구역 하나에 속합니다. kind:
  - start: 진입점. "앱 실행"과 "알림 진입"은 꼭 넣습니다.
  - page: 화면. 기능명세서가 암시하는 화면을 모두 page로 만듭니다(목록·상세·작성·완료·빈 화면 등).
  - data: 화면이 보여주거나 저장하는 데이터(예: 모임 일정 목록). page에서 data로 연결합니다.
  - branch: 조건 판단, 질문 형태 이름(예: "로그인 상태인가요?"). 나가는 연결 라벨은 "Y"와 "N"으로 시작합니다.
  - action: 제출·저장·결제처럼 사용자가 실행하는 동작.
- 연결(edges) 라벨은 사용자의 행동을 짧게 씁니다(예: "가입 신청 제출"). 앞 화면으로 돌아가는 연결은 라벨 앞에 "↩"를 붙입니다.
- key는 n1, n2처럼 고유하게 짓고 from/to에 그 key를 씁니다. 모든 노드는 적어도 하나의 연결에 이어집니다.
${styleOf(p)}`);
  step("구역 나누는 중");
  const ids = new Map(out.nodes.map((n) => [n.key, nodeId()]));
  const sections = [...new Set([...out.sections, ...out.nodes.map((n) => n.section)].filter(Boolean))];
  const nodes = out.nodes.filter((n, i) => out.nodes.findIndex((m) => m.key === n.key) === i)
    .map((n) => ({ id: ids.get(n.key)!, section: n.section || sections[0], kind: n.kind as FlowKind, label: n.label }));
  step("연결 정리");
  const edges: FlowEdge[] = [];
  for (const e of out.edges) {
    const from = ids.get(e.from), to = ids.get(e.to);
    if (from && to && from !== to && !edges.some((x) => x.from === from && x.to === to)) edges.push({ id: edgeId(), from, to, label: e.label || undefined });
  }
  if (nodes.length < 3) throw new Error("AI가 그린 유저플로우가 너무 짧아요.");
  return { sections, nodes, edges };
}

function addFlow(id: string, body: FlowBody, how: string) {
  let summary = "";
  updateProject(id, (p) => {
    const flow: Flow = { id: uid("f_"), name: nextName(p), at: Date.now(), ...body };
    summary = `${flow.name} 생성 · 노드 ${flow.nodes.length}개 · 연결 ${flow.edges.length}개`;
    return {
      ...p, flows: [...p.flows, flow], flowId: flow.id, stale: { ...p.stale, flow: false },
      chat: [...p.chat, ai(`${flow.name}${josa(flow.name, "을/를")} ${how}. 구역 ${flow.sections.length}개, 노드 ${flow.nodes.length}개, 연결 ${flow.edges.length}개예요. 노드를 눌러 고치거나 [수정본 생성]으로 크게 바꿀 수 있어요.\n다음은 와이어프레임이에요. 유저플로우의 페이지마다 화면을 하나씩 그려요.`, { actions: ["make-wire"] })],
    };
  }, "유저플로우를 만들었어요");
  autoVersion(id, summary);
  saveToDrive();
}

export function generateFlow(id: string) {
  const local = () => {
    const p = getProject(id);
    if (p) addFlow(id, localFlow(p), "만들었어요");
  };
  if (!aiEnabled()) return local();
  return withAi(id, FLOW_BUSY.generate, async (p, step) => {
    const body = await aiFlow(p, step);
    addFlow(id, body, "AI가 그렸어요");
  }, local);
}

// --- Revision plans --------------------------------------------------------------------

export const PlanSchema = z.object({
  summary: z.string(),
  ops: z.array(z.object({
    op: z.enum(["addNode", "removeNode", "renameNode", "addEdge", "removeEdge", "setEdgeLabel"]),
    line: z.string(),
    tempId: z.string(), section: z.string(), kind: z.string(), label: z.string(),
    nodeId: z.string(), from: z.string(), to: z.string(), edgeId: z.string(),
  })),
});

// Keeps only ops that point at nodes/edges that exist (or temp nodes added earlier in the plan).
function cleanPlan(flow: FlowBody, out: z.infer<typeof PlanSchema>): FlowPlan {
  const nodes = new Set(flow.nodes.map((n) => n.id));
  const edges = new Set(flow.edges.map((e) => e.id));
  const ops: FlowPlanOp[] = [];
  for (const o of out.ops) {
    const line = o.line;
    if (o.op === "addNode" && o.tempId && o.label) {
      nodes.add(o.tempId);
      const kind = (KINDS as readonly string[]).includes(o.kind) ? (o.kind as FlowKind) : "page";
      ops.push({ op: "addNode", tempId: o.tempId, section: o.section || flow.sections[0] || "기본", kind, label: o.label, line });
    } else if (o.op === "removeNode" && nodes.has(o.nodeId)) ops.push({ op: "removeNode", nodeId: o.nodeId, line });
    else if (o.op === "renameNode" && nodes.has(o.nodeId) && o.label) ops.push({ op: "renameNode", nodeId: o.nodeId, label: o.label, line });
    else if (o.op === "addEdge" && nodes.has(o.from) && nodes.has(o.to)) ops.push({ op: "addEdge", from: o.from, to: o.to, label: o.label || undefined, line });
    else if (o.op === "removeEdge" && edges.has(o.edgeId)) ops.push({ op: "removeEdge", edgeId: o.edgeId, line });
    else if (o.op === "setEdgeLabel" && edges.has(o.edgeId)) ops.push({ op: "setEdgeLabel", edgeId: o.edgeId, label: o.label, line });
  }
  return { summary: out.summary, ops };
}

async function aiPlan(p: Project, flow: FlowBody, request: string, focus: string[]): Promise<FlowPlan> {
  const focusText = focus.length
    ? `\n주로 고칠 노드: ${focus.map((id) => flow.nodes.find((n) => n.id === id)).filter(Boolean).map((n) => `${n!.id}(${n!.label})`).join(", ")}`
    : "";
  const out = await ask(PlanSchema, `${context(p)}

지금 유저플로우:
${flowText(flow)}

요청: ${request}${focusText}

요청을 반영하는 변경 계획을 세웁니다. 플로우 전체를 다시 그리지 말고 꼭 필요한 변경만 순서대로 적습니다.
- summary: 무엇을 왜 바꾸는지 한 문장.
- ops의 op: addNode(새 노드: tempId "t1","t2"…, section, kind=start|page|data|branch|action, label), removeNode(nodeId), renameNode(nodeId, label), addEdge(from, to, label), removeEdge(edgeId), setEdgeLabel(edgeId, label).
- addEdge의 from/to에는 기존 노드 id나 앞에서 만든 tempId를 씁니다. 분기에서 나가는 연결 라벨은 "Y"/"N"으로 시작하고, 돌아가는 연결은 "↩"로 시작합니다.
- 쓰지 않는 필드는 빈 문자열로 둡니다.
- line: 사람이 읽는 한 줄 설명(예: "새 노드 추가 (승인 대기 화면)", "연결 삭제 (홈 → 설정)", "조건 설정 (Y → 결제 완료)").
${styleOf(p)}`);
  return cleanPlan(flow, out);
}

// For the chat: the open flow as text, and a change plan made inside an AI run the chat already holds.
export const flowOutline = (p: Project) => { const f = openFlow(p); return f ? `${f.name}\n${flowText(f)}` : ""; };
export const chatFlowPlan = (p: Project, request: string) => aiPlan(p, openFlow(p)!, request, []);
export const localChatFlowPlan = (p: Project, request: string) => localPlan(openFlow(p)!, request, []);

export function setChatFlowPlan(id: string, msgId: string, done: "applied" | "copied" | "dismissed") {
  const p = getProject(id);
  const m = p?.chat.find((x) => x.id === msgId);
  if (!p || !m?.flowPlan || m.flowPlan.done) return;
  if (done !== "dismissed") {
    if (p.flowId !== m.flowPlan.flowId && p.flows.some((f) => f.id === m.flowPlan!.flowId)) selectFlow(id, m.flowPlan.flowId);
    applyFlowPlan(id, m.flowPlan, done === "copied");
  }
  updateProject(id, (x) => ({ ...x, chat: x.chat.map((y) => (y.id === msgId && y.flowPlan ? { ...y, flowPlan: { ...y.flowPlan, done } } : y)) }));
  saveToDrive();
}

export async function planFlowRevision(id: string, request: string, focusNodeIds: string[]): Promise<FlowPlan> {
  const p = getProject(id);
  const flow = p && openFlow(p);
  if (!p || !flow) return { summary: "열린 유저플로우가 없어요.", ops: [] };
  const local = () => localPlan(flow, request, focusNodeIds);
  if (!aiEnabled() || isBusy(p)) return local();
  let plan: FlowPlan | null = null;
  await withAi(id, FLOW_BUSY.plan, async (x, step) => {
    step("요청 읽는 중");
    plan = await aiPlan(x, openFlow(x) ?? flow, request, focusNodeIds);
    step("계획 정리");
  }, () => { plan = local(); });
  return plan ?? local();
}

export function applyFlowPlan(id: string, plan: FlowPlan, asNewVersion: boolean, enabledOps?: number[]) {
  const ops = plan.ops.filter((_, i) => !enabledOps || enabledOps.includes(i));
  if (!ops.length) return;
  let label = "";
  updateProject(id, (p) => {
    const cur = openFlow(p);
    if (!cur) return p;
    const stale = { ...p.stale, ...(p.wires.length ? { wire: true } : {}) };
    if (asNewVersion) {
      const copy = applyOps({ ...cur, id: uid("f_"), name: `${cur.name} 수정본`, at: Date.now() }, ops);
      label = `${copy.name} 생성 · ${opsSummary(ops)}`;
      return { ...p, flows: [...p.flows, copy], flowId: copy.id, stale };
    }
    const next = applyOps(cur, ops);
    label = `${cur.name} 수정 · ${opsSummary(ops)}`;
    return { ...p, flows: p.flows.map((f) => (f.id === cur.id ? next : f)), stale };
  }, "유저플로우 변경 계획을 적용했어요");
  if (label) autoVersion(id, label);
  saveToDrive();
}

// Spec changed since the flow was drawn: revise the open flow in place to match it.
export async function syncFlow(id: string): Promise<void> {
  const p = getProject(id);
  const flow = p && openFlow(p);
  if (!p) return;
  const done = (plan: FlowPlan) => {
    if (plan.ops.length) applyFlowPlan(id, plan, false);
    updateProject(id, (x) => ({ ...x, stale: { ...x.stale, flow: false } }), "유저플로우를 기능명세서에 맞췄어요");
    saveToDrive();
  };
  if (!flow) return done({ summary: "", ops: [] });
  if (!aiEnabled()) return done(localSyncPlan(p, flow));
  await withAi(id, FLOW_BUSY.sync, async (x, step) => {
    step("바뀐 기능 찾는 중");
    const f = openFlow(x) ?? flow;
    const plan = await aiPlan(x, f, "기능명세서가 바뀌었습니다. 지금 기능명세서에 맞게 유저플로우를 고칩니다. 새 기능의 화면을 추가하고, 명세에서 사라진 기능의 화면과 연결은 지우고, 이름이 바뀐 기능은 노드 이름을 바꿉니다.", []);
    step("연결 정리");
    done(plan);
  }, () => {
    const x = getProject(id);
    const f = x && openFlow(x);
    if (x && f) done(localSyncPlan(x, f));
  });
}

// --- Direct edits --------------------------------------------------------------------------

function editFlow(id: string, flowId: string, fn: (f: Flow) => Flow, log?: string) {
  updateProject(id, (p) => ({
    ...p,
    flows: p.flows.map((f) => (f.id === flowId ? fn(f) : f)),
    stale: p.wires.some((w) => w.flowId === flowId) ? { ...p.stale, wire: true } : p.stale,
  }), log);
  saveToDrive();
}

export const selectFlow = (id: string, flowId: string) => updateProject(id, (p) => ({ ...p, flowId }));

export function renameFlow(id: string, flowId: string, name: string) {
  if (!name.trim()) return;
  updateProject(id, (p) => ({ ...p, flows: p.flows.map((f) => (f.id === flowId ? { ...f, name: name.trim() } : f)) }));
  saveToDrive();
}

export function deleteFlow(id: string, flowId: string) {
  let name = "";
  updateProject(id, (p) => {
    name = p.flows.find((f) => f.id === flowId)?.name ?? "";
    const flows = p.flows.filter((f) => f.id !== flowId);
    return { ...p, flows, flowId: p.flowId === flowId ? flows[flows.length - 1]?.id : p.flowId };
  }, "유저플로우를 삭제했어요");
  autoVersion(id, `${name} 삭제`);
  saveToDrive();
}

export const renameNode = (id: string, flowId: string, nid: string, label: string) => label.trim() &&
  editFlow(id, flowId, (f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === nid ? { ...n, label: label.trim() } : n)) }));

export const setNodeKind = (id: string, flowId: string, nid: string, kind: FlowKind) =>
  editFlow(id, flowId, (f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === nid ? { ...n, kind } : n)) }));

export const deleteNode = (id: string, flowId: string, nid: string) =>
  editFlow(id, flowId, (f) => ({ ...f, nodes: f.nodes.filter((n) => n.id !== nid), edges: f.edges.filter((e) => e.from !== nid && e.to !== nid) }), "유저플로우 노드를 삭제했어요");

export const moveNodeSection = (id: string, flowId: string, nid: string, section: string) =>
  editFlow(id, flowId, (f) => ({
    ...f, sections: f.sections.includes(section) ? f.sections : [...f.sections, section],
    nodes: f.nodes.map((n) => (n.id === nid ? { ...n, section } : n)),
  }));

const NEW_LABEL: Record<FlowKind, string> = { start: "새 진입점", page: "새 화면", data: "새 데이터", branch: "조건?", action: "새 행동" };

// Adds a node connected from nodeId; it lands one column to the right. Returns the new id.
export function addNodeAfter(id: string, flowId: string, nid: string, kind: FlowKind = "page") {
  const nn = nodeId();
  editFlow(id, flowId, (f) => {
    const src = f.nodes.find((n) => n.id === nid);
    if (!src) return f;
    return { ...f, nodes: [...f.nodes, { id: nn, section: src.section, kind, label: NEW_LABEL[kind] }], edges: [...f.edges, { id: edgeId(), from: nid, to: nn }] };
  });
  return nn;
}

// Adds a sibling below nodeId: it gets the same incoming connection, so it sits in the same column.
export function addNodeBelow(id: string, flowId: string, nid: string, kind: FlowKind = "page") {
  const nn = nodeId();
  editFlow(id, flowId, (f) => {
    const src = f.nodes.find((n) => n.id === nid);
    if (!src) return f;
    const parent = f.edges.find((e) => e.to === nid && !e.label?.startsWith("↩"))?.from;
    return {
      ...f, nodes: [...f.nodes, { id: nn, section: src.section, kind, label: NEW_LABEL[kind] }],
      edges: parent ? [...f.edges, { id: edgeId(), from: parent, to: nn }] : f.edges,
    };
  });
  return nn;
}

export const addSection = (id: string, flowId: string, name: string) => name.trim() &&
  editFlow(id, flowId, (f) => (f.sections.includes(name.trim()) ? f : { ...f, sections: [...f.sections, name.trim()] }));

export const renameSection = (id: string, flowId: string, from: string, to: string) => to.trim() && from !== to.trim() &&
  editFlow(id, flowId, (f) => {
    const t = to.trim();
    return { ...f, sections: [...new Set(f.sections.map((s) => (s === from ? t : s)))], nodes: f.nodes.map((n) => (n.section === from ? { ...n, section: t } : n)) };
  });

export const setEdgeLabel = (id: string, flowId: string, eid: string, label: string) =>
  editFlow(id, flowId, (f) => ({ ...f, edges: f.edges.map((e) => (e.id === eid ? { ...e, label: label.trim() || undefined } : e)) }));

export const deleteEdge = (id: string, flowId: string, eid: string) =>
  editFlow(id, flowId, (f) => ({ ...f, edges: f.edges.filter((e) => e.id !== eid) }));
