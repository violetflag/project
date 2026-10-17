"use client";

import { useEffect, useRef, useState } from "react";
import { flatten, LEVEL_LABEL, slotFill } from "@/lib/spec-model";
import { SLOTS, STATUS_LABEL } from "@/lib/types";
import type { Project, SpecItem } from "@/lib/types";
import { highlight, PendingBadge, PriorityBars, Star } from "./ui";

function Fold({ title, open, children }: { title: string; open: boolean; children: React.ReactNode }) {
  const [o, setO] = useState(true);
  const show = open || o;
  return (
    <div className="mt-2">
      <button onClick={() => setO(!o)} aria-expanded={show} className="flex items-center gap-1 text-xs font-medium text-foreground-support">
        <span className="text-[10px] text-foreground-muted">{show ? "▾" : "▸"}</span>{title}
      </button>
      {show && <div className="mt-1 pl-4">{children}</div>}
    </div>
  );
}

// The whole spec as one continuous document, with in-page search.
export function DocumentView({ p, num, shown, dim, onOpen, scrollTo }: {
  p: Project; num: Record<string, string>; shown: Set<string> | null; dim: Set<string> | null; onOpen: (id: string) => void; scrollTo: string | null;
}) {
  const [q, setQ] = useState("");
  const [hit, setHit] = useState(0);
  const [total, setTotal] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const items = flatten(p.spec).filter((x) => !shown || shown.has(x.id));
  const h = (s: string) => highlight(s, q);

  useEffect(() => {
    if (scrollTo) document.getElementById(`doc-${scrollTo}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollTo]);
  useEffect(() => {
    const marks = root.current?.querySelectorAll("mark[data-hit]") ?? [];
    setTotal(marks.length);
    setHit(0);
  }, [q, p.spec]);
  const jump = (dir: number) => {
    const marks = [...(root.current?.querySelectorAll("mark[data-hit]") ?? [])];
    if (!marks.length) return;
    const i = (hit + dir + marks.length) % marks.length;
    setHit(i);
    marks.forEach((m, j) => m.classList.toggle("ring-2", j === i));
    marks[i].scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const body = (x: SpecItem) => {
    const f = slotFill(x);
    return (
      <article key={x.id} id={`doc-${x.id}`} className={`scroll-mt-16 ${x.level === 1 ? "mt-8 first:mt-0" : x.level === 2 ? "mt-6 pl-0 md:pl-4" : "mt-4 pl-3 md:pl-8"} ${dim?.has(x.id) ? "opacity-35" : ""}`}>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => onOpen(x.id)} className={`text-left hover:text-primary ${x.level === 1 ? "text-lg font-semibold" : x.level === 2 ? "text-base font-semibold" : "text-sm font-medium"}`}>
            <span className="mr-1.5 text-foreground-muted">{num[x.id]}</span>{h(x.title)}
          </button>
          <PendingBadge x={x} />
          {x.starred && <Star on className="text-xs" />}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-foreground-muted">
          <span>{LEVEL_LABEL[x.level]} · {x.code}</span><span>{STATUS_LABEL[x.status]}</span><PriorityBars value={x.priority} />
          {x.roles.length > 0 && <span>{x.roles.join(", ")}</span>}
        </p>
        {x.summary && <p className="mt-1.5 text-sm leading-relaxed text-foreground-support">{h(x.summary)}</p>}
        {x.level === 1 && !!x.criteria?.length && (
          <Fold title="수용 기준" open={!!q}>
            <ul className="space-y-0.5 text-sm">{x.criteria.map((c, i) => <li key={i}>☐ {h(c)}</li>)}</ul>
          </Fold>
        )}
        {x.rationale && <Fold title="기능의 근거" open={!!q}><p className="text-sm leading-relaxed text-foreground-support">{h(x.rationale)}</p></Fold>}
        {x.success && <Fold title="성공 기준" open={!!q}><p className="text-sm leading-relaxed text-foreground-support">{h(x.success)}</p></Fold>}
        {x.level > 1 && (
          <Fold title={`개발 준비 슬롯 · ${f.filled}/${f.total}`} open={!!q}>
            <dl className="space-y-1.5 text-sm">
              {SLOTS.filter(([k]) => !x.offSlots?.includes(k) && (x.slots?.[k]?.length || x.questions?.some((y) => y.slot === k))).map(([k, label]) => (
                <div key={k} className="grid gap-x-3 md:grid-cols-[96px_1fr]">
                  <dt className="text-xs text-foreground-muted md:pt-0.5">{label}</dt>
                  <dd className="text-foreground-support">
                    {(x.slots?.[k] ?? []).map((s, i) => <p key={i}>• {h(s)}</p>)}
                    {x.questions?.filter((y) => y.slot === k).map((y) => <p key={y.id} className="text-amber-600">? {h(y.text)}</p>)}
                  </dd>
                </div>
              ))}
            </dl>
          </Fold>
        )}
      </article>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1.5">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="문서에서 찾기" aria-label="문서에서 찾기"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) jump(e.shiftKey ? -1 : 1); }}
          className="w-48 rounded border border-border px-2 py-1 text-xs outline-none focus:border-primary" />
        {q && <span className="text-[11px] text-foreground-muted">{total ? `${hit + 1}/${total}` : "결과 없음"}</span>}
        {q && total > 0 && (
          <>
            <button onClick={() => jump(-1)} aria-label="이전 검색 결과" className="px-1 text-foreground-muted">‹</button>
            <button onClick={() => jump(1)} aria-label="다음 검색 결과" className="px-1 text-foreground-muted">›</button>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div ref={root} className="mx-auto my-4 max-w-3xl rounded-xl border border-border bg-background px-5 py-6 pb-28 md:my-6 md:px-10 md:py-9">
          <h1 className="mb-6 text-2xl font-semibold">기능명세서</h1>
          {items.map(body)}
        </div>
      </div>
    </div>
  );
}
