// Local, rule-based stand-in for the AI planner. Every output is built from
// the user's idea and answers with fixed templates, so it works offline and
// on static hosting. Swap these functions for real model calls later.
import { uid } from "./id";
import type {
  Feature, FeatureGroup, Finding, Flow, FlowNode, PrdSection, Question, Screen, WireBlock,
} from "./types";

export function shortName(idea: string) {
  const t = idea.trim().replace(/\s+/g, " ");
  return t.length > 28 ? t.slice(0, 28) + "…" : t || "새 프로젝트";
}

export function makeQuestions(): Question[] {
  return [
    { id: "users", text: "이 서비스를 가장 먼저 쓸 사람은 누구인가요?", multi: true,
      options: ["일반 개인 사용자", "소규모 사업자", "사내 팀·직원", "전문가·크리에이터"] },
    { id: "pain", text: "그 사람들이 지금 가장 불편해하는 점은 무엇인가요?", multi: true,
      options: ["정보가 여러 곳에 흩어져 있음", "손으로 하는 반복 작업이 많음", "서로 일정·소통을 맞추기 어려움", "믿을 만한 선택지를 찾기 어려움"] },
    { id: "value", text: "가장 먼저 해결하고 싶은 핵심 가치는 무엇인가요?", multi: false,
      options: ["시간 절약과 자동화", "사람과 사람을 연결", "기록과 관리의 편리함", "더 나은 의사결정"] },
    { id: "platform", text: "처음 출시할 형태는 무엇인가요?", multi: false,
      options: ["모바일 앱", "웹 서비스", "웹 관리자 화면 + 모바일 앱"] },
    { id: "flow", text: "사용자가 목적을 이루는 대표 흐름은 어떤가요?", multi: false,
      options: ["가입 → 탐색 → 참여", "가입 → 생성 → 공유", "요청 → 검토·승인 → 완료"] },
    { id: "revenue", text: "수익은 어떻게 낼 계획인가요?", multi: false,
      options: ["무료로 시작 후 유료 플랜", "거래 수수료", "광고·제휴", "아직 정하지 않음"] },
  ];
}

const pick = (a: Record<string, string[]>, k: string, d: string) => (a[k]?.length ? a[k].join(", ") : d);

export function summarizeAnswers(idea: string, a: Record<string, string[]>) {
  return `${pick(a, "users", "주요 사용자")}를 위한 서비스로, ${pick(a, "pain", "현재의 불편")} 문제를 ` +
    `${pick(a, "value", "핵심 가치")} 중심으로 풀어요. ${pick(a, "platform", "웹")} 형태로 시작하고, ` +
    `대표 흐름은 '${pick(a, "flow", "가입 → 사용")}'입니다. 이 내용으로 PRD 초안을 만들 수 있어요.`;
}

export function makePrd(idea: string, a: Record<string, string[]>): PrdSection[] {
  const users = pick(a, "users", "주요 사용자");
  const pain = pick(a, "pain", "반복되는 불편");
  const value = pick(a, "value", "편리함");
  const platform = pick(a, "platform", "웹 서비스");
  return [
    { id: "overview", title: "개요", blocks: [
      { label: "한 줄 정의", body: idea.trim() },
      { label: "제품 목표", body: `${users}가 ${pain} 문제를 겪지 않도록, ${value}을(를) 가장 먼저 제공한다.` },
      { label: "배경", body: `현재 ${users}는 ${pain} 때문에 시간을 잃고 있다. 기존 방식은 도구가 나뉘어 있어 맥락이 끊기고, 같은 일을 여러 번 반복하게 만든다.` },
    ]},
    { id: "problem", title: "문제 및 해결 방안", blocks: [
      { label: "문제 정의", body: `${pain}. 이 문제는 사용 빈도가 높은 순간에 집중적으로 드러난다.` },
      { label: "해결 방식", body: `핵심 흐름(${pick(a, "flow", "가입 → 사용")})을 한 화면 흐름으로 묶고, 반복 작업은 자동화하며, 진행 상태를 한눈에 보여 준다.` },
      { label: "비목표", body: "첫 출시에는 고급 통계, 외부 시스템 대량 연동, 다국어 지원을 포함하지 않는다." },
    ]},
    { id: "target", title: "타겟 및 시나리오", blocks: [
      { label: "타겟 사용자", body: `${users}. 처음 써 보는 사람도 안내 없이 핵심 흐름을 끝낼 수 있어야 한다.` },
      { label: "사용 시나리오", body: `1. 사용자가 ${platform}에 들어와 간단히 가입한다.\n2. 자신의 상황에 맞는 항목을 고르거나 직접 만든다.\n3. 진행 상황을 확인하고 필요한 사람과 공유한다.\n4. 결과를 기록으로 남기고 다음에 다시 이어서 쓴다.` },
    ]},
    { id: "metrics", title: "성공 지표", blocks: [
      { label: "핵심 지표", body: "출시 3개월 안에 주간 활성 사용자 비율 40% 이상, 핵심 흐름 완료율 70% 이상." },
      { label: "보조 지표", body: "첫 방문 후 7일 재방문율, 공유 기능 사용률, 문의 건수 감소율." },
    ]},
    { id: "risk", title: "리스크와 범위", blocks: [
      { label: "리스크", body: "초기 사용자 확보가 늦어질 수 있고, 개인정보를 다루는 기능은 별도 검토가 필요하다." },
      { label: "수익 모델", body: pick(a, "revenue", "아직 정하지 않음") },
      { label: "출시 형태", body: platform },
    ]},
  ];
}

const F = (code: string, title: string, summary: string, roles: string[], priority: 1 | 2 | 3): Feature => ({
  id: uid("f_"), code, title, summary,
  rationale: "사용자가 핵심 흐름을 끊김 없이 끝내려면 이 기능이 필요하다.",
  success: "해당 흐름의 완료율이 목표치 이상이다.",
  criteria: ["필수 입력이 비어 있으면 다음 단계로 넘어가지 않는다", "처리 결과가 화면과 알림으로 바로 보인다"],
  roles, status: "draft", priority,
});

export function makeFeatures(idea: string, a: Record<string, string[]>): FeatureGroup[] {
  const admin = (a.platform ?? []).some((p) => p.includes("관리자")) || (a.users ?? []).some((u) => u.includes("사업자"));
  const owner = admin ? "운영자" : "관리자";
  const g = (code: string, title: string, items: Feature[]): FeatureGroup => ({ id: uid("g_"), code, title, features: items });
  return [
    g("1", "계정과 시작하기", [
      F("1.1", "회원가입과 로그인", "이메일 또는 소셜 계정으로 가입하고 로그인한다.", ["사용자"], 3),
      F("1.2", "첫 사용 안내", "처음 들어온 사용자에게 관심사와 기본 설정을 묻는다.", ["사용자"], 2),
    ]),
    g("2", "핵심 항목 만들기", [
      F("2.1", "항목 생성", `${shortName(idea)}의 중심이 되는 항목을 만든다.`, ["사용자"], 3),
      F("2.2", "항목 편집과 삭제", "만든 항목의 내용을 고치거나 지운다.", ["사용자"], 2),
    ]),
    g("3", "찾아보기와 참여", [
      F("3.1", "목록과 검색", "조건과 키워드로 항목을 찾는다.", ["사용자"], 3),
      F("3.2", "참여 신청", "원하는 항목에 참여를 요청한다.", ["사용자"], 3),
      F("3.3", "신청 검토와 승인", "들어온 참여 요청을 확인하고 승인하거나 거절한다.", [owner], 2),
    ]),
    g("4", "일정과 알림", [
      F("4.1", "일정 조율", "참여자들이 가능한 시간을 모아 일정을 정한다.", ["사용자", owner], 2),
      F("4.2", "알림", "신청, 승인, 일정 변경을 알림으로 보낸다.", ["사용자"], 2),
    ]),
    g("5", "운영과 안전", [
      F("5.1", "신고와 차단", "부적절한 사용자나 내용을 신고하고 차단한다.", ["사용자", owner], 1),
      F("5.2", "운영 대시보드", "가입, 활동, 신고 현황을 한눈에 본다.", [owner], 1),
    ]),
  ];
}

export function makeFlow(groups: FeatureGroup[]): Flow {
  const nodes: FlowNode[] = [];
  const edges: Flow["edges"] = [];
  const lanes = groups.map((g) => g.title);
  groups.forEach((g, gi) => {
    let prev: string | null = null;
    if (gi === 0) {
      const s = { id: uid("n_"), lane: g.title, kind: "start" as const, label: "앱 실행", col: 0 };
      nodes.push(s); prev = s.id;
    }
    g.features.forEach((f, fi) => {
      const kind = /승인|검토/.test(f.title) ? "branch" : fi % 3 === 2 ? "layer" : "page";
      const n = { id: uid("n_"), lane: g.title, kind, label: f.title, col: fi + 1 } as FlowNode;
      nodes.push(n);
      if (prev) edges.push({ from: prev, to: n.id });
      prev = n.id;
    });
    if (gi > 0) {
      const lastOfPrev = [...nodes].reverse().find((n) => n.lane === groups[gi - 1].title);
      const firstOfThis = nodes.find((n) => n.lane === g.title);
      if (lastOfPrev && firstOfThis) edges.push({ from: lastOfPrev.id, to: firstOfThis.id });
    }
  });
  return { lanes, nodes, edges };
}

export function makeScreens(groups: FeatureGroup[]): Screen[] {
  return groups.flatMap((g) => g.features.slice(0, 2)).map((f) => {
    const main: WireBlock[] = [{ type: "header", text: f.title }];
    if (/가입|로그인/.test(f.title)) {
      main.push({ type: "input", label: "이메일" }, { type: "input", label: "비밀번호" }, { type: "button", text: "계속하기", primary: true });
    } else if (/목록|검색/.test(f.title)) {
      main.push({ type: "input", label: "검색어" }, { type: "tabs", items: ["전체", "가까운 순", "인기 순"] },
        { type: "card", title: "항목 이름", lines: ["간단한 설명", "장소 · 시간"] }, { type: "card", title: "항목 이름", lines: ["간단한 설명", "장소 · 시간"] });
    } else {
      main.push({ type: "card", title: "기본 정보", lines: [f.summary] }, { type: "select", label: "옵션 선택" }, { type: "input", label: "메모" });
    }
    const side: WireBlock[] = [
      { type: "card", title: "요약", lines: ["상태: 작성 중", "담당: " + f.roles.join(", ")] },
      { type: "button", text: "저장하기", primary: true },
    ];
    return { id: uid("s_"), name: f.title + " 화면", main, side };
  });
}

export function runReview(groups: FeatureGroup[]): Finding[] {
  const all = groups.flatMap((g) => g.features);
  const out: Finding[] = [];
  const find = (re: RegExp) => all.find((f) => re.test(f.title));
  const approve = find(/승인|검토/);
  if (approve) out.push({ id: uid("r_"), perspective: "개발", level: "주의", featureId: approve.id, state: "open",
    title: "승인 대기 중 상태가 정의되지 않음", body: "요청이 승인을 기다리는 동안 다른 요청이 같은 자리를 차지할 수 있는지, 대기 시간이 끝나면 어떻게 되는지 정해야 합니다." });
  out.push({ id: uid("r_"), perspective: "사업", level: "제안", state: "open",
    title: "유료 전환 시점이 기능에 드러나지 않음", body: "무료로 쓸 수 있는 범위와 유료로 넘어가는 지점을 기능명세에 표시하면 가격 정책을 검증하기 쉽습니다." });
  const search = find(/검색|목록/);
  out.push({ id: uid("r_"), perspective: "UX·디자인", level: "주의", featureId: search?.id, state: "open",
    title: "검색 결과가 없을 때의 화면이 없음", body: "결과가 0건일 때 보여 줄 안내와 다음 행동(조건 바꾸기, 새로 만들기)을 정해야 합니다." });
  out.push({ id: uid("r_"), perspective: "QA", level: "주의", state: "open",
    title: "동시에 수정할 때의 기준이 없음", body: "두 사람이 같은 항목을 동시에 고치면 어떤 내용이 남는지 수용 기준에 넣어야 테스트할 수 있습니다." });
  out.push({ id: uid("r_"), perspective: "보안", level: "주의", featureId: find(/가입|로그인/)?.id, state: "open",
    title: "개인정보 보관 기간이 정해지지 않음", body: "탈퇴한 사용자의 정보를 언제 지우는지, 누가 열람할 수 있는지 정의가 필요합니다." });
  out.push({ id: uid("r_"), perspective: "운영", level: "제안", featureId: find(/신고|차단/)?.id, state: "open",
    title: "신고 처리 담당과 기한이 없음", body: "신고가 들어오면 누가 며칠 안에 처리하는지 정해 두면 운영 부담을 예측할 수 있습니다." });
  return out;
}

// Turns a free-form chat request into a reply and, when it asks for a change,
// a proposed edit that the user must approve.
export function interpret(text: string, groups: FeatureGroup[] | null) {
  const t = text.trim();
  if (!groups) return { reply: "먼저 PRD와 기능명세서를 만들어야 그 내용에 맞춰 도와드릴 수 있어요. 위의 질문에 답하고 [바로 PRD 생성하기]를 눌러 주세요." };
  const add = t.match(/(.+?)\s*기능\s*(추가|넣어)/);
  if (add) {
    const title = add[1].replace(/^["'“]|["'”]$/g, "").trim();
    return { reply: `'${title}' 기능을 추가하는 안을 만들었어요. 기능명세서에서 확인하고 승인해 주세요.`, add: title };
  }
  const all = groups.flatMap((g) => g.features);
  const target = all.find((f) => t.includes(f.title));
  if (target && /(구체|자세|보강|수정|바꿔)/.test(t)) {
    return { reply: `'${target.title}'의 설명과 수용 기준을 보강하는 안을 만들었어요. 승인하면 반영돼요.`, edit: target.id };
  }
  if (/검토|빈틈|리뷰/.test(t)) return { reply: "여섯 관점에서 기획서를 다시 검토했어요. 왼쪽 [검토] 패널에서 결과를 확인하세요.", review: true };
  return { reply: "요청을 이해했어요. \"OO 기능 추가해줘\", \"(기능 이름) 더 구체화해줘\", \"기획 검토해줘\"처럼 말씀해 주시면 기획서에 바로 반영할 수 있어요." };
}
