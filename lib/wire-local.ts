// Local wireframe generator (no network) and flow helpers shared with lib/wire.ts.
// Pages are built from the page name, its section, related spec features and the flow edges.

import { josa } from "./josa";
import { uid } from "./id";
import { flatten } from "./spec-model";
import type { Flow, FlowNode, Project, SpecItem, WireEl } from "./types";

type Device = "mobile" | "desktop";
type ElBody = WireEl extends infer U ? (U extends WireEl ? Omit<U, "id"> : never) : never;

// Page nodes in section order, so a page added later to an early section still sits with it.
export const pageNodes = (flow: Flow) => {
  const sec = (name: string) => { const i = flow.sections.indexOf(name); return i < 0 ? flow.sections.length : i; };
  return flow.nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.kind === "page")
    .sort((a, b) => sec(a.n.section) - sec(b.n.section) || a.i - b.i).map(({ n }) => n);
};

// Pages reachable from a page, walking through data/branch/action nodes in between.
export function nextPages(flow: Flow, nodeId: string): { node: FlowNode; label?: string }[] {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const out: { node: FlowNode; label?: string }[] = [];
  const seen = new Set([nodeId]);
  let front: { id: string; label?: string }[] = [{ id: nodeId }];
  for (let depth = 0; depth < 4 && front.length; depth++) {
    const next: { id: string; label?: string }[] = [];
    for (const f of front) {
      for (const e of flow.edges.filter((x) => x.from === f.id)) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        const n = byId.get(e.to);
        if (!n) continue;
        const label = f.label || e.label;
        if (n.kind === "page") out.push({ node: n, label });
        else next.push({ id: n.id, label });
      }
    }
    front = next;
  }
  return out;
}

const AUTH = /로그인|인증|온보딩|가입|회원|시작|스플래시|약관|계정 ?생성/;

// Main pages that get a bottom tab menu: the first page of each non-auth section.
export function navPages(flow: Flow): FlowNode[] {
  const pages = pageNodes(flow);
  const out: FlowNode[] = [];
  for (const s of flow.sections) {
    if (AUTH.test(s)) continue;
    const first = pages.find((n) => n.section === s && !AUTH.test(n.label));
    if (first) out.push(first);
  }
  return out.slice(0, 5);
}
export const hasNav = (flow: Flow, node: FlowNode) => !AUTH.test(node.section) && !AUTH.test(node.label) && navPages(flow).length >= 2;

// Short tab name for a page: "모임 탐색 홈" → "모임 탐색"; at most 5 characters per word kept.
export const navName = (label: string) => label.replace(/(페이지|화면|목록|메인)$/g, "").trim().split(/\s+/).slice(0, 2).join(" ") || label;

export const normal = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const words = (s: string) => s.split(/[\s·,/()]+/).map((w) => w.replace(/(을|를|이|가|은|는|의|에|와|과|로|으로|하기|기능)$/, "")).filter((w) => w.length >= 2);

// Which flow page a nav/tab/list item points to, matched by name (falls back to the element's own `to`).
export function matchPage(text: string, pages: FlowNode[]): FlowNode | undefined {
  const t = normal(text);
  if (!t) return undefined;
  return pages.find((n) => normal(n.label) === t)
    ?? pages.find((n) => normal(n.label).includes(t) || t.includes(normal(navName(n.label))))
    ?? pages.find((n) => words(n.label).some((w) => t.includes(normal(w)) && w.length >= 2));
}

export function relatedFeatures(spec: SpecItem[] | null | undefined, text: string, max = 4): SpecItem[] {
  const ws = words(text);
  if (!ws.length) return [];
  return flatten(spec)
    .map((x) => ({ x, score: ws.filter((w) => (x.title + " " + x.summary).includes(w)).length + (ws.some((w) => x.title.includes(w)) ? 1 : 0) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.x.level - b.x.level)
    .slice(0, max)
    .map((r) => r.x);
}

// --- Sample data -----------------------------------------------------------------

const NAMES = ["김지윤", "이서준", "박하은", "최민재", "정다은", "한유진", "오세훈", "윤채원"];
const AREAS = ["망원동", "성수동", "연남동", "서촌", "판교", "해운대", "광교", "을지로"];
const DAYS = ["10월 24일 (금) 19:30", "10월 26일 (일) 14:00", "11월 2일 (일) 10:00", "11월 7일 (금) 20:00", "11월 12일 (수) 18:30"];

function topic(p: Pick<Project, "idea" | "name">) {
  const ws = words(p.idea || p.name).filter((w) => !/앱|서비스|플랫폼|관리|만들|위한|있는|하는/.test(w));
  return ws.slice(0, 2).join(" ") || p.name || "서비스";
}

const pick = <T,>(arr: T[], i: number) => arr[((i % arr.length) + arr.length) % arr.length];

// --- Page builder -------------------------------------------------------------------

export function localPage(p: Project, flow: Flow, node: FlowNode, device: Device, seed = 0): WireEl[] {
  const name = node.label;
  const subject = topic(p);
  const feats = relatedFeatures(p.spec, `${name} ${node.section}`);
  const next = nextPages(flow, node.id);
  const pages = pageNodes(flow);
  const first = pages[0]?.id === node.id;
  const detail = next.find((x) => /상세|정보|보기/.test(x.node.label))?.node ?? next[0]?.node;
  const s = seed * 3 + name.length;
  const els: ElBody[] = [];

  els.push({ t: "bar", title: name, back: !first && !navPages(flow).some((n) => n.id === node.id) });

  const card = (i: number, to?: string): ElBody => ({
    t: "card", image: true, to,
    title: `${pick(AREAS, s + i)} ${subject} ${pick(["모임", "클래스", "추천", "소식", "기록"], s + i)}`,
    lines: [pick(DAYS, s + i), `${pick(NAMES, s + i)} 외 ${3 + ((s + i) % 9)}명 · ${pick(["참여 가능", "마감 임박", "새로 올라옴"], s + i)}`],
  });
  const featText = feats.slice(0, 2).map((f) => f.summary).filter(Boolean);
  const buttons = () => next.slice(0, 2).forEach((x, i) =>
    els.push({ t: "button", text: x.label || `${navName(x.node.label)} ${i === 0 ? "바로 가기" : "보기"}`, primary: i === 0, to: x.node.id }));

  if (/로그인|인증|회원/.test(name) || (/가입/.test(name) && !/신청|작성|입력|모임|그룹/.test(name))) {
    els.push({ t: "heading", text: /가입/.test(name) ? `${subject}에 오신 걸 환영해요` : "다시 만나서 반가워요" });
    els.push({ t: "text", text: featText[0] ?? "이메일이나 간편 로그인으로 시작할 수 있어요.", muted: true });
    els.push({ t: "input", label: "이메일", placeholder: "jiyoon@example.com" });
    els.push({ t: "input", label: "비밀번호", placeholder: "8자 이상 입력" });
    if (/가입/.test(name)) els.push({ t: "input", label: "닉네임", placeholder: pick(NAMES, s).slice(1) + "님" });
    els.push({ t: "button", text: /가입/.test(name) ? "가입하기" : "로그인", primary: true, to: next[0]?.node.id });
    els.push({ t: "button", text: "카카오로 계속하기", to: next[1]?.node.id ?? next[0]?.node.id });
    if (next[2]) els.push({ t: "text", text: `${next[2].node.label} >`, muted: true, to: next[2].node.id });
  } else if (/온보딩|소개|스플래시|시작|튜토리얼/.test(name)) {
    els.push({ t: "image", label: `${subject} 소개 그림`, tall: true });
    els.push({ t: "heading", text: `${subject}, 이제 한곳에서 해결해요` });
    els.push({ t: "text", text: featText[0] ?? `${p.idea || subject}${josa(p.idea || subject, "을/를")} 더 쉽게 시작해 보세요.`, muted: true });
    els.push({ t: "chips", items: ["1 / 3", "건너뛰기"] });
    buttons();
    if (!next.length) els.push({ t: "button", text: "시작하기", primary: true });
  } else if (/완료|성공|결과|축하/.test(name)) {
    els.push({ t: "image", label: "완료 표시" });
    els.push({ t: "heading", text: `${navName(name)}가 끝났어요` });
    els.push({ t: "rows", items: [{ label: "일시", value: pick(DAYS, s) }, { label: "장소", value: `${pick(AREAS, s)} 카페 ${pick(["오후의 서재", "책방 골목", "느린 마당"], s)}` }] });
    buttons();
    if (!next.length) els.push({ t: "button", text: "확인", primary: true });
  } else if (/작성|등록|생성|만들|편집|수정|신청|입력|추가|제안|투표/.test(name)) {
    els.push({ t: "heading", text: navName(name) });
    if (featText[0]) els.push({ t: "text", text: featText[0], muted: true });
    const fields = feats.filter((f) => f.level >= 2).slice(0, 3).map((f) => f.title);
    const base = ["제목", "날짜와 시간", "내용"];
    (fields.length >= 2 ? fields : base).forEach((f, i) =>
      els.push({ t: "input", label: f, placeholder: pick([`${pick(AREAS, s)} ${subject} 모임`, pick(DAYS, s), "자세한 내용을 적어 주세요"], i) }));
    els.push({ t: "image", label: "사진 추가" });
    els.push({ t: "chips", items: [subject.split(" ")[0], "초보 환영", "주말", "온라인"] });
    buttons();
    if (!next.length) els.push({ t: "button", text: "저장하기", primary: true });
  } else if (/상세|정보|프로필|보기|내용/.test(name)) {
    els.push({ t: "image", label: `${subject} 대표 이미지`, tall: device === "mobile" });
    els.push({ t: "heading", text: `${pick(AREAS, s)} ${subject} ${pick(["정기 모임", "이번 주 일정", "추천 모음"], s)}` });
    els.push({ t: "chips", items: [pick(["모집 중", "진행 중", "새 소식"], s), `${4 + (s % 8)}/12명`, pick(AREAS, s)] });
    els.push({ t: "rows", items: [
      { label: "일시", value: pick(DAYS, s) },
      { label: "장소", value: `${pick(AREAS, s)} ${pick(["작은 책방", "공유 라운지", "주민 센터 2층"], s)}` },
      { label: "주최", value: pick(NAMES, s) },
    ] });
    els.push({ t: "text", text: featText[0] ?? `${subject}에 관심 있는 이웃과 함께하는 자리예요. 처음 오셔도 괜찮아요.` });
    els.push({ t: "divider" });
    buttons();
  } else if (/알림|채팅|메시지|대화|댓글|공지/.test(name)) {
    els.push({ t: "tabs", items: ["전체", "안 읽음", "공지"], active: 0 });
    els.push({ t: "list", to: detail?.id, items: [0, 1, 2, 3].map((i) => ({
      title: `${pick(NAMES, s + i)} · ${pick(["새 일정이 올라왔어요", "참여를 확정했어요", "댓글을 남겼어요", "투표가 곧 마감돼요"], s + i)}`,
      sub: `${pick(["방금", "12분 전", "어제", "2일 전"], i)}`,
    })) });
    buttons();
  } else if (/설정|마이|내 정보|계정|프로필/.test(name)) {
    els.push({ t: "card", title: `${pick(NAMES, s)}님`, lines: [`${pick(AREAS, s)} · 참여 ${3 + (s % 10)}회`], image: true });
    els.push({ t: "list", items: [...next.map((x) => ({ title: x.node.label })), { title: "알림 설정" }, { title: "로그아웃" }].slice(0, 6) });
    buttons();
  } else if (/결제|주문|예약|구매/.test(name)) {
    els.push({ t: "heading", text: navName(name) });
    els.push({ t: "rows", items: [{ label: "상품", value: `${subject} ${pick(["정기권", "1회 참가권"], s)}` }, { label: "일시", value: pick(DAYS, s) }, { label: "금액", value: `${(8 + (s % 5)) * 1000}원` }] });
    els.push({ t: "input", label: "결제 수단", placeholder: "카드 선택" });
    buttons();
    if (!next.length) els.push({ t: "button", text: "결제하기", primary: true });
  } else {
    // List / home / search style page
    if (/검색|탐색|찾기/.test(name)) els.push({ t: "input", label: "", placeholder: `${subject} 검색` });
    else els.push({ t: "heading", text: `${pick(NAMES, s).slice(1)}님, ${pick(["오늘의", "이번 주", "가까운"], s)} ${subject}` });
    els.push({ t: "chips", items: ["전체", ...feats.slice(0, 3).map((f) => navName(f.title)), "가까운 순"].slice(0, 5) });
    if (featText[0] && !/검색/.test(name)) els.push({ t: "text", text: featText[0], muted: true });
    [0, 1, 2].forEach((i) => els.push(card(i, detail?.id)));
    next.filter((x) => x.node.id !== detail?.id).slice(0, 2).forEach((x, i) =>
      els.push({ t: "button", text: x.label || navName(x.node.label), primary: i === 0, to: x.node.id }));
  }

  if (device === "mobile" && hasNav(flow, node)) {
    const nav = navPages(flow);
    const active = nav.findIndex((n) => n.id === node.id);
    els.push({ t: "nav", items: nav.map((n) => navName(n.label)), active: active >= 0 ? active : undefined });
  }
  return els.map((e) => ({ ...e, id: uid("e_") }) as WireEl);
}
