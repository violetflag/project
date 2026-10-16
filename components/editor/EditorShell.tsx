"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { review } from "@/lib/actions";
import { updateProject } from "@/lib/store";
import type { Project } from "@/lib/types";
import { BellIcon, Chat, Gear, Sparkle } from "../icons";
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

export function EditorShell({ p }: { p: Project }) {
  const [panel, setPanel] = useState<Panel | null>("chat");
  const [tab, setTab] = useState<Tab>("prd");
  const [share, setShare] = useState(false);
  const [name, setName] = useState(p.name);

  // Move to the feature spec once it first appears, like the guided flow.
  const hasGroups = !!p.groups;
  useEffect(() => { if (hasGroups) setTab((t) => (t === "prd" ? "features" : t)); }, [hasGroups]);

  // Shift+1..4 switches documents.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || (e.target as HTMLElement).closest("input,textarea")) return;
      const i = ["!", "@", "#", "$"].indexOf(e.key);
      if (i >= 0) setTab(TABS[i][0]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const goto = (t: string) => {
    if (t === "features") setTab("features");
    if (t === "review") setPanel("review");
  };
  const featureTitle = (id?: string) => p.groups?.flatMap((g) => g.features).find((f) => f.id === id)?.title;
  const ready: Record<Tab, boolean> = { prd: !!p.prd, features: !!p.groups, flow: !!p.flow, wire: !!p.screens };
  const openComments = p.comments.filter((c) => !c.resolved).length;
  const openFindings = p.findings?.filter((f) => f.state === "open").length ?? 0;

  return (
    <div className="flex h-screen bg-background">
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
        <div className="mt-auto flex flex-col items-center gap-2 text-foreground-muted">
          <BellIcon />
          <span className="grid h-6 w-6 place-items-center rounded-full bg-foreground-support text-[10px] text-white">J</span>
        </div>
      </nav>

      {panel && (
        <section className="flex w-[340px] shrink-0 flex-col border-r border-border bg-background">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <p className="text-sm font-medium">{RAIL.find((r) => r[0] === panel)?.[1]}</p>
            {panel === "review" && p.groups && !p.findings && <button onClick={() => review(p.id)} className="text-xs text-primary">검토 시작</button>}
          </div>
          <div className="min-h-0 flex-1">
            {panel === "chat" && <ChatPanel p={p} onGoto={goto} />}
            {panel === "review" && <ReviewPanel p={p} onChat={() => setPanel("chat")} />}
            {panel === "docs" && <DocsPanel p={p} />}
            {panel === "comments" && <CommentsPanel p={p} featureTitle={featureTitle} />}
            {panel === "versions" && <VersionsPanel p={p} />}
            {panel === "settings" && <SettingsPanel p={p} />}
          </div>
        </section>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 items-center gap-1 border-b border-border px-3">
          <button onClick={() => setPanel(panel ? null : "chat")} className="mr-1 rounded p-1 text-foreground-muted hover:bg-surface" title="패널 접기"><Chat className="h-4 w-4" /></button>
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => updateProject(p.id, (x) => ({ ...x, name: name.trim() || x.name }))}
            className="mr-3 w-56 truncate rounded px-1 text-sm font-medium outline-none hover:bg-surface focus:bg-surface" />
          {TABS.map(([k, l], i) => (
            <button key={k} onClick={() => setTab(k)} title={`Shift + ${i + 1}`}
              className={`flex items-center gap-1 rounded px-2.5 py-1 text-sm ${tab === k ? "bg-surface font-medium" : ready[k] ? "text-foreground-support hover:bg-surface" : "text-foreground-assistive"}`}>
              {ready[k] && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}{l}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-foreground-assistive">자동 저장됨</span>
            <button onClick={() => setShare((s) => !s)} className="rounded-md bg-primary px-3 py-1 text-sm text-white">공유</button>
            <Gear className="h-4 w-4 text-foreground-muted" />
          </div>
        </header>
        {share && <ShareDialog p={p} onClose={() => setShare(false)} />}
        <div className="min-h-0 flex-1 bg-background-canvas">
          {tab === "prd" && <PrdView p={p} />}
          {tab === "features" && <FeaturesView p={p} />}
          {tab === "flow" && <FlowView p={p} />}
          {tab === "wire" && <WireframeView p={p} />}
        </div>
      </div>
    </div>
  );
}
