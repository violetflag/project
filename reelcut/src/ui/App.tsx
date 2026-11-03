import { useEffect } from "preact/hooks";
import { api, onFileDrop, windowCmd } from "../api";
import { createProject, importPaths, initJobs, loadProjects, loadSettings, refreshModels, refreshCc, refreshQwen, saveNow, set, st, useStore } from "../store";
import { Home } from "./Home";
import { ProjectView } from "./Project";
import { SettingsView } from "./Settings";

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  await initJobs();
  await loadSettings();
  await loadProjects();
  refreshModels();
  refreshQwen(false);
  refreshCc();
  api.appInfo().then((info) => set({ info })).catch(() => {});
  onFileDrop(async (paths) => {
    if (!st.project) await createProject(paths[0].split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ""));
    await importPaths(paths);
  });
  // Opened with files (double-click on an .osv / .lrf).
  const files = await api.initialFiles().catch(() => [] as string[]);
  if (files.length) {
    await createProject(files[0].split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ""));
    await importPaths(files);
  }
  window.addEventListener("beforeunload", () => { saveNow(); });
}

export function App() {
  const s = useStore();
  useEffect(() => { boot(); }, []);
  return (
    <div class="app">
      <header class="titlebar" data-tauri-drag-region>
        <div class="brand" data-tauri-drag-region>
          <span class="logo">◧</span> Reelcut
        </div>
        <nav>
          <button class={s.route === "home" ? "on" : ""} onClick={() => { saveNow(); set({ route: "home" }); loadProjects(); }}>홈</button>
          {s.project && <button class={s.route === "project" ? "on" : ""} onClick={() => set({ route: "project" })} title={s.project.name}>{s.project.name}</button>}
          <button class={s.route === "settings" ? "on" : ""} onClick={() => set({ route: "settings" })}>설정</button>
        </nav>
        <div class="spacer" data-tauri-drag-region />
        <div class="winbtns">
          <button aria-label="최소화" onClick={() => windowCmd("minimize")}>–</button>
          <button aria-label="최대화" onClick={() => windowCmd("toggleMaximize")}>▢</button>
          <button aria-label="닫기" class="close" onClick={async () => { await saveNow(); windowCmd("close"); }}>✕</button>
        </div>
      </header>
      <main>
        {s.route === "home" && <Home />}
        {s.route === "project" && s.project && <ProjectView />}
        {s.route === "settings" && <SettingsView />}
      </main>
      {s.toast && <div class="toast">{s.toast}</div>}
    </div>
  );
}
