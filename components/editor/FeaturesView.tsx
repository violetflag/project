"use client";

import { useMemo, useState } from "react";
import {
  addComment, addFeature, addGroup, deleteFeature, resolvePending, updateFeature,
} from "@/lib/actions";
import type { Feature, FeatureGroup, Project, Status } from "@/lib/types";
import { Close } from "../icons";
import { EmptyDoc } from "./PrdView";

const LANE = ["#78b08a", "#7ab7b9", "#83a3c4", "#9989b5", "#adbf6e", "#c7ab65", "#d18578"];
const STATUS: Record<Status, string> = { draft: "작성 중", review: "검토 중", done: "확정" };
type View = "graph" | "tree" | "doc";
type Filter = { status: Status | "all"; role: string; priority: number };

function Detail({ p, f, group, onClose }: { p: Project; f: Feature; group: FeatureGroup; onClose: () => void }) {
  const [comment, setComment] = useState("");
  const comments = p.comments.filter((c) => c.featureId === f.id);
  const set = (patch: Partial<Feature>) => updateFeature(p.id, f.id, patch);
  return (
    <aside className="animate-fade-up absolute top-0 right-0 bottom-0 z-20 w-[420px] overflow-y-auto border-l border-border bg-background shadow-xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs text-foreground-muted">
        <button onClick={onClose} aria-label="닫기"><Close className="h-3.5 w-3.5" /></button>
        <span className="truncate">{group.title} / {f.title}</span>
        <button onClick={() => { deleteFeature(p.id, f.id); onClose(); }} className="ml-auto text-foreground-muted hover:text-red-500">삭제</button>
      </div>
      <div className="space-y-4 px-5 py-5">
        <p className="text-xs text-foreground-muted">{f.code}</p>
        <input value={f.title} onChange={(e) => set({ title: e.target.value })} className="w-full text-xl font-semibold outline-none" />
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5">상태
            <select value={f.status} onChange={(e) => set({ status: e.target.value as Status })} className="rounded border border-border px-1.5 py-0.5">
              {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5">중요도
            <select value={f.priority} onChange={(e) => set({ priority: Number(e.target.value) as 1 | 2 | 3 })} className="rounded border border-border px-1.5 py-0.5">
              <option value={3}>높음</option><option value={2}>보통</option><option value={1}>낮음</option>
            </select>
          </label>
        </div>
        <label className="block text-xs text-foreground-support">역할 (쉼표로 구분)
          <input value={f.roles.join(", ")} onChange={(e) => set({ roles: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            className="mt-1 w-full rounded border border-border px-2 py-1 text-sm text-foreground" />
        </label>
        {([["summary", "설명"], ["rationale", "기능의 근거"], ["success", "성공 기준"]] as const).map(([k, label]) => (
          <label key={k} className="block text-xs text-foreground-support">{label}
            <textarea value={f[k]} onChange={(e) => set({ [k]: e.target.value })} rows={3}
              className="mt-1 w-full rounded border border-border px-2 py-1.5 text-sm leading-relaxed text-foreground outline-none focus:border-primary" />
          </label>
        ))}
        <div>
          <p className="mb-1 text-xs text-foreground-support">수용 기준</p>
          {f.criteria.map((c, i) => (
            <div key={i} className="mb-1 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" />
              <input value={c} onChange={(e) => set({ criteria: f.criteria.map((x, j) => (j === i ? e.target.value : x)) })} className="flex-1 outline-none" />
              <button onClick={() => set({ criteria: f.criteria.filter((_, j) => j !== i) })} className="text-xs text-foreground-muted">✕</button>
            </div>
          ))}
          <button onClick={() => set({ criteria: [...f.criteria, "새 기준"] })} className="text-xs text-primary">+ 기준 추가</button>
        </div>
        <div className="border-t border-border pt-4">
          <p className="mb-2 text-xs text-foreground-support">코멘트 {comments.length}</p>
          {comments.map((c) => <p key={c.id} className="mb-1.5 rounded bg-surface px-2 py-1.5 text-sm">{c.text}</p>)}
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="이 기능에 코멘트 남기기"
            onKeyDown={(e) => { if (e.key === "Enter" && comment.trim() && !e.nativeEvent.isComposing) { addComment(p.id, comment.trim(), f.id); setComment(""); } }}
            className="w-full rounded border border-border px-2 py-1.5 text-sm outline-none focus:border-primary" />
        </div>
      </div>
    </aside>
  );
}

function Graph({ p, groups, onOpen, pendingIds }: { p: Project; groups: FeatureGroup[]; onOpen: (id: string) => void; pendingIds: Set<string> }) {
  const rows = groups.map((g) => Math.max(1, g.features.length));
  const total = rows.reduce((a, b) => a + b, 0);
  const H = Math.max(480, total * 56 + 80);
  let y = 40;
  const layout = groups.map((g, gi) => {
    const h = rows[gi] * 56;
    const gy = y + h / 2;
    const feats = g.features.map((f, fi) => ({ f, y: y + fi * 56 + 28 }));
    y += h;
    return { g, gy, feats, color: LANE[gi % LANE.length] };
  });
  const rootY = H / 2;
  return (
    <div className="relative" style={{ height: H, width: 1100 }}>
      <svg className="absolute inset-0" width={1100} height={H}>
        {layout.map(({ g, gy, feats, color }) => (
          <g key={g.id} stroke={color} fill="none" strokeWidth={1.5}>
            <path d={`M240 ${rootY} C 320 ${rootY}, 320 ${gy}, 400 ${gy}`} />
            {feats.map(({ f, y: fy }) => <path key={f.id} d={`M640 ${gy} C 690 ${gy}, 690 ${fy}, 740 ${fy}`} />)}
          </g>
        ))}
      </svg>
      <div className="absolute w-56 rounded-lg border border-border bg-background p-3 shadow-sm" style={{ left: 20, top: rootY - 36 }}>
        <p className="text-sm font-medium">PRD</p>
        <p className="mt-1 truncate text-xs text-foreground-muted">{p.name}</p>
        <span className="mt-2 block h-1 rounded bg-primary" />
      </div>
      {layout.map(({ g, gy, feats, color }) => (
        <div key={g.id}>
          <div className="absolute w-60 rounded-md border-2 bg-background px-3 py-2 text-sm" style={{ left: 400, top: gy - 18, borderColor: color }}>
            <span className="mr-1.5 rounded bg-surface px-1 text-[11px]">{g.code}</span>{g.title}
          </div>
          {feats.map(({ f, y: fy }) => (
            <button key={f.id} onClick={() => onOpen(f.id)}
              className={`absolute flex w-80 items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-left text-sm hover:shadow ${pendingIds.has(f.id) ? "border-primary ring-2 ring-primary/30" : "border-border"}`}
              style={{ left: 740, top: fy - 16 }}>
              <span className="rounded bg-surface px-1 text-[11px]">{f.code}</span>
              <span className="truncate">{f.title}</span>
              {pendingIds.has(f.id) && <span className="ml-auto rounded bg-primary-soft px-1 text-[10px] text-primary">수정안</span>}
              <span className="ml-auto text-[10px] text-foreground-muted">{"●".repeat(f.priority)}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export function FeaturesView({ p }: { p: Project }) {
  const [view, setView] = useState<View>("graph");
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>({ status: "all", role: "all", priority: 0 });
  const [pi, setPi] = useState(0);
  const [q, setQ] = useState("");

  const groups = useMemo(() => (p.groups ?? []).map((g) => ({
    ...g,
    features: g.features.filter((f) =>
      (filter.status === "all" || f.status === filter.status) &&
      (filter.role === "all" || f.roles.includes(filter.role)) &&
      (!filter.priority || f.priority === filter.priority) &&
      (!q || f.title.includes(q))),
  })), [p.groups, filter, q]);

  if (!p.groups) return <EmptyDoc title="기능명세서가 여기에 생겨요" hint="PRD를 만들면 기능명세서 초안도 함께 만들어져요." />;

  const roles = [...new Set(p.groups.flatMap((g) => g.features.flatMap((f) => f.roles)))];
  const allFeatures = p.groups.flatMap((g) => g.features.map((f) => ({ f, g })));
  const current = open ? allFeatures.find((x) => x.f.id === open) : null;
  const pendingIds = new Set(p.pending.map((c) => c.featureId));
  const pending = p.pending[Math.min(pi, p.pending.length - 1)];

  return (
    <div className="relative flex h-full">
      <aside className="w-56 shrink-0 overflow-y-auto border-r border-border bg-background px-2 py-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="기능 이름으로 찾기" className="mb-2 w-full rounded border border-border px-2 py-1 text-xs outline-none" />
        {p.groups.map((g) => (
          <div key={g.id} className="mb-1">
            <p className="px-1.5 py-1 text-xs font-medium">{g.code}. {g.title}</p>
            {g.features.map((f) => (
              <button key={f.id} onClick={() => setOpen(f.id)} className={`block w-full truncate rounded px-3 py-0.5 text-left text-xs hover:bg-surface ${open === f.id ? "bg-surface" : "text-foreground-support"}`}>
                {f.code} {f.title}
              </button>
            ))}
            <button onClick={() => addFeature(p.id, g.id)} className="px-3 py-0.5 text-[11px] text-foreground-muted hover:text-primary">+ 기능 추가</button>
          </div>
        ))}
        <button onClick={() => addGroup(p.id)} className="mt-2 px-1.5 text-xs text-foreground-muted hover:text-primary">+ 기능 묶음 추가</button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-xs">
          {([["graph", "그래프"], ["tree", "디렉터리"], ["doc", "문서"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setView(k)} className={`rounded px-2 py-1 ${view === k ? "bg-border font-medium" : "text-foreground-support"}`}>{l}</button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value as Filter["status"] })} className="rounded border border-border px-1 py-0.5">
              <option value="all">진행 상태 전체</option>
              {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={filter.role} onChange={(e) => setFilter({ ...filter, role: e.target.value })} className="rounded border border-border px-1 py-0.5">
              <option value="all">역할 전체</option>
              {roles.map((r) => <option key={r}>{r}</option>)}
            </select>
            <select value={filter.priority} onChange={(e) => setFilter({ ...filter, priority: Number(e.target.value) })} className="rounded border border-border px-1 py-0.5">
              <option value={0}>중요도 전체</option><option value={3}>높음</option><option value={2}>보통</option><option value={1}>낮음</option>
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px]">
          {view === "graph" && <div className="p-6"><Graph p={p} groups={groups} onOpen={setOpen} pendingIds={pendingIds} /></div>}
          {view === "tree" && (
            <div className="mx-auto max-w-3xl p-6">
              {groups.map((g) => (
                <div key={g.id} className="mb-3 rounded-lg border border-border bg-background">
                  <p className="border-b border-border px-4 py-2 text-sm font-medium">{g.code}. {g.title} <span className="text-xs text-foreground-muted">{g.features.length}</span></p>
                  {g.features.map((f) => (
                    <button key={f.id} onClick={() => setOpen(f.id)} className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-surface">
                      <span className="w-8 text-xs text-foreground-muted">{f.code}</span>
                      <span className="flex-1">{f.title}</span>
                      <span className="text-xs text-foreground-muted">{f.roles.join(", ")}</span>
                      <span className="rounded bg-surface px-1.5 text-[11px]">{STATUS[f.status]}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          {view === "doc" && (
            <div className="mx-auto max-w-3xl space-y-4 p-6">
              {groups.map((g) => (
                <section key={g.id} className="rounded-xl border border-border bg-background px-7 py-6">
                  <h2 className="mb-4 text-lg font-semibold">{g.code}. {g.title}</h2>
                  {g.features.map((f) => (
                    <div key={f.id} className="mb-5 cursor-pointer" onClick={() => setOpen(f.id)}>
                      <p className="font-medium">{f.code} {f.title}</p>
                      <p className="mt-1 text-sm text-foreground-support">{f.summary}</p>
                      <ul className="mt-1 list-disc pl-5 text-xs text-foreground-muted">{f.criteria.map((c) => <li key={c}>{c}</li>)}</ul>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      {current && <Detail p={p} f={current.f} group={current.g} onClose={() => setOpen(null)} />}

      {pending && (
        <div className="animate-fade-up absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 text-sm shadow-lg">
          <span className="text-xs text-foreground-muted">AI 수정안</span>
          <button onClick={() => setPi(Math.max(0, pi - 1))} className="text-foreground-muted">‹</button>
          <span className="text-xs">{Math.min(pi, p.pending.length - 1) + 1} / {p.pending.length}</span>
          <button onClick={() => setPi(Math.min(p.pending.length - 1, pi + 1))} className="text-foreground-muted">›</button>
          <button onClick={() => setOpen(pending.kind === "edit" ? pending.featureId : null)} className="max-w-56 truncate text-left">
            <span className="mr-1 rounded bg-primary-soft px-1 text-[10px] text-primary">{pending.kind === "add" ? "추가" : "수정"}</span>
            {(pending.after.title as string) ?? allFeatures.find((x) => x.f.id === pending.featureId)?.f.title}
          </button>
          <button onClick={() => resolvePending(p.id, pending.id, false)} className="rounded border border-border px-2 py-1 text-xs">✕ 거절</button>
          <button onClick={() => resolvePending(p.id, pending.id, true)} className="rounded bg-primary px-2 py-1 text-xs text-white">✓ 승인</button>
          {p.pending.length > 1 && (
            <button onClick={() => p.pending.forEach((c) => resolvePending(p.id, c.id, true))} className="text-xs text-primary">모두 승인</button>
          )}
        </div>
      )}
    </div>
  );
}
