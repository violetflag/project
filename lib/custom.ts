"use client";

// 커스텀: a before/after preview of the writing rules, and rewriting the existing PRD and spec
// to follow them ("이 프로젝트에 적용"). PRD changes apply at once (a version is saved first);
// spec changes come back as pending edits to approve.
import { z } from "zod";
import { ask, styleOf } from "./ai";
import { ai, aiEnabled, withAi } from "./run";
import { flatten, proposeEdit } from "./spec-model";
import { getProject, updateProject } from "./store";
import { saveToDrive } from "./sync";
import type { Project, ProjectSettings } from "./types";
import { autoVersion } from "./versions";

export const CUSTOM_BUSY = "커스텀 규칙에 맞춰 기획서를 다시 쓰고 있어요…";

// "회원 → 멤버, 모임 -> 클럽" → [["회원","멤버"],["모임","클럽"]]
export function termPairs(terms?: string): [string, string][] {
  return (terms ?? "").split(/[,\n]/).map((s) => s.split(/\s*(?:→|->|=>)\s*/)).filter((x) => x.length === 2 && x[0].trim() && x[1].trim())
    .map(([a, b]) => [a.trim(), b.trim()]);
}
const swapTerms = (s: string, pairs: [string, string][]) => pairs.reduce((t, [a, b]) => t.split(a).join(b), s);

// A short sample from the project to show the rules on.
export function sampleOf(p: Project): { where: string; text: string } {
  for (const s of p.prd ?? []) for (const b of s.blocks) if (b.body.trim().length > 20) return { where: `PRD · ${s.title} · ${b.label}`, text: b.body.slice(0, 400) };
  const f = flatten(p.spec).find((x) => x.summary.trim());
  if (f) return { where: `기능명세서 · ${f.title}`, text: f.summary };
  return { where: "아이디어", text: p.idea || "사용자가 동네 모임을 찾아 참여 신청을 하고, 모임장은 신청을 승인한다." };
}

const PreviewSchema = z.object({ after: z.string() });

export async function previewCustom(p: Project, settings: ProjectSettings): Promise<{ where: string; before: string; after: string; local: boolean }> {
  const s = sampleOf(p);
  if (!aiEnabled()) return { where: s.where, before: s.text, after: swapTerms(s.text, termPairs(settings.terms)), local: true };
  const out = await ask(PreviewSchema, `아래 글을 규칙에 맞춰 다시 씁니다. 뜻과 정보는 그대로 두고 문체·양식·용어만 바꿉니다. after에 다시 쓴 글만 넣습니다.
[규칙] ${styleOf({ settings })}
[글]
${s.text}`);
  return { where: s.where, before: s.text, after: out.after.trim() || s.text, local: false };
}

const ApplySchema = z.object({
  prd: z.array(z.object({ key: z.string(), body: z.string() })),
  spec: z.array(z.object({ code: z.string(), title: z.string(), summary: z.string() })),
  summary: z.string(),
});

type Out = z.infer<typeof ApplySchema>;

function finish(id: string, out: Out, how: string) {
  autoVersion(id, "커스텀 적용 전");
  let prdN = 0, specN = 0;
  updateProject(id, (p) => {
    const bodies = new Map(out.prd.map((x) => [x.key, x.body]));
    const prd = p.prd?.map((s, si) => ({
      ...s, blocks: s.blocks.map((b, bi) => {
        const v = bodies.get(`${si}.${bi}`)?.trim();
        if (!v || v === b.body) return b;
        prdN++;
        return { ...b, body: v };
      }),
    })) ?? p.prd;
    let spec = p.spec ?? [];
    const byCode = new Map(flatten(spec).map((x) => [x.code, x]));
    for (const e of out.spec) {
      const x = byCode.get(e.code);
      if (!x || x.pending?.kind === "new") continue;
      const next = { title: e.title.trim() || x.title, summary: e.summary.trim() || x.summary };
      if (next.title === x.title && next.summary === x.summary) continue;
      spec = proposeEdit(spec, x.id, next, "커스텀 규칙 적용");
      specN++;
    }
    const text = `${how} PRD ${prdN}곳은 바로 바꿨고, 기능명세서 ${specN}개 항목은 승인 대기로 올렸어요.${out.summary ? `\n${out.summary}` : ""}\n바뀌기 전 상태는 [버전]의 '커스텀 적용 전'에 있어요.`;
    return { ...p, prd, spec: p.spec ? spec : p.spec, chat: [...p.chat, ai(text, specN ? { actions: ["goto-features"] } : {})] };
  }, "커스텀 규칙을 기획서에 적용했어요");
  saveToDrive();
}

export function applyCustomToProject(id: string) {
  const local = () => {
    const p = getProject(id);
    if (!p) return;
    const pairs = termPairs(p.settings.terms);
    finish(id, {
      prd: (p.prd ?? []).flatMap((s, si) => s.blocks.map((b, bi) => ({ key: `${si}.${bi}`, body: swapTerms(b.body, pairs) }))),
      spec: flatten(p.spec).map((x) => ({ code: x.code, title: swapTerms(x.title, pairs), summary: swapTerms(x.summary, pairs) })),
      summary: pairs.length ? "AI 없이 팀 용어만 바꿨어요." : "AI가 연결되지 않아 바꿀 수 있는 것이 팀 용어뿐인데, 적힌 용어가 없어요.",
    }, "커스텀 규칙을 적용했어요.");
  };
  if (!aiEnabled()) return local();
  return withAi(id, CUSTOM_BUSY, async (p, step) => {
    step("문서 읽음");
    const prd = (p.prd ?? []).flatMap((s, si) => s.blocks.map((b, bi) => `${si}.${bi} | ${s.title} · ${b.label} | ${b.body}`)).join("\n");
    const spec = flatten(p.spec).filter((x) => x.pending?.kind !== "new").map((x) => `${x.code} | ${x.title} | ${x.summary}`).join("\n");
    const out = await ask(ApplySchema, `이 프로젝트의 기존 기획서를 새 규칙에 맞춰 다시 씁니다. 뜻과 정보는 그대로 두고 문체·양식·용어만 바꿉니다.
[규칙] ${styleOf(p)}

[PRD 블록] (key | 위치 | 본문)
${prd || "(없음)"}

[기능명세서] (code | 이름 | 설명)
${spec || "(없음)"}

- prd: 바꿀 블록만. key는 위 key 그대로, body는 다시 쓴 본문 전체.
- spec: 바꿀 항목만. code는 위 code 그대로, title과 summary는 다시 쓴 값(바꾸지 않으면 원래 값).
- 규칙과 이미 맞는 글은 넣지 않습니다.
- summary: 무엇을 어떻게 바꿨는지 1~2문장.`);
    step("다시 쓰기 완료");
    finish(id, out, "AI가 커스텀 규칙에 맞춰 기획서를 다시 썼어요.");
  }, local);
}
