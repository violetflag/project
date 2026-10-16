"use client";

import { AiKeyForm } from "../AiKeyForm";
import { useState } from "react";
import {
  addComment, applyDecision, discussFinding, extractDecisions, restoreVersion, review, saveVersion,
  setFinding, setSettings, toggleComment,
} from "@/lib/actions";
import type { Perspective, Project } from "@/lib/types";

const fmt = (t: number) => new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const Empty = ({ text }: { text: string }) => <p className="py-10 text-center text-xs text-foreground-muted">{text}</p>;
const PERSPECTIVES: Perspective[] = ["개발", "사업", "UX·디자인", "QA", "보안", "운영"];

export function ReviewPanel({ p, onChat }: { p: Project; onChat: () => void }) {
  const [filter, setFilter] = useState<Perspective | "전체">("전체");
  if (!p.groups) return <Empty text="기능명세서가 생기면 검토할 수 있어요." />;
  if (!p.findings) {
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-sm text-foreground-support">개발, 사업, UX·디자인, QA, 보안, 운영 여섯 관점에서 기획서 전체를 읽고 빠진 부분을 찾아 드려요.</p>
        <button onClick={() => review(p.id)} className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">검토 시작</button>
      </div>
    );
  }
  const open = p.findings.filter((f) => f.state === "open");
  const shown = p.findings.filter((f) => filter === "전체" || f.perspective === filter);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-foreground-support">
        <span>남은 의견 {open.length} · 전체 {p.findings.length}</span>
        <button onClick={() => review(p.id)} className="rounded border border-border px-2 py-0.5 hover:border-border-strong">다시 검토</button>
      </div>
      <div className="flex flex-wrap gap-1 px-4 py-2">
        {(["전체", ...PERSPECTIVES] as const).map((k) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${filter === k ? "border-primary bg-primary-soft text-primary" : "border-border text-foreground-support"}`}>
            {k}
          </button>
        ))}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4">
        {shown.map((f) => (
          <div key={f.id} className={`rounded-lg border border-border bg-background p-3 ${f.state !== "open" ? "opacity-50" : ""}`}>
            <div className="flex items-center gap-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${f.level === "주의" ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700"}`}>{f.level}</span>
              <span className="text-[11px] text-foreground-muted">{f.perspective}</span>
            </div>
            <p className="mt-1.5 text-sm font-medium">{f.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-foreground-support">{f.body}</p>
            {f.state === "open" ? (
              <div className="mt-2 flex gap-1.5 text-xs">
                <button onClick={() => setFinding(p.id, f.id, "held")} className="rounded border border-border px-2 py-1">보류</button>
                <button onClick={() => setFinding(p.id, f.id, "resolved")} className="rounded border border-border px-2 py-1 text-green-700">✓ 해결</button>
                <button onClick={() => { discussFinding(p.id, f.id); onChat(); }} className="rounded border border-primary/40 px-2 py-1 text-primary">채팅에서 해결하기</button>
              </div>
            ) : (
              <button onClick={() => setFinding(p.id, f.id, "open")} className="mt-2 text-xs text-foreground-muted underline">
                {f.state === "resolved" ? "해결됨" : "보류됨"} · 다시 열기
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

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
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="회의 제목" className="w-full rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-primary" />
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10}
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
                ? <p className="mt-1.5 text-[11px] text-green-700">기획서에 반영됨</p>
                : <button onClick={() => applyDecision(p.id, d.id)} disabled={!p.prd} className="mt-1.5 text-xs text-primary disabled:opacity-40">기획서에 반영</button>)}
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

export function CommentsPanel({ p, featureTitle }: { p: Project; featureTitle: (id?: string) => string | undefined }) {
  const [text, setText] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const list = p.comments.filter((c) => showResolved || !c.resolved);
  return (
    <div className="flex h-full flex-col">
      <label className="flex items-center gap-1.5 px-4 pt-3 text-xs text-foreground-support">
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> 해결된 코멘트도 보기
      </label>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {list.length ? list.map((c) => (
          <div key={c.id} className={`rounded-lg border border-border bg-background p-3 ${c.resolved ? "opacity-50" : ""}`}>
            {c.featureId && <p className="mb-1 text-[11px] text-primary">@ {featureTitle(c.featureId)}</p>}
            <p className="text-sm">{c.text}</p>
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-foreground-muted">
              <span>{c.author} · {fmt(c.at)}</span>
              <button onClick={() => toggleComment(p.id, c.id)}>{c.resolved ? "다시 열기" : "해결"}</button>
            </div>
          </div>
        )) : <Empty text="아직 코멘트가 없어요. 기능 상세 화면에서도 남길 수 있어요." />}
      </div>
      <div className="m-3 flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="프로젝트 전체에 코멘트 남기기"
          onKeyDown={(e) => { if (e.key === "Enter" && text.trim() && !e.nativeEvent.isComposing) { addComment(p.id, text.trim()); setText(""); } }}
          className="flex-1 rounded-md border border-border px-2 py-1.5 text-sm outline-none focus:border-primary" />
      </div>
    </div>
  );
}

export function VersionsPanel({ p }: { p: Project }) {
  const [tab, setTab] = useState<"버전" | "작업 로그">("버전");
  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 px-4 pt-3">
        {(["버전", "작업 로그"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-md px-2.5 py-1 text-xs ${tab === t ? "bg-border font-medium" : "text-foreground-support"}`}>{t}</button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {tab === "버전" ? (
          <>
            <button onClick={() => saveVersion(p.id, `버전 ${p.versions.length + 1}`)} className="mb-3 w-full rounded-md border border-border py-2 text-sm hover:border-border-strong">+ 지금 상태를 버전으로 저장</button>
            {p.versions.length ? p.versions.map((v) => (
              <div key={v.id} className="mb-2 flex items-center rounded-lg border border-border bg-background px-3 py-2">
                <span className="flex-1 text-sm">{v.name}<span className="ml-2 text-[11px] text-foreground-muted">{fmt(v.at)}</span></span>
                <button onClick={() => restoreVersion(p.id, v.id)} className="text-xs text-primary">되돌리기</button>
              </div>
            )) : <Empty text="아직 저장한 버전이 없어요." />}
          </>
        ) : (
          <ol className="relative border-l border-border pl-4">
            {p.log.map((l) => (
              <li key={l.id} className="mb-3">
                <span className="absolute -left-[3px] mt-1.5 h-1.5 w-1.5 rounded-full bg-border-strong" />
                <p className="text-sm">{l.text}</p>
                <p className="text-[11px] text-foreground-muted">{fmt(l.at)}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export function SettingsPanel({ p }: { p: Project }) {
  const [s, setS] = useState(p.settings);
  return (
    <div className="space-y-4 px-4 py-4 text-sm">
      <label className="block">
        <span className="text-xs text-foreground-support">문서 언어</span>
        <select value={s.language} onChange={(e) => setS({ ...s, language: e.target.value })} className="mt-1 w-full rounded-md border border-border px-2 py-1.5">
          <option>한국어</option><option>English</option>
        </select>
      </label>
      <label className="block">
        <span className="text-xs text-foreground-support">문체</span>
        <select value={s.tone} onChange={(e) => setS({ ...s, tone: e.target.value })} className="mt-1 w-full rounded-md border border-border px-2 py-1.5">
          <option>간결하게</option><option>자세하게</option><option>보고서체</option>
        </select>
      </label>
      <button onClick={() => setSettings(p.id, s)} className="w-full rounded-md bg-primary py-2 text-white">저장</button>
      <p className="text-xs text-foreground-muted">이 설정은 다음에 만드는 문서부터 적용돼요.</p>
      <div className="border-t border-border pt-4">
        <p className="mb-2 font-medium">AI 연결</p>
        <AiKeyForm />
      </div>
    </div>
  );
}
