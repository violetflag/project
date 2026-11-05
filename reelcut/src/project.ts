// Project files (2.18): every project also lives in a folder the user can see,
// Documents\Reelcut\<이름>\<이름>.reelcut, with its AI conversations, the action log, the AI's raw
// records and dated backups (src-tauri/src/project.rs writes it on every save). This module opens
// such files (double-click, 파일 > 열기, a drop, a second start), saves a copy under another name,
// restores a backup, and keeps the hourly backup.
import { api, pickProject, type FoundChat } from "./api";
import { flush, logAction } from "./actionlog";
import { newDraft, uid } from "./edit";
import {
  backupProject, checkpoint, cleanProject, createProject, importPaths, loadProjects, localIso, mutate, openProject, saveNow, set, st, toast,
} from "./store";
import type { Project } from "./types";

export const isProjectFile = (p: string) => /\.reelcut$/i.test(p);
const msg = (e: unknown) => String((e as Error)?.message ?? e);

/**
 * Opens a .reelcut file. The newer of the file and the app's own copy wins; a project whose
 * folder was copied (another folder already holds it) opens as a copy with its own id.
 */
export async function openProjectFile(path: string): Promise<boolean> {
  let r: Awaited<ReturnType<typeof api.projectOpen>>;
  try {
    r = await api.projectOpen(path);
  } catch (e) {
    toast(`프로젝트를 열 수 없습니다: ${msg(e)}`);
    return false;
  }
  let p = r.project as Project;
  if (r.conflict) p = { ...p, id: uid(), name: `${p.name} (사본)`, chats: p.chats?.map((c) => ({ ...c, ccSession: undefined })) };
  if (st.project) await saveNow();
  let cur: Project | null = null;
  try { const raw = await api.storeGet("project-" + p.id); cur = raw ? JSON.parse(raw) : null; } catch { cur = null; }
  // The file is newer (copied from another PC, or restored by hand): it replaces the app's copy,
  // which the store keeps as a backup.
  if (!cur || (p.updated ?? 0) > (cur.updated ?? 0)) await api.projectSave(p.id, JSON.stringify(p), localIso());
  await loadProjects();
  await openProject(p.id);
  if (r.from !== "file") toast(`프로젝트 파일이 손상되어 ${r.from === "bak" ? "바로 전에 저장한 내용" : "가장 최근 백업"}으로 열었습니다`);
  else if (r.conflict) toast("다른 폴더에 같은 프로젝트가 있어 사본으로 열었습니다");
  else if (r.warnings.length) toast(r.warnings[0]);
  return true;
}

export async function openProjectDialog() {
  const p = await pickProject();
  if (p) await openProjectFile(p);
}

/** Files from Explorer, a drop or a second start: a project opens, media is imported. */
export async function openPaths(paths: string[]) {
  const proj = paths.find(isProjectFile);
  if (proj) {
    await openProjectFile(proj);
    return;
  }
  if (!paths.length) return;
  if (!st.project) await createProject(paths[0].split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ""));
  await importPaths(paths);
}

/**
 * 다른 이름으로 저장: a copy with its own id and folder. It keeps the edits, the conversations
 * (they start a new Claude Code session, so the two never write into one) and the action log.
 */
export async function saveProjectAs(name: string): Promise<boolean> {
  const p = st.project;
  if (!p) return false;
  await saveNow();
  flush();
  const id = uid();
  const now = Date.now();
  const copy: Project = {
    ...structuredClone(cleanProject(p)), id, name: name.trim() || `${p.name} 사본`, created: now, updated: now,
    chats: p.chats?.map((c) => ({ ...structuredClone(c), ccSession: undefined })),
  };
  try {
    await api.projectCopyLogs(p.id, id).catch(() => {});
    const r = await api.projectSave(id, JSON.stringify(copy), localIso());
    await loadProjects();
    await openProject(id);
    logAction(id, { who: "user", kind: "edit", label: "다른 이름으로 저장", detail: `"${p.name}"의 사본으로 만듦` });
    toast(r.error ? `사본을 만들었지만 폴더에는 저장하지 못했습니다: ${r.error}` : `"${copy.name}"(으)로 저장했습니다`);
    return true;
  } catch (e) {
    toast(`다른 이름으로 저장하지 못했습니다: ${msg(e)}`);
    return false;
  }
}

/** 파일 > 백업 만들기. */
export async function backupNow() {
  const f = await backupProject("수동");
  toast(f ? `백업을 만들었습니다: ${f}` : "백업을 만들지 못했습니다 (프로젝트 폴더가 아직 없습니다)");
}

/**
 * Brings a backup's edits back (drafts, media list, folders). The conversations stay as they are,
 * and the state before is kept as a "복구" backup and as an undo step.
 */
export async function restoreBackup(file: string): Promise<boolean> {
  const p = st.project;
  if (!p) return false;
  let b: Project | null;
  try { b = await api.projectBackupRead(p.id, file); } catch (e) { toast(`백업을 읽지 못했습니다: ${msg(e)}`); return false; }
  if (!b?.drafts?.length) { toast("이 백업에는 편집본이 없습니다"); return false; }
  await backupProject("복구");
  checkpoint(`백업에서 되살리기 (${file})`);
  // The media list only grows: media added since stays, media the backup had comes back.
  const have = new Set(p.assets.map((a) => a.id));
  const assets = [...p.assets, ...(b.assets ?? []).filter((a) => !have.has(a.id))];
  mutate((x) => ({ ...x, drafts: b!.drafts, assets, folders: b!.folders ?? x.folders }), `백업에서 되살리기: ${file}`);
  set({ draftId: b.drafts.some((d) => d.id === st.draftId) ? st.draftId : b.drafts[0].id, selClip: null, selItem: null });
  await saveNow();
  toast("백업을 되살렸습니다. 되돌리기(Ctrl+Z)로 취소할 수 있습니다");
  return true;
}

export async function revealProjectFolder(id = st.project?.id) {
  if (!id) return;
  const f = await api.projectInfo(id).catch(() => null);
  if (!f) {
    if (st.project?.id === id) await saveNow();
    const g = await api.projectInfo(id).catch(() => null);
    if (!g) return toast("프로젝트 폴더가 아직 없습니다");
    return api.reveal(g.file ?? g.folder);
  }
  await api.reveal(f.file ?? f.folder);
}

// ---------------------------------------------------------------- hourly backup and migration

export const HOURLY_MS = 3_600_000;
let lastHourly = { id: "", at: 0, savedAt: 0 };

/** One backup an hour while a project is open and has changed since the last one. */
export async function hourlyTick(now = Date.now()) {
  const p = st.project;
  if (!p) return;
  if (lastHourly.id !== p.id) { lastHourly = { id: p.id, at: now, savedAt: st.savedAt }; return; }
  if (now - lastHourly.at < HOURLY_MS || st.savedAt <= lastHourly.savedAt) return;
  lastHourly = { id: p.id, at: now, savedAt: st.savedAt };
  await backupProject("1시간마다");
}

let started = false;
/** At start: every project of the app gets its folder (once), then the hourly backup runs. */
export async function startProjectFiles() {
  if (started) return;
  started = true;
  setInterval(() => { void hourlyTick(); }, 5 * 60_000);
  try {
    const r = await api.projectMigrate(localIso());
    if (r.saved) {
      const root = await api.projectRoot().catch(() => null);
      toast(`프로젝트 ${r.saved}개를 ${root?.root ?? "문서\\Reelcut"} 폴더에 파일로 저장했습니다`);
    }
    if (r.failed.length) api.logEvent("project", `migrate failed: ${r.failed.join(" / ")}`).catch(() => {});
  } catch (e) {
    api.logEvent("project", `migrate: ${msg(e)}`).catch(() => {});
  }
}

// ---------------------------------------------------------------- 대화 복구

/** The project a found conversation goes to: the name it mentions, else its day. */
export function recoverGroup(f: FoundChat): string {
  if (f.project) return `${f.project} (복구된 대화)`;
  const d = new Date(f.started || Date.now()), p = (n: number) => String(n).padStart(2, "0");
  return `복구된 대화 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Makes one project per group with the chosen conversations as its chats (on their Claude Code
 * session, so asking again continues them). Media and edits are not in a conversation, so the
 * projects start with an empty draft.
 */
export async function recoverConversations(found: FoundChat[]): Promise<number> {
  const groups = new Map<string, FoundChat[]>();
  for (const f of found) groups.set(recoverGroup(f), [...(groups.get(recoverGroup(f)) ?? []), f]);
  let made = 0;
  for (const [name, fs] of groups) {
    const chats = await api.recoverChats(fs.map((f) => f.session));
    if (!chats.length) continue;
    chats.sort((a, b) => a.created - b.created);
    const now = Date.now();
    const p: Project = {
      id: uid(), name, created: Math.min(...fs.map((f) => f.started || now)), updated: now,
      assets: [], folders: [], drafts: [newDraft("첫 편집본")], chats, activeChat: chats[chats.length - 1].id,
    };
    await api.projectSave(p.id, JSON.stringify(p), localIso());
    logAction(p.id, { who: "user", kind: "edit", label: "대화 복구", detail: `Claude Code 대화 ${chats.length}개를 되살림` });
    made++;
  }
  await loadProjects();
  return made;
}
