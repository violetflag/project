// Bridge to the Rust side. Outside Tauri (plain browser, for UI tests) a small mock answers instead.

import type { BadShot, Hw, JobEvent, Lens, MediaInfo, MotionInfo, Plan, Stitch, View, Word } from "./types";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeImpl: Invoke;
let convert: (p: string) => string = (p) => p;
let listenImpl: (cb: (e: JobEvent) => void) => Promise<() => void>;
let listenAny: (name: string, cb: (p: any) => void) => Promise<() => void>;

if (inTauri) {
  const core = await import("@tauri-apps/api/core");
  const ev = await import("@tauri-apps/api/event");
  invokeImpl = core.invoke as Invoke;
  convert = (p) => core.convertFileSrc(p);
  listenImpl = (cb) => ev.listen<JobEvent>("job", (e) => cb(e.payload));
  listenAny = (name, cb) => ev.listen<any>(name, (e) => cb(e.payload));
} else {
  const m = await import("./mock");
  invokeImpl = m.invoke as Invoke;
  listenImpl = m.listen;
  listenAny = m.listenEvent;
}

export const invoke = invokeImpl;
/** URL the webview can load for a local file. */
export const fileSrc = (p: string) => (p.startsWith("/mock/") || p.startsWith("data:") || p.startsWith("blob:") ? p : convert(p));
export const onJob = (cb: (e: JobEvent) => void) => listenImpl(cb);
export const onEvent = (name: string, cb: (p: any) => void) => listenAny(name, cb);

export type AppInfo = {
  version: string;
  ffmpeg: string; ffmpegOk: boolean; ffmpegVersion: string; whisper: string; whisperOk: boolean;
  dataDir: string; cacheDir: string; hw: Hw; platform: string; videosDir: string;
};
export type QwenStatus = { env: boolean; package: boolean; models: boolean; ready: boolean; cuda: boolean; gpu: string; vram_gb: number; torch: string; error: string };
/** Claude Code on this PC (the "Claude 계정" connection). */
export type CcStatus = { found: boolean; path: string; version: string; logged_in: boolean; method: string; account: string; plan: string; error: string };
export type CcRun = { model: string; effort: string; system: string; prompt: string; session: string | null; tools: unknown };
export type ModelInfo = { id: string; label: string; file: string; size_mb: number; downloaded: boolean };

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  hwInfo: (force: boolean) => invoke<Hw>("hw_info", { force }),
  storeGet: (name: string) => invoke<string | null>("store_get", { name }),
  storeSet: (name: string, value: string) => invoke<void>("store_set", { name, value }),
  storeDelete: (name: string, by: "user" | "cleanup" = "user", reason = "") => invoke<void>("store_delete", { name, by, reason }),
  trashList: () => invoke<{ file: string; at: number; name?: string; drafts?: number; assets?: number }[]>("trash_list"),
  trashRestore: (file: string) => invoke<void>("trash_restore", { file }),
  logEvent: (kind: string, text: string) => invoke<void>("log_event", { kind, text }),
  storeList: (prefix: string) => invoke<string[]>("store_list", { prefix }),
  /** Append-only logs: "actions" (per project) and "chats" (raw AI conversation archive). */
  jsonlAppend: (kind: "actions" | "chats", name: string, lines: string[]) => invoke<void>("jsonl_append", { kind, name, lines }),
  jsonlTail: (kind: "actions" | "chats", name: string, max: number) => invoke<string[]>("jsonl_tail", { kind, name, max }),
  /** Integrated loudness (LUFS, ffmpeg ebur128) of a stretch of a file; i is -70 or lower for silence. */
  loudness: (path: string, start: number, dur: number) => invoke<{ i: number }>("loudness", { path, start, dur }),
  expandPaths: (paths: string[]) => invoke<[string, string][]>("expand_paths", { paths }),
  inspect: (path: string) => invoke<MediaInfo>("inspect", { path }),
  analyzeMotion: (id: string, info: MediaInfo, lens: Lens) => invoke<void>("analyze_motion", { id, info, lens }),
  /** A live preview stream ("stream") or still frame ("frame") of a file the WebView cannot play. */
  liveUrl: (req: { slot: string; info: MediaInfo; lens: Lens | null; t: number; kind: "stream" | "frame"; rate?: number }) => invoke<string>("live_url", { req }),
  liveStop: (slot: string) => invoke<boolean>("live_stop", { slot }),
  calibrate360: (info: MediaInfo, lens: Lens) => invoke<Stitch>("calibrate_360", { info, lens }),
  measure: (what: "loudness" | "beats" | "events" | "scenes", path: string, from: number, to: number, threshold = 0) => invoke<any>("measure", { req: { what, path, from, to, threshold } }),
  scriptFiles: (op: "list" | "read" | "write", path: string, text: string, roots: string[]) => invoke<any>("script_files", { req: { op, path, text, roots } }),
  dirExists: (path: string) => invoke<boolean>("dir_exists", { path }),
  scanGaze: (path: string, lens: Lens | null, from: number, to: number, step: number) => invoke<{ t: number; faces: { x: number; y: number; w: number; h: number; score: number; front: number }[] }[]>("scan_gaze", { req: { path, lens, from, to, step } }),
  findFaces: (path: string, lens: Lens, times: number[]) => invoke<{ t: number; faces: { x: number; y: number; w: number; h: number; score: number }[] }[]>("find_faces", { req: { path, lens, times } }),
  trackPeople: (path: string, lens: Lens, from: number, to: number, subjects: { name: string; seeds: [number, number, number][] }[]) =>
    invoke<{ name: string; tracked: number; marks: [number, number, number][] }[]>("track_people", { req: { path, lens, from, to, subjects } }),
  faceCheck: (path: string, lens: Lens, items: [number, View][], aspect = 16 / 9) => invoke<{ t: number; faces: number; edges: string[] }[]>("face_check", { req: { path, lens, items, aspect } }),
  scanShots: (id: string, info: MediaInfo, from?: number, to?: number) => invoke<BadShot[]>("scan_shots", { id, info, from: from ?? null, to: to ?? null }),
  syncAudio: (a: string, b: string) => invoke<{ offset: number; clear: number }>("sync_audio", { a, b }),
  autoColor: (path: string, start: number, end: number, lens?: Lens, view?: View) => invoke<{ exposure: number; contrast: number; temperature: number }>("auto_color", { req: { path, start, end, lens: lens ?? null, view: view ?? null } }),
  motionTrack: (path: string, lens: Lens) => invoke<{ fps: number; quats: string } | null>("motion_track", { path, lens }),
  motionInfo: (path: string) => invoke<MotionInfo | null>("motion_info", { path }),
  filmstrip: (path: string, duration: number, count: number) => invoke<string>("filmstrip", { path, duration, count }),
  poster: (path: string, at: number) => invoke<string>("poster", { path, at }),
  waveform: (path: string) => invoke<number[]>("waveform", { path }),
  frames: (path: string, times: number[], width?: number, view?: View, lens?: Lens, aspect?: number) => invoke<string[]>("frames", { req: { path, times, width: width ?? null, view: view ?? null, lens: lens ?? null, aspect: aspect ?? null } }),
  eqSheet: (path: string, lens: Lens, times: number[], width: number) => invoke<string[]>("eq_sheet", { req: { path, lens, times, width, grid: true } }),
  contactSheet: (path: string, start: number, every: number, cols: number, rows: number, tileW: number) =>
    invoke<string>("contact_sheet", { path, start, every, cols, rows, tileW }),
  whisperModels: () => invoke<ModelInfo[]>("whisper_models"),
  downloadModel: (id: string) => invoke<void>("download_model", { id }),
  transcribe: (id: string, path: string, model: string, lang: string, engine = "whisper") => invoke<void>("transcribe", { id, path, model, lang, engine }),
  qwenStatus: (deep: boolean) => invoke<QwenStatus>("qwen_status", { deep }),
  qwenSetup: () => invoke<void>("qwen_setup"),
  setDataDir: (path: string) => invoke<void>("set_data_dir", { path }),
  export: (id: string, plan: Plan) => invoke<string>("export", { id, plan }),
  saveSrt: (video: string, text: string) => invoke<string>("save_srt", { video, text }),
  cancel: (tag: string) => invoke<number>("cancel", { tag }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  initialFiles: () => invoke<string[]>("initial_files"),
  ccStatus: () => invoke<CcStatus>("cc_status"),
  ccLogin: () => invoke<void>("cc_login"),
  ccSetup: () => invoke<void>("cc_setup"),
  ccRun: (r: CcRun) => invoke<void>("cc_run", r),
  ccAnswer: (id: string, result: unknown) => invoke<boolean>("cc_answer", { id, result }),
  ccStop: () => invoke<boolean>("cc_stop"),
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

/** A colour lookup table (.cube) for the colour section. */
export async function pickLut(): Promise<string | null> {
  if (!inTauri) return null;
  const d = await import("@tauri-apps/plugin-dialog");
  const r = await d.open({ multiple: false, filters: [{ name: "LUT (.cube)", extensions: ["cube"] }] });
  return typeof r === "string" ? r : null;
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
