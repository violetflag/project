import { josa } from "./josa";
import { uid } from "./id";
import type { Flow, FlowEdge, FlowKind, FlowNode, Project, SpecItem } from "./types";

// Pure helpers for user flows: plan ops, applying them, and the local (no API key) generator.

export type FlowOp =
  | { op: "addNode"; tempId: string; section: string; kind: FlowKind; label: string }
  | { op: "removeNode"; nodeId: string }
  | { op: "renameNode"; nodeId: string; label: string }
  | { op: "addEdge"; from: string; to: string; label?: string }
  | { op: "removeEdge"; edgeId: string }
  | { op: "setEdgeLabel"; edgeId: string; label: string };

export type FlowPlanOp = FlowOp & { line: string };
export interface FlowPlan {
  summary: string;
  ops: FlowPlanOp[];
}

export type FlowBody = Pick<Flow, "sections" | "nodes" | "edges">;

export const KIND_LABEL: Record<FlowKind, string> = { start: "시작", page: "페이지", data: "데이터", branch: "분기", action: "행동" };
export const FLOW_KINDS: FlowKind[] = ["start", "page", "data", "branch", "action"];

export const nodeId = () => uid("n_");
export const edgeId = () => uid("e_");

// Applies ops in order. addNode's tempId can be used as from/to in later addEdge ops.
export function applyOps(flow: Flow, ops: FlowOp[]): Flow {
  const temp = new Map<string, string>();
  const ref = (x: string) => temp.get(x) ?? x;
  let { sections, nodes, edges } = flow;
  for (const o of ops) {
    if (o.op === "addNode") {
      const id = nodeId();
      temp.set(o.tempId, id);
      const section = o.section || sections[0] || "기본";
      if (!sections.includes(section)) sections = [...sections, section];
      nodes = [...nodes, { id, section, kind: o.kind, label: o.label }];
    } else if (o.op === "removeNode") {
      const id = ref(o.nodeId);
      nodes = nodes.filter((n) => n.id !== id);
      edges = edges.filter((e) => e.from !== id && e.to !== id);
    } else if (o.op === "renameNode") {
      const id = ref(o.nodeId);
      nodes = nodes.map((n) => (n.id === id ? { ...n, label: o.label } : n));
    } else if (o.op === "addEdge") {
      const from = ref(o.from), to = ref(o.to);
      if (!nodes.some((n) => n.id === from) || !nodes.some((n) => n.id === to)) continue;
      if (edges.some((e) => e.from === from && e.to === to)) continue;
      edges = [...edges, { id: edgeId(), from, to, label: o.label || undefined }];
    } else if (o.op === "removeEdge") {
      edges = edges.filter((e) => e.id !== o.edgeId);
    } else if (o.op === "setEdgeLabel") {
      edges = edges.map((e) => (e.id === o.edgeId ? { ...e, label: o.label || undefined } : e));
    }
  }
  return { ...flow, sections, nodes, edges };
}

// Short, readable summary of a plan's ops, e.g. "노드 2개 추가 · 연결 1개 삭제".
export function opsSummary(ops: FlowOp[]) {
  const c = (k: FlowOp["op"]) => ops.filter((o) => o.op === k).length;
  return [
    [c("addNode"), "노드", "추가"], [c("removeNode"), "노드", "삭제"], [c("renameNode"), "노드 이름", "변경"],
    [c("addEdge"), "연결", "추가"], [c("removeEdge"), "연결", "삭제"], [c("setEdgeLabel"), "연결 이름", "변경"],
  ].filter(([n]) => n).map(([n, w, v]) => `${w} ${n}개 ${v}`).join(" · ") || "변경 없음";
}

// --- Local generator -------------------------------------------------------------

const ACTION_RE = /(등록|저장|신청|제출|결제|작성|전송|예약|초대|참여|투표|업로드|추가|요청|공유|신고|보내기|수락|승인)/;
const MY_RE = /(마이|내 정보|프로필|설정|계정)/;

const short = (s: string, n = 18) => {
  const t = s.replace(/[()[\]{}「」"']/g, "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n).trim() : t;
};
const live = (xs: SpecItem[]) => xs.filter((x) => x.pending?.kind !== "delete");

class Builder {
  sections: string[] = [];
  nodes: FlowNode[] = [];
  edges: FlowEdge[] = [];
  section(name: string) {
    if (!this.sections.includes(name)) this.sections.push(name);
    return name;
  }
  node(section: string, kind: FlowKind, label: string) {
    const id = nodeId();
    this.nodes.push({ id, section: this.section(section), kind, label });
    return id;
  }
  edge(from: string, to: string, label?: string) {
    if (from && to && from !== to && !this.edges.some((e) => e.from === from && e.to === to)) this.edges.push({ id: edgeId(), from, to, label });
  }
}

// Main areas of the app: level-1 requirements with their features (level 2) and details (level 3).
function areas(p: Project): { title: string; features: { title: string; details: string[] }[] }[] {
  const reqs = live(p.spec ?? []);
  if (reqs.length) {
    return reqs.slice(0, 6).map((r) => ({
      title: short(r.title, 16),
      features: live(r.children).map((f) => ({ title: f.title, details: live(f.children).map((d) => d.title) })),
    }));
  }
  // No spec yet: build from the idea's first words.
  const w = short(p.idea.split(/[,.\n]/)[0] || p.name, 10) || "항목";
  return [
    { title: `${w} 둘러보기`, features: [{ title: `${w} 목록`, details: ["추천 목록"] }, { title: `${w} 상세`, details: ["상세 정보", "관심 등록"] }, { title: "검색", details: ["검색 결과"] }] },
    { title: `${w} 만들기`, features: [{ title: `${w} 작성`, details: ["작성 내용 저장"] }, { title: "작성 미리보기", details: ["입력한 내용"] }] },
    { title: "소식과 알림", features: [{ title: "알림 목록", details: ["받은 알림"] }] },
  ];
}

export function localFlow(p: Project): FlowBody {
  const b = new Builder();
  const all = areas(p);
  const auth = b.section("인증 및 온보딩");
  const main = all.map((a) => b.section(a.title));
  const homeSection = main[0] ?? b.section("홈");

  // Onboarding and login.
  const launch = b.node(auth, "start", "앱 실행");
  const splash = b.node(auth, "page", "스플래시");
  const logged = b.node(auth, "branch", "로그인 상태인가요?");
  const login = b.node(auth, "page", "로그인");
  const loginReq = b.node(auth, "action", "로그인 요청");
  const ok = b.node(auth, "branch", "인증 성공?");
  const join = b.node(auth, "page", "회원가입");
  const joinData = b.node(auth, "data", "가입 입력 항목");
  const joinReq = b.node(auth, "action", "가입 신청");
  const welcome = b.node(auth, "page", "시작 안내");
  const home = b.node(homeSection, "page", "홈");
  const homeData = b.node(homeSection, "data", short(`${all[0]?.features[0]?.title ?? "주요"} 요약`, 18));
  b.edge(launch, splash, "앱 열기");
  b.edge(splash, logged, "자동 로그인 확인");
  b.edge(logged, home, "Y");
  b.edge(logged, login, "N");
  b.edge(login, loginReq, "로그인 버튼 누름");
  b.edge(loginReq, ok, "계정 확인");
  b.edge(ok, home, "Y");
  b.edge(ok, login, "N ↩ 다시 입력");
  b.edge(login, join, "회원가입 선택");
  b.edge(join, joinData, "입력");
  b.edge(join, joinReq, "가입 신청 제출");
  b.edge(joinReq, welcome, "가입 완료");
  b.edge(welcome, home, "시작하기");
  b.edge(home, homeData, "표시");

  // Each area: a hub page reached from home, the other feature pages from the hub.
  const budget = Math.max(2, Math.floor(26 / Math.max(1, all.length)));
  const hubs: string[] = [];
  all.forEach((a, i) => {
    const sec = main[i];
    let hub = "";
    a.features.slice(0, budget).forEach((f, j) => {
      const page = b.node(sec, "page", short(f.title));
      if (j === 0) {
        hub = page;
        hubs.push(page);
        b.edge(home, page, short(`${a.title} 메뉴 선택`, 16));
      } else {
        b.edge(hub, page, short(`${f.title} 열기`, 16));
      }
      const act = f.details.find((d) => ACTION_RE.test(d)) ?? (ACTION_RE.test(f.title) ? f.title : undefined);
      const show = f.details.find((d) => d !== act);
      if (show && b.nodes.length < 52) b.edge(page, b.node(sec, "data", short(show)), "표시");
      if (act && b.nodes.length < 54) {
        const a2 = b.node(sec, "action", short(act, 14));
        b.edge(page, a2, short(act, 14));
        // The first action of each area gets a success check.
        if (j === 0 || a.features.length === 1) {
          const br = b.node(sec, "branch", "처리 성공?");
          b.edge(a2, br, "결과 확인");
          b.edge(br, hub, "Y ↩ 목록으로");
          b.edge(br, page, "N ↩ 다시 시도");
        } else {
          b.edge(a2, page, "↩ 완료");
        }
      }
    });
  });

  // My page, unless the spec already has one.
  if (!all.some((a) => MY_RE.test(a.title))) {
    const my = b.section("마이페이지 및 설정");
    const mine = b.node(my, "page", "마이페이지");
    const profile = b.node(my, "data", "내 활동 내역");
    const settings = b.node(my, "page", "설정");
    const logout = b.node(my, "action", "로그아웃");
    b.edge(home, mine, "내 정보 탭");
    b.edge(mine, profile, "표시");
    b.edge(mine, settings, "설정 열기");
    b.edge(settings, logout, "로그아웃 누름");
    b.edge(logout, login, "↩ 로그인으로");
  }

  // Entry from a push notification into the second area (or home).
  const push = b.node(homeSection, "start", "알림 진입");
  b.edge(push, hubs[1] ?? hubs[0] ?? home, "알림 누름");
  return { sections: b.sections, nodes: b.nodes, edges: b.edges };
}

// --- Local revision plans -------------------------------------------------------------

// "가입 승인 대기 화면을 추가해 줘" → "가입 승인 대기 화면"
export function nameFrom(request: string) {
  const q = request.match(/["'“‘「]([^"'”’」]+)["'”’」]/);
  if (q) return short(q[1], 20);
  const t = request.split(/[.\n]/)[0]
    .replace(/\s*(을|를|이|가|은|는)?\s*(추가|넣|만들|그려|생성|붙|넣어|보여|연결|두|하나)[^]*$/, "")
    .replace(/^(그리고|또|새로운?|새)\s*/, "").trim();
  return short(t, 20) || "새 화면";
}

const succ = (f: FlowBody, id: string) => f.edges.filter((e) => e.from === id).map((e) => e.to);

export function localPlan(flow: FlowBody, request: string, focus: string[]): FlowPlan {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const focused = focus.map((id) => byId.get(id)).filter((n): n is FlowNode => !!n);
  const anchor = focused[0] ?? [...flow.nodes].reverse().find((n) => n.kind === "page") ?? flow.nodes[0];
  const name = nameFrom(request);
  const ops: FlowPlanOp[] = [];

  if (/(삭제|빼|없애|제거|지워)/.test(request) && focused.length) {
    focused.forEach((n) => ops.push({ op: "removeNode", nodeId: n.id, line: `노드 삭제 (${n.label})` }));
    return { summary: `고른 노드 ${focused.length}개와 그 연결을 지워요.`, ops };
  }
  if (/(이름|바꿔|변경|고쳐)/.test(request) && focused.length === 1 && name !== "새 화면") {
    ops.push({ op: "renameNode", nodeId: focused[0].id, label: name, line: `이름 변경 (${focused[0].label} → ${name})` });
    return { summary: `'${focused[0].label}' 노드의 이름을 '${name}'${josa(name, "으로/로")} 바꿔요.`, ops };
  }
  const section = anchor?.section ?? flow.sections[0] ?? "기본";
  if (/(분기|조건|여부|확인|인지)/.test(request)) {
    const base = name.replace(/\s*(분기|조건)(을|를)?$/, "") || "조건";
    const label = base.endsWith("?") ? base : `${base}?`;
    ops.push({ op: "addNode", tempId: "t1", section, kind: "branch", label, line: `분기 추가 (${label})` });
    if (anchor) {
      ops.push({ op: "addEdge", from: anchor.id, to: "t1", label: "조건 확인", line: `연결 추가 (${anchor.label} → ${label})` });
      const next = succ(flow, anchor.id).map((id) => byId.get(id)!).find((n) => n && n.kind !== "data");
      if (next) ops.push({ op: "addEdge", from: "t1", to: next.id, label: "Y", line: `조건 설정 (Y → ${next.label})` });
      ops.push({ op: "addEdge", from: "t1", to: anchor.id, label: "N ↩ 다시 시도", line: `조건 설정 (N → ${anchor.label})` });
    }
    return { summary: `${anchor ? `'${anchor.label}' 다음에 ` : ""}'${label}' 분기를 넣어요.`, ops };
  }
  const kind: FlowKind = /(데이터|정보|목록 데이터|내역)/.test(name) && !/화면|페이지/.test(name) ? "data" : ACTION_RE.test(name) && !/화면|페이지/.test(name) ? "action" : "page";
  ops.push({ op: "addNode", tempId: "t1", section, kind, label: name, line: `새 노드 추가 (${name})` });
  if (anchor) ops.push({ op: "addEdge", from: anchor.id, to: "t1", label: kind === "data" ? "표시" : short(`${name} 열기`, 16), line: `연결 추가 (${anchor.label} → ${name})` });
  focused.slice(1).forEach((n) => ops.push({ op: "addEdge", from: "t1", to: n.id, label: `${n.label} 이동`, line: `연결 추가 (${name} → ${n.label})` }));
  if (anchor && kind === "page") ops.push({ op: "addEdge", from: "t1", to: anchor.id, label: "↩ 돌아가기", line: `연결 추가 (${name} → ${anchor.label}, 돌아가기)` });
  return { summary: `${anchor ? `'${anchor.label}' 뒤에 ` : ""}'${name}' ${KIND_LABEL[kind]} 노드를 붙여요.`, ops };
}

// Spec changed: add a page for every feature that has no page of the same name yet.
export function localSyncPlan(p: Project, flow: FlowBody): FlowPlan {
  const labels = new Set(flow.nodes.map((n) => n.label.replace(/\s/g, "")));
  const ops: FlowPlanOp[] = [];
  let t = 0;
  for (const r of live(p.spec ?? [])) {
    const sec = short(r.title, 16);
    const inSec = flow.nodes.find((n) => n.section === sec && n.kind === "page" && n.label !== "홈");
    const home = flow.nodes.find((n) => n.label === "홈");
    for (const f of live(r.children)) {
      if (t >= 12) break;
      const label = short(f.title);
      if (labels.has(label.replace(/\s/g, ""))) continue;
      labels.add(label.replace(/\s/g, ""));
      const tempId = `t${++t}`;
      ops.push({ op: "addNode", tempId, section: inSec?.section ?? sec, kind: "page", label, line: `새 노드 추가 (${label})` });
      const from = inSec ?? home;
      if (from) ops.push({ op: "addEdge", from: from.id, to: tempId, label: short(`${f.title} 열기`, 16), line: `연결 추가 (${from.label} → ${label})` });
    }
  }
  return { summary: ops.length ? "기능명세서에 새로 생긴 기능을 화면으로 추가해요." : "플로우가 이미 기능명세서와 맞아요.", ops };
}
