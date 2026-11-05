import { Film, Home as HomeIcon, Minus, Settings as Gear, Square, X } from "lucide-preact";
import { useEffect } from "preact/hooks";
import { api, beforeClose, onFileDrop, onOpenFiles, windowCmd } from "../api";
import { flush, flushArchive } from "../actionlog";
import { openPaths, startProjectFiles } from "../project";
import { BackupsDialog, SaveAsDialog } from "./ProjectDialogs";
import { handleKey } from "../commands";
import { initJobs, loadProjects, loadPrompts, loadSettings, loadSkills, refreshModels, refreshCc, refreshQwen, saveNow, set, st, useStore } from "../store";
import { ExportDialog } from "./ExportDialog";
import { Home, NewProjectDialog } from "./Home";
import { MenuBar } from "./MenuBar";
import { ProjectView } from "./Project";
import { SettingsView } from "./Settings";
import { ShortcutsDialog } from "./Shortcuts";
import { PasteAttrsDialog } from "./PasteAttrs";
import { applyKeymap } from "../commands";
import { StatusBar } from "./StatusBar";
import { applyWorkspace } from "./layout";
import { draft } from "../store";

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  await initJobs();
  await loadSettings();
  applyKeymap(st.settings.keys);
  await loadProjects();
  loadPrompts();
  loadSkills();
  refreshModels();
  refreshQwen(false);
  refreshCc();
  api.appInfo().then((info) => set({ info })).catch(() => {});
  // A .reelcut opens its project; videos are imported (into a new project when none is open).
  onFileDrop(openPaths);
  // Opened with files (double-click on a .reelcut, .osv or .lrf), or handed over by a second start.
  const files = await api.initialFiles().catch(() => [] as string[]);
  if (files.length) await openPaths(files);
  onOpenFiles(openPaths);
  // Every project gets its folder in Documents\Reelcut (once), and the hourly backup starts.
  void startProjectFiles();
  // Closing (X, Alt+F4, the taskbar) waits for the last save and log lines.
  beforeClose(async () => { flush(); flushArchive(); await saveNow(); });
  window.addEventListener("beforeunload", () => { saveNow(); });
  window.addEventListener("keydown", (e) => { if (!st.dialog || e.key === "Escape") handleKey(e); });
}

const WS: { id: "edit" | "transcript" | "r360"; label: string; key: string }[] = [
  { id: "edit", label: "편집", key: "Alt+1" },
  { id: "transcript", label: "대본", key: "Alt+2" },
  { id: "r360", label: "360", key: "Alt+3" },
];

export function App() {
  const s = useStore();
  useEffect(() => { boot(); }, []);
  const d = s.route === "project" ? draft() : null;
  return (
    <div class="app">
      <header class="titlebar" data-tauri-drag-region>
        <div class="brand" data-tauri-drag-region>
          <Film size={16} class="logo" aria-hidden="true" /> Reelcut
        </div>
        <MenuBar />
        <nav class="routes" aria-label="화면">
          <button class={s.route === "home" ? "on" : ""} onClick={() => { saveNow(); set({ route: "home" }); loadProjects(); }} title="홈 (프로젝트 목록)"><HomeIcon size={14} aria-hidden="true" /> 홈</button>
          {s.project && <button class={`proj ${s.route === "project" ? "on" : ""}`} onClick={() => set({ route: "project" })} title={s.project.name}>{s.project.name}</button>}
        </nav>
        {s.route === "project" && s.project && (
          <div class="pages" role="tablist" aria-label="작업 화면">
            {WS.map((w) => (
              <button role="tab" aria-selected={s.workspace === w.id} class={s.workspace === w.id ? "on" : ""} onClick={() => applyWorkspace(w.id)} title={`${w.label} 화면 (${w.key})`}>{w.label}</button>
            ))}
            <button role="tab" aria-selected={false} disabled={!d?.clips.length} onClick={() => set({ dialog: "export" })} title="내보내기 (Ctrl+E)">내보내기</button>
          </div>
        )}
        <div class="spacer" data-tauri-drag-region />
        <button class={`icon-btn ${s.route === "settings" ? "on" : ""}`} onClick={() => set({ route: "settings" })} aria-label="설정" title="설정 (Ctrl+,)"><Gear size={16} /></button>
        <div class="winbtns">
          <button aria-label="최소화" onClick={() => windowCmd("minimize")}><Minus size={14} /></button>
          <button aria-label="최대화" onClick={() => windowCmd("toggleMaximize")}><Square size={12} /></button>
          <button aria-label="닫기" class="close" onClick={async () => { await saveNow(); windowCmd("close"); }}><X size={15} /></button>
        </div>
      </header>
      <main>
        {s.route === "home" && <Home />}
        {s.route === "project" && s.project && <ProjectView />}
        {s.route === "settings" && <SettingsView />}
      </main>
      <StatusBar />
      {s.dialog === "shortcuts" && <ShortcutsDialog onClose={() => set({ dialog: "" })} />}
      {s.dialog === "pasteAttrs" && <PasteAttrsDialog onClose={() => set({ dialog: "" })} />}
      {s.dialog === "newProject" && <NewProjectDialog onClose={() => set({ dialog: "" })} />}
      {s.dialog === "saveAs" && s.project && <SaveAsDialog onClose={() => set({ dialog: "" })} />}
      {s.dialog === "backups" && s.project && <BackupsDialog onClose={() => set({ dialog: "" })} />}
      {s.dialog === "export" && d && <ExportDialog draft={d} onClose={() => set({ dialog: "" })} />}
      {s.toast && <div class="toast" role="status">{s.toast}</div>}
    </div>
  );
}
