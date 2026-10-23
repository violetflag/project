"use client";

import { useState } from "react";
import { aiEnabled } from "@/lib/run";
import { generatePrd } from "@/lib/spec";
import {
  DEFAULT_TEMPLATE, isDefaultTemplate, PRESETS, recommendTemplate, setPrdTemplate, templateFromPrd, type PrdTemplate,
} from "@/lib/prd-template";
import type { Project } from "@/lib/types";
import { Close, Plus, Sparkle } from "../icons";

const move = <T,>(xs: T[], i: number, d: number) => {
  const j = i + d;
  if (j < 0 || j >= xs.length) return xs;
  const n = [...xs];
  [n[i], n[j]] = [n[j], n[i]];
  return n;
};

function startOf(p: Project): PrdTemplate {
  if (p.prdTemplate) return p.prdTemplate;
  if (!p.prd) return DEFAULT_TEMPLATE;
  const t = templateFromPrd(p.prd);
  return isDefaultTemplate(t) ? DEFAULT_TEMPLATE : t;
}

// PRD 양식 편집: presets, an AI suggestion, or hand edits; then save, or save and (re)write the PRD.
export function PrdTemplateDialog({ p, onClose }: { p: Project; onClose: () => void }) {
  const [t, setT] = useState<PrdTemplate>(() => startOf(p));
  const [ai, setAi] = useState<{ busy?: boolean; err?: string }>({});
  const sections = t.sections;
  const setSections = (s: PrdTemplate["sections"]) => setT({ sections: s });
  const setSec = (i: number, patch: Partial<PrdTemplate["sections"][number]>) => setSections(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const setItem = (si: number, ii: number, patch: { label?: string; hint?: string }) =>
    setSec(si, { items: sections[si].items.map((it, j) => (j === ii ? { ...it, ...patch } : it)) });
  const count = sections.reduce((n, s) => n + s.items.length, 0);

  const recommend = async () => {
    setAi({ busy: true });
    try { setT(await recommendTemplate(p)); setAi({}); } catch (e) { setAi({ err: e instanceof Error ? e.message : String(e) }); }
  };
  const save = (write: boolean) => {
    setPrdTemplate(p.id, t);
    if (write) void generatePrd(p.id);
    onClose();
  };
  const small = "rounded px-1 text-foreground-muted hover:bg-surface hover:text-foreground disabled:opacity-30";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 md:items-center md:p-6" onClick={onClose}>
      <div role="dialog" aria-label="PRD 양식 편집" onClick={(e) => e.stopPropagation()}
        className="animate-fade-up flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-t-2xl bg-background shadow-2xl md:rounded-xl">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <div className="flex-1">
            <p className="font-medium">PRD 양식 편집</p>
            <p className="text-xs text-foreground-muted">PRD에 들어갈 섹션과 항목을 정해요. 항목 아래 안내는 AI가 그 칸에 무엇을 쓸지 알려 줘요.</p>
          </div>
          <button onClick={onClose} aria-label="닫기" className="p-1 text-foreground-muted hover:text-foreground"><Close className="h-4 w-4" /></button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-5 py-2.5">
          {PRESETS.map((x) => (
            <button key={x.id} onClick={() => setT(x.t)} title={x.desc} aria-label={`양식 ${x.name}`}
              className="rounded-full border border-border px-2.5 py-1 text-xs hover:border-primary hover:text-primary">{x.name}</button>
          ))}
          <button onClick={recommend} disabled={ai.busy || !aiEnabled()} aria-label="AI 추천 양식" title={aiEnabled() ? "아이디어에 맞는 양식을 AI가 만들어요" : "AI 키를 연결하면 쓸 수 있어요"}
            className="flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-1 text-xs font-medium text-primary disabled:opacity-50">
            <Sparkle className="h-3 w-3" />{ai.busy ? "추천받는 중…" : "AI 추천"}
          </button>
          {ai.err && <span className="text-[11px] text-red-600">추천을 받지 못했어요: {ai.err}</span>}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {sections.map((s, si) => (
            <div key={si} className="rounded-lg border border-border p-3" aria-label={`섹션 ${s.title}`}>
              <div className="flex items-center gap-1">
                <input value={s.title} onChange={(e) => setSec(si, { title: e.target.value })} aria-label={`섹션 ${si + 1} 이름`} placeholder="섹션 이름"
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 text-sm font-semibold outline-none hover:border-border focus:border-primary" />
                <button onClick={() => setSections(move(sections, si, -1))} disabled={si === 0} aria-label={`${s.title} 섹션 위로`} className={small}>↑</button>
                <button onClick={() => setSections(move(sections, si, 1))} disabled={si === sections.length - 1} aria-label={`${s.title} 섹션 아래로`} className={small}>↓</button>
                <button onClick={() => setSections(sections.filter((_, j) => j !== si))} aria-label={`${s.title} 섹션 빼기`} className={`${small} hover:text-red-500`}>빼기</button>
              </div>
              <ul className="mt-1 space-y-1">
                {s.items.map((it, ii) => (
                  <li key={ii} className="flex items-start gap-1 rounded-md bg-surface px-2 py-1.5">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <input value={it.label} onChange={(e) => setItem(si, ii, { label: e.target.value })} aria-label={`${s.title} 항목 ${ii + 1} 이름`} placeholder="항목 이름"
                        className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm outline-none hover:border-border focus:border-primary" />
                      <input value={it.hint ?? ""} onChange={(e) => setItem(si, ii, { hint: e.target.value })} aria-label={`${it.label} 안내`} placeholder="AI에게 줄 안내 (선택)"
                        className="w-full rounded border border-transparent bg-transparent px-1 text-[11px] text-foreground-muted outline-none hover:border-border focus:border-primary" />
                    </div>
                    <button onClick={() => setSec(si, { items: move(s.items, ii, -1) })} disabled={ii === 0} aria-label={`${it.label} 위로`} className={small}>↑</button>
                    <button onClick={() => setSec(si, { items: move(s.items, ii, 1) })} disabled={ii === s.items.length - 1} aria-label={`${it.label} 아래로`} className={small}>↓</button>
                    <button onClick={() => setSec(si, { items: s.items.filter((_, j) => j !== ii) })} aria-label={`${it.label} 빼기`} className={`${small} hover:text-red-500`}>✕</button>
                  </li>
                ))}
              </ul>
              <button onClick={() => setSec(si, { items: [...s.items, { label: "새 항목" }] })} aria-label={`${s.title}에 항목 넣기`}
                className="mt-1.5 flex items-center gap-1 text-xs text-foreground-muted hover:text-primary"><Plus className="h-3 w-3" />항목 넣기</button>
            </div>
          ))}
          <button onClick={() => setSections([...sections, { title: "새 섹션", items: [{ label: "새 항목" }] }])} aria-label="섹션 넣기"
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border py-2 text-xs text-foreground-muted hover:border-primary hover:text-primary">
            <Plus className="h-3 w-3" />섹션 넣기
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          <span className="mr-auto text-xs text-foreground-muted">섹션 {sections.length}개 · 항목 {count}개</span>
          <button onClick={() => save(false)} disabled={!count} aria-label="양식만 저장" className="rounded-md border border-border px-3 py-2 text-sm hover:border-border-strong disabled:opacity-40">양식만 저장</button>
          <button onClick={() => save(true)} disabled={!count} aria-label={p.prd ? "저장하고 PRD 다시 쓰기" : "저장하고 PRD 만들기"}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-40">
            <Sparkle className="h-3.5 w-3.5" />{p.prd ? "저장하고 PRD 다시 쓰기" : "저장하고 PRD 만들기"}
          </button>
        </div>
        {p.prd && <p className="px-5 pb-3 text-[11px] text-foreground-muted">다시 쓸 때 지금 PRD의 내용을 새 양식에 옮겨 담아요. 지금 PRD는 [버전]에 남아요.</p>}
      </div>
    </div>
  );
}
