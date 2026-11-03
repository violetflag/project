// App state: one module-level store, components re-render through useStore().
import { useEffect, useReducer } from "preact/hooks";
import { api, onJob, type AppInfo, type CcStatus, type ModelInfo, type QwenStatus } from "./api";
import { CTX_DEFAULTS, migrateChats, newSession, promptName } from "./chats";
export { promptName };
import { draftDuration, newDraft, refineWords, rippleConnected, uid } from "./edit";
import type { Asset, ChatSession, Draft, JobEvent, Lens, Project, SavedPrompt, Settings, Word } from "./types";

export type Meta = { id: string; name: string; updated: number; created: number; assets: number; drafts: number; duration: number; poster?: string; clips: number };
export type ExportJob = { id: string; draft: string; pct: number; state: string; message: string; out: string; result?: any; left?: number; name?: string };
/** Timeline tools: select (V), blade (C), roll (R), slip (Y). */
export type Tool = "select" | "blade" | "roll" | "slip";
/** Panel arrangement: the editing page, the transcript page, the 360 page. */
export type Workspace = "edit" | "transcript" | "r360";
/** One AI request: the drafts before it, so its changes can be listed and undone as one. */
export type AiRun = { id: string; chat: string; at: number; prompt: string; before: Draft[]; after?: Draft[]; draftId: string | null; done: boolean; undone?: boolean };

export const DEFAULT_SETTINGS: Settings = {
  aiMode: "account", apiKey: "", model: "claude-opus-5-5", effort: "high", engine: "whisper", whisperModel: "turbo", lang: "ko", exportDir: "", autoTranscribe: true,
  ...CTX_DEFAULTS,
};

type S = {
  route: "home" | "project" | "settings";
  projects: Meta[];
  project: Project | null;
  draftId: string | null;
  /** Asset shown in the source viewer (null = the draft). */
  sourceId: string | null;
  folder: string;
  playhead: number;
  selClip: string | null;
  settings: Settings;
  info: AppInfo | null;
  models: ModelInfo[];
  qwen: QwenStatus | null;
  cc: CcStatus | null;
  /** Connecting the Claude account: download progress / waiting for the browser sign-in. */
  ccConnect: { pct: number; state: string; message: string } | null;
  qwenSetup: { pct: number; state: string; message: string } | null;
  downloads: Record<string, { pct: number; state: string; message: string }>;
  exportJob: ExportJob | null;
  toast: string;
  agentBusy: boolean;
  agentStatus: string;
  rightTab: "inspect" | "agent";
  leftTab: "media" | "transcript";
  /** Selected item on V2/V3 or A1–A3. */
  selItem: string | null;
  tool: Tool;
  snap: boolean;
  workspace: Workspace;
  /** Words selected in the transcript, as timeline ranges (shown on the timeline). */
  trRanges: [number, number][];
  exportQueue: { draftId: string; choice: any }[];
  aiRuns: AiRun[];
  savedAt: number;
  dialog: "" | "shortcuts" | "export" | "newProject";
  showSafe: boolean;
  /** Timeline shows where silence removal would cut. */
  showSilence: boolean;
  /** 360 motion analysis running, by asset id: percent. */
  motion: Record<string, number>;
  /** AI requests saved for reuse (all projects). */
  prompts: SavedPrompt[];
};

export const st: S = {
  route: "home", projects: [], project: null, draftId: null, sourceId: null, folder: "", playhead: 0, selClip: null,
  settings: { ...DEFAULT_SETTINGS }, info: null, models: [], qwen: null, cc: null, ccConnect: null, qwenSetup: null, downloads: {}, exportJob: null, toast: "",
  agentBusy: false, agentStatus: "", rightTab: "inspect", leftTab: "media",
  selItem: null, tool: "select", snap: true, workspace: "edit", trRanges: [], exportQueue: [], aiRuns: [], savedAt: 0, dialog: "", showSafe: false, showSilence: false, motion: {}, prompts: [],
};

const subs = new Set<() => void>();
export function set(p: Partial<S>) {
  Object.assign(st, p);
  subs.forEach((f) => f());
}
export function useStore() {
  const [, force] = useReducer((x: number, _: void) => x + 1, 0);
  useEffect(() => {
    const f = () => force();
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);
  return st;
}

let toastT: any;
export function toast(m: string) {
  set({ toast: m });
  clearTimeout(toastT);
  toastT = setTimeout(() => set({ toast: "" }), 3200);
}

export const waves = new Map<string, Uint8Array>();
export const assetMap = () => new Map((st.project?.assets ?? []).map((a) => [a.id, a]));
export const draft = (): Draft | null => st.project?.drafts.find((d) => d.id === st.draftId) ?? null;
export const asset = (id: string | null | undefined) => (id ? st.project?.assets.find((a) => a.id === id) ?? null : null);

// ---------------------------------------------------------------- persistence

let saveT: any;
function scheduleSave() {
  clearTimeout(saveT);
  saveT = setTimeout(saveNow, 400);
}
export async function saveNow() {
  clearTimeout(saveT);
  const p = st.project;
  if (!p) return;
  const clean: Project = { ...p, assets: p.assets.map((a) => ({ ...a, stitching: false, tState: a.tState === "running" ? "idle" : a.tState })) };
  await api.storeSet("project-" + p.id, JSON.stringify(clean));
  const meta = metaOf(p);
  set({ projects: [meta, ...st.projects.filter((m) => m.id !== p.id)].sort((a, b) => b.updated - a.updated), savedAt: Date.now() });
}

function metaOf(p: Project): Meta {
  return {
    id: p.id, name: p.name, updated: p.updated, created: p.created, assets: p.assets.length, drafts: p.drafts.length,
    duration: p.drafts[0] ? draftDuration(p.drafts[0]) : 0, poster: p.assets.find((a) => a.poster)?.poster,
    clips: p.drafts.reduce((n, d) => n + d.clips.length, 0),
  };
}

export async function loadSettings() {
  try {
    const s = await api.storeGet("settings");
    if (s) set({ settings: { ...DEFAULT_SETTINGS, ...JSON.parse(s) } });
  } catch { /* defaults */ }
}
export async function saveSettings(p: Partial<Settings>) {
  set({ settings: { ...st.settings, ...p } });
  await api.storeSet("settings", JSON.stringify(st.settings));
}

export async function loadProjects() {
  const names = await api.storeList("project-");
  const metas: Meta[] = [];
  for (const n of names) {
    try { const raw = await api.storeGet(n); if (raw) metas.push(metaOf(JSON.parse(raw))); } catch { /* skip broken */ }
  }
  metas.sort((a, b) => b.updated - a.updated);
  set({ projects: metas });
}

export async function createProject(name: string, aspect = "16:9", fps = 30): Promise<Project> {
  const now = Date.now();
  const d = newDraft("첫 편집본", aspect, fps);
  const c = newSession();
  const p: Project = { id: uid(), name: name || "새 프로젝트", created: now, updated: now, assets: [], folders: [], drafts: [d], chats: [c], activeChat: c.id };
  set({ project: p, draftId: d.id, route: "project", sourceId: null, playhead: 0, selClip: null, selItem: null, folder: "", aiRuns: [] });
  undoStack.length = 0; redoStack.length = 0;
  await saveNow();
  return p;
}

export async function openProject(id: string) {
  const raw = await api.storeGet("project-" + id);
  if (!raw) return toast("프로젝트를 찾을 수 없습니다");
  const p: Project = migrateChats(JSON.parse(raw));
  p.folders ??= [];
  // Projects from before 2.5.0 carry preview-copy (proxy) fields; the preview plays the files now.
  p.assets = p.assets.map(({ proxy: _p, proxyState: _s, proxyPct: _c, proxyError: _e, proxyStage: _g, ...a }: any) => a);
  if (!p.drafts.length) p.drafts.push(newDraft("첫 편집본"));
  undoStack.length = 0; redoStack.length = 0;
  set({ project: p, draftId: p.drafts[0].id, route: "project", sourceId: null, playhead: 0, selClip: null, selItem: null, folder: "", aiRuns: [] });
  // Resume work that was cut off when the app closed.
  for (const a of p.assets) {
    prepare360(a.id);
    if (st.settings.autoTranscribe && a.info.has_audio && !a.words && (a.tState === "idle" || a.tState === "running")) startTranscribe(a.id);
    // Transcripts made before word-time repair existed.
    if (a.words?.length && !a.refined) refineAsset(a.id);
  }
}

export async function deleteProject(id: string) {
  await api.storeDelete("project-" + id);
  set({ projects: st.projects.filter((m) => m.id !== id) });
}

export async function renameProject(id: string, name: string) {
  if (st.project?.id === id) { mutate((p) => ({ ...p, name })); return; }
  const raw = await api.storeGet("project-" + id);
  if (!raw) return;
  const p: Project = { ...JSON.parse(raw), name, updated: Date.now() };
  await api.storeSet("project-" + id, JSON.stringify(p));
  await loadProjects();
}

/** The AI conversation open in the panel. */
export const activeChat = (): ChatSession | null => st.project?.chats?.find((c) => c.id === st.project?.activeChat) ?? st.project?.chats?.[0] ?? null;

/** Changes one conversation (the open one by default). */
export function mutateChat(fn: (c: ChatSession) => ChatSession, id = activeChat()?.id) {
  if (!id) return;
  mutate((p) => ({ ...p, chats: (p.chats ?? []).map((c) => (c.id === id ? fn(c) : c)) }));
}

/** Changes the open project (no undo entry). */
export function mutate(fn: (p: Project) => Project) {
  if (!st.project) return;
  set({ project: { ...fn(st.project), updated: Date.now() } });
  scheduleSave();
}
export function patchAsset(id: string, patch: Partial<Asset>) {
  mutate((p) => ({ ...p, assets: p.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
}

// ---------------------------------------------------------------- drafts + undo

type Snap = { drafts: Draft[]; draftId: string | null; label: string };
const undoStack: Snap[] = [];
const redoStack: Snap[] = [];
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export const undoLabel = () => undoStack[undoStack.length - 1]?.label ?? "";

export function checkpoint(label: string) {
  if (!st.project) return;
  undoStack.push({ drafts: st.project.drafts, draftId: st.draftId, label });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

/**
 * Replaces the current draft and records an undo step. When the main track changes, clips on
 * V2/V3, A1 and A3 move with the picture they sit over (ripple).
 */
export function editDraft(label: string, fn: (d: Draft) => Draft, id = st.draftId, ripple = true) {
  const p = st.project;
  const d = p?.drafts.find((x) => x.id === id);
  if (!p || !d) return;
  let nd = fn(d);
  if (nd === d) return;
  if (ripple) nd = rippleConnected(d, nd);
  checkpoint(label);
  mutate((p) => ({ ...p, drafts: p.drafts.map((x) => (x.id === id ? { ...nd, updated: Date.now() } : x)) }));
}

export function setDrafts(label: string, drafts: Draft[], draftId = st.draftId) {
  checkpoint(label);
  mutate((p) => ({ ...p, drafts }));
  set({ draftId });
}

export function undo() {
  const s = undoStack.pop();
  if (!s || !st.project) return;
  redoStack.push({ drafts: st.project.drafts, draftId: st.draftId, label: s.label });
  mutate((p) => ({ ...p, drafts: s.drafts }));
  set({ draftId: s.drafts.some((d) => d.id === s.draftId) ? s.draftId : s.drafts[0]?.id ?? null });
  toast(`되돌림: ${s.label}`);
}
export function redo() {
  const s = redoStack.pop();
  if (!s || !st.project) return;
  undoStack.push({ drafts: st.project.drafts, draftId: st.draftId, label: s.label });
  mutate((p) => ({ ...p, drafts: s.drafts }));
  set({ draftId: s.drafts.some((d) => d.id === s.draftId) ? s.draftId : s.drafts[0]?.id ?? null });
  toast(`다시 실행: ${s.label}`);
}

// ---------------------------------------------------------------- import + background work

export async function importPaths(paths: string[], folder = st.folder): Promise<Asset[]> {
  if (!st.project || !paths.length) return [];
  const list = await api.expandPaths(paths);
  const have = new Set(st.project.assets.map((a) => a.info.path));
  // An .lrf/.lrv next to an .osv/.mp4 of the same name is its low-res copy (used for thumbnails),
  // not listed as its own clip.
  const stems = new Set(list.map(([p]) => p.replace(/\.[^.\\/]+$/, "").toLowerCase()).filter((_, i) => !/\.(lrf|lrv)$/i.test(list[i][0])));
  const added: Asset[] = [];
  let skipped = 0;
  for (const [path, rel] of list) {
    if (have.has(path)) { skipped++; continue; }
    if (/\.(lrf|lrv)$/i.test(path) && stems.has(path.replace(/\.[^.\\/]+$/, "").toLowerCase())) continue;
    try {
      const info = await api.inspect(path);
      const f = [folder, rel].filter(Boolean).join("/");
      const a: Asset = { id: uid(), info, folder: f, tState: "idle", added: Date.now() };
      added.push(a);
      mutate((p) => ({ ...p, assets: [...p.assets, a], folders: f && !p.folders.includes(f) ? [...p.folders, f] : p.folders }));
      if (info.kind !== "audio") {
        api.poster(path, Math.min(1, info.duration / 3)).then((poster) => patchAsset(a.id, { poster })).catch(() => {});
      }
      // Nothing to wait for: the preview plays the file, transcription starts now.
      prepare360(a.id);
      if (st.settings.autoTranscribe && info.has_audio) startTranscribe(a.id);
    } catch (e) {
      toast(`가져오지 못했습니다: ${path.split(/[\\/]/).pop()} (${e})`);
    }
  }
  if (skipped) toast(`${skipped}개는 이미 프로젝트에 있습니다`);
  return added;
}

/**
 * Two-lens 360: lines the lenses up and matches their brightness (automatic stitching) for the
 * export. Runs at import and again when the lens settings change; the preview does not wait for it.
 */
export async function prepare360(id: string) {
  const a = asset(id);
  if (!a || a.info.kind !== "video" || a.stitching) return;
  const lens: Lens = a.lens ?? { layout: a.info.layout360, swap: false, fov: 190 };
  if ((lens.layout !== "dual" && lens.layout !== "dfisheye") || lens.stitch?.on === false || lens.stitch?.calibrated) return;
  patchAsset(id, { stitching: true });
  try {
    const stitch = await api.calibrate360(a.info, lens);
    patchAsset(id, { lens: { ...(asset(id)?.lens ?? lens), stitch } });
  } catch (e) {
    toast(`이음새 자동 맞춤을 못 했습니다 (기본값으로 이어 붙입니다): ${e}`);
  }
  patchAsset(id, { stitching: false });
}

/** Works out how a 360 camera moved (for stabilisation at export), in the background. */
export async function analyzeMotion(id: string) {
  const a = asset(id);
  if (!a || id in st.motion) return;
  set({ motion: { ...st.motion, [id]: 0 } });
  try {
    await api.analyzeMotion(id, a.info, a.lens ?? { layout: a.info.layout360, swap: false, fov: 190 });
  } catch (e) {
    endMotion(id);
    toast(`흔들림 분석 실패: ${e}`);
  }
}
function endMotion(id: string) {
  const { [id]: _, ...rest } = st.motion;
  set({ motion: rest });
}

export async function startTranscribe(id: string) {
  const a = asset(id);
  if (!a || !a.info.has_audio) return;
  const qwen = st.settings.engine === "qwen";
  const m = st.models.find((x) => x.id === st.settings.whisperModel);
  if (!qwen && m && !m.downloaded) {
    patchAsset(id, { tState: "error", tError: "받아쓰기 모델이 없습니다. 설정에서 내려받아 주세요." });
    return;
  }
  if (qwen && st.qwen && !st.qwen.ready) {
    patchAsset(id, { tState: "error", tError: "Qwen 받아쓰기가 아직 설치되지 않았습니다. 설정에서 설치해 주세요." });
    return;
  }
  patchAsset(id, { tState: "running", tPct: 0, tError: "" });
  try {
    await api.transcribe(id, a.info.path, st.settings.whisperModel, st.settings.lang === "auto" ? "" : st.settings.lang, st.settings.engine);
  } catch (e) {
    patchAsset(id, { tState: "error", tError: String(e) });
  }
}

/** Resolves when a job for `id` of `kind` ends (for the agent). */
const waiters: { id: string; kind: string; res: (e: JobEvent) => void }[] = [];
export function waitJob(id: string, kind: string): Promise<JobEvent> {
  return new Promise((res) => waiters.push({ id, kind, res }));
}

export async function refreshModels() {
  try { set({ models: await api.whisperModels() }); } catch { /* none */ }
}
export async function refreshCc() {
  try { set({ cc: await api.ccStatus() }); } catch (e) { set({ cc: { found: false, path: "", version: "", logged_in: false, method: "", account: "", plan: "", error: String(e) } }); }
  return st.cc!;
}
/** "Claude 계정 연결": fetch Reelcut's own Claude Code if needed, open the sign-in, wait for it. */
export async function connectClaude() {
  if (st.ccConnect?.state === "running") return;
  try {
    let cc = st.cc ?? (await refreshCc());
    if (!cc.found) {
      set({ ccConnect: { pct: 0, state: "running", message: "Claude Code 내려받는 중" } });
      const w = waitJob("claude", "cc-setup");
      await api.ccSetup();
      const e = await w;
      if (e.state !== "done") throw new Error(e.message || "내려받기 실패");
      cc = await refreshCc();
    }
    set({ ccConnect: { pct: 100, state: "running", message: "브라우저에서 Claude 계정으로 승인해 주세요. 로그인 창이 따로 열립니다." } });
    await api.ccLogin();
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (st.ccConnect?.state !== "running") return;
      cc = await refreshCc();
      if (cc.logged_in) { set({ ccConnect: null }); toast("Claude 계정을 연결했습니다"); return; }
    }
    set({ ccConnect: { pct: 0, state: "error", message: "로그인을 기다리다 시간이 지났습니다. 다시 눌러 주세요." } });
  } catch (e) {
    set({ ccConnect: { pct: 0, state: "error", message: String((e as Error)?.message ?? e) } });
  }
}

export async function refreshQwen(deep = false) {
  try { set({ qwen: await api.qwenStatus(deep) }); } catch { /* none */ }
}

let lastPaint = 0;
export async function initJobs() {
  await onJob((e) => {
    if (e.state !== "running") {
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].id === e.id && waiters[i].kind === e.kind) { waiters[i].res(e); waiters.splice(i, 1); }
    }
    // Progress events come fast; repaint at most ~6 times a second.
    if (e.state === "running" && Date.now() - lastPaint < 160) return;
    lastPaint = Date.now();
    switch (e.kind) {
      case "motion":
        if (e.state === "running") { if (e.id in st.motion) set({ motion: { ...st.motion, [e.id]: e.pct } }); }
        else {
          endMotion(e.id);
          if (e.state === "done") toast(`흔들림 분석 완료: ${asset(e.id)?.info.name ?? ""}`);
          else if (e.state === "error") toast(`흔들림 분석 실패: ${e.message}`);
        }
        break;
      case "transcribe":
        if (e.state === "running") patchAsset(e.id, { tState: "running", tPct: e.pct });
        else if (e.state === "done") {
          const a = asset(e.id);
          const words: Word[] = e.result.words ?? [];
          patchAsset(e.id, { tState: "done", tPct: 100, words, lang: e.result.lang });
          toast(`받아쓰기 완료: ${a?.info.name ?? ""}`);
          if (a) refineAsset(a.id);
        } else patchAsset(e.id, { tState: e.state, tError: e.message });
        break;
      case "download":
        set({ downloads: { ...st.downloads, [e.id]: { pct: e.pct, state: e.state, message: e.message } } });
        if (e.state === "done") { refreshModels(); toast("모델을 내려받았습니다"); }
        if (e.state === "error") toast("모델 내려받기 실패: " + e.message);
        break;
      case "qwen-setup":
        set({ qwenSetup: { pct: e.pct, state: e.state, message: e.message } });
        if (e.state === "done") { refreshQwen(true); toast("Qwen 받아쓰기를 설치했습니다"); }
        if (e.state === "error") toast("Qwen 설치 실패: " + e.message.slice(0, 200));
        break;
      case "cc-setup":
        if (e.state === "running") set({ ccConnect: { pct: e.pct, state: "running", message: e.message } });
        break;
      case "export":
        if (st.exportJob && st.exportJob.id === e.id) {
          set({ exportJob: { ...st.exportJob, pct: e.pct, state: e.state, message: e.message, result: e.result, left: e.state === "running" ? Number(e.message) : undefined } });
          if (e.state !== "running") import("./exporter").then((m) => m.onExportEnd(e.state, st.exportJob?.name ?? "", e.result?.path ?? "", e.message));
        }
        break;
    }
  });
}

const stripBusy = new Set<string>();
/** A row of 30 frames across the whole media (timeline thumbnails), made once per file. */
export async function ensureStrip(a: Asset) {
  if (a.strip || a.info.kind !== "video" || stripBusy.has(a.id)) return;
  // An .osv's thumbnails come from its .lrf when there is one (both lenses, quick to read).
  const path = a.info.layout360 === "dual" && a.info.lrf ? a.info.lrf : a.info.path;
  stripBusy.add(a.id);
  try { patchAsset(a.id, { strip: await api.filmstrip(path, a.info.duration, 30) }); } catch { /* keep the poster */ }
  finally { stripBusy.delete(a.id); }
}

/** Fixes word times that recognition squeezed into pauses, and drops words made up in silence. */
export async function refineAsset(id: string) {
  const a = asset(id);
  if (!a?.words?.length || !a.info.has_audio) return;
  const w = await loadWave(a);
  const now = asset(id);
  if (!w || !now?.words) return;
  const fixed = refineWords(now.words, w, now.info.duration);
  patchAsset(id, { words: fixed, refined: true });
}

export async function loadWave(a: Asset): Promise<Uint8Array | null> {
  if (waves.has(a.id)) return waves.get(a.id)!;
  if (!a.info.has_audio) return null;
  try {
    const w = new Uint8Array(await api.waveform(a.info.path));
    waves.set(a.id, w);
    set({});
    return w;
  } catch { return null; }
}

// ---------------------------------------------------------------- saved AI prompts

export async function loadPrompts() {
  try {
    const raw = await api.storeGet("prompts");
    if (raw) set({ prompts: JSON.parse(raw) });
  } catch { /* none yet */ }
}
function savePrompts(prompts: SavedPrompt[]) {
  set({ prompts });
  api.storeSet("prompts", JSON.stringify(prompts)).catch((e) => toast(`프롬프트를 저장하지 못했습니다: ${e}`));
}
/** Keeps a request for reuse. */
export function addPrompt(text: string, name?: string): SavedPrompt | null {
  const t = text.trim();
  if (!t) return null;
  const now = Date.now();
  const p: SavedPrompt = { id: uid(), name: (name ?? "").trim() || promptName(t), text: t, created: now, updated: now };
  savePrompts([p, ...st.prompts]);
  return p;
}
export function updatePrompt(id: string, patch: Partial<Pick<SavedPrompt, "name" | "text">>) {
  savePrompts(st.prompts.map((p) => (p.id === id ? { ...p, ...patch, updated: Date.now() } : p)));
}
export function deletePrompt(id: string) {
  savePrompts(st.prompts.filter((p) => p.id !== id));
}
