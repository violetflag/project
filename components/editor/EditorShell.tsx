"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { isBusy } from "@/lib/actions";
import { updateProject } from "@/lib/store";
import type { Project } from "@/lib/types";
import { useIsMobile } from "@/lib/useMedia";
import { ArrowLeft, Chat, Gear, Sparkle } from "../icons";
import { ChatPanel } from "./ChatPanel";
import { FeaturesView } from "./FeaturesView";
import { FlowView } from "./FlowView";
import { PrdView } from "./PrdView";
import { SaveButton } from "../SaveButton";
import { ShareDialog } from "./ShareDialog";
import { CustomizePanel, ReviewPanel, VersionsPanel } from "./SidePanels";
import { ProjectInfo } from "./ProjectInfo";
import { SyncDialog, SyncIcon, filledDocs } from "./SyncDialog";
import { WireframeView } from "./WireframeView";

type Panel = "chat" | "review" | "custom" | "versions";
type Tab = "prd" | "features" | "flow" | "wire";

const RAIL: [Panel, string, string][] = [
  ["chat", "채팅", "💬"], ["review", "검토", "🔍"], ["custom", "커스텀", "🎛"], ["versions", "버전", "🕘"],
];
const TABS: [Tab, string][] = [["prd", "PRD"], ["features", "기능명세서"], ["flow", "유저플로우"], ["wire", "와이어프레임"]];
const PANEL_TITLE: Record<Panel, string> = {
  chat: "채팅", review: "검토", custom: "프로젝트 커스터마이징", versions: "버전",
};
const REVIEW_ONLY = "검토는 PRD와 기능명세서 탭에서 쓸 수 있어요";

function NameInput({ p, className }: { p: Project; className: string }) {
  const [name, setName] = useState(p.name);
  return (
    <input value={name} onChange={(e) => setName(e.target.value)} aria-label="프로젝트 이름"
      onBlur={() => updateProject(p.id, (x) => ({ ...x, name: name.trim() || x.name }))}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={`truncate rounded px-1 text-sm font-medium outline-none hover:bg-surface focus:bg-surface ${className}`} />
  );
}

export function EditorShell({ p }: { p: Project }) {
  const mobile = useIsMobile();
  const [panel, setPanel] = useState<Panel | null>("chat");
  const [tab, setTab] = useState<Tab>("prd");
  const [share, setShare] = useState(false);
  // Phones show one pane at a time: a side panel or the documents.
  const [mobilePane, setMobilePane] = useState<Panel | "doc">("chat");
  const [more, setMore] = useState(false);

  // Move to the feature spec once it first appears, like the guided flow.
  const hasSpec = !!p.spec?.length;
  useEffect(() => {
    if (hasSpec) setTab((t) => (t === "prd" ? "features" : t));
  }, [hasSpec]);

  // Shift+1..4 switches documents.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || (e.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]")) return;
      const i = ["!", "@", "#", "$"].indexOf(e.key);
      const j = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(e.code);
      const k = i >= 0 ? i : j;
      if (k >= 0) { e.preventDefault(); setTab(TABS[k][0]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const reviewUsable = tab === "prd" || tab === "features";
  const showPanel = (k: Panel) => { setPanel(k); setMobilePane(k); };
  const gotoTab = (t: Tab) => { setTab(t); setMobilePane("doc"); };
  const goto = (t: string) => {
    if (t === "features" || t === "prd" || t === "flow" || t === "wire") gotoTab(t);
    if (t === "review") { setTab((x) => (x === "flow" || x === "wire" ? "features" : x)); showPanel("review"); }
  };

  // Documents ask for a tab change with a "planspace:goto" event, e.g. the PRD's 기능명세서로 이동.
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<string>).detail;
      if (t === "features" || t === "prd" || t === "flow" || t === "wire") { setTab(t); setMobilePane("doc"); }
    };
    window.addEventListener("planspace:goto", on);
    return () => window.removeEventListener("planspace:goto", on);
  }, []);

  const filled: Record<Tab, boolean> = { prd: !!p.prd, features: hasSpec, flow: p.flows.length > 0, wire: p.wires.length > 0 };
  const stale: Record<Tab, boolean> = { prd: false, features: false, flow: !!p.stale?.flow && filled.flow, wire: !!p.stale?.wire && filled.wire };
  const anyStale = stale.flow || stale.wire;
  const busy = isBusy(p);
  const [syncOpen, setSyncOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoBtn = (
    <button type="button" onClick={() => setInfoOpen(true)} aria-label="프로젝트 정보" title="프로젝트 정보"
      className="shrink-0 rounded p-1 text-xs text-foreground-muted hover:bg-surface">정보</button>
  );
  const canSync = Object.values(filledDocs(p)).filter(Boolean).length >= 2;
  const openFindings = p.findings?.filter((f) => f.state === "open").length ?? 0;

  const panelBody = (k: Panel) => (
    <>
      {k === "chat" && <ChatPanel p={p} onGoto={goto} />}
      {k === "review" && <ReviewPanel p={p} usable={reviewUsable} onGotoSpec={() => setTab("features")} onChat={() => showPanel("chat")} />}
      {k === "custom" && <CustomizePanel key={p.id} p={p} />}
      {k === "versions" && <VersionsPanel p={p} />}
    </>
  );
  const dot = (k: Tab) => (
    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${stale[k] ? "bg-amber-500" : filled[k] ? "bg-primary" : "border border-border-strong"}`} />
  );
  const tabs = (
    <div className="flex min-w-0 items-center gap-1">
      <div role="tablist" className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map(([k, l], i) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            title={`${stale[k] ? "앞 단계가 바뀌었어요. 탭 안의 [동기화]로 반영할 수 있어요 · " : ""}Shift + ${i + 1}`}
            className={`flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1 text-sm whitespace-nowrap ${tab === k ? "bg-surface font-medium" : filled[k] ? "text-foreground-support hover:bg-surface" : "text-foreground-assistive hover:bg-surface"}`}>
            {dot(k)}{l}
          </button>
        ))}
      </div>
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
      <div className="relative shrink-0">
        <button type="button" onClick={() => setSyncOpen((o) => !o)} disabled={!canSync} aria-label="동기화" aria-expanded={syncOpen}
          title={canSync ? "문서를 기준 문서에 맞춰 동기화해요" : "문서를 두 개 이상 만들면 동기화할 수 있어요"}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-sm whitespace-nowrap text-foreground-support hover:bg-surface disabled:opacity-40">
          <SyncIcon />동기화{anyStale && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />}
        </button>
        {syncOpen && <SyncDialog p={p} onClose={() => setSyncOpen(false)} />}
      </div>
    </div>
  );
  const doc = (
    <div className="min-h-0 flex-1 bg-background-canvas">
      {tab === "prd" && <PrdView p={p} />}
      {tab === "features" && <FeaturesView p={p} />}
      {tab === "flow" && <FlowView p={p} />}
      {tab === "wire" && <WireframeView p={p} />}
    </div>
  );
  const exportBtn = (
    <button onClick={() => setShare((s) => !s)} aria-label="내보내기" className="shrink-0 rounded-md bg-primary px-3 py-1 text-sm text-white">내보내기</button>
  );

  if (mobile) {
    const NAV: [Panel | "doc", string, string][] = [["chat", "채팅", "💬"], ["doc", "문서", "📄"], ["review", "검토", "🔍"]];
    const inMore = mobilePane !== "doc" && !NAV.some((n) => n[0] === mobilePane);
    return (
      <div className="flex h-dvh flex-col bg-background">
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
          <Link href="/" aria-label="홈으로" className="rounded p-1.5 text-foreground-muted hover:bg-surface"><ArrowLeft className="h-5 w-5" /></Link>
          <NameInput p={p} className="min-w-0 flex-1" />
          {infoBtn}
          <SaveButton />
          {exportBtn}
        </header>
        {share && <ShareDialog p={p} onClose={() => setShare(false)} />}
        {infoOpen && <ProjectInfo p={p} onClose={() => setInfoOpen(false)} />}
        {mobilePane === "doc" ? (
          <>
            <div className="shrink-0 border-b border-border px-2 py-1.5">{tabs}</div>
            {doc}
          </>
        ) : (
          <section className="flex min-h-0 flex-1 flex-col">
            {mobilePane !== "chat" && (
              <div className="border-b border-border px-4 py-2"><p className="text-sm font-medium">{PANEL_TITLE[mobilePane]}</p></div>
            )}
            <div className="min-h-0 flex-1">{panelBody(mobilePane)}</div>
          </section>
        )}
        <nav className="flex shrink-0 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
          {NAV.map(([k, label, icon]) => (
            <button key={k} onClick={() => { setMobilePane(k); setMore(false); }} aria-label={label}
              className={`relative flex flex-1 flex-col items-center py-2 text-[11px] ${mobilePane === k ? "text-foreground" : "text-foreground-muted"}`}>
              <span className="text-base grayscale">{icon}</span>{label}
              {k === "review" && openFindings > 0 && <span className="absolute top-1.5 right-[35%] h-1.5 w-1.5 rounded-full bg-amber-500" />}
              {k === "doc" && anyStale && <span className="absolute top-1.5 right-[35%] h-1.5 w-1.5 rounded-full bg-amber-500" />}
            </button>
          ))}
          <button onClick={() => setMore((m) => !m)} aria-label="더보기"
            className={`relative flex flex-1 flex-col items-center py-2 text-[11px] ${inMore || more ? "text-foreground" : "text-foreground-muted"}`}>
            <span className="text-base">⋯</span>더보기
          </button>
        </nav>
        {more && (
          <div className="fixed inset-0 z-40" onClick={() => setMore(false)}>
            <div className="absolute inset-0 bg-black/20" />
            <div className="animate-fade-up absolute inset-x-0 bottom-0 rounded-t-2xl bg-background p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] shadow-xl" onClick={(e) => e.stopPropagation()}>
              {RAIL.filter(([k]) => !["chat", "review"].includes(k)).map(([k, label, icon]) => (
                <button key={k} onClick={() => { setMobilePane(k); setMore(false); }} aria-label={label}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm hover:bg-surface">
                  <span className="grayscale">{icon}</span>{PANEL_TITLE[k]}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-dvh bg-background">
      <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border py-2">
        <Link href="/" className="mb-2 grid h-8 w-8 place-items-center rounded-md bg-primary text-white" title="홈으로" aria-label="홈으로"><Sparkle className="h-4 w-4" /></Link>
        {RAIL.map(([k, label, icon]) => {
          const off = k === "review" && !reviewUsable;
          return (
            <button key={k} onClick={() => !off && setPanel(panel === k ? null : k)} aria-label={label} aria-disabled={off}
              title={off ? REVIEW_ONLY : label}
              className={`relative flex w-12 flex-col items-center rounded-md py-1.5 text-[10px] ${off ? "cursor-not-allowed opacity-40" : panel === k ? "bg-border text-foreground" : "text-foreground-muted hover:bg-surface"}`}>
              <span className="text-sm grayscale">{icon}</span>{label}
              {k === "review" && openFindings > 0 && <span className="absolute top-1 right-2 h-1.5 w-1.5 rounded-full bg-amber-500" />}
            </button>
          );
        })}
      </nav>

      {panel && (
        <section className="flex w-[340px] shrink-0 flex-col border-r border-border bg-background">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <p className="text-sm font-medium">{PANEL_TITLE[panel]}</p>
            <button onClick={() => setPanel(null)} aria-label="패널 닫기" className="text-xs text-foreground-muted hover:text-foreground">닫기</button>
          </div>
          <div className="min-h-0 flex-1">{panelBody(panel)}</div>
        </section>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 items-center gap-1 border-b border-border px-3">
          <button onClick={() => setPanel(panel ? null : "chat")} className="mr-1 rounded p-1 text-foreground-muted hover:bg-surface" title={panel ? "패널 접기" : "채팅 열기"} aria-label={panel ? "패널 접기" : "채팅 열기"}><Chat className="h-4 w-4" /></button>
          <NameInput p={p} className="mr-1 w-56 shrink-0" />
          {infoBtn}
          <span className="mr-2" />
          {tabs}
          <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            <SaveButton label />
            {exportBtn}
            <button onClick={() => setPanel("custom")} aria-label="커스터마이징 열기" className="rounded p-1 text-foreground-muted hover:bg-surface"><Gear className="h-4 w-4" /></button>
          </div>
        </header>
        {share && <ShareDialog p={p} onClose={() => setShare(false)} />}
        {infoOpen && <ProjectInfo p={p} onClose={() => setInfoOpen(false)} />}
        {doc}
      </div>
    </div>
  );
}
