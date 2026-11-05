import { Bot, Gauge, Magnet, MousePointer2, MoveHorizontal, PanelLeftClose, PanelRightClose, Redo2, Scissors, SplitSquareHorizontal, Undo2 } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { canRedo, canUndo, redo, set, undo, undoLabel, useStore, type Tool } from "../store";
import { AgentPanel } from "./AgentPanel";
import { CaptionsPanel } from "./CaptionsPanel";
import { DraftTabs } from "./DraftTabs";
import { Inspector } from "./Inspector";
import { layout, setLayout, Splitter, togglePanel } from "./layout";
import { MediaBin } from "./MediaBin";
import { QuickBar } from "./QuickBar";
import { Timeline } from "./Timeline";
import { Transcript } from "./Transcript";
import { Viewer } from "./Viewer";

const TOOLS: { id: Tool; label: string; key: string; term: string; Icon: any }[] = [
  { id: "select", label: "선택", key: "V", term: "Selection", Icon: MousePointer2 },
  { id: "blade", label: "자르기", key: "C", term: "Razor", Icon: Scissors },
  { id: "roll", label: "편집점 굴리기", key: "N", term: "Rolling Edit", Icon: SplitSquareHorizontal },
  { id: "slip", label: "내용 밀기", key: "Y", term: "Slip", Icon: MoveHorizontal },
  { id: "rate", label: "길이로 속도 바꾸기", key: "R", term: "Rate Stretch", Icon: Gauge },
];

const DEFAULT_CHAT = 22;

const SIDE_TABS: { id: "transcript" | "captions" | "inspect"; label: string; title?: string }[] = [
  { id: "transcript", label: "대본" },
  { id: "captions", label: "자막" },
  { id: "inspect", label: "속성", title: "선택한 클립의 시점·변형·색·소리와 편집본 설정" },
];

function FoldButton({ label, side, onClick }: { label: string; side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? PanelLeftClose : PanelRightClose;
  return <button class="icon-btn fold" aria-label={`${label} 접기`} title={`${label} 접기`} onClick={onClick}><Icon size={15} /></button>;
}

/** A folded panel's button, in the preview's corner. */
function Unfold({ side, label, onClick }: { side: "left" | "right"; label: string; onClick: () => void }) {
  return <button class={`unfold ${side}`} onClick={onClick} title={`${label} 펼치기`}>{label}</button>;
}

function ChatPanel() {
  const l = layout();
  return (
    <aside class="p-chat" aria-label="AI 편집" style={{ width: `${l.chat}%` }}>
      <div class="panel-head"><b>AI 편집</b><span class="spacer" /><FoldButton label="AI 편집" side="left" onClick={() => togglePanel("chat")} /></div>
      <AgentPanel />
    </aside>
  );
}

function SourcePanel({ style }: { style?: Record<string, string> }) {
  return (
    <aside class="p-source" aria-label="미디어" style={style}>
      <div class="panel-head"><b>미디어</b><span class="spacer" /><FoldButton label="미디어" side="left" onClick={() => togglePanel("source")} /></div>
      <MediaBin />
    </aside>
  );
}

function SidePanel({ style }: { style?: Record<string, string> }) {
  const s = useStore();
  return (
    <aside class="p-side" aria-label="대본, 자막과 속성" style={style}>
      <div class="tabs" role="tablist">
        {SIDE_TABS.map((t) => (
          <button role="tab" aria-selected={s.sideTab === t.id} class={s.sideTab === t.id ? "on" : ""} title={t.title} onClick={() => set({ sideTab: t.id })}>{t.label}</button>
        ))}
        <FoldButton label="오른쪽 패널" side="right" onClick={() => togglePanel("side")} />
      </div>
      {s.sideTab === "transcript" ? <Transcript /> : s.sideTab === "captions" ? <CaptionsPanel /> : <Inspector />}
    </aside>
  );
}

function PreviewPanel({ children, style }: { children?: ComponentChildren; style?: Record<string, string> }) {
  return (
    <section class="p-preview" aria-label="미리보기" style={style}>
      <div class="preview-bar" role="toolbar" aria-label="빠른 작업"><QuickBar /></div>
      <div class="preview-body"><Viewer />{children}</div>
    </section>
  );
}

function TimelinePanel() {
  const s = useStore();
  return (
    <div class="p-timeline">
      <div class="tl-head">
        <DraftTabs />
        <div class="tl-head-tools" role="toolbar" aria-label="편집 도구">
          <div class="seg" role="radiogroup" aria-label="타임라인 도구">
            {TOOLS.map((t) => (
              <button role="radio" aria-checked={s.tool === t.id} class={`icon-btn ${s.tool === t.id ? "on" : ""}`} onClick={() => set({ tool: t.id })} title={`${t.label} (${t.key}) · ${t.term}`} aria-label={`${t.label} 도구`}>
                <t.Icon size={16} />
              </button>
            ))}
          </div>
          <button class={`icon-btn ${s.snap ? "on" : ""}`} aria-pressed={s.snap} onClick={() => set({ snap: !s.snap })} title="자석 붙이기 (Shift+S) · Snapping" aria-label="자석 붙이기"><Magnet size={16} /></button>
          <span class="sep" />
          <button class="icon-btn" disabled={!canUndo()} onClick={undo} title={undoLabel() ? `되돌리기: ${undoLabel()} (Ctrl+Z)` : "되돌리기 (Ctrl+Z)"} aria-label="되돌리기"><Undo2 size={16} /></button>
          <button class="icon-btn" disabled={!canRedo()} onClick={redo} title="다시 실행 (Ctrl+Y)" aria-label="다시 실행"><Redo2 size={16} /></button>
        </div>
      </div>
      <Timeline />
    </div>
  );
}

export function ProjectView() {
  useStore();
  const l = layout();
  const unfold = (
    <>
      {!l.sourceOpen && <Unfold side="left" label="미디어" onClick={() => togglePanel("source")} />}
      {!l.sideOpen && <Unfold side="right" label="대본" onClick={() => togglePanel("side")} />}
    </>
  );
  const chat = l.chatOpen
    ? <><ChatPanel /><Splitter axis="x" pct label="AI 편집 너비" value={l.chat} min={3} max={45} onChange={(v) => v < 5 ? setLayout({ chatOpen: false, chat: DEFAULT_CHAT }) : setLayout({ chat: v })} /></>
    : <div class="rail"><button class="icon-btn" aria-label="AI 편집 열기" title="AI 편집 열기" onClick={() => togglePanel("chat")}><Bot size={16} /></button></div>;

  if (l.view === "preview") {
    return <div class="project">{chat}<PreviewPanel /></div>;
  }
  if (l.view === "vertical") {
    // A tall picture gets a full-height column; the rest shares the middle.
    return (
      <div class="project">
        {chat}
        <div class="p-editor">
          <div class="p-upper" style={{ height: `${l.upper}%` }}>
            {l.sourceOpen && <SourcePanel style={{ width: `${l.vSource}%` }} />}
            {l.sourceOpen && l.sideOpen && <Splitter axis="x" pct label="미디어 너비" value={l.vSource} min={20} max={80} onChange={(v) => setLayout({ vSource: v })} />}
            {l.sideOpen && <SidePanel style={{ flex: "1 1 0" }} />}
          </div>
          <Splitter axis="y" pct label="타임라인 높이" value={l.upper} min={25} max={80} onChange={(v) => setLayout({ upper: v })} />
          <TimelinePanel />
        </div>
        <Splitter axis="x" pct invert label="미리보기 너비" value={l.vPreview} min={22} max={60} onChange={(v) => setLayout({ vPreview: v })} />
        <PreviewPanel style={{ flex: `0 0 ${l.vPreview}%` }}>{unfold}</PreviewPanel>
      </div>
    );
  }
  return (
    <div class="project">
      {chat}
      <div class="p-editor">
        <div class="p-upper" style={{ height: `${l.upper}%` }}>
          {l.sourceOpen && <SourcePanel style={{ width: `${l.source}%` }} />}
          {l.sourceOpen && <Splitter axis="x" pct label="미디어 너비" value={l.source} min={15} max={40} onChange={(v) => setLayout({ source: v })} />}
          <PreviewPanel>{unfold}</PreviewPanel>
          {l.sideOpen && <Splitter axis="x" pct invert label="오른쪽 패널 너비" value={l.side} min={15} max={45} onChange={(v) => setLayout({ side: v })} />}
          {l.sideOpen && <SidePanel style={{ width: `${l.side}%` }} />}
        </div>
        <Splitter axis="y" pct label="타임라인 높이" value={l.upper} min={25} max={80} onChange={(v) => setLayout({ upper: v })} />
        <TimelinePanel />
      </div>
    </div>
  );
}
