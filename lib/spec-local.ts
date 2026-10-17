// Offline stand-ins for the spec AI (lib/spec.ts). Everything is built from the
// project's idea, answers, PRD properties and the current spec with templates,
// so the editor works without an API key and never touches the network.
import { josa } from "./josa";
import { blankItem, flatten, itemId, newCode, slotFill } from "./spec-model";
import { SLOTS } from "./types";
import type { PrdProps, PrdSection, Project, SlotKey, SlotQuestion, SpecCore, SpecItem } from "./types";

type Slots = Partial<Record<SlotKey, string[]>>;
type Q = Omit<SlotQuestion, "id">;

// What a spec run proposes: new top-level requirements, new children under
// existing items, and rewrites of existing items.
export interface SpecPlan {
  roots: SpecItem[];
  under: { parentId: string; item: SpecItem }[];
  edits: { id: string; patch: Partial<SpecCore>; reason: string }[];
}

const qid = () => `sq_${Math.random().toString(36).slice(2, 9)}`;
const hasAny = (s: string, re: RegExp) => re.test(s);

// --- Reading the idea and answers ----------------------------------------------------

const allAnswers = (p: Pick<Project, "answers">) => Object.values(p.answers ?? {}).flat();
const context = (p: Pick<Project, "idea" | "answers">) => `${p.idea} ${allAnswers(p).join(" ")}`;

// Answer to the question whose text matches re, or the default.
function ans(p: Pick<Project, "questions" | "answers">, re: RegExp, d: string) {
  const q = p.questions.find((x) => re.test(x.text) && p.answers[x.id]?.length);
  return q ? p.answers[q.id].join(", ") : d;
}

// The main "thing" the service handles, guessed from the idea.
export function nounOf(p: Pick<Project, "idea" | "answers">) {
  const t = context(p);
  const table: [RegExp, string][] = [
    [/모임|동호회|클럽|스터디/, "모임"], [/예약|숙소|병원|미용/, "예약"], [/주문|배달|음식|메뉴/, "주문"],
    [/강의|수업|과외|교육|학습/, "수업"], [/상품|쇼핑|판매|마켓|중고/, "상품"], [/일정|캘린더|스케줄/, "일정"],
    [/게시|커뮤니티|글|피드/, "게시글"], [/프로젝트|업무|팀|협업/, "작업"], [/여행|코스|장소/, "여행 계획"],
    [/운동|건강|식단|습관/, "기록"], [/도서|책|독서/, "도서"],
  ];
  return table.find(([re]) => re.test(t))?.[1] ?? "항목";
}

const subject = (idea: string) => {
  const t = idea.trim().replace(/\s+/g, " ").replace(/\s*(앱|어플|서비스|플랫폼|웹사이트|사이트)$/, "");
  return t.length > 30 ? t.slice(0, 30) + "…" : t || "이 서비스";
};

// Korean object particle 을/를 for a word.
export function eul(word: string) {
  return word + josa(word, "을/를");
}
const iga = (word: string) => {
  return word + josa(word, "이/가");
};

// --- PRD ------------------------------------------------------------------------------

export function localPrd(p: Project): { prd: PrdSection[]; props: PrdProps } {
  const users = ans(p, /누구|누가|사용자|대상|타겟|고객/, "처음 이 서비스를 찾는 일반 사용자");
  const pain = ans(p, /불편|문제|어려|고민/, "필요한 정보와 사람을 한곳에서 관리하기 어려움");
  const value = ans(p, /가치|해결|목표|중요/, "시간을 아끼고 과정을 단순하게 만드는 것");
  const platform = ans(p, /형태|플랫폼|출시|기기|앱|웹/, "모바일 앱");
  const flow = ans(p, /흐름|과정|순서/, "가입 → 둘러보기 → 참여");
  const revenue = ans(p, /수익|돈|과금|비즈니스/, "초기에는 무료, 이후 유료 플랜 검토");
  const noun = nounOf(p);
  const name = subject(p.idea);
  const props = localProps(p);
  const steps = flow.split(/→|->|>/).map((s) => s.trim()).filter(Boolean);
  return {
    props,
    prd: [
      { id: "overview", title: "개요", blocks: [
        { label: "한 줄 정의", body: `${users}가 ${eul(noun)} 쉽게 만들고 찾고 관리할 수 있게 돕는 ${name} 서비스.` },
        { label: "제품 목표", body: `출시 후 3개월 안에 ${users}가 ${noun} 관련 일을 한 곳에서 끝내도록 만든다. 가장 먼저 제공할 가치는 ${value}이다.` },
        { label: "배경", body: `지금은 ${pain} 때문에 메신저, 메모, 스프레드시트를 오가며 같은 정보를 여러 번 옮기고 있다. ${noun} 하나를 처리하는 데 필요한 맥락이 흩어져 있어 실수와 누락이 잦다.` },
      ] },
      { id: "problem", title: "문제 및 해결 방안", blocks: [
        { label: "사용자 문제", body: `${pain}. 특히 ${noun}에 여러 사람이 얽히는 순간 연락과 확인이 반복되어 시간이 많이 든다.` },
        { label: "해결 방안", body: `'${flow}' 흐름을 몇 번의 탭으로 끝낼 수 있게 묶고, 반복되는 확인과 알림은 자동으로 보낸다. ${noun}의 상태를 한 화면에서 보여 주어 다음에 할 일을 바로 알 수 있게 한다.` },
        { label: "차별점", body: `범용 메신저·캘린더와 달리 ${noun}에 맞춘 단계와 정보만 담아, 처음 쓰는 사람도 설명 없이 핵심 흐름을 끝낼 수 있다. ${props.roles.length > 1 ? `${props.roles.slice(1).join("·")}용 관리 도구를 함께 제공한다.` : ""}`.trim() },
      ] },
      { id: "target", title: "타겟 및 시나리오", blocks: [
        { label: "타겟 사용자", body: `주 사용자: ${users}. 보조 사용자: ${props.roles.slice(1).join(", ") || "운영자"}. 주로 ${platform}으로 짧게 자주 들어온다.` },
        { label: "사용자 시나리오", body: (steps.length ? steps : ["가입", "둘러보기", "참여"])
          .map((s, i) => `${i + 1}. ${s}: ${i === 0 ? `${platform}에 들어와 1분 안에 시작한다.` : i === steps.length - 1 ? `결과를 확인하고 다음 ${noun}에도 다시 쓴다.` : `조건에 맞는 ${eul(noun)} 고르거나 직접 만든다.`}`).join("\n") },
      ] },
      { id: "metrics", title: "성공·위험 요소", blocks: [
        { label: "핵심 지표", body: `핵심 흐름 완료율 70% 이상, 가입 후 7일 재방문율 40% 이상, ${noun} 1건당 처리 시간 50% 단축. 수익 방식: ${revenue}.` },
        { label: "리스크", body: `초기 사용자가 적으면 ${noun}이 비어 보여 이탈할 수 있다. 개인정보(연락처·위치)를 다루므로 공개 범위와 보관 기간을 먼저 정해야 한다.` },
      ] },
    ],
  };
}

export function localProps(p: Project): PrdProps {
  const t = context(p);
  const category = hasAny(t, /모임|커뮤니티|소통|친구|동네/) ? "커뮤니티"
    : hasAny(t, /쇼핑|상품|판매|주문|결제/) ? "커머스"
    : hasAny(t, /강의|수업|학습|교육/) ? "교육"
    : hasAny(t, /건강|운동|식단|병원/) ? "헬스케어"
    : hasAny(t, /업무|협업|팀|프로젝트|일정/) ? "생산성" : "라이프스타일";
  const roles = ["일반 사용자"];
  if (hasAny(t, /모임|그룹|팀|사업자|가게|매장|강사|호스트|운영/)) roles.push(hasAny(t, /사업자|가게|매장/) ? "사업자" : "운영자");
  roles.push("관리자");
  const devices = hasAny(t, /웹|PC|데스크톱/) && !hasAny(t, /모바일|앱/) ? ["데스크톱 웹"]
    : hasAny(t, /모바일|앱/) && !hasAny(t, /웹/) ? ["모바일(iOS)", "모바일(Android)"]
    : ["모바일(iOS)", "모바일(Android)", "데스크톱 웹"];
  return { category, roles, devices };
}

// --- Spec templates ------------------------------------------------------------------------

interface FeatT {
  title: string;
  summary: string;
  who: "user" | "owner" | "admin" | "both";
  slots?: Slots;
  q?: Q;
  details?: { title: string; summary: string; slots?: Slots; q?: Q }[];
}
interface ReqT { key: string; when: RegExp | null; title: string; summary: string; criteria: string[]; feats: FeatT[] }

function themes(n: string, owner: string): ReqT[] {
  return [
    { key: "account", when: null, title: "계정과 시작하기", summary: "누구나 1분 안에 가입하고 자기 상황에 맞게 시작할 수 있어야 한다.",
      criteria: ["이메일 또는 소셜 계정으로 가입할 수 있다", "가입 직후 관심사 설정 화면으로 이어진다", "로그인 상태가 30일간 유지된다"],
      feats: [
        { title: "회원가입과 로그인", summary: "이메일 인증 또는 소셜 계정으로 가입하고 로그인한다.", who: "user",
          slots: { trigger: ["사용자가 시작 화면에서 [시작하기]를 누른다."], data: ["사용자: 이메일, 닉네임, 가입 경로, 가입일, 마지막 로그인"] },
          q: { slot: "access", text: "만 14세 미만 사용자의 가입을 허용할까요?", options: ["허용하지 않음", "보호자 동의 후 허용", "제한 없이 허용"], recommended: 0 },
          details: [
            { title: "소셜 로그인", summary: "카카오·구글·애플 계정으로 한 번에 가입한다." },
            { title: "비밀번호 재설정", summary: "가입한 이메일로 재설정 링크를 받아 새 비밀번호를 정한다.",
              slots: { rule: ["재설정 링크는 30분 동안만 유효하다.", "같은 이메일로 10분에 3번까지만 요청할 수 있다."] } },
          ] },
        { title: "첫 사용 설정", summary: `관심 분야와 지역을 골라 나에게 맞는 ${eul(n)} 먼저 보여 준다.`, who: "user",
          slots: { trigger: ["가입을 마친 직후 자동으로 열린다."], rule: ["설정은 건너뛸 수 있고, 나중에 내 정보에서 바꿀 수 있다."] } },
      ] },
    { key: "create", when: null, title: `${n} 만들기와 관리`, summary: `사용자가 ${eul(n)} 직접 만들고 내용을 언제든 고칠 수 있어야 한다.`,
      criteria: [`필수 정보만 입력하면 ${iga(n)} 바로 만들어진다`, "작성 중 나가도 임시 저장된 내용이 남는다", "만든 사람만 수정·삭제할 수 있다"],
      feats: [
        { title: `${n} 만들기`, summary: `제목, 설명, 일시, 장소 같은 기본 정보를 입력해 새 ${eul(n)} 만든다.`, who: "both",
          slots: { data: [`${n}: 제목(40자), 설명(1,000자), 대표 이미지, 일시, 장소, 정원, 공개 여부, 만든 사람`] },
          q: { slot: "rule", text: `한 사람이 동시에 운영할 수 있는 ${n} 수를 제한할까요?`, options: ["제한 없음", "최대 3개", "최대 5개", "유료 플랜만 무제한"], recommended: 1 },
          details: [{ title: "대표 이미지 첨부", summary: "사진을 올리거나 기본 이미지 중에서 고른다.",
            slots: { rule: ["이미지는 10MB 이하 JPG·PNG만 올릴 수 있다.", "올린 이미지는 4:3으로 자동 자른다."] } }] },
        { title: `${n} 수정과 삭제`, summary: `만든 ${eul(n)} 고치거나 지우고, 참여자에게 변경을 알린다.`, who: "both",
          slots: { rule: ["참여자가 있는 경우 삭제 전에 사유를 입력해야 한다.", "삭제된 내용은 7일간 복구할 수 있다."] } },
      ] },
    { key: "discover", when: /찾|탐색|검색|연결|참여|모임|매칭|선택|추천|동네/, title: `${n} 찾기와 참여`, summary: `원하는 ${eul(n)} 빠르게 찾고 바로 참여를 신청할 수 있어야 한다.`,
      criteria: ["키워드와 조건으로 검색할 수 있다", "결과가 없으면 조건 바꾸기를 제안한다", "신청 결과를 알림으로 받는다"],
      feats: [
        { title: "목록과 검색", summary: `거리·날짜·관심사 조건으로 ${n} 목록을 거르고 정렬한다.`, who: "user",
          slots: { display: ["카드마다 제목, 일시, 장소, 남은 자리를 보여 준다.", "결과가 0건이면 '조건을 넓혀 보세요' 안내와 필터 초기화 버튼을 보여 준다."] },
          details: [{ title: "검색 필터", summary: "날짜, 거리, 분야 필터를 조합하고 마지막 조건을 기억한다." }] },
        { title: "참여 신청", summary: `${n} 상세에서 참여를 신청하고 승인 여부를 확인한다.`, who: "user",
          q: { slot: "rule", text: "정원이 찼을 때 대기 신청을 받을까요?", options: ["받지 않음", "대기 5명까지", "제한 없이 대기", "운영자가 정함"], recommended: 1 },
          details: [{ title: "신청 승인·거절", summary: `${owner}가 들어온 신청을 확인하고 승인하거나 거절한다.` }] },
      ] },
    { key: "schedule", when: /일정|시간|예약|캘린더|모임|날짜/, title: "일정 조율", summary: "참여자들이 가능한 시간을 모아 한 번에 일정을 정할 수 있어야 한다.",
      criteria: ["후보 시간을 여러 개 올릴 수 있다", "참여자는 가능한 시간을 표시할 수 있다", "확정되면 모두에게 알림이 간다"],
      feats: [
        { title: "일정 투표", summary: "후보 날짜를 올리고 참여자가 가능한 시간을 표시해 가장 많이 겹치는 시간을 고른다.", who: "both",
          q: { slot: "rule", text: "일정 확정은 누가 할까요?", options: [`${owner}만`, "가장 많이 고른 시간으로 자동 확정", `${owner}가 자동 결과를 확인 후 확정`], recommended: 2 } },
        { title: "일정 알림", summary: "확정된 일정 하루 전과 한 시간 전에 알림을 보낸다.", who: "user",
          slots: { rule: ["알림 시간은 사용자가 끌 수 있다.", "일정이 바뀌면 즉시 다시 알린다."] } },
      ] },
    { key: "record", when: /기록|관리|정리|히스토리|리뷰|후기|독서|도서/, title: "기록과 후기", summary: `지난 ${eul(n)} 돌아보고 후기를 남겨 다음 선택에 활용할 수 있어야 한다.`,
      criteria: ["참여한 내역이 날짜순으로 쌓인다", "후기는 참여한 사람만 쓸 수 있다", "부적절한 후기는 신고할 수 있다"],
      feats: [
        { title: "활동 기록", summary: `참여했던 ${n}과 메모를 날짜순으로 모아 본다.`, who: "user" },
        { title: "후기 남기기", summary: "별점과 짧은 글로 후기를 남긴다.", who: "user",
          slots: { rule: ["후기는 참여 후 14일 안에만 쓸 수 있다.", "별점은 1~5점, 글은 300자 이내다."] } },
      ] },
    { key: "pay", when: /유료|결제|수수료|구독|가격|플랜|판매/, title: "결제와 요금제", summary: "유료 기능을 쓰려는 사용자가 안전하게 결제하고 내역을 확인할 수 있어야 한다.",
      criteria: ["카드·간편결제로 결제할 수 있다", "영수증을 메일로 받는다", "구독을 언제든 해지할 수 있다"],
      feats: [
        { title: "요금제 결제", summary: "무료와 유료 플랜을 비교하고 결제한다.", who: "user",
          q: { slot: "exception", text: "정기 결제가 실패하면 어떻게 할까요?", options: ["즉시 무료로 전환", "3일간 유예 후 전환", "7일간 3번 재시도"], recommended: 1 } },
        { title: "결제 내역", summary: "결제·환불 내역과 영수증을 본다.", who: "user" },
      ] },
    { key: "notify", when: null, title: "알림과 소통", summary: "중요한 변화를 놓치지 않고, 참여자끼리 필요한 대화를 나눌 수 있어야 한다.",
      criteria: ["알림 종류별로 켜고 끌 수 있다", "읽지 않은 알림 수가 보인다", "대화는 참여자에게만 보인다"],
      feats: [
        { title: "알림 센터", summary: "신청, 승인, 일정 변경, 댓글 알림을 한곳에서 본다.", who: "user",
          slots: { display: ["읽지 않은 알림은 굵게 표시하고 탭 아이콘에 개수를 띄운다."] } },
        { title: `${n} 대화방`, summary: `${n} 참여자끼리 공지와 메시지를 주고받는다.`, who: "both",
          details: [{ title: "공지 고정", summary: `${owner}가 중요한 메시지를 대화방 위에 고정한다.` }] },
      ] },
    { key: "ops", when: null, title: "운영과 안전", summary: "부적절한 사용자와 내용을 빠르게 걸러 서비스 신뢰를 지켜야 한다.",
      criteria: ["사용자와 게시물을 신고할 수 있다", "신고는 24시간 안에 처리된다", "제재 이력이 남는다"],
      feats: [
        { title: "신고와 차단", summary: "사용자나 내용을 신고하고, 원치 않는 사용자를 차단한다.", who: "user" },
        { title: "운영 대시보드", summary: "가입, 활동, 신고 현황을 보고 신고를 처리한다.", who: "admin",
          slots: { access: ["관리자 계정만 들어올 수 있다.", "처리 내역은 처리자 이름과 함께 기록된다."] } },
      ] },
  ];
}

// Concrete sentences for each of the nine slots of a feature.
function slotTemplate(title: string, n: string, role: string, extra: Slots = {}): Slots {
  const base: Record<SlotKey, string[]> = {
    pre: [`${iga(role)} 로그인한 상태다.`, `${title} 화면에 들어올 권한이 있다.`],
    trigger: [`${iga(role)} '${title}' 버튼을 누른다.`],
    action: ["입력값을 검사하고 서버에 저장 요청을 보낸다.", "처리하는 동안 버튼을 잠그고 진행 표시를 보여 준다."],
    result: [`처리가 끝나면 화면에 바로 반영되고 '완료했어요' 안내가 3초간 뜬다.`, `관련된 사람에게 알림이 간다.`],
    exception: ["필수 항목이 비어 있으면 해당 칸 아래에 이유를 보여 주고 진행을 막는다.", "네트워크 오류가 나면 입력 내용을 유지한 채 [다시 시도]를 보여 준다."],
    display: [`${title} 화면 상단에 현재 단계와 남은 단계를 보여 준다.`, "모바일에서는 주요 버튼을 화면 아래에 고정한다."],
    access: [`${role}만 실행할 수 있다.`, "다른 사람의 데이터는 읽기만 가능하다."],
    rule: [`같은 요청은 5초 안에 한 번만 처리한다.`, `${n} 정보가 바뀌면 변경 이력을 남긴다.`],
    data: [`${title} 기록: 요청자, 대상 ${n}, 처리 상태, 처리 시각`],
  };
  const out: Slots = {};
  for (const [k] of SLOTS) out[k] = extra[k] ?? base[k];
  return out;
}

const mkQ = (q?: Q): SlotQuestion[] | undefined => (q ? [{ ...q, id: qid() }] : undefined);

function roleOf(who: FeatT["who"], roles: string[]) {
  const user = roles[0] ?? "일반 사용자";
  const owner = roles.find((r) => /운영|사업|호스트|강사/.test(r)) ?? roles[1] ?? "운영자";
  const admin = roles.find((r) => /관리/.test(r)) ?? roles[roles.length - 1] ?? "관리자";
  return who === "user" ? [user] : who === "owner" ? [owner] : who === "admin" ? [admin] : [user, owner];
}

function build(t: ReqT, n: string, roles: string[], pending = true): SpecItem {
  const pend = pending ? { kind: "new" as const } : undefined;
  return {
    ...blankItem(1, t.title, pend), summary: t.summary, criteria: t.criteria, roles: [...new Set(t.feats.flatMap((f) => roleOf(f.who, roles)))],
    priority: t.when ? 2 : 3,
    children: t.feats.map((f, fi) => {
      const r = roleOf(f.who, roles);
      return {
        ...blankItem(2, f.title, pend), summary: f.summary, roles: r, priority: (fi === 0 ? 3 : 2) as 1 | 2 | 3,
        rationale: `'${t.title}' 요구사항을 이루는 핵심 단계다. 이 기능이 없으면 ${iga(r[0])} 같은 일을 하려고 메신저나 메모 같은 다른 도구를 오가야 한다.`,
        success: `${f.title} 시도 대비 완료율 80% 이상, 평균 완료 시간 1분 이내.`,
        slots: slotTemplate(f.title, n, r[0], f.slots), questions: mkQ(f.q),
        children: (f.details ?? []).map((d) => ({
          ...blankItem(3, d.title, pend), summary: d.summary, roles: r, priority: 2 as const,
          slots: slotTemplate(d.title, n, r[0], d.slots), questions: mkQ(d.q),
        })),
      };
    }),
  };
}

const norm = (s: string) => s.replace(/\s+/g, "");

export function localSpec(p: Project): SpecPlan {
  const roles = p.prdProps?.roles?.length ? p.prdProps.roles : localProps(p).roles;
  const n = nounOf(p);
  const owner = roleOf("owner", roles)[0];
  const t = context(p);
  const hasOwnerRole = roles.length > 2 || roles.some((r) => /운영|관리/.test(r));
  const picked = themes(n, owner).filter((x) => (x.key === "ops" ? hasOwnerRole : !x.when || x.when.test(t)));
  const existing = p.spec ?? [];
  if (!existing.length) return { roots: picked.map((x) => build(x, n, roles)), under: [], edits: [] };

  // Spec already there: add missing requirements, fill thin items.
  const titles = new Set(flatten(existing).map((x) => norm(x.title)));
  const roots = picked.filter((x) => !titles.has(norm(x.title))).slice(0, 3).map((x) => build(x, n, roles));
  const under: SpecPlan["under"] = [];
  const edits: SpecPlan["edits"] = [];
  for (const x of flatten(existing)) {
    if (x.pending?.kind === "delete") continue;
    if (x.level === 1) {
      if (!x.criteria?.length) edits.push({ id: x.id, reason: "수용 기준 보강", patch: { criteria: [`${x.title}의 핵심 흐름을 처음 쓰는 사람도 끝낼 수 있다`, "처리 결과가 화면과 알림으로 바로 보인다", "실패하면 이유와 다음 행동을 안내한다"] } });
      if (!x.children.length) under.push({ parentId: x.id, item: build({ key: "", when: null, title: "", summary: x.summary || `${x.title}을 이루는 기능`, criteria: [], feats: [{ title: `${x.title} 기본 기능`, summary: x.summary || `${x.title}의 핵심 동작을 처리한다.`, who: "user" }] }, n, roles).children[0] });
    } else {
      const fill = slotFill(x);
      const patch: Partial<SpecCore> = {};
      if (fill.filled < fill.total) {
        const tpl = slotTemplate(x.title, n, x.roles[0] ?? roles[0]);
        const slots = { ...x.slots };
        for (const [k] of SLOTS) if (!x.offSlots?.includes(k) && !slots[k]?.some((s) => s.trim())) slots[k] = tpl[k];
        patch.slots = slots;
      }
      if (x.level === 2 && !x.rationale) patch.rationale = `${x.title} 없이는 사용자가 ${x.summary || "이 단계"}를 스스로 끝낼 수 없다.`;
      if (x.level === 2 && !x.success) patch.success = `${x.title} 완료율 80% 이상, 관련 문의 월 5건 이하.`;
      if (!x.summary) patch.summary = `${eul(x.title)} 처리한다.`;
      if (Object.keys(patch).length) edits.push({ id: x.id, patch, reason: "빈 칸 채우기" });
    }
  }
  return { roots, under, edits };
}

// --- Single-item helpers ----------------------------------------------------------------

export function localEnhance(p: Project, x: SpecItem, request: string): { patch: Partial<SpecCore>; children: SpecItem[]; reason: string } {
  const n = nounOf(p);
  const role = x.roles[0] ?? p.prdProps?.roles?.[0] ?? "일반 사용자";
  const r = request.trim().replace(/[.。]$/, "");
  const patch: Partial<SpecCore> = { summary: `${x.summary ? x.summary.replace(/\.?$/, ".") + " " : ""}'${r}' 요청을 반영해 범위를 분명히 한다.`.trim() };
  const children: SpecItem[] = [];
  if (x.level === 1) {
    patch.criteria = [...(x.criteria ?? []), `'${r}' 내용이 화면과 데이터에 반영된다`];
  } else {
    const slots: Slots = { ...slotTemplate(x.title, n, role), ...x.slots };
    const add = (k: SlotKey, s: string) => { slots[k] = [...(slots[k] ?? []), s]; };
    if (/예외|오류|실패|에러/.test(r)) add("exception", `${r}: 실패 원인을 화면에 보여 주고 같은 화면에서 다시 시도할 수 있게 한다.`);
    else if (/권한|관리자|운영자|역할/.test(r)) add("access", `${r}: 권한이 없는 사용자에게는 버튼을 숨기고 직접 접근하면 안내 화면을 보여 준다.`);
    else if (/화면|표시|디자인|UI|보여/.test(r)) add("display", `${r}: 변경 내용을 목록과 상세 화면에 같은 방식으로 보여 준다.`);
    else if (/데이터|저장|필드|항목/.test(r)) add("data", `${r}: 필요한 필드를 추가하고 변경 이력을 남긴다.`);
    else add("rule", `${r}.`);
    patch.slots = slots;
    if (x.level === 2) {
      patch.success = x.success || `${x.title} 완료율 80% 이상.`;
      patch.rationale = x.rationale || `${iga(x.title)} 없으면 ${role}가 목적을 끝까지 이루기 어렵다.`;
    }
    if (x.level === 2 && /상세|나눠|쪼개|세분|단계|추가/.test(r)) {
      children.push({ ...blankItem(3, `${r.replace(/(추가|나눠|쪼개).*$/, "").trim() || x.title} 처리`, { kind: "new" }), summary: `${r}에 해당하는 동작만 따로 떼어 검증한다.`, roles: x.roles, slots: slotTemplate(x.title, n, role) });
    }
    if (/할지|정할|고민|모르/.test(r)) {
      patch.questions = [...(x.questions ?? []), { id: qid(), slot: "rule", text: `'${r}'${josa(r, "은/는")} 어떻게 할까요?`, options: ["가장 단순하게 시작", "설정으로 고를 수 있게", "운영자가 정함"], recommended: 0 }];
    }
  }
  return { patch, children, reason: `요청: ${r}` };
}

export function localFill(p: Project, x: SpecItem): Slots {
  const tpl = slotTemplate(x.title, nounOf(p), x.roles[0] ?? p.prdProps?.roles?.[0] ?? "일반 사용자");
  const slots: Slots = { ...x.slots };
  for (const [k] of SLOTS) if (!x.offSlots?.includes(k) && !slots[k]?.some((s) => s.trim())) slots[k] = tpl[k];
  return slots;
}

export function localAnswer(x: SpecItem, q: SlotQuestion, answer: string): string[] {
  const keep = (x.slots?.[q.slot] ?? []).filter((s) => s.trim() && !/미정|정해야/.test(s));
  const topic = q.text.replace(/\s*(을|를)?\s*(할까요|될까요|둘까요|받을까요|까요)\?*$/, "").trim();
  return [...keep, `${topic}: ${answer}${josa(answer, "으로/로")} 정한다.`];
}

// Fresh copy with new ids and codes (for 복제).
export function cloneItem(x: SpecItem): SpecItem {
  return { ...x, id: itemId(), code: newCode(x.level), pending: undefined, questions: x.questions?.map((q) => ({ ...q, id: qid() })), children: x.children.map(cloneItem) };
}
