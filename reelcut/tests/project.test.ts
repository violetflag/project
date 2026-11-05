// Project files (2.18): saving through the folder, opening .reelcut files, Save As, backups.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { newDraft } from "../src/edit";
import { hourlyTick, HOURLY_MS, isProjectFile, openPaths, openProjectFile, queueOpen, recoverConversations, recoverGroup, relinkFrom, restoreBackup, saveProjectAs, takeHanded } from "../src/project";
import { canUndo, checkMissing, deleteProject, localIso, localStamp, mutate, SAVE_DEBOUNCE, SAVE_MAX, saveNow, set, st, undo } from "../src/store";
import { COMMANDS } from "../src/commands";
import { copyChat, retire } from "../src/chats";
import type { Project } from "../src/types";

/** The app store and the folders, in memory. */
let store: Map<string, string>;
let saves: { id: string; json: string }[];
let backups: { id: string; reason: string }[];
function fakeBackend() {
  store = new Map();
  saves = [];
  backups = [];
  vi.spyOn(api, "storeGet").mockImplementation(async (n) => store.get(n) ?? null);
  vi.spyOn(api, "storeList").mockImplementation(async (pre) => [...store.keys()].filter((k) => k.startsWith(pre)));
  vi.spyOn(api, "projectSave").mockImplementation(async (id, json) => { store.set("project-" + id, json); saves.push({ id, json }); return { file: `C:/R/${JSON.parse(json).name}/${JSON.parse(json).name}.reelcut` }; });
  vi.spyOn(api, "projectInfo").mockImplementation(async () => null);
  vi.spyOn(api, "projectBackup").mockImplementation(async (id, reason) => { backups.push({ id, reason }); return `2026-11-05 1000 ${reason}.reelcut`; });
  vi.spyOn(api, "projectCopyLogs").mockImplementation(async () => {});
  vi.spyOn(api, "storeDelete").mockImplementation(async (n) => { store.delete(n); });
  vi.spyOn(api, "projectTrash").mockImplementation(async () => {});
  vi.spyOn(api, "projectFileIn").mockImplementation(async () => null);
}

const proj = (id: string, extra: Partial<Project> = {}): Project => {
  const d = { ...newDraft("편집본"), id: "d1" };
  return { id, name: "여행", created: 1, updated: 100, assets: [], folders: [], drafts: [d], chats: [{ id: "s1", title: "대화", created: 1, updated: 2, messages: [{ role: "user", content: "둘 다 나오게" }], ccSession: "cc-1" }], activeChat: "s1", ...extra };
};

beforeEach(() => { fakeBackend(); set({ project: null, draftId: null, route: "home", projects: [] }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("times for file names", () => {
  it("are local, with the offset", () => {
    const d = new Date(2026, 10, 5, 9, 7, 3);
    expect(localStamp(d)).toBe("2026-11-05 0907");
    expect(localIso(d)).toMatch(/^2026-11-05T09:07:03[+-]\d\d:\d\d$/);
  });
});

describe("autosave", () => {
  it("waits for a pause, but never more than 10 s after the first change", async () => {
    vi.useFakeTimers();
    set({ project: proj("pA"), draftId: "d1" });
    // A change every second for 12 s: no pause long enough, so the cap saves it.
    for (let i = 0; i < 12; i++) {
      mutate((p) => ({ ...p, name: `여행 ${i}` }));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(saves.length).toBe(1);
    expect(JSON.parse(saves[0].json).name).toBe(`여행 ${SAVE_MAX / 1000 - 1}`);
    // Then a pause: saved once more after the debounce.
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE + 10);
    expect(saves.length).toBe(2);
    expect(JSON.parse(saves[1].json).name).toBe("여행 11");
  });
});

describe("opening a .reelcut", () => {
  it("takes the file when it is newer than the app's copy", async () => {
    store.set("project-p1", JSON.stringify(proj("p1", { updated: 50, name: "옛 이름" })));
    vi.spyOn(api, "projectOpen").mockResolvedValue({ project: proj("p1", { updated: 200 }), folder: "C:/R/여행", from: "file", warnings: [], conflict: false });
    expect(await openProjectFile("C:/R/여행/여행.reelcut")).toBe(true);
    expect(st.project?.name).toBe("여행");
    expect(st.project?.chats?.[0].messages.length).toBe(1);
    expect(backups.map((b) => b.reason)).toContain("열기");
  });

  it("keeps the app's copy when that is newer", async () => {
    store.set("project-p2", JSON.stringify(proj("p2", { updated: 900, name: "새 이름" })));
    vi.spyOn(api, "projectOpen").mockResolvedValue({ project: proj("p2", { updated: 200 }), folder: "C:/R/여행", from: "file", warnings: [], conflict: false });
    await openProjectFile("C:/R/여행/여행.reelcut");
    expect(st.project?.name).toBe("새 이름");
    expect(saves.length).toBe(0);
  });

  it("opens a copied folder as a copy with its own id and Claude Code session", async () => {
    vi.spyOn(api, "projectOpen").mockResolvedValue({ project: proj("p3"), folder: "D:/복사/여행", from: "file", warnings: [], conflict: true });
    await openProjectFile("D:/복사/여행/여행.reelcut");
    expect(st.project?.id).not.toBe("p3");
    expect(st.project?.name).toBe("여행 (사본)");
    expect(st.project?.chats?.[0].ccSession).toBeUndefined();
  });

  it("says so when it could not open", async () => {
    vi.spyOn(api, "projectOpen").mockRejectedValue(new Error("C:/x.reelcut: 파일이 없습니다"));
    expect(await openProjectFile("C:/x.reelcut")).toBe(false);
    expect(st.toast).toContain("열 수 없습니다");
  });

  it("is chosen over media among dropped files", async () => {
    const open = vi.spyOn(api, "projectOpen").mockResolvedValue({ project: proj("p4"), folder: "C:/R/여행", from: "file", warnings: [], conflict: false });
    await openPaths(["C:/v/a.mp4", "C:/R/여행/여행.REELCUT"]);
    expect(open).toHaveBeenCalledWith("C:/R/여행/여행.REELCUT", expect.stringMatching(/^\d{4}-\d\d-\d\d \d{4}$/));
    expect(isProjectFile("a.osv")).toBe(false);
  });
});

describe("다른 이름으로 저장", () => {
  it("makes a copy with a new id, its own session and the action log", async () => {
    set({ project: proj("p5"), draftId: "d1" });
    expect(await saveProjectAs("여행 짧게")).toBe(true);
    expect(st.project?.id).not.toBe("p5");
    expect(st.project?.name).toBe("여행 짧게");
    expect(st.project?.chats?.[0].messages[0]).toEqual({ role: "user", content: "둘 다 나오게" });
    expect(st.project?.chats?.[0].ccSession).toBeUndefined();
    expect(api.projectCopyLogs).toHaveBeenCalledWith("p5", st.project?.id);
    // The original is untouched.
    expect(JSON.parse(store.get("project-p5")!).name).toBe("여행");
  });
});

describe("backups", () => {
  it("restores the edits, keeps media added since and the chats, and can be undone", async () => {
    const now = proj("p6", { assets: [{ id: "new", folder: "", tState: "idle", added: 0, info: { path: "C:/v/new.mp4" } as any }] });
    now.drafts[0] = { ...now.drafts[0], name: "지금" };
    set({ project: now, draftId: "d1" });
    const old = proj("p6", { assets: [{ id: "old", folder: "", tState: "idle", added: 0, info: { path: "C:/v/old.mp4" } as any }], chats: [] });
    old.drafts[0] = { ...old.drafts[0], name: "예전" };
    vi.spyOn(api, "projectBackupRead").mockResolvedValue(old);
    expect(await restoreBackup("2026-11-05 0900 AI 작업 전.reelcut")).toBe(true);
    expect(backups.map((b) => b.reason)).toEqual(["복구"]);
    expect(st.project?.drafts[0].name).toBe("예전");
    expect(st.project?.assets.map((a) => a.id)).toEqual(["new", "old"]);
    expect(st.project?.chats?.length).toBe(1);
    expect(canUndo()).toBe(true);
    undo();
    expect(st.project?.drafts[0].name).toBe("지금");
  });

  it("are made hourly only while something changed", async () => {
    set({ project: proj("p7"), draftId: "d1", savedAt: 10 });
    await hourlyTick(1_000);
    await hourlyTick(1_000 + HOURLY_MS);
    expect(backups).toEqual([]);
    set({ savedAt: 20 });
    await hourlyTick(1_000 + HOURLY_MS / 2);
    expect(backups).toEqual([]);
    await hourlyTick(1_000 + HOURLY_MS + 5);
    expect(backups.map((b) => b.reason)).toEqual(["1시간마다"]);
  });
});

describe("대화 복구", () => {
  it("makes one project per mentioned project name, else per day", async () => {
    const f = (session: string, project: string | null, started: number) => ({ session, started, ended: started + 1, messages: 2, first: "둘 다", project, title: null, bytes: 1 });
    const found = [f("a", "제주 여행", 1000), f("b", "제주 여행", 2000), f("c", null, new Date(2026, 10, 3, 10).getTime())];
    vi.spyOn(api, "recoverChats").mockImplementation(async (ss) => ss.map((s, i) => ({ id: "r" + s, title: s, created: 10 - i, updated: 20, messages: [{ role: "user", content: "x" }], ccSession: s, chatMode: "account" })));
    expect(recoverGroup(found[2])).toBe("복구된 대화 2026-11-03");
    expect(await recoverConversations(found)).toBe(2);
    const made = saves.map((x) => JSON.parse(x.json) as Project);
    expect(made.map((p) => p.name).sort()).toEqual(["복구된 대화 2026-11-03", "제주 여행 (복구된 대화)"]);
    const jeju = made.find((p) => p.name.startsWith("제주"))!;
    expect(jeju.chats?.map((c) => c.ccSession)).toEqual(["b", "a"]);
    expect(jeju.drafts.length).toBe(1);
    expect(jeju.created).toBe(1000);
  });
});

describe("moved footage", () => {
  it("is noticed on opening and found again by name and size, with its .lrf", async () => {
    const asset = (id: string, path: string, lrf: string | null = null) => ({ id, folder: "", tState: "idle" as const, added: 0, info: { path, name: path.split("/").pop()!, size: 42, lrf } as any });
    set({ dialog: "", project: proj("p8", { assets: [asset("a", "E:/DJI/CAM_1.OSV", "E:/DJI/CAM_1.LRF"), asset("b", "C:/v/ok.mp4")] }), draftId: "d1" });
    vi.spyOn(api, "pathsExist").mockImplementation(async (ps) => ps.map((p) => p.startsWith("C:/") || p.startsWith("F:/")));
    expect(await checkMissing(true)).toEqual(["a"]);
    expect(st.dialog).toBe("relink");
    const search = vi.spyOn(api, "relinkSearch").mockResolvedValue({ a: "F:/옮김/CAM_1.OSV" });
    expect(await relinkFrom("F:/옮김")).toEqual({ found: 1, left: 0 });
    expect(search).toHaveBeenCalledWith("F:/옮김", [{ id: "a", name: "CAM_1.OSV", size: 42 }]);
    const a = st.project!.assets.find((x) => x.id === "a")!;
    expect([a.info.path, a.info.lrf]).toEqual(["F:/옮김/CAM_1.OSV", "F:/옮김/CAM_1.LRF"]);
    expect(st.missing).toEqual([]);
    expect(JSON.parse(saves[saves.length - 1].json).assets[0].info.path).toBe("F:/옮김/CAM_1.OSV");
  });
});

describe("saving", () => {
  it("runs one save at a time and the last one carries the newest state", async () => {
    set({ project: proj("s1"), draftId: "d1" });
    let running = 0, most = 0;
    const gates: (() => void)[] = [];
    vi.spyOn(api, "projectSave").mockImplementation(async (id, json) => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((r) => gates.push(r));
      running--;
      saves.push({ id, json });
      return { file: "C:/R/여행/여행.reelcut" };
    });
    const a = saveNow();
    mutate((p) => ({ ...p, name: "둘째" }));
    const b = saveNow();
    mutate((p) => ({ ...p, name: "셋째" }));
    const c = saveNow();
    expect(b).toBe(c);
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gates.shift()!();
    await a;
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gates.shift()!();
    await c;
    expect(most).toBe(1);
    expect(saves.map((x) => JSON.parse(x.json).name)).toEqual(["여행", "셋째"]);
  });

  it("never brings back a project deleted from Home while it was the last one open", async () => {
    set({ project: proj("s2"), draftId: "d1", route: "home" });
    await saveNow();
    await deleteProject("s2");
    expect(st.project).toBeNull();
    expect(store.has("project-s2")).toBe(false);
    await saveNow();
    expect(store.has("project-s2")).toBe(false);
    expect(st.projects.some((m) => m.id === "s2")).toBe(false);
  });

  it("says so on Ctrl+S when the folder could not be written", async () => {
    set({ project: proj("s3"), draftId: "d1", route: "project", projectFile: "C:/R/여행/여행.reelcut" });
    vi.spyOn(api, "projectSave").mockResolvedValue({ error: "C:/R/여행: 액세스가 거부되었습니다" });
    await COMMANDS.find((c) => c.id === "save")!.run();
    expect(st.toast).toContain("프로젝트 폴더에는 저장하지 못했습니다");
    expect(st.projectFile).toBe("");
  });
});

describe("opening from Explorer", () => {
  it("opens a dropped project folder instead of making an empty project", async () => {
    vi.spyOn(api, "projectFileIn").mockResolvedValue("C:/R/여행/여행.reelcut");
    const open = vi.spyOn(api, "projectOpen").mockResolvedValue({ project: proj("o1"), folder: "C:/R/여행", from: "file", warnings: [], conflict: false });
    await openPaths(["C:/R/여행"]);
    expect(open).toHaveBeenCalledWith("C:/R/여행/여행.reelcut", expect.any(String));
    expect(st.project?.id).toBe("o1");
  });

  it("opens a backup file's project with that backup picked", async () => {
    vi.spyOn(api, "projectOpen").mockResolvedValue({ project: proj("o2"), folder: "C:/R/여행", from: "file", warnings: [], conflict: false, backup: "2026-11-05 0900 수동.reelcut" });
    await openProjectFile("C:/R/여행/백업/2026-11-05 0900 수동.reelcut");
    expect(st.project?.id).toBe("o2");
    expect([st.dialog, st.backupPick]).toEqual(["backups", "2026-11-05 0900 수동.reelcut"]);
  });

  it("keeps files handed over while starting, and opens them in order once ready", async () => {
    const handed = [["C:/v/1.osv"], ["C:/v/2.osv"]];
    vi.spyOn(api, "takeOpenFiles").mockImplementation(async () => handed.shift() ?? []);
    const order: string[] = [];
    vi.spyOn(api, "projectFileIn").mockImplementation(async (ps) => { order.push(ps[0]); return null; });
    set({ project: proj("o3"), draftId: "d1" });
    vi.spyOn(await import("../src/store"), "importPaths").mockImplementation(async () => {});
    await takeHanded();
    expect(order).toEqual([]);
    await takeHanded(true);
    await takeHanded();
    await queueOpen(["C:/v/3.osv"]);
    expect(order).toEqual(["C:/v/1.osv", "C:/v/2.osv", "C:/v/3.osv"]);
  });
});

describe("copies of a project", () => {
  it("carry the conversation for the AI, without the original's Claude Code session", () => {
    const c = { id: "s1", title: "대화", created: 1, updated: 2, messages: [{ role: "user" as const, content: "둘 다 나오게 해 줘" }, { role: "assistant" as const, content: "네, 둘 다 넣었습니다" }], ccSession: "cc-1", ccPast: ["cc-0"] };
    const k = copyChat(c);
    expect([k.ccSession, k.ccPast]).toEqual([undefined, undefined]);
    expect(k.seed).toContain("둘 다 나오게 해 줘");
    expect(k.messages).toEqual(c.messages);
    // A summary waiting for the next fresh conversation is kept as it is.
    expect(copyChat({ ...c, ccSession: undefined, seed: "<compacted-summary>요약</compacted-summary>" }).seed).toBe("<compacted-summary>요약</compacted-summary>");
    expect(retire(c, "cc-1", null, "cc-0")).toEqual(["cc-0", "cc-1"]);
  });

  it("restoring a backup keeps every media folder in use", async () => {
    const now = proj("c1", { folders: ["인물"], assets: [{ id: "x", folder: "인물", tState: "idle", added: 0, info: { path: "C:/v/x.mp4" } as any }] });
    set({ project: now, draftId: "d1" });
    vi.spyOn(api, "projectBackupRead").mockResolvedValue(proj("c1", { folders: ["풍경"], chats: [] }));
    expect(await restoreBackup("2026-11-05 0900 AI 작업 전.reelcut")).toBe(true);
    expect(st.project?.folders).toEqual(["인물", "풍경"]);
    expect(st.project?.assets.find((a) => a.id === "x")?.folder).toBe("인물");
  });
});
