import { useEffect, useState } from "preact/hooks";
import { draftDuration, fmtTC, newDraft, splitAt, deleteClip } from "../edit";
import { canRedo, canUndo, draft, editDraft, redo, set, setDrafts, st, undo, undoLabel, useStore } from "../store";
import { AgentPanel } from "./AgentPanel";
import { ExportDialog } from "./ExportDialog";
import { Inspector } from "./Inspector";
import { MediaBin } from "./MediaBin";
import { Timeline } from "./Timeline";
import { Transcript } from "./Transcript";
import { player, Viewer } from "./Viewer";

export function ProjectView() {
  const s = useStore();
  const p = s.project!;
  const d = draft();
  const [exporting, setExporting] = useState(false);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === "e") { e.preventDefault(); setExporting(true); return; }
      if (e.key === " ") { e.preventDefault(); player.toggle(); return; }
      if (e.key === "s" && !mod && !st.sourceId) { editDraft("자르기", (d) => splitAt(d, st.playhead)); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && st.selClip && !st.sourceId) {
        const id = st.selClip;
        set({ selClip: null });
        editDraft("클립 삭제", (d) => deleteClip(d, id));
        return;
      }
      if (e.key === "ArrowLeft") { e.preventDefault(); player.seek(st.playhead - (e.shiftKey ? 1 : 1 / 30)); }
      if (e.key === "ArrowRight") { e.preventDefault(); player.seek(st.playhead + (e.shiftKey ? 1 : 1 / 30)); }
      if (e.key === "Home") player.seek(0);
      if (e.key === "End" && d) player.seek(draftDuration(d));
      if (e.key === "m" && d && !st.sourceId) editDraft("마커", (d) => ({ ...d, markers: [...d.markers, { id: Math.random().toString(36).slice(2), t: st.playhead, label: `마커 ${d.markers.length + 1}`, color: "#FFB020" }] }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [d?.id]);

  return (
    <div class="project">
      <div class="toolbar">
        <select value={s.draftId ?? ""} onChange={(e) => set({ draftId: (e.target as HTMLSelectElement).value, sourceId: null, playhead: 0, selClip: null })}>
          {p.drafts.map((x) => <option value={x.id}>{x.name} · {fmtTC(draftDuration(x))}</option>)}
        </select>
        {renaming && d ? (
          <input autoFocus defaultValue={d.name} onKeyDown={(e) => { if (e.key === "Enter") { const v = (e.target as HTMLInputElement).value.trim(); if (v) editDraft("이름 바꾸기", (x) => ({ ...x, name: v })); setRenaming(false); } if (e.key === "Escape") setRenaming(false); }} onBlur={() => setRenaming(false)} />
        ) : (
          <button class="small" onClick={() => setRenaming(true)}>이름</button>
        )}
        <button class="small" onClick={() => { const nd = newDraft(`편집본 ${p.drafts.length + 1}`, d?.aspect); setDrafts("새 편집본", [...p.drafts, nd], nd.id); set({ playhead: 0, sourceId: null }); }}>＋ 새 편집본</button>
        <button class="small" disabled={!d} onClick={() => { if (!d) return; const c = { ...structuredClone(d), id: Math.random().toString(36).slice(2, 10), name: d.name + " 사본" }; setDrafts("편집본 복제", [...p.drafts, c], c.id); }}>복제</button>
        <button class="small" disabled={p.drafts.length < 2} onClick={() => { if (!d) return; const rest = p.drafts.filter((x) => x.id !== d.id); setDrafts(`편집본 삭제 "${d.name}"`, rest, rest[0].id); }}>삭제</button>
        <span class="sep" />
        <button class="small" disabled={!canUndo()} onClick={undo} title={undoLabel() ? `되돌리기: ${undoLabel()}` : "되돌리기"}>↶ 되돌리기</button>
        <button class="small" disabled={!canRedo()} onClick={redo}>↷ 다시</button>
        <span class="spacer" />
        <button class="primary" disabled={!d?.clips.length} onClick={() => setExporting(true)}>내보내기</button>
      </div>
      <div class="workspace">
        <aside class="left">
          <div class="tabs">
            <button class={s.leftTab === "media" ? "on" : ""} onClick={() => set({ leftTab: "media" })}>미디어</button>
            <button class={s.leftTab === "transcript" ? "on" : ""} onClick={() => set({ leftTab: "transcript" })}>대본</button>
          </div>
          {s.leftTab === "media" ? <MediaBin /> : <Transcript />}
        </aside>
        <section class="center">
          <Viewer />
        </section>
        <aside class="right">
          <div class="tabs">
            <button class={s.rightTab === "inspect" ? "on" : ""} onClick={() => set({ rightTab: "inspect" })}>속성</button>
            <button class={s.rightTab === "agent" ? "on" : ""} onClick={() => set({ rightTab: "agent" })}>AI 편집{s.agentBusy ? " ●" : ""}</button>
          </div>
          {s.rightTab === "inspect" ? <Inspector /> : <AgentPanel />}
        </aside>
      </div>
      <Timeline />
      {exporting && d && <ExportDialog draft={d} onClose={() => setExporting(false)} />}
    </div>
  );
}
