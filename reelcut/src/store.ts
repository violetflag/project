// App state: one module-level store, components re-render through useStore().
import { useEffect, useReducer } from "preact/hooks";
import { api, onJob, type AppInfo, type CcStatus, type ModelInfo, type QwenStatus } from "./api";
import { draftDuration, newDraft, uid } from "./edit";
import type { Asset, Draft, JobEvent, Project, Settings } from "./types";

export type Meta = { id: string; name: string; updated: number; created: number; assets: number; drafts: number; duration: number; poster?: string };
export type ExportJob = { id: string; draft: string; pct: number; state: string; message: string; out: string; result?: any; left?: number };

export const DEFAULT_SETTINGS: Settings = {
  aiMode: "account", apiKey: "", model: "claude-opus-5-5", effort: "high", engine: "whisper", whisperModel: "turbo", lang: "ko", exportDir: "", autoProxy: true, autoTranscribe: true,
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
  qwenSetup: { pct: number; state: string; message: string } | null;
  downloads: Record<string, { pct: number; state: string; message: string }>;
  exportJob: ExportJob | null;
  toast: string;
  agentBusy: boolean;
  agentStatus: string;
  rightTab: "inspect" | "agent";
  leftTab: "media" | "transcript";
};

export const st: S = {
  route: "home", projects: [], project: null, draftId: null, sourceId: null, folder: "", playhead: 0, selClip: null,
  settings: { ...DEFAULT_SETTINGS }, info: null, models: [], qwen: null, cc: null, qwenSetup: null, downloads: {}, exportJob: null, toast: "",
  agentBusy: false, agentStatus: "", rightTab: "inspect", leftTab: "media",
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
  const clean: Project = { ...p, assets: p.assets.map((a) => ({ ...a, proxyState: a.proxyState === "running" ? "idle" : a.proxyState, tState: a.tState === "running" ? "idle" : a.tState })) };
  await api.storeSet("project-" + p.id, JSON.stringify(clean));
  const meta = metaOf(p);
  set({ projects: [meta, ...st.projects.filter((m) => m.id !== p.id)].sort((a, b) => b.updated - a.updated) });
}

function metaOf(p: Project): Meta {
  return {
    id: p.id, name: p.name, updated: p.updated, created: p.created, assets: p.assets.length, drafts: p.drafts.length,
    duration: p.drafts[0] ? draftDuration(p.drafts[0]) : 0, poster: p.assets.find((a) => a.poster)?.poster,
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

export async function createProject(name: string): Promise<Project> {
  const now = Date.now();
  const d = newDraft("첫 편집본");
  const p: Project = { id: uid(), name: name || "새 프로젝트", created: now, updated: now, assets: [], folders: [], drafts: [d], chat: [] };
  set({ project: p, draftId: d.id, route: "project", sourceId: null, playhead: 0, selClip: null, folder: "" });
  undoStack.length = 0; redoStack.length = 0;
  await saveNow();
  return p;
}

export async function openProject(id: string) {
  const raw = await api.storeGet("project-" + id);
  if (!raw) return toast("프로젝트를 찾을 수 없습니다");
  const p: Project = JSON.parse(raw);
  p.chat ??= []; p.folders ??= [];
  if (!p.drafts.length) p.drafts.push(newDraft("첫 편집본"));
  undoStack.length = 0; redoStack.length = 0;
  set({ project: p, draftId: p.drafts[0].id, route: "project", sourceId: null, playhead: 0, selClip: null, folder: "" });
  // Resume work that was cut off when the app closed.
  for (const a of p.assets) {
    if (st.settings.autoProxy && !a.proxy && a.info.kind !== "image") startProxy(a.id);
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

/** Replaces the current draft and records an undo step. */
export function editDraft(label: string, fn: (d: Draft) => Draft, id = st.draftId) {
  const p = st.project;
  const d = p?.drafts.find((x) => x.id === id);
  if (!p || !d) return;
  const nd = fn(d);
  if (nd === d) return;
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
  // An .lrf/.lrv next to an .osv/.mp4 of the same name is its low-res copy; it's used for the
  // preview, not listed as its own clip.
  const stems = new Set(list.map(([p]) => p.replace(/\.[^.\\/]+$/, "").toLowerCase()).filter((_, i) => !/\.(lrf|lrv)$/i.test(list[i][0])));
  const added: Asset[] = [];
  let skipped = 0;
  for (const [path, rel] of list) {
    if (have.has(path)) { skipped++; continue; }
    if (/\.(lrf|lrv)$/i.test(path) && stems.has(path.replace(/\.[^.\\/]+$/, "").toLowerCase())) continue;
    try {
      const info = await api.inspect(path);
      const f = [folder, rel].filter(Boolean).join("/");
      const a: Asset = { id: uid(), info, folder: f, proxyState: "idle", tState: "idle" };
      added.push(a);
      mutate((p) => ({ ...p, assets: [...p.assets, a], folders: f && !p.folders.includes(f) ? [...p.folders, f] : p.folders }));
      if (info.kind !== "audio") {
        api.poster(path, Math.min(1, info.duration / 3)).then((poster) => patchAsset(a.id, { poster })).catch(() => {});
      }
      if (st.settings.autoProxy && info.kind !== "image") startProxy(a.id);
      else if (st.settings.autoTranscribe && info.has_audio) startTranscribe(a.id);
    } catch (e) {
      toast(`가져오지 못했습니다: ${path.split(/[\\/]/).pop()} (${e})`);
    }
  }
  if (skipped) toast(`${skipped}개는 이미 프로젝트에 있습니다`);
  return added;
}

export async function startProxy(id: string) {
  const a = asset(id);
  if (!a || a.info.kind === "image") return;
  const lens = a.lens ?? { layout: a.info.layout360, swap: false, fov: 190 };
  patchAsset(id, { proxyState: "running", proxyPct: 0, proxyError: "" });
  try {
    const ready = await api.makeProxy(id, a.info, lens);
    if (ready) onProxyDone(id, ready);
  } catch (e) {
    patchAsset(id, { proxyState: "error", proxyError: String(e) });
  }
}

function onProxyDone(id: string, path: string) {
  patchAsset(id, { proxy: path, proxyState: "done", proxyPct: 100 });
  const a = asset(id);
  if (a && st.settings.autoTranscribe && a.info.has_audio && !a.words && a.tState !== "running") startTranscribe(id);
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
      case "proxy":
        if (e.state === "running") patchAsset(e.id, { proxyState: "running", proxyPct: e.pct });
        else if (e.state === "done") onProxyDone(e.id, e.result);
        else patchAsset(e.id, { proxyState: e.state, proxyError: e.message });
        break;
      case "transcribe":
        if (e.state === "running") patchAsset(e.id, { tState: "running", tPct: e.pct });
        else if (e.state === "done") {
          patchAsset(e.id, { tState: "done", tPct: 100, words: e.result.words, lang: e.result.lang });
          toast(`받아쓰기 완료: ${asset(e.id)?.info.name ?? ""}`);
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
      case "export":
        if (st.exportJob && st.exportJob.id === e.id) {
          set({ exportJob: { ...st.exportJob, pct: e.pct, state: e.state, message: e.message, result: e.result, left: e.state === "running" ? Number(e.message) : undefined } });
        }
        break;
    }
  });
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
