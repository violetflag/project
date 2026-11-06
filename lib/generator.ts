// Local, rule-based stand-in for the AI planner. Every output is built from
// the user's idea and answers with fixed templates, so it works offline and
// on static hosting. Swap these functions for real model calls later.
import { josa } from "./josa";
import type { PrdSection, Question } from "./types";

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
      { label: "제품 목표", body: `${users}가 ${pain} 문제를 겪지 않도록, ${value}${josa(value, "을/를")} 가장 먼저 제공한다.` },
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
