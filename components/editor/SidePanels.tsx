"use client";

import { useCallback, useState } from "react";
import {
  addComment, applyDecision, deleteComment, deleteVersion, extractDecisions, fixFinding, isBusy, resolveFindingInChat, review,
  setFinding, setSettings, toggleComment,
} from "@/lib/actions";
import { findItem, flatten } from "@/lib/spec-model";
import { PERSPECTIVES } from "@/lib/types";
import type { Perspective, Project, ProjectSettings } from "@/lib/types";
import { josa } from "@/lib/josa";
import { restoreVersion, saveVersion } from "@/lib/versions";
import { saveToDrive } from "@/lib/sync";
import { useDismiss } from "../Popover";
import { AiKeyForm } from "../AiKeyForm";

const fmt = (t: number) => new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const time = (t: number) => new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
const day = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return "오늘";
  if (d.toDateString() === y.toDateString()) return "어제";
  return d.toLocaleDateString("ko-KR", { year: d.getFullYear() === today.getFullYear() ? undefined : "numeric", month: "long", day: "numeric" });
};
const Empty = ({ text }: { text: string }) => <p className="py-10 text-center text-xs text-foreground-muted">{text}</p>;

// --- Review --------------------------------------------------------------------------------

export function ReviewPanel({ p, onChat, usable, onGotoSpec }: { p: Project; onChat: () => void; usable: boolean; onGotoSpec: () => void }) {
  const [filter, setFilter] = useState<Perspective | "전체">("전체");
  const busy = isBusy(p);
  if (!usable) {
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-sm text-foreground-support">검토는 PRD와 기능명세서 탭에서 쓸 수 있어요.</p>
        <button onClick={onGotoSpec} className="mt-4 rounded-md border border-border px-4 py-2 text-sm hover:border-border-strong">기능명세서로 이동</button>
      </div>
    );
  }
  if (!p.spec?.length) return <Empty text="기능명세서가 생기면 검토할 수 있어요." />;
  if (!p.findings) {
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-sm text-foreground-support">개발, 사업, UX, 디자인, QA, 보안 여섯 관점에서 PRD와 기능명세서를 읽고, 빠졌거나 위험한 부분을 예시 상황과 함께 짚어 드려요.</p>
        <button disabled={busy} onClick={() => review(p.id)} aria-label="검토 시작" className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">검토 시작</button>
      </div>
    );
  }
  const fs = p.findings;
  const open = fs.filter((f) => f.state === "open");
  const warn = open.filter((f) => f.level === "주의").length;
  const shown = fs.filter((f) => filter === "전체" || f.perspective === filter)
    .sort((a, b) => Number(a.state !== "open") - Number(b.state !== "open"));
  const count = (k: Perspective) => fs.filter((f) => f.perspective === k && f.state === "open").length;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-foreground-support">
        <span>남은 의견 {open.length}개 · 주의 {warn} · 제안 {open.length - warn} <span className="text-foreground-muted">/ 전체 {fs.length}</span></span>
        <button disabled={busy} onClick={() => review(p.id)} aria-label="다시 검토" className="shrink-0 rounded border border-border px-2 py-0.5 hover:border-border-strong disabled:opacity-50">다시 검토</button>
      </div>
      <div className="flex flex-wrap gap-1 px-4 py-2">
        {(["전체", ...PERSPECTIVES] as const).map((k) => (
          <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${filter === k ? "border-primary bg-primary-soft text-primary" : "border-border text-foreground-support"}`}>
            {k} {k === "전체" ? open.length : count(k)}
          </button>
        ))}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4">
        {!shown.length && <Empty text="이 관점의 의견은 없어요." />}
        {shown.map((f) => {
          const item = findItem(p.spec, f.featureId ?? "");
          return (
            <div key={f.id} className={`rounded-lg border border-border bg-background p-3 ${f.state !== "open" ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-1.5">
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${f.level === "주의" ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700"}`}>{f.level}</span>
                <span className="text-[11px] text-foreground-muted">{f.perspective}</span>
                {item && <span className="ml-auto truncate font-mono text-[10px] text-foreground-muted" title={item.title}>{item.code}</span>}
              </div>
              <p className="mt-1.5 text-sm font-medium">{f.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-foreground-support">{f.body}</p>
              {f.scenario && (
                <div className="mt-2 rounded-md bg-surface px-2.5 py-2 text-xs leading-relaxed">
                  <span className="mb-0.5 block text-[10px] text-foreground-muted">예시 상황</span>{f.scenario}
                </div>
              )}
              {f.fix && (
                <div className="mt-2 rounded-md border border-green-200 bg-green-50 px-2.5 py-2 text-xs leading-relaxed text-green-900">
                  <span className="mb-0.5 block text-[10px] text-green-700">해결 방법</span>{f.fix}
                </div>
              )}
              {f.evidence && (
                <details className="mt-1.5 text-xs">
                  <summary className="cursor-pointer text-foreground-muted">근거 인용</summary>
                  <blockquote className="mt-1 border-l-2 border-border-strong pl-2 text-foreground-support">{f.evidence}</blockquote>
                </details>
              )}
              {f.state === "open" ? (
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                  <button onClick={() => setFinding(p.id, f.id, "held")} aria-label="보류" className="rounded border border-border px-2 py-1">보류</button>
                  <button disabled={busy} onClick={() => { void fixFinding(p.id, f.id); onChat(); }} aria-label="해결"
                    title="해결 방법대로 AI가 문서를 고쳐요" className="rounded border border-border px-2 py-1 text-green-700 disabled:opacity-50">✓ 해결</button>
                  <button disabled={busy} onClick={() => { resolveFindingInChat(p.id, f.id); onChat(); }} aria-label="채팅에서 해결하기"
                    className="rounded border border-primary/40 px-2 py-1 text-primary disabled:opacity-50">채팅에서 해결하기</button>
                </div>
              ) : f.state === "resolved" ? (
                <p className="mt-2 text-xs font-medium text-green-700">
                  ✓ {f.resolvedBy === "chat" ? "채팅에서 해결됨" : f.resolvedBy === "ai" ? "해결 방법대로 해결됨" : "해결됨"}
                </p>
              ) : (
                <button onClick={() => setFinding(p.id, f.id, "open")} className="mt-2 text-xs text-foreground-muted underline">보류됨 · 다시 열기</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Docs ---------------------------------------------------------------------------------------

export function DocsPanel({ p }: { p: Project }) {
  const [tab, setTab] = useState<"결정" | "회의록">("결정");
  const [writing, setWriting] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 px-4 pt-3">
        {(["결정", "회의록"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-md px-2.5 py-1 text-xs ${tab === t ? "bg-border font-medium" : "text-foreground-support"}`}>{t}</button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {writing ? (
          <div className="space-y-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="회의 제목" aria-label="회의 제목" className="w-full rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-primary" />
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} aria-label="회의 내용"
              placeholder={"회의 내용을 붙여 넣으세요.\n예) 첫 출시는 웹으로 한다\n예) 결제는 다음 버전에서 검토\n예) 단체 요금제는 만들지 않는다"}
              className="w-full rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-primary" />
            <div className="flex gap-2">
              <button onClick={() => { extractDecisions(p.id, title || "제목 없는 회의", body); setWriting(false); setTitle(""); setBody(""); setTab("결정"); }}
                disabled={!body.trim()} className="rounded-md bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-40">결정 뽑아내기</button>
              <button onClick={() => setWriting(false)} className="rounded-md border border-border px-3 py-1.5 text-sm">취소</button>
            </div>
          </div>
        ) : tab === "결정" ? (
          p.decisions.length ? p.decisions.map((d) => (
            <div key={d.id} className="mb-2 rounded-lg border border-border bg-background p-3">
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${d.state === "확정" ? "bg-green-100 text-green-700" : d.state === "기각" ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-700"}`}>{d.state}</span>
              <p className="mt-1.5 text-sm">{d.text}</p>
              <p className="mt-1 text-[11px] text-foreground-muted">근거: {d.source}</p>
              {d.state === "확정" && (d.applied
                ? <p className="mt-1.5 text-[11px] text-green-700">PRD에 반영됨</p>
                : <button onClick={() => applyDecision(p.id, d.id)} disabled={!p.prd} className="mt-1.5 text-xs text-primary disabled:opacity-40">PRD에 반영</button>)}
            </div>
          )) : <Empty text="아직 정리된 결정이 없어요. 회의록을 올리면 결정만 골라 드려요." />
        ) : p.notes.length ? p.notes.map((n) => (
          <details key={n.id} className="mb-2 rounded-lg border border-border bg-background p-3">
            <summary className="cursor-pointer text-sm">{n.title} <span className="text-[11px] text-foreground-muted">{fmt(n.at)}</span></summary>
            <p className="mt-2 text-xs whitespace-pre-line text-foreground-support">{n.body}</p>
          </details>
        )) : <Empty text="아직 올린 회의록이 없어요." />}
      </div>
      {!writing && (
        <button onClick={() => setWriting(true)} className="m-3 rounded-md bg-primary py-2 text-sm font-medium text-white">+ 회의록 올리기</button>
      )}
    </div>
  );
}

// --- Comments -------------------------------------------------------------------------------------

export function CommentsPanel({ p }: { p: Project }) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const list = p.comments.filter((c) => showResolved || !c.resolved);
  const items = flatten(p.spec).filter((x) => x.pending?.kind !== "new");
  return (
    <div className="flex h-full flex-col">
      <label className="flex items-center gap-1.5 px-4 pt-3 text-xs text-foreground-support">
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> 해결된 코멘트도 보기
      </label>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {list.length ? list.map((c) => {
          const it = c.featureId ? findItem(p.spec, c.featureId) : undefined;
          return (
            <div key={c.id} className={`rounded-lg border border-border bg-background p-3 ${c.resolved ? "opacity-50" : ""}`}>
              {c.featureId && <p className="mb-1 text-[11px] text-primary">@ {it ? `${it.code} ${it.title}` : "삭제된 항목"}</p>}
              <p className="text-sm whitespace-pre-line">{c.text}</p>
              <div className="mt-1.5 flex items-center gap-3 text-[11px] text-foreground-muted">
                <span className="mr-auto">{c.author} · {fmt(c.at)}</span>
                <button onClick={() => toggleComment(p.id, c.id)}>{c.resolved ? "다시 열기" : "해결"}</button>
                <button onClick={() => deleteComment(p.id, c.id)} className="hover:text-red-500">삭제</button>
              </div>
            </div>
          );
        }) : <Empty text="아직 코멘트가 없어요. 기능명세서 항목에서도 남길 수 있어요." />}
      </div>
      <form className="m-3 space-y-1.5" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { addComment(p.id, text.trim(), target || undefined); setText(""); } }}>
        {items.length > 0 && (
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="코멘트 대상"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs">
            <option value="">프로젝트 전체</option>
            {items.map((x) => <option key={x.id} value={x.id}>{"  ".repeat(x.level - 1)}{x.code} {x.title}</option>)}
          </select>
        )}
        <div className="flex gap-2">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="코멘트 남기기" aria-label="코멘트 입력"
            className="min-w-0 flex-1 rounded-md border border-border px-2 py-2 text-sm outline-none focus:border-primary" />
          <button disabled={!text.trim()} className="rounded-md bg-primary px-3 text-sm text-white disabled:opacity-40">남기기</button>
        </div>
      </form>
    </div>
  );
}

// --- Versions -------------------------------------------------------------------------------------

function VersionMenu({ onRestore, onDelete }: { onRestore: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label="버전 메뉴" className="rounded px-1.5 text-foreground-muted hover:bg-surface">⋮</button>
      {open && (
        <div className="absolute top-full right-0 z-20 mt-1 w-28 rounded-md border border-border bg-background p-1 text-xs shadow-lg">
          <button onClick={() => { close(); onRestore(); }} className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface">되돌리기</button>
          <button onClick={() => { close(); onDelete(); }} className="block w-full rounded px-2 py-1.5 text-left text-red-600 hover:bg-surface">삭제</button>
        </div>
      )}
    </div>
  );
}

export function VersionsPanel({ p }: { p: Project }) {
  const [showLog, setShowLog] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const days: [string, Project["versions"]][] = [];
  p.versions.forEach((v) => {
    const d = day(v.at);
    const g = days.find((x) => x[0] === d);
    if (g) g[1].push(v);
    else days.push([d, [v]]);
  });
  const save = () => {
    saveVersion(p.id, name.trim());
    saveToDrive();
    setName("");
    setNaming(false);
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-3">
        <button onClick={() => setNaming((n) => !n)} aria-label="새 버전 저장" className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white">+ 새 버전 저장</button>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-foreground-support">
          <input type="checkbox" checked={showLog} onChange={(e) => setShowLog(e.target.checked)} aria-label="작업 로그" /> 작업 로그
        </label>
      </div>
      {naming && (
        <form className="mx-4 mt-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`버전 ${p.versions.length + 1}`} aria-label="버전 이름"
            className="min-w-0 flex-1 rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-primary" />
          <button className="rounded-md border border-border px-3 text-sm">저장</button>
        </form>
      )}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {showLog ? (
          p.log.length ? (
            <ol className="relative border-l border-border pl-4">
              {p.log.map((l) => (
                <li key={l.id} className="mb-3">
                  <span className="absolute -left-[3px] mt-1.5 h-1.5 w-1.5 rounded-full bg-border-strong" />
                  <p className="text-sm">{l.text}</p>
                  <p className="text-[11px] text-foreground-muted">{fmt(l.at)}</p>
                </li>
              ))}
            </ol>
          ) : <Empty text="아직 작업 기록이 없어요." />
        ) : days.length ? days.map(([d, vs]) => (
          <div key={d} className="mb-3">
            <p className="mb-1.5 text-[11px] font-medium text-foreground-muted">{d}</p>
            {vs.map((v) => (
              <div key={v.id} className="mb-1.5 rounded-lg border border-border bg-background px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{v.name}</span>
                  {v.auto && <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] text-foreground-muted">자동 저장</span>}
                  <span className="ml-auto shrink-0 text-[11px] text-foreground-muted">{time(v.at)}</span>
                  <VersionMenu
                    onRestore={() => { if (confirm(`'${v.name}'${josa(v.name, "으로/로")} 되돌릴까요? 지금 상태는 새 버전으로 먼저 저장해요.`)) { saveVersion(p.id, "되돌리기 전"); restoreVersion(p.id, v.id); saveToDrive(); } }}
                    onDelete={() => { if (confirm(`'${v.name}'을 삭제할까요?`)) deleteVersion(p.id, v.id); }} />
                </div>
                {v.summary && <p className="mt-0.5 text-xs text-foreground-support">{v.summary}</p>}
              </div>
            ))}
          </div>
        )) : <Empty text="아직 저장한 버전이 없어요. 결과물이 만들어질 때마다 자동으로 쌓여요." />}
      </div>
    </div>
  );
}

// --- Customizing ------------------------------------------------------------------------------------

const TONES = ["간결하게", "친절하게", "자세하게", "보고서체"];

export function CustomizePanel({ p }: { p: Project }) {
  const [s, setS] = useState<ProjectSettings>(p.settings);
  const [saved, setSaved] = useState(false);
  const set = (patch: Partial<ProjectSettings>) => { setS((x) => ({ ...x, ...patch })); setSaved(false); };
  const area = (key: "style" | "format" | "terms" | "avoid" | "extra", label: string, hint: string, rows = 2) => (
    <label className="block">
      <span className="text-xs text-foreground-support">{label}</span>
      <textarea value={s[key] ?? ""} onChange={(e) => set({ [key]: e.target.value })} rows={rows} placeholder={hint} aria-label={label}
        className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm outline-none placeholder:text-foreground-assistive focus:border-primary" />
    </label>
  );
  return (
    <div className="h-full space-y-4 overflow-y-auto px-4 py-4 text-sm">
      <div>
        <p className="font-medium">프로젝트 커스터마이징</p>
        <p className="mt-0.5 text-xs text-foreground-muted">여기 적은 내용은 이 프로젝트에서 AI가 쓰는 모든 글에 적용돼요.</p>
      </div>
      <label className="block">
        <span className="text-xs text-foreground-support">기본 출력 언어</span>
        <select value={s.language} onChange={(e) => set({ language: e.target.value })} aria-label="기본 출력 언어" className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5">
          <option>한국어</option><option>English</option>
        </select>
      </label>
      <label className="block">
        <span className="text-xs text-foreground-support">대화 말투</span>
        <select value={TONES.includes(s.tone) ? s.tone : "__"} onChange={(e) => set({ tone: e.target.value === "__" ? s.tone : e.target.value })} aria-label="대화 말투"
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5">
          {TONES.map((t) => <option key={t}>{t}</option>)}
          {!TONES.includes(s.tone) && <option value="__">{s.tone}</option>}
        </select>
      </label>
      {area("style", "기획서 문체", "예: '~한다' 체로, 한 문장은 짧게")}
      {area("format", "기능 설명 양식", "예: 누가 / 무엇을 / 왜 순서로 한 줄씩")}
      {area("terms", "팀 용어", "예: 회원 → 멤버, 모임 → 클럽")}
      {area("avoid", "하지 말아야 할 것", "예: 결제 기능은 넣지 않기, 영어 약어 쓰지 않기")}
      {area("extra", "그 밖에 알아둘 것", "예: 첫 출시는 3개월 안, 개발자 2명", 3)}
      <button onClick={() => { setSettings(p.id, s); setSaved(true); }} aria-label="커스터마이징 저장" className="w-full rounded-md bg-primary py-2 text-white">{saved ? "저장했어요" : "저장"}</button>
      <p className="text-xs text-foreground-muted">AI가 다음에 쓰는 글부터 적용돼요. AI를 연결하지 않은 기본 생성기는 한국어 템플릿으로만 써요.</p>
      <div className="border-t border-border pt-4">
        <p className="mb-2 font-medium">AI 연결 (모든 프로젝트 공통)</p>
        <AiKeyForm />
      </div>
    </div>
  );
}
