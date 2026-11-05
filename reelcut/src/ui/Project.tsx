import { Gauge, Magnet, MousePointer2, MoveHorizontal, PanelLeft, PanelRight, Redo2, Scissors, SplitSquareHorizontal, Undo2, Upload } from "lucide-preact";
import { draftDuration } from "../edit";
import { canRedo, canUndo, draft, redo, set, undo, undoLabel, useStore, type Tool } from "../store";
import { AgentPanel } from "./AgentPanel";
import { DraftTabs } from "./DraftTabs";
import { Inspector } from "./Inspector";
import { layout, setLayout, Splitter, togglePanel } from "./layout";
import { MediaBin } from "./MediaBin";
import { QuickBar } from "./QuickBar";
import { Timeline } from "./Timeline";
import { Transcript } from "./Transcript";
import { CaptionsPanel } from "./CaptionsPanel";
import { Viewer } from "./Viewer";

const TOOLS: { id: Tool; label: string; key: string; term: string; Icon: any }[] = [
  { id: "select", label: "선택", key: "V", term: "Selection", Icon: MousePointer2 },
  { id: "blade", label: "자르기", key: "C", term: "Razor", Icon: Scissors },
  { id: "roll", label: "편집점 굴리기", key: "N", term: "Rolling Edit", Icon: SplitSquareHorizontal },
  { id: "slip", label: "내용 밀기", key: "Y", term: "Slip", Icon: MoveHorizontal },
  { id: "rate", label: "길이로 속도 바꾸기", key: "R", term: "Rate Stretch", Icon: Gauge },
];

export function ProjectView() {
  const s = useStore();
  const d = draft();
  const l = layout();
  const cols = [l.leftOpen ? `${l.left}px` : "0px", l.leftOpen ? "5px" : "0px", "minmax(320px,1fr)", l.rightOpen ? "5px" : "0px", l.rightOpen ? `${l.right}px` : "0px"].join(" ");

  return (
    <div class="project" style={{ gridTemplateRows: `auto 1fr 5px ${l.timeline}px` }}>
      <div class="toolbar" role="toolbar" aria-label="편집 도구">
        <button class="icon-btn" aria-label="왼쪽 패널" aria-pressed={l.leftOpen} onClick={() => togglePanel("left")} title="왼쪽 패널 보이기/숨기기 (Ctrl+Alt+←)"><PanelLeft size={16} /></button>
        <span class="sep" />
        <div class="seg" role="radiogroup" aria-label="타임라인 도구">
          {TOOLS.map((t) => (
            <button role="radio" aria-checked={s.tool === t.id} class={`icon-btn ${s.tool === t.id ? "on" : ""}`} onClick={() => set({ tool: t.id })} title={`${t.label} 도구 (${t.key}) · ${t.term}`} aria-label={`${t.label} 도구`}>
              <t.Icon size={16} />
            </button>
          ))}
        </div>
        <button class={`icon-btn ${s.snap ? "on" : ""}`} aria-pressed={s.snap} onClick={() => set({ snap: !s.snap })} title="자석 붙이기 (Shift+S) · Snapping" aria-label="자석 붙이기"><Magnet size={16} /></button>
        <span class="sep" />
        <button class="icon-btn" disabled={!canUndo()} onClick={undo} title={undoLabel() ? `되돌리기: ${undoLabel()} (Ctrl+Z)` : "되돌리기 (Ctrl+Z)"} aria-label="되돌리기"><Undo2 size={16} /></button>
        <button class="icon-btn" disabled={!canRedo()} onClick={redo} title="다시 실행 (Ctrl+Y)" aria-label="다시 실행"><Redo2 size={16} /></button>
        <span class="sep" />
        <QuickBar />
        <span class="spacer" />
        {d && <span class="muted tc" title="편집본 길이">{d.name} · {Math.floor(draftDuration(d) / 60)}분 {Math.round(draftDuration(d) % 60)}초</span>}
        <button class="primary" disabled={!d?.clips.length} onClick={() => set({ dialog: "export" })} title="내보내기 (Ctrl+E)"><Upload size={15} aria-hidden="true" /> 내보내기</button>
        <span class="sep" />
        <button class="icon-btn" aria-label="오른쪽 패널" aria-pressed={l.rightOpen} onClick={() => togglePanel("right")} title="오른쪽 패널 보이기/숨기기 (Ctrl+Alt+→)"><PanelRight size={16} /></button>
      </div>
      <div class="workspace" style={{ gridTemplateColumns: cols }}>
        <aside class="left" aria-label="미디어와 대본" hidden={!l.leftOpen}>
          <div class="tabs" role="tablist">
            <button role="tab" aria-selected={s.leftTab === "media"} class={s.leftTab === "media" ? "on" : ""} onClick={() => set({ leftTab: "media" })}>미디어</button>
            <button role="tab" aria-selected={s.leftTab === "transcript"} class={s.leftTab === "transcript" ? "on" : ""} onClick={() => set({ leftTab: "transcript" })}>대본</button>
            <button role="tab" aria-selected={s.leftTab === "captions"} class={s.leftTab === "captions" ? "on" : ""} onClick={() => set({ leftTab: "captions" })}>자막</button>
          </div>
          {s.leftTab === "media" ? <MediaBin /> : s.leftTab === "captions" ? <CaptionsPanel /> : <Transcript />}
        </aside>
        {l.leftOpen ? <Splitter axis="x" label="왼쪽 패널 너비" value={l.left} min={200} max={760} onChange={(v) => setLayout({ left: v })} /> : <span />}
        <section class="center" aria-label="미리보기">
          <Viewer />
        </section>
        {l.rightOpen ? <Splitter axis="x" label="오른쪽 패널 너비" value={l.right} min={260} max={620} invert onChange={(v) => setLayout({ right: v })} /> : <span />}
        <aside class="right" aria-label="속성과 AI 편집" hidden={!l.rightOpen}>
          <div class="tabs" role="tablist">
            <button role="tab" aria-selected={s.rightTab === "inspect"} class={s.rightTab === "inspect" ? "on" : ""} onClick={() => set({ rightTab: "inspect" })} title="속성 · Inspector">속성</button>
            <button role="tab" aria-selected={s.rightTab === "agent"} class={s.rightTab === "agent" ? "on" : ""} onClick={() => set({ rightTab: "agent" })}>AI 편집{s.agentBusy ? " ●" : ""}</button>
          </div>
          {s.rightTab === "inspect" ? <Inspector /> : <AgentPanel />}
        </aside>
      </div>
      <Splitter axis="y" label="타임라인 높이" value={l.timeline} min={160} max={640} invert onChange={(v) => setLayout({ timeline: v })} />
      <div class="tl-area">
        <DraftTabs />
        <Timeline />
      </div>
    </div>
  );
}
