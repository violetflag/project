"use client";

import { useState } from "react";
import { addPrdBlock, completeSpec, deletePrdBlock, generatePrd, setPrdBlock, setPrdProps } from "@/lib/spec";
import { isBusy } from "@/lib/run";
import type { Project } from "@/lib/types";
import { useIsMobile } from "@/lib/useMedia";
import { ArrowRight, Plus, Sparkle } from "../icons";
import { InlineText } from "./spec/ui";

export function EmptyDoc({ title, hint, action }: { title: string; hint: string; action?: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="mx-4 w-full max-w-[420px] rounded-xl border border-border bg-background px-8 py-10 text-center shadow-sm">
        <div className="mx-auto mb-4 h-12 w-10 rounded-md bg-primary-soft" />
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-foreground-support">{hint}</p>
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}

// Asks the app shell to switch tabs (EditorShell listens for this event).
const gotoTab = (tab: string) => window.dispatchEvent(new CustomEvent("planspace:goto", { detail: tab }));

const DEVICE_SUGGEST = ["모바일(iOS)", "모바일(Android)", "데스크톱 웹", "태블릿", "모바일 웹"];

function Chips({ label, values, onChange, suggest = [], aria }: { label: string; values: string[]; onChange: (v: string[]) => void; suggest?: string[]; aria: string }) {
  const [text, setText] = useState("");
  const add = (v: string) => { const t = v.trim(); if (t && !values.includes(t)) onChange([...values, t]); setText(""); };
  const rest = suggest.filter((s) => !values.includes(s));
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-foreground-support">{label}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <span key={v} className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary-soft px-2 py-0.5 text-xs text-primary">
            {v}
            <button onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`${aria} ${v} 삭제`} className="text-primary/70 hover:text-primary">✕</button>
          </span>
        ))}
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="+ 추가" aria-label={`${aria} 추가`}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); add(text); } }}
          onBlur={() => text.trim() && add(text)}
          className="w-24 rounded-full border border-dashed border-border px-2 py-0.5 text-xs outline-none focus:border-primary" />
      </div>
      {rest.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {rest.map((s) => <button key={s} onClick={() => add(s)} className="rounded-full px-1.5 text-[11px] text-foreground-muted hover:bg-surface">+ {s}</button>)}
        </div>
      )}
    </div>
  );
}

function PropsCard({ p }: { p: Project }) {
  const props = p.prdProps ?? { category: "", roles: [], devices: [] };
  return (
    <section id="prd-props" className="scroll-mt-12 rounded-xl border border-border bg-background px-5 py-6 md:px-8" aria-label="속성 설정">
      <h2 className="mb-1 text-lg font-semibold">속성 설정</h2>
      <p className="mb-5 text-xs text-foreground-muted">여기서 정한 사용자 역할은 기능명세서의 역할 선택지로 쓰여요.</p>
      <div className="space-y-5">
        <div>
          <p className="mb-1.5 text-xs font-medium text-foreground-support">카테고리</p>
          <InlineText value={props.category} onSave={(category) => setPrdProps(p.id, { category })} placeholder="예: 커뮤니티" className="text-sm" ariaLabel="카테고리" />
        </div>
        <Chips label="사용자 역할" aria="역할" values={props.roles} onChange={(roles) => setPrdProps(p.id, { roles })} suggest={["일반 사용자", "운영자", "관리자"]} />
        <Chips label="지원 기기" aria="기기" values={props.devices} onChange={(devices) => setPrdProps(p.id, { devices })} suggest={DEVICE_SUGGEST} />
      </div>
    </section>
  );
}

export function PrdView({ p }: { p: Project }) {
  const mobile = useIsMobile();
  const busy = isBusy(p);
  if (!p.prd) {
    return (
      <EmptyDoc title="PRD가 여기에 생겨요" hint="채팅에서 질문에 답하면 PRD 초안을 만들어 드려요. 답을 다 하지 않았어도 지금까지의 내용으로 바로 만들 수 있어요."
        action={
          <button onClick={() => void generatePrd(p.id)} disabled={busy} aria-label="PRD 만들기"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
            <Sparkle className="h-3.5 w-3.5" /> {busy ? "AI가 작업 중이에요…" : "PRD 만들기"}
          </button>
        } />
    );
  }
  const blocks = p.prd.flatMap((s) => s.blocks);
  const filled = blocks.filter((b) => b.body.trim()).length;
  const pct = blocks.length ? Math.round((filled / blocks.length) * 100) : 0;
  const hasSpec = !!p.spec?.length;
  const scroll = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="flex h-full">
      {!mobile && (
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-border bg-background px-3 py-4" aria-label="문서 구조">
          <p className="mb-2 px-2 text-xs font-medium text-foreground-support">문서 구조</p>
          {p.prd.map((s) => (
            <div key={s.id} className="mb-2">
              <button onClick={() => scroll(`prd-${s.id}`)} className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-surface">{s.title}</button>
              {s.blocks.map((b, i) => (
                <button key={i} onClick={() => scroll(`prd-${s.id}-${i}`)} className="flex w-full items-center gap-1.5 truncate rounded px-4 py-0.5 text-left text-xs text-foreground-muted hover:bg-surface">
                  <span className={`h-1 w-1 shrink-0 rounded-full ${b.body.trim() ? "bg-primary" : "bg-border-strong"}`} />{b.label}
                </button>
              ))}
            </div>
          ))}
          <button onClick={() => scroll("prd-props")} className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-surface">속성 설정</button>
        </aside>
      )}
      <div className="flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background-canvas/90 px-4 py-2 text-xs backdrop-blur md:px-6" aria-label="완성도">
          완성도
          <span className="h-1.5 w-32 overflow-hidden rounded-full bg-border"><span className="block h-full bg-primary transition-all" style={{ width: `${pct}%` }} /></span>
          {pct}% <span className="text-foreground-muted">({filled}/{blocks.length})</span>
        </div>
        <div className="mx-auto max-w-3xl space-y-4 px-3 py-4 md:px-6 md:py-6">
          {p.prd.map((s) => (
            <section key={s.id} id={`prd-${s.id}`} className="scroll-mt-12 rounded-xl border border-border bg-background px-5 py-6 md:px-8 md:py-7">
              <h2 className="mb-5 text-xl font-semibold">{s.title}</h2>
              {s.blocks.map((b, i) => (
                <div key={i} id={`prd-${s.id}-${i}`} className="group mb-5 scroll-mt-14">
                  <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    <InlineText value={b.label} onSave={(label) => label && setPrdBlock(p.id, s.id, i, { label })} className="flex-1" ariaLabel={`${b.label} 이름`} />
                    <button onClick={() => deletePrdBlock(p.id, s.id, i)} aria-label={`${b.label} 삭제`}
                      className="text-xs text-foreground-muted hover:text-red-500 md:opacity-0 md:group-hover:opacity-100">삭제</button>
                  </div>
                  <InlineText value={b.body} onSave={(body) => setPrdBlock(p.id, s.id, i, { body })} multiline placeholder="클릭해서 내용을 적어 주세요"
                    className="pl-3 text-sm leading-relaxed text-foreground-support" ariaLabel={`${b.label} 내용`} />
                </div>
              ))}
              <button onClick={() => addPrdBlock(p.id, s.id)} aria-label={`${s.title}에 항목 추가`} className="flex items-center gap-1 text-xs text-foreground-muted hover:text-primary">
                <Plus className="h-3 w-3" /> 항목 추가
              </button>
            </section>
          ))}
          <PropsCard p={p} />
          <div className="flex justify-center py-4">
            {hasSpec ? (
              <button onClick={() => gotoTab("features")} aria-label="기능명세서로 이동" className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-4 py-2 text-sm hover:border-primary hover:text-primary">
                기능명세서로 이동 <ArrowRight />
              </button>
            ) : (
              <button onClick={() => { void completeSpec(p.id); gotoTab("features"); }} disabled={busy} aria-label="기능명세서 완성하기"
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
                <Sparkle className="h-3.5 w-3.5" /> 기능명세서 완성하기
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
