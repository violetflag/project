"use client";

// PRD 양식: which sections and items a PRD has. The default matches the built-in PRD; a project can
// pick a preset, ask the AI for one that fits the idea, or edit it (rename, reorder, add, remove).
import { z } from "zod";
import { ask, materialText, styleOf } from "./ai";
import { josa } from "./josa";
import { updateProject } from "./store";
import { saveToDrive } from "./sync";
import type { PrdSection, PrdTemplate, Project } from "./types";

export type { PrdTemplate };

export const DEFAULT_TEMPLATE: PrdTemplate = {
  sections: [
    { title: "개요", items: [{ label: "한 줄 정의" }, { label: "제품 목표", hint: "측정 가능한 목표 포함" }, { label: "배경" }] },
    { title: "문제 및 해결 방안", items: [{ label: "사용자 문제" }, { label: "해결 방안" }, { label: "차별점", hint: "기존 방법과 비교" }] },
    { title: "타겟 및 시나리오", items: [{ label: "타겟 사용자", hint: "주·보조 사용자" }, { label: "사용자 시나리오", hint: "1. 2. 줄바꿈 목록" }] },
    { title: "성공·위험 요소", items: [{ label: "핵심 지표", hint: "숫자 목표" }, { label: "리스크", hint: "대응 방법 포함" }] },
  ],
};

export const PRESETS: { id: string; name: string; desc: string; t: PrdTemplate }[] = [
  { id: "default", name: "기본", desc: "개요·문제와 해결·타겟·지표와 리스크", t: DEFAULT_TEMPLATE },
  { id: "lean", name: "린 캔버스", desc: "문제부터 수익 구조까지 한 장으로", t: { sections: [
    { title: "문제와 고객", items: [{ label: "문제", hint: "상위 3개" }, { label: "기존 대안" }, { label: "고객군" }, { label: "얼리 어답터" }] },
    { title: "가치와 해결책", items: [{ label: "고유 가치 제안", hint: "한 문장" }, { label: "해결책", hint: "핵심 기능 3개" }, { label: "경쟁 우위" }] },
    { title: "시장 진입", items: [{ label: "채널" }, { label: "핵심 지표" }] },
    { title: "비용과 수익", items: [{ label: "비용 구조" }, { label: "수익원" }] },
  ] } },
  { id: "mvp", name: "MVP 빠른 검증", desc: "가설·범위·검증 방법 위주로 짧게", t: { sections: [
    { title: "가설", items: [{ label: "핵심 가설", hint: "누가 무엇 때문에 쓸 것인가" }, { label: "성공 기준", hint: "숫자로" }] },
    { title: "범위", items: [{ label: "꼭 넣을 것" }, { label: "이번엔 뺄 것" }, { label: "대표 시나리오" }] },
    { title: "검증", items: [{ label: "검증 방법" }, { label: "일정", hint: "주 단위" }, { label: "리스크" }] },
  ] } },
  { id: "b2b", name: "사내·B2B 서비스", desc: "업무 흐름·권한·도입 효과 중심", t: { sections: [
    { title: "개요", items: [{ label: "한 줄 정의" }, { label: "도입 배경" }, { label: "도입 효과", hint: "시간·비용 절감 수치" }] },
    { title: "사용자와 권한", items: [{ label: "사용 부서와 역할" }, { label: "권한 정책" }] },
    { title: "업무 흐름", items: [{ label: "현재 업무 방식" }, { label: "바뀐 업무 방식" }, { label: "연동 시스템" }] },
    { title: "운영", items: [{ label: "보안·감사 요구" }, { label: "도입 일정" }, { label: "리스크" }] },
  ] } },
];

export const templateOf = (p: Pick<Project, "prdTemplate">) => p.prdTemplate ?? DEFAULT_TEMPLATE;
const sig = (t: PrdTemplate) => JSON.stringify(t.sections.map((s) => [s.title, s.items.map((i) => i.label)]));
export const isDefaultTemplate = (t: PrdTemplate) => sig(t) === sig(DEFAULT_TEMPLATE);

// Drops empty names and duplicate labels so the AI keys stay unambiguous.
export function cleanTemplate(t: PrdTemplate): PrdTemplate {
  return {
    sections: t.sections.map((s) => {
      const seen = new Set<string>();
      return {
        title: s.title.trim(), items: s.items.map((i) => ({ label: i.label.trim(), ...(i.hint?.trim() ? { hint: i.hint.trim() } : {}) }))
          .filter((i) => i.label && !seen.has(i.label) && !!seen.add(i.label)),
      };
    }).filter((s) => s.title && s.items.length),
  };
}

export function setPrdTemplate(id: string, t: PrdTemplate) {
  const clean = cleanTemplate(t);
  updateProject(id, (p) => ({ ...p, prdTemplate: isDefaultTemplate(clean) ? undefined : clean }), "PRD 양식을 바꿨어요");
  saveToDrive();
}

// The template that matches an existing PRD (so editing starts from what is on screen).
export const templateFromPrd = (prd: PrdSection[]): PrdTemplate => ({ sections: prd.map((s) => ({ title: s.title, items: s.blocks.map((b) => ({ label: b.label })) })) });

const RecommendSchema = z.object({ items: z.array(z.object({ section: z.string(), label: z.string(), hint: z.string() })) });

export async function recommendTemplate(p: Project): Promise<PrdTemplate> {
  const out = await ask(RecommendSchema, `아이디어: ${p.idea}${materialText(p)}
이 서비스의 PRD에 알맞은 양식(섹션과 항목)을 추천합니다. 내용은 쓰지 않고 틀만 만듭니다.
- 섹션 3~6개, 섹션마다 항목 2~5개. 이 서비스에서 특히 중요한 것(예: 결제가 핵심이면 결제 정책, 커뮤니티면 신고·운영 정책)을 꼭 넣습니다.
- items 한 줄이 항목 하나: section은 섹션 이름, label은 항목 이름(짧게), hint는 그 항목에 쓸 내용 안내 한 구절.
- 같은 섹션의 항목은 같은 section 이름을 씁니다. 순서대로 씁니다.
${styleOf(p)}`);
  const sections: PrdTemplate["sections"] = [];
  for (const it of out.items) {
    const name = it.section.trim();
    if (!name || !it.label.trim()) continue;
    let s = sections.find((x) => x.title === name);
    if (!s) sections.push((s = { title: name, items: [] }));
    s.items.push({ label: it.label.trim(), hint: it.hint.trim() || undefined });
  }
  if (!sections.length) throw new Error("AI가 양식을 비워서 보냈어요.");
  return cleanTemplate({ sections });
}

// --- Writing a PRD in a custom template ----------------------------------------------------

export const TemplatePrdSchema = z.object({
  blocks: z.array(z.object({ key: z.string(), body: z.string(), src: z.string() })),
  category: z.string(), roles: z.array(z.string()), devices: z.array(z.string()),
});

export const templateKeys = (t: PrdTemplate) => t.sections.flatMap((s, si) => s.items.map((it, ii) => ({ key: `${si}.${ii}`, section: s.title, ...it })));

export function templateLines(t: PrdTemplate) {
  return templateKeys(t).map((k) => `${k.key} | ${k.section} · ${k.label}${k.hint ? ` (${k.hint})` : ""}`).join("\n");
}

// Builds PRD sections from keyed bodies; items the AI left empty get a gentle placeholder.
export function prdFromTemplate(t: PrdTemplate, bodies: Map<string, { body: string; src?: string }>): PrdSection[] {
  return t.sections.map((s, si) => ({
    id: `t${si}`, title: s.title,
    blocks: s.items.map((it, ii) => {
      const v = bodies.get(`${si}.${ii}`);
      const body = v?.body.trim() || `아직 비어 있어요. ${it.hint ? `${it.hint}${josa(it.hint, "을/를")} ` : ""}채팅으로 알려 주시면 채워 드려요.`;
      return { label: it.label, body, ...(v?.src?.trim() ? { src: v.src.trim() } : {}) };
    }),
  }));
}

// Local fallback: reuse a built-in block whose label matches, by name or meaning.
export function localTemplatePrd(t: PrdTemplate, base: PrdSection[]): PrdSection[] {
  const blocks = base.flatMap((s) => s.blocks);
  const near = (label: string) => blocks.find((b) => b.label === label) ?? blocks.find((b) => label.includes(b.label.slice(0, 2)) || b.label.includes(label.slice(0, 2)));
  const m = new Map(templateKeys(t).flatMap((k) => { const b = near(k.label); return b ? [[k.key, { body: b.body }] as const] : []; }));
  return prdFromTemplate(t, m);
}

