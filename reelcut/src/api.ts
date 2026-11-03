// Bridge to the Rust side. Outside Tauri (plain browser, for UI tests) a small mock answers instead.

import type { Hw, JobEvent, Lens, MediaInfo, Plan, View, Word } from "./types";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeImpl: Invoke;
let convert: (p: string) => string = (p) => p;
let listenImpl: (cb: (e: JobEvent) => void) => Promise<() => void>;

if (inTauri) {
  const core = await import("@tauri-apps/api/core");
  const ev = await import("@tauri-apps/api/event");
  invokeImpl = core.invoke as Invoke;
  convert = (p) => core.convertFileSrc(p);
  listenImpl = (cb) => ev.listen<JobEvent>("job", (e) => cb(e.payload));
} else {
  const m = await import("./mock");
  invokeImpl = m.invoke as Invoke;
  listenImpl = m.listen;
}

export const invoke = invokeImpl;
/** URL the webview can load for a local file. */
export const fileSrc = (p: string) => (p.startsWith("/mock/") || p.startsWith("data:") || p.startsWith("blob:") ? p : convert(p));
export const onJob = (cb: (e: JobEvent) => void) => listenImpl(cb);

export type AppInfo = {
  ffmpeg: string; ffmpegOk: boolean; ffmpegVersion: string; whisper: string; whisperOk: boolean;
  dataDir: string; cacheDir: string; hw: Hw; platform: string; videosDir: string;
};
export type ModelInfo = { id: string; label: string; file: string; size_mb: number; downloaded: boolean };

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  hwInfo: (force: boolean) => invoke<Hw>("hw_info", { force }),
  storeGet: (name: string) => invoke<string | null>("store_get", { name }),
  storeSet: (name: string, value: string) => invoke<void>("store_set", { name, value }),
  storeDelete: (name: string) => invoke<void>("store_delete", { name }),
  storeList: (prefix: string) => invoke<string[]>("store_list", { prefix }),
  expandPaths: (paths: string[]) => invoke<[string, string][]>("expand_paths", { paths }),
  inspect: (path: string) => invoke<MediaInfo>("inspect", { path }),
  makeProxy: (id: string, info: MediaInfo, lens: Lens) => invoke<string | null>("make_proxy", { id, info, lens }),
  filmstrip: (path: string, duration: number, count: number) => invoke<string>("filmstrip", { path, duration, count }),
  poster: (path: string, at: number) => invoke<string>("poster", { path, at }),
  waveform: (path: string) => invoke<number[]>("waveform", { path }),
  frames: (path: string, times: number[], width?: number, view?: View) => invoke<string[]>("frames", { req: { path, times, width: width ?? null, view: view ?? null } }),
  contactSheet: (path: string, start: number, every: number, cols: number, rows: number, tileW: number) =>
    invoke<string>("contact_sheet", { path, start, every, cols, rows, tileW }),
  whisperModels: () => invoke<ModelInfo[]>("whisper_models"),
  downloadModel: (id: string) => invoke<void>("download_model", { id }),
  transcribe: (id: string, path: string, model: string, lang: string) => invoke<void>("transcribe", { id, path, model, lang }),
  export: (id: string, plan: Plan) => invoke<string>("export", { id, plan }),
  cancel: (tag: string) => invoke<number>("cancel", { tag }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  initialFiles: () => invoke<string[]>("initial_files"),
  claude: (key: string, body: unknown, betas: string[] = []) => invoke<any>("claude", { key, body, betas }),
};

export async function pickFiles(folder = false): Promise<string[]> {
  if (!inTauri) return (window as any).__mockPick?.() ?? [];
  const d = await import("@tauri-apps/plugin-dialog");
  const r = await d.open({
    multiple: true,
    directory: folder,
    filters: folder ? undefined : [{ name: "미디어", extensions: ["mp4", "mov", "mkv", "avi", "m4v", "webm", "mxf", "osv", "lrf", "lrv", "insv", "360", "mts", "m2ts", "mp3", "wav", "m4a", "aac", "flac", "ogg", "aif", "aiff", "jpg", "jpeg", "png", "heic", "webp"] }],
  });
  return r == null ? [] : Array.isArray(r) ? r : [r];
}

export async function pickFolder(): Promise<string | null> {
  if (!inTauri) return null;
  const d = await import("@tauri-apps/plugin-dialog");
  const r = await d.open({ directory: true, multiple: false });
  return typeof r === "string" ? r : null;
}

export async function onFileDrop(cb: (paths: string[]) => void) {
  if (!inTauri) return () => {};
  const w = await import("@tauri-apps/api/webview");
  return w.getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") cb(e.payload.paths);
  });
}

export async function windowCmd(cmd: "minimize" | "toggleMaximize" | "close") {
  if (!inTauri) return;
  const w = await import("@tauri-apps/api/window");
  const win = w.getCurrentWindow();
  if (cmd === "minimize") await win.minimize();
  else if (cmd === "toggleMaximize") await win.toggleMaximize();
  else await win.close();
}

export type { Word };
