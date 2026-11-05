// Every editor command in one list: the menu bar, the keyboard shortcuts and the shortcut list
// (Ctrl+/) all come from here, so a command is never reachable one way and missing another.
import { api, pickFiles, pickSave } from "./api";
import { draftCaptions } from "./captions";
import {
  clipAt, deleteClip, detachAudio, draftDuration, draftWords, is360, isGap, lensFor, trimClipTo, liftClip, nudgeClip, removeFillers, removeItem, removeSilences, setTransition, splitAt, splitItem, starts, uid, type Pacing,
} from "./edit";
import { asset, assetMap, canRedo, canUndo, draft, editDraft, importPaths, loadWave, redo, saveNow, set, st, toast, undo, waves, type Tool, type Workspace } from "./store";
import type { Clip } from "./types";
import { player } from "./ui/Viewer";
import { applyWorkspace, togglePanel } from "./ui/layout";
import { actionList, runAction } from "./actions";
import { backupNow, makeDiagBundle, openProjectDialog, packProject, revealProjectFolder } from "./project";
import "./quick";
import "./quick360";

export type Cmd = {
  id: string;
  label: string;
  menu: "파일" | "편집" | "클립" | "타임라인" | "재생" | "보기" | "도움말";
  /** Shown and matched, e.g. "Ctrl+Shift+Z". Several bindings: "Ctrl+Y|Ctrl+Shift+Z". */
  keys?: string;
  /** Industry term shown in the tooltip next to the plain name. */
  term?: string;
  run: () => void;
  enabled?: () => boolean;
  checked?: () => boolean;
  /** Works outside a project (home, settings). */
  global?: boolean;
  sep?: boolean;
};

const inProject = () => st.route === "project" && !!st.project;
const hasDraft = () => inProject() && !!draft();
const hasClips = () => !!draft()?.clips.length;
const draftMode = () => hasDraft() && !st.sourceId;
const selClip = () => (st.selClip ? draft()?.clips.find((c) => c.id === st.selClip) ?? null : null);

/** The clip "copy" last took its settings from. */
export let attrSource: Clip | null = null;

function toggleSelected() {
  const d = draft();
  if (!d) return;
  const id = st.selClip ?? st.selItem;
  const flip = <T extends { id: string; disabled?: boolean }>(x: T) => (x.id === id ? { ...x, disabled: !x.disabled } : x);
  editDraft("클립 켜기·끄기", (x) => ({ ...x, clips: x.clips.map(flip), overlays: (x.overlays ?? []).map(flip), music: x.music.map(flip) }), st.draftId, false);
  player.refresh();
}

/** Ripple trim at the playhead: Q the part before it goes (the playhead follows), W the part after. */
function trimToPlayhead(side: "start" | "end") {
  const d = draft();
  const hit = d?.clips.length ? clipAt(d, st.playhead) : null;
  if (!d || !hit || isGap(hit.clip)) return;
  const next = trimClipTo(d, hit.clip.id, side, hit.src);
  if (!next) return toast("재생 위치가 클립 끝에 너무 가까워 자를 수 없습니다");
  editDraft(side === "start" ? "앞부분 잘라 당기기" : "뒷부분 잘라 당기기", () => next);
  if (side === "start") player.seek(hit.at);
}

function jumpMarker(dir: 1 | -1) {
  const ts = (draft()?.markers ?? []).map((m) => m.t).sort((a, b) => a - b);
  const t = dir > 0 ? ts.find((x) => x > st.playhead + 1e-3) : [...ts].reverse().find((x) => x < st.playhead - 1e-3);
  if (t == null) return toast(ts.length ? `${dir > 0 ? "다음" : "이전"} 마커가 없습니다` : "마커가 없습니다");
  player.seek(t);
}

const stamp = (t: number) => {
  const s = Math.floor(t), p = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
};

/** 파일 > 현재 화면을 사진으로 저장: the frame itself, at the export's stitching for 360. */
async function saveStill() {
  const d = draft();
  const hit = !st.sourceId && d?.clips.length ? clipAt(d, st.playhead) : null;
  const a = st.sourceId ? asset(st.sourceId) : hit && !isGap(hit.clip) ? asset(hit.clip.asset) : null;
  if (!a) return toast("저장할 화면이 없습니다");
  const src = st.sourceId ? player.srcT : hit!.src;
  const dest = await pickSave(`${a.info.name.replace(/\.[^.]+$/, "")} ${stamp(src).replace(/:/g, "-")}.jpg`, "JPEG 사진", "jpg");
  if (!dest) return;
  try {
    const [w, h] = (d?.aspect ?? "16:9").split(":").map(Number);
    const r360 = is360(a);
    const lens = r360 ? (hit ? lensFor(hit.clip, a) : { ...(a.lens ?? { swap: false, fov: 190 }), layout: a.info.layout360 }) : undefined;
    const [b] = await api.frames(a.info.path, [src], 1920, r360 ? player.currentView() : undefined, lens, r360 ? (st.sourceId ? 16 / 9 : w / h || 16 / 9) : undefined);
    if (!b) throw new Error("그림이 없습니다");
    await api.saveBase64(dest, b);
    toast("사진을 저장했습니다. 자막과 글자는 들어가지 않습니다");
  } catch (e) { toast(`사진을 저장하지 못했습니다: ${String((e as Error)?.message ?? e)}`); }
}

/** 파일 > 대본 저장: the draft's spoken words, a line each with its time on the timeline. */
async function saveTranscript() {
  const d = draft();
  if (!d) return;
  const lines = draftCaptions(d, draftWords(d, assetMap())).lines.filter((l) => !l.hidden && l.text.trim());
  if (!lines.length) return toast("대본이 없습니다. 먼저 받아쓰기를 하세요");
  const dest = await pickSave(`${d.name} 대본.txt`, "텍스트", "txt");
  if (!dest) return;
  try {
    await api.saveText(dest, lines.map((l) => `[${stamp(l.t0)}] ${l.text.replace(/\s*\n\s*/g, " ")}`).join("\r\n") + "\r\n");
    toast(`대본 ${lines.length}줄을 저장했습니다`);
  } catch (e) { toast(`대본을 저장하지 못했습니다: ${String((e as Error)?.message ?? e)}`); }
}

let silencePad: number | null = null;
export const setSilencePad = (p: number | null) => { silencePad = p; };
export const getSilencePad = () => silencePad;

let pacing: Pacing = "normal";
export const setPacing = (p: Pacing) => { pacing = p; };
export const getPacing = () => pacing;

export async function doSilence() {
  const d = draft();
  if (!d) return;
  for (const c of d.clips) { const a = asset(c.asset); if (a && !a.words && a.info.has_audio && !waves.has(a.id)) await loadWave(a); }
  const r = removeSilences(d, assetMap(), waves, pacing, silencePad);
  if (!r.removed) return toast("잘라 낼 무음이 없습니다");
  editDraft("무음 정리", () => r.draft);
  toast(`무음 ${r.removed.toFixed(1)}초를 잘라 냈습니다`);
  player.refresh();
}
export function doFillers() {
  const d = draft();
  if (!d) return;
  const r = removeFillers(d, assetMap());
  if (!r.count) return toast(d.clips.some((c) => asset(c.asset)?.words) ? "군더더기 말이 없습니다" : "먼저 받아쓰기가 필요합니다");
  editDraft("군더더기 말 정리", () => r.draft);
  toast(`군더더기 말 ${r.count}개를 잘라 냈습니다`);
  player.refresh();
}

export function deleteSelection(ripple: boolean) {
  if (st.selItem) {
    const id = st.selItem;
    set({ selItem: null });
    editDraft("트랙 클립 삭제", (d) => removeItem(d, id), st.draftId, false);
    return;
  }
  if (!st.selClip) return;
  const id = st.selClip;
  set({ selClip: null });
  editDraft(ripple ? "클립 삭제" : "빈칸 남기고 삭제", (d) => (ripple ? deleteClip(d, id) : liftClip(d, id)));
  player.refresh();
}

export function splitHere() {
  if (st.selItem) { const id = st.selItem; editDraft("트랙 클립 자르기", (d) => splitItem(d, id, st.playhead), st.draftId, false); return; }
  editDraft("자르기", (d) => splitAt(d, st.playhead));
}

/** Next / previous edit point (clip boundaries and connected item edges). */
export function jumpEdit(dir: 1 | -1) {
  const d = draft();
  if (!d) return;
  const pts = new Set<number>([0, draftDuration(d)]);
  const ss = starts(d);
  d.clips.forEach((c, i) => { pts.add(ss[i]); pts.add(ss[i] + (c.end - c.start) / c.speed); });
  for (const o of d.overlays ?? []) { pts.add(o.at); pts.add(o.at + (o.end - o.start) / (o.speed || 1)); }
  for (const m of d.music) { pts.add(m.at); pts.add(m.at + (m.end - m.start)); }
  const list = [...pts].sort((a, b) => a - b);
  const t = st.playhead;
  const hit = dir > 0 ? list.find((x) => x > t + 0.01) : [...list].reverse().find((x) => x < t - 0.01);
  if (hit != null) { player.pause(); player.seek(hit); }
}

export function setMark(which: "in" | "out") {
  if (st.sourceId) {
    const a = asset(st.sourceId);
    if (!a) return;
    if (which === "in") { player.markIn = player.srcT; if (player.markOut <= player.markIn) player.markOut = a.info.duration; }
    else player.markOut = Math.max(player.srcT, player.markIn + 0.1);
    set({});
    return;
  }
  const d = draft();
  if (!d) return;
  const t = st.playhead;
  editDraft(which === "in" ? "인 점" : "아웃 점", (x) => {
    let i = which === "in" ? t : x.inPoint ?? null, o = which === "out" ? t : x.outPoint ?? null;
    if (i != null && o != null && o <= i) { if (which === "in") o = null; else i = null; }
    return { ...x, inPoint: i, outPoint: o };
  }, st.draftId, false);
}

const fit = () => window.dispatchEvent(new CustomEvent("reelcut:zoom", { detail: "fit" }));
const zoom = (k: number) => window.dispatchEvent(new CustomEvent("reelcut:zoom", { detail: k }));
const setTool = (t: Tool) => set({ tool: t });
const ws = (w: Workspace) => applyWorkspace(w);

/** Toolbar quick buttons with a shortcut (Alt+Shift+…), in the 클립 menu too. */
const QUICK_CMDS: Cmd[] = actionList().filter((a) => a.key).map((a, i) => ({
  id: `quick-${a.id}`, label: a.label, menu: "클립", keys: a.key, sep: i === 0, term: a.group === "360" ? "360" : undefined,
  enabled: () => { const d = draft(); return draftMode() && !!d && (!a.enabled || a.enabled(d, { kind: "draft" })); },
  run: () => { runAction(a.id, { scope: "selection" }).catch((e) => toast(`${a.label}: ${String((e as Error)?.message ?? e)}`)); },
}));

export const COMMANDS: Cmd[] = [
  // 파일
  { id: "new", label: "새 프로젝트…", menu: "파일", keys: "Ctrl+N", global: true, run: () => set({ dialog: "newProject" }) },
  { id: "open", label: "열기…", menu: "파일", keys: "Ctrl+O", term: "Open Project (.reelcut)", global: true, run: openProjectDialog },
  { id: "import", label: "미디어 가져오기…", menu: "파일", keys: "Ctrl+I", sep: true, enabled: inProject, run: async () => importPaths(await pickFiles()) },
  { id: "importFolder", label: "폴더 가져오기…", menu: "파일", enabled: inProject, run: async () => importPaths(await pickFiles(true)) },
  { id: "relink", label: "미디어 다시 연결…", menu: "파일", term: "Relink Media", enabled: () => inProject() && st.missing.length > 0, run: () => set({ dialog: "relink" }) },
  { id: "save", label: "저장", menu: "파일", keys: "Ctrl+S", sep: true, enabled: inProject, run: async () => {
    const r = await saveNow();
    toast(r?.error ? `앱 안에는 저장했지만 프로젝트 폴더에는 저장하지 못했습니다: ${r.error}` : st.projectFile ? `저장했습니다: ${st.projectFile}` : "저장했습니다");
  } },
  { id: "saveAs", label: "다른 이름으로 저장…", menu: "파일", keys: "Ctrl+Shift+S", term: "Save As", enabled: inProject, run: () => set({ dialog: "saveAs" }) },
  { id: "revealProject", label: "프로젝트 폴더 열기", menu: "파일", term: "Show in Explorer", enabled: inProject, run: () => revealProjectFolder() },
  { id: "pack", label: "프로젝트 묶어 내보내기…", menu: "파일", term: "Project Manager / Archive", enabled: inProject, run: packProject },
  { id: "backupNow", label: "백업 만들기", menu: "파일", enabled: inProject, run: backupNow },
  { id: "restoreBackup", label: "백업에서 되살리기…", menu: "파일", term: "Revert to Backup", enabled: inProject, run: () => set({ dialog: "backups" }) },
  { id: "saveStill", label: "현재 화면을 사진으로 저장…", menu: "파일", keys: "Ctrl+Shift+E", sep: true, term: "Export Frame", enabled: inProject, run: saveStill },
  { id: "saveTranscript", label: "대본 저장…", menu: "파일", term: "Export Transcript", enabled: hasClips, run: saveTranscript },
  { id: "export", label: "내보내기…", menu: "파일", keys: "Ctrl+E", sep: true, term: "Export / Render", enabled: hasClips, run: () => set({ dialog: "export" }) },
  { id: "home", label: "홈으로", menu: "파일", sep: true, global: true, run: () => { saveNow(); set({ route: "home" }); } },

  // 편집
  { id: "undo", label: "되돌리기", menu: "편집", keys: "Ctrl+Z", enabled: () => inProject() && canUndo(), run: undo },
  { id: "redo", label: "다시 실행", menu: "편집", keys: "Ctrl+Y|Ctrl+Shift+Z", enabled: () => inProject() && canRedo(), run: redo },
  { id: "delete", label: "삭제 (뒤 클립 당기기)", menu: "편집", keys: "Delete|Backspace", term: "Ripple Delete", sep: true, enabled: () => draftMode() && !!(st.selClip || st.selItem), run: () => deleteSelection(true) },
  { id: "lift", label: "빈칸 남기고 삭제", menu: "편집", keys: "Shift+Delete", term: "Lift", enabled: () => draftMode() && !!st.selClip, run: () => deleteSelection(false) },
  { id: "deselect", label: "선택 해제", menu: "편집", keys: "Escape", enabled: inProject, run: () => set({ selClip: null, selItem: null, trRanges: [] }) },

  // 클립
  { id: "split", label: "재생 위치에서 자르기", menu: "클립", keys: "S|Ctrl+K", term: "Split / Razor", enabled: draftMode, run: splitHere },
  { id: "detach", label: "소리 분리 (J·L컷)", menu: "클립", keys: "Ctrl+L", term: "Unlink / Detach Audio", enabled: () => draftMode() && !!selClip() && !selClip()!.detached,
    run: () => { const c = selClip(); if (!c) return; if (c.speed !== 1) return toast("소리 분리는 1x 속도 클립에서만 됩니다"); editDraft("소리 분리", (d) => detachAudio(d, c.id)); toast("소리를 A1 트랙으로 분리했습니다. 따로 늘이거나 줄여 J·L컷을 만드세요"); } },
  { id: "dissolve", label: "디졸브 넣기 (앞 클립과)", menu: "클립", keys: "Ctrl+D", term: "Cross Dissolve", enabled: () => draftMode() && !!selClip(),
    run: () => { const d = draft(), c = selClip(); if (!d || !c) return; const i = d.clips.findIndex((x) => x.id === c.id); if (i <= 0) return toast("첫 클립에는 앞 클립이 없습니다"); editDraft("디졸브", (x) => setTransition(x, c.id, c.xin ? 0 : 0.5)); } },
  { id: "toggle-clip", label: "클립 켜기 / 끄기", menu: "클립", keys: "Shift+E", term: "Enable / Disable", enabled: () => draftMode() && !!(st.selClip || st.selItem), run: toggleSelected },
  { id: "copy-attrs", label: "클립 속성 복사", menu: "클립", keys: "Ctrl+C", term: "Copy", enabled: () => draftMode() && !!st.selClip, run: () => { attrSource = selClip(); toast("클립 속성을 복사했습니다"); } },
  { id: "paste-attrs", label: "속성 붙여넣기…", menu: "클립", keys: "Ctrl+Alt+V", term: "Paste Attributes", enabled: () => draftMode() && !!attrSource && !!st.selClip, run: () => set({ dialog: "pasteAttrs" }) },
  { id: "left", label: "클립을 왼쪽으로", menu: "클립", keys: "Alt+ArrowLeft", sep: true, enabled: () => draftMode() && !!st.selClip, run: () => editDraft("클립 옮기기", (d) => nudgeClip(d, st.selClip!, -1)) },
  { id: "right", label: "클립을 오른쪽으로", menu: "클립", keys: "Alt+ArrowRight", enabled: () => draftMode() && !!st.selClip, run: () => editDraft("클립 옮기기", (d) => nudgeClip(d, st.selClip!, 1)) },
  { id: "marker", label: "마커 달기", menu: "클립", keys: "M", sep: true, enabled: draftMode,
    run: () => editDraft("마커", (d) => ({ ...d, markers: [...d.markers, { id: uid(), t: st.playhead, label: `마커 ${d.markers.length + 1}`, color: "#FFB020" }] }), st.draftId, false) },

  { id: "trimStart", label: "재생 위치 앞부분 잘라 당기기", menu: "클립", keys: "Q", term: "Ripple Trim Previous Edit to Playhead", enabled: draftMode, run: () => trimToPlayhead("start") },
  { id: "trimEnd", label: "재생 위치 뒷부분 잘라 당기기", menu: "클립", keys: "W", term: "Ripple Trim Next Edit to Playhead", enabled: draftMode, run: () => trimToPlayhead("end") },

  // 타임라인
  { id: "toolSelect", label: "선택 도구", menu: "타임라인", keys: "V", term: "Selection Tool", checked: () => st.tool === "select", enabled: inProject, run: () => setTool("select") },
  { id: "toolBlade", label: "자르기 도구", menu: "타임라인", keys: "C", term: "Razor / Blade", checked: () => st.tool === "blade", enabled: inProject, run: () => setTool("blade") },
  { id: "toolRoll", label: "편집점 굴리기 도구", menu: "타임라인", keys: "N", term: "Rolling Edit", checked: () => st.tool === "roll", enabled: inProject, run: () => setTool("roll") },
  { id: "toolRate", label: "길이로 속도 바꾸기 도구", menu: "타임라인", keys: "R", term: "Rate Stretch", checked: () => st.tool === "rate", enabled: inProject, run: () => setTool("rate") },
  { id: "toolSlip", label: "내용 밀기 도구", menu: "타임라인", keys: "Y", term: "Slip", checked: () => st.tool === "slip", enabled: inProject, run: () => setTool("slip") },
  { id: "snap", label: "자석 붙이기", menu: "타임라인", keys: "Shift+S", term: "Snapping", sep: true, checked: () => st.snap, enabled: inProject, run: () => set({ snap: !st.snap }) },
  { id: "markIn", label: "인 점", menu: "타임라인", keys: "I", term: "Mark In", sep: true, enabled: hasDraft, run: () => setMark("in") },
  { id: "markOut", label: "아웃 점", menu: "타임라인", keys: "O", term: "Mark Out", enabled: hasDraft, run: () => setMark("out") },
  { id: "clearIO", label: "인·아웃 지우기", menu: "타임라인", keys: "Alt+X", enabled: draftMode, run: () => editDraft("인·아웃 지우기", (d) => ({ ...d, inPoint: null, outPoint: null }), st.draftId, false) },
  { id: "silence", label: "무음 정리", menu: "타임라인", sep: true, enabled: () => draftMode() && hasClips(), run: doSilence },
  { id: "fillers", label: "군더더기 말 정리", menu: "타임라인", enabled: () => draftMode() && hasClips(), run: doFillers },
  { id: "showSilence", label: "잘릴 무음 미리 보기", menu: "타임라인", checked: () => st.showSilence, enabled: hasDraft, run: () => set({ showSilence: !st.showSilence }) },
  { id: "captions", label: "받아쓰기 자막", menu: "타임라인", checked: () => !!draft()?.captions, enabled: hasDraft, run: () => editDraft("자막", (d) => ({ ...d, captions: !d.captions }), st.draftId, false) },
  { id: "zoomIn", label: "확대", menu: "타임라인", keys: "=|+", sep: true, enabled: inProject, run: () => zoom(1.5) },
  { id: "zoomOut", label: "축소", menu: "타임라인", keys: "-", enabled: inProject, run: () => zoom(1 / 1.5) },
  { id: "zoomFit", label: "전체 맞춤", menu: "타임라인", keys: "Shift+Z", enabled: inProject, run: fit },

  ...QUICK_CMDS,

  // 재생
  { id: "play", label: "재생 / 멈춤", menu: "재생", keys: "Space", enabled: inProject, run: () => player.toggle() },
  { id: "shuttleBack", label: "뒤로 재생 (누를수록 빠르게)", menu: "재생", keys: "J", term: "Shuttle", enabled: inProject, run: () => player.shuttle(-1) },
  { id: "shuttleStop", label: "멈춤", menu: "재생", keys: "K", enabled: inProject, run: () => player.shuttle(0) },
  { id: "shuttleFwd", label: "앞으로 재생 (누를수록 빠르게)", menu: "재생", keys: "L", enabled: inProject, run: () => player.shuttle(1) },
  { id: "frameBack", label: "한 프레임 뒤로", menu: "재생", keys: "ArrowLeft", sep: true, enabled: inProject, run: () => player.step(-1) },
  { id: "frameFwd", label: "한 프레임 앞으로", menu: "재생", keys: "ArrowRight", enabled: inProject, run: () => player.step(1) },
  { id: "secBack", label: "1초 뒤로", menu: "재생", keys: "Shift+ArrowLeft", enabled: inProject, run: () => player.nudge(-1) },
  { id: "secFwd", label: "1초 앞으로", menu: "재생", keys: "Shift+ArrowRight", enabled: inProject, run: () => player.nudge(1) },
  { id: "prevEdit", label: "이전 편집점", menu: "재생", keys: "ArrowUp", sep: true, enabled: draftMode, run: () => jumpEdit(-1) },
  { id: "nextEdit", label: "다음 편집점", menu: "재생", keys: "ArrowDown", enabled: draftMode, run: () => jumpEdit(1) },
  { id: "toStart", label: "처음으로", menu: "재생", keys: "Home", enabled: inProject, run: () => player.seek(0) },
  { id: "toEnd", label: "끝으로", menu: "재생", keys: "End", enabled: hasDraft, run: () => { const d = draft(); if (d) player.seek(draftDuration(d)); } },

  // 보기
  { id: "nextMarker", label: "다음 마커로", menu: "재생", keys: "Shift+M", term: "Go to Next Marker", enabled: draftMode, run: () => jumpMarker(1) },
  { id: "prevMarker", label: "이전 마커로", menu: "재생", keys: "Ctrl+Shift+M", term: "Go to Previous Marker", enabled: draftMode, run: () => jumpMarker(-1) },
  { id: "wsEdit", label: "편집 화면", menu: "보기", keys: "Alt+1", term: "Edit Workspace", checked: () => st.workspace === "edit", enabled: inProject, run: () => ws("edit") },
  { id: "wsTranscript", label: "대본 화면", menu: "보기", keys: "Alt+2", checked: () => st.workspace === "transcript", enabled: inProject, run: () => ws("transcript") },
  { id: "ws360", label: "360 화면", menu: "보기", keys: "Alt+3", checked: () => st.workspace === "r360", enabled: inProject, run: () => ws("r360") },
  { id: "panelLeft", label: "왼쪽 패널 보이기", menu: "보기", keys: "Ctrl+Alt+ArrowLeft", sep: true, enabled: inProject, run: () => togglePanel("left") },
  { id: "panelRight", label: "오른쪽 패널 보이기", menu: "보기", keys: "Ctrl+Alt+ArrowRight", enabled: inProject, run: () => togglePanel("right") },
  { id: "fullscreen", label: "미리보기 전체 화면", menu: "보기", keys: "F", enabled: inProject, run: () => window.dispatchEvent(new Event("reelcut:fullscreen")) },
  { id: "safe", label: "안전 영역·격자", menu: "보기", term: "Safe Margins", checked: () => st.showSafe, enabled: inProject, run: () => set({ showSafe: !st.showSafe }) },
  { id: "resetLayout", label: "패널 배치 초기화", menu: "보기", enabled: inProject, run: () => applyWorkspace(st.workspace, true) },
  { id: "settings", label: "설정", menu: "보기", keys: "Ctrl+,", sep: true, global: true, run: () => set({ route: "settings" }) },

  // 도움말
  { id: "shortcuts", label: "단축키 목록", menu: "도움말", keys: "Ctrl+/", global: true, run: () => set({ dialog: "shortcuts" }) },
  { id: "diagBundle", label: "진단 파일 만들기…", menu: "도움말", global: true, run: makeDiagBundle },
];

// ---------------------------------------------------------------- key matching

/** The bindings the app ships with, so changes can be undone. */
const DEFAULT_KEYS = new Map(COMMANDS.map((c) => [c.id, c.keys ?? ""]));

/** Key layouts of other editors, as changes over the defaults. */
export const KEY_LAYOUTS: { id: string; label: string; keys: Record<string, string> }[] = [
  { id: "default", label: "Reelcut 기본", keys: {} },
  { id: "premiere", label: "Premiere Pro", keys: { split: "Ctrl+K", delete: "Alt+Backspace|Shift+Delete", lift: "Delete|Backspace", dissolve: "Ctrl+D", "toggle-clip": "Shift+E", "paste-attrs": "Ctrl+Alt+V", marker: "M" } },
  { id: "finalcut", label: "Final Cut Pro", keys: { split: "Ctrl+B", delete: "Delete|Backspace", lift: "Shift+Backspace", dissolve: "Ctrl+T", "toggle-clip": "V", "paste-attrs": "Ctrl+Shift+V", marker: "M", toolSelect: "A", toolBlade: "B" } },
  { id: "resolve", label: "DaVinci Resolve", keys: { split: "Ctrl+B", delete: "Delete", lift: "Backspace", dissolve: "Ctrl+T", "toggle-clip": "D", "paste-attrs": "Alt+V", marker: "M" } },
];

/** Puts the user's changes over the default keys; every list and the matcher read `keys`. */
export function applyKeymap(over: Record<string, string> | undefined) {
  for (const c of COMMANDS) {
    const k = over && c.id in over ? over[c.id] : DEFAULT_KEYS.get(c.id) ?? "";
    c.keys = k || undefined;
  }
}

const KEY_NAME: Record<string, string> = { " ": "Space", Esc: "Escape", Del: "Delete" };
export const keyLabel = (k: string) => k.replace("ArrowLeft", "←").replace("ArrowRight", "→").replace("ArrowUp", "↑").replace("ArrowDown", "↓").replace("Escape", "Esc").replace("Delete", "Del");
export const firstKey = (c: Cmd) => (c.keys ? keyLabel(c.keys.split("|")[0]) : "");

export function eventKey(e: KeyboardEvent): string {
  let k = KEY_NAME[e.key] ?? e.key;
  // Letters and digits by physical key, so shortcuts also work while the Korean IME is on (S → ㄴ).
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code) && (e.altKey || e.ctrlKey)) k = e.code.slice(5);
  if (k.length === 1) k = k.toUpperCase();
  // Shift counts with letters, named keys and (with Alt/Ctrl) digits: Alt+Shift+1 is not Alt+1.
  const mods = [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey && (k.length > 1 || /[A-Z0-9]/.test(k)) ? "Shift" : ""].filter(Boolean);
  return [...mods, k].join("+");
}

/** Runs the command bound to this key press; returns true when one ran. */
export function handleKey(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement;
  const typing = !!t.closest?.("input, textarea, select, [contenteditable]");
  const k = eventKey(e);
  const c = COMMANDS.find((x) => x.keys?.split("|").some((b) => b === k));
  if (!c) return false;
  // While typing only Ctrl shortcuts work (and Escape leaves the field alone).
  if (typing && !k.startsWith("Ctrl+")) return false;
  // Copy stays the system's while typing or with text selected.
  if (k === "Ctrl+C" && (typing || String(window.getSelection() ?? ""))) return false;
  if (!c.global && !inProject()) return false;
  if (c.enabled && !c.enabled()) return false;
  e.preventDefault();
  c.run();
  return true;
}

export const clipUnderPlayhead = () => { const d = draft(); return d && d.clips.length ? clipAt(d, st.playhead) : null; };
