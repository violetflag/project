import { Film, Home as HomeIcon, LayoutPanelTop, Minus, Settings as Gear, Square, Upload, X } from "lucide-preact";
import { useEffect } from "preact/hooks";
import { api, beforeClose, onFileDrop, onOpenFiles, windowCmd } from "../api";
import { flush, flushArchive } from "../actionlog";
import { queueOpen, startProjectFiles, takeHanded } from "../project";
import { BackupsDialog, RelinkDialog, SaveAsDialog } from "./ProjectDialogs";
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
import { layout, setView, type ViewMode } from "./layout";
import { draft } from "../store";

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  // First of all: files a later start hands over wait in the app until the window is ready below.
  onOpenFiles(() => { void takeHanded(); });
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
  // A .reelcut (or a project folder) opens its project; videos are imported (into a new project when none is open).
  onFileDrop((paths) => { void queueOpen(paths); });
  // Opened with files (double-click on a .reelcut, .osv or .lrf), then those later starts handed over meanwhile.
  const files = await api.initialFiles().catch(() => [] as string[]);
  if (files.length) await queueOpen(files);
  await takeHanded(true);
  // Every project gets its folder in Documents\Reelcut (once), and the hourly backup starts.
  void startProjectFiles();
  // Closing (X, Alt+F4, the taskbar) waits for the last save and log lines.
  beforeClose(async () => { flush(); flushArchive(); await saveNow(); });
  window.addEventListener("beforeunload", () => { saveNow(); });
  window.addEventListener("keydown", (e) => { if (!st.dialog || e.key === "Escape") handleKey(e); });
}

const VIEWS: { id: ViewMode; label: string; key: string }[] = [
  { id: "default", label: "기본", key: "Alt+1" },
  { id: "vertical", label: "세로 영상", key: "Alt+2" },
  { id: "preview", label: "미리보기만", key: "Alt+3" },
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
        <div class="spacer" data-tauri-drag-region />
        {s.route === "project" && s.project && (
          <label class="view-mode" title="화면 배치">
            <LayoutPanelTop size={15} aria-hidden="true" />
            <select aria-label="화면 배치" value={layout().view} onChange={(e) => setView((e.target as HTMLSelectElement).value as ViewMode)}>
              {VIEWS.map((v) => <option value={v.id}>{v.label}</option>)}
            </select>
          </label>
        )}
        <button class={`icon-btn ${s.route === "settings" ? "on" : ""}`} onClick={() => set({ route: "settings" })} aria-label="설정" title="설정 (Ctrl+,)"><Gear size={16} /></button>
        {s.route === "project" && s.project && (
          <button class="primary small export-btn" disabled={!d?.clips.length} onClick={() => set({ dialog: "export" })} title="내보내기 (Ctrl+E)"><Upload size={14} aria-hidden="true" /> 내보내기</button>
        )}
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
      {s.dialog === "relink" && s.project && <RelinkDialog onClose={() => set({ dialog: "" })} />}
      {s.dialog === "export" && d && <ExportDialog draft={d} onClose={() => set({ dialog: "" })} />}
      {s.toast && <div class="toast" role="status">{s.toast}</div>}
    </div>
  );
}
