"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { review } from "@/lib/actions";
import { updateProject } from "@/lib/store";
import type { Project } from "@/lib/types";
import { useIsMobile } from "@/lib/useMedia";
import { ArrowLeft, Chat, Gear, Sparkle } from "../icons";
import { ChatPanel } from "./ChatPanel";
import { FeaturesView } from "./FeaturesView";
import { FlowView } from "./FlowView";
import { PrdView } from "./PrdView";
import { ShareDialog } from "./ShareDialog";
import { CommentsPanel, DocsPanel, ReviewPanel, SettingsPanel, VersionsPanel } from "./SidePanels";
import { WireframeView } from "./WireframeView";

type Panel = "chat" | "review" | "docs" | "comments" | "versions" | "settings";
type Tab = "prd" | "features" | "flow" | "wire";

const RAIL: [Panel, string, string][] = [
  ["chat", "채팅", "💬"], ["review", "검토", "🔍"], ["docs", "기획실", "🗂"],
  ["comments", "코멘트", "📝"], ["versions", "버전", "🕘"], ["settings", "설정", "⚙"],
];
const TABS: [Tab, string][] = [["prd", "PRD"], ["features", "기능명세서"], ["flow", "유저플로우"], ["wire", "와이어프레임"]];
const panelName = (k: Panel) => RAIL.find((r) => r[0] === k)?.[1];

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
  const hasGroups = !!p.groups;
  useEffect(() => { if (hasGroups) setTab((t) => (t === "prd" ? "features" : t)); }, [hasGroups]);

  // Shift+1..4 switches documents.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || (e.target as HTMLElement).closest("input,textarea,select")) return;
      const i = ["!", "@", "#", "$"].indexOf(e.key);
      if (i >= 0) setTab(TABS[i][0]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showPanel = (k: Panel) => { setPanel(k); setMobilePane(k); };
  const goto = (t: string) => {
    if (t === "features") { setTab("features"); setMobilePane("doc"); }
    if (t === "review") showPanel("review");
  };
  const featureTitle = (id?: string) => p.groups?.flatMap((g) => g.features).find((f) => f.id === id)?.title;
  const ready: Record<Tab, boolean> = { prd: !!p.prd, features: !!p.groups, flow: !!p.flow, wire: !!p.screens };
  const openComments = p.comments.filter((c) => !c.resolved).length;
  const openFindings = p.findings?.filter((f) => f.state === "open").length ?? 0;

  const panelBody = (k: Panel) => (
    <>
      {k === "chat" && <ChatPanel p={p} onGoto={goto} />}
      {k === "review" && <ReviewPanel p={p} onChat={() => showPanel("chat")} />}
      {k === "docs" && <DocsPanel p={p} />}
      {k === "comments" && <CommentsPanel p={p} featureTitle={featureTitle} />}
      {k === "versions" && <VersionsPanel p={p} />}
      {k === "settings" && <SettingsPanel p={p} />}
    </>
  );
  const tabs = (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {TABS.map(([k, l], i) => (
        <button key={k} onClick={() => setTab(k)} title={`Shift + ${i + 1}`}
          className={`flex shrink-0 items-center gap-1 rounded px-2.5 py-1 text-sm whitespace-nowrap ${tab === k ? "bg-surface font-medium" : ready[k] ? "text-foreground-support hover:bg-surface" : "text-foreground-assistive"}`}>
          {ready[k] && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}{l}
        </button>
      ))}
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
    <button onClick={() => setShare((s) => !s)} className="shrink-0 rounded-md bg-primary px-3 py-1 text-sm text-white">내보내기</button>
  );

  if (mobile) {
    const NAV: [Panel | "doc", string, string][] = [["chat", "채팅", "💬"], ["doc", "문서", "📄"], ["review", "검토", "🔍"]];
    const inMore = mobilePane !== "doc" && !NAV.some((n) => n[0] === mobilePane);
    return (
      <div className="flex h-dvh flex-col bg-background">
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
          <Link href="/" aria-label="홈으로" className="rounded p-1.5 text-foreground-muted hover:bg-surface"><ArrowLeft className="h-5 w-5" /></Link>
          <NameInput p={p} className="min-w-0 flex-1" />
          {exportBtn}
        </header>
        {share && <ShareDialog p={p} onClose={() => setShare(false)} />}
        {mobilePane === "doc" ? (
          <>
            <div className="shrink-0 border-b border-border px-2 py-1.5">{tabs}</div>
            {doc}
          </>
        ) : (
          <section className="flex min-h-0 flex-1 flex-col">
            {mobilePane !== "chat" && (
              <div className="flex items-center justify-between border-b border-border px-4 py-2">
                <p className="text-sm font-medium">{panelName(mobilePane)}</p>
                {mobilePane === "review" && p.groups && !p.findings && <button onClick={() => review(p.id)} className="text-xs text-primary">검토 시작</button>}
              </div>
            )}
            <div className="min-h-0 flex-1">{panelBody(mobilePane)}</div>
          </section>
        )}
        <nav className="flex shrink-0 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
          {NAV.map(([k, label, icon]) => (
            <button key={k} onClick={() => { setMobilePane(k); setMore(false); }}
              className={`relative flex flex-1 flex-col items-center py-2 text-[11px] ${mobilePane === k ? "text-foreground" : "text-foreground-muted"}`}>
              <span className="text-base grayscale">{icon}</span>{label}
              {k === "review" && openFindings > 0 && <span className="absolute top-1.5 right-[35%] h-1.5 w-1.5 rounded-full bg-amber-500" />}
            </button>
          ))}
          <button onClick={() => setMore((m) => !m)}
            className={`relative flex flex-1 flex-col items-center py-2 text-[11px] ${inMore || more ? "text-foreground" : "text-foreground-muted"}`}>
            <span className="text-base">⋯</span>더보기
            {openComments > 0 && <span className="absolute top-1.5 right-[35%] h-1.5 w-1.5 rounded-full bg-primary" />}
          </button>
        </nav>
        {more && (
          <div className="fixed inset-0 z-40" onClick={() => setMore(false)}>
            <div className="absolute inset-0 bg-black/20" />
            <div className="animate-fade-up absolute inset-x-0 bottom-0 rounded-t-2xl bg-background p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] shadow-xl" onClick={(e) => e.stopPropagation()}>
              {RAIL.filter(([k]) => !["chat", "review"].includes(k)).map(([k, label, icon]) => (
                <button key={k} onClick={() => { setMobilePane(k); setMore(false); }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm hover:bg-surface">
                  <span className="grayscale">{icon}</span>{label}
                  {k === "comments" && openComments > 0 && <span className="ml-auto text-xs text-primary">{openComments}</span>}
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
        <Link href="/" className="mb-2 grid h-8 w-8 place-items-center rounded-md bg-primary text-white" title="홈으로"><Sparkle className="h-4 w-4" /></Link>
        {RAIL.map(([k, label, icon]) => (
          <button key={k} onClick={() => setPanel(panel === k ? null : k)}
            className={`relative flex w-12 flex-col items-center rounded-md py-1.5 text-[10px] ${panel === k ? "bg-border text-foreground" : "text-foreground-muted hover:bg-surface"}`}>
            <span className="text-sm grayscale">{icon}</span>{label}
            {k === "review" && openFindings > 0 && <span className="absolute top-1 right-2 h-1.5 w-1.5 rounded-full bg-amber-500" />}
            {k === "comments" && openComments > 0 && <span className="absolute top-1 right-2 h-1.5 w-1.5 rounded-full bg-primary" />}
          </button>
        ))}
      </nav>

      {panel && (
        <section className="flex w-[340px] shrink-0 flex-col border-r border-border bg-background">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <p className="text-sm font-medium">{panelName(panel)}</p>
            {panel === "review" && p.groups && !p.findings && <button onClick={() => review(p.id)} className="text-xs text-primary">검토 시작</button>}
          </div>
          <div className="min-h-0 flex-1">{panelBody(panel)}</div>
        </section>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 items-center gap-1 border-b border-border px-3">
          <button onClick={() => setPanel(panel ? null : "chat")} className="mr-1 rounded p-1 text-foreground-muted hover:bg-surface" title={panel ? "패널 접기" : "채팅 열기"}><Chat className="h-4 w-4" /></button>
          <NameInput p={p} className="mr-3 w-56 shrink-0" />
          {tabs}
          <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            <span className="hidden text-[11px] text-foreground-assistive lg:inline">자동 저장됨</span>
            {exportBtn}
            <button onClick={() => setPanel("settings")} aria-label="설정 열기" className="rounded p-1 text-foreground-muted hover:bg-surface"><Gear className="h-4 w-4" /></button>
          </div>
        </header>
        {share && <ShareDialog p={p} onClose={() => setShare(false)} />}
        {doc}
      </div>
    </div>
  );
}
