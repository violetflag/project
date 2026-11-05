import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, aiBegin, aiEnd, diffDraft, entries, fmtEntry, INJECT_MAX, isUndone, logAction, logReady, markUserSet, parseLines, setSink, stateLine, userActionsNote, useLog, type Sink,
} from "../src/actionlog";
import { registerAction, resolveScope, runAction } from "../src/actions";
import { applyOps, TOOLS } from "../src/agent";
import { newDraft, uid, updateClip } from "../src/edit";
import { canUndo, editDraft, redo, set, st, undo } from "../src/store";
import type { ActionEntry, Asset, Clip, Draft, Project } from "../src/types";

/** A memory sink that keeps every saved line, like the file. */
function memSink(seed: ActionEntry[] = []) {
  const lines = seed.map((e) => JSON.stringify(e));
  const sink: Sink = { load: async () => parseLines(lines), save: async (_p, es) => { lines.push(...es.map((e) => JSON.stringify(e))); } };
  return { sink, lines };
}

const asset360 = (id = "a1"): Asset => ({
  id, folder: "", tState: "idle", added: 0,
  info: { path: `/v/${id}.osv`, name: `${id}.osv`, kind: "video", duration: 60, width: 3840, height: 3840, fps: 30, has_audio: true, layout360: "dual_fisheye" } as any,
});
const clip = (id: string, extra: Partial<Clip> = {}): Clip => ({ id, asset: "a1", start: 0, end: 5, speed: 1, volume: 1, view: { yaw: 0, pitch: 0, roll: 0, hfov: 100 }, ...extra });
function draftWith(clips: Clip[]): Draft { return { ...newDraft("편집본"), id: "d1", clips }; }
function openProject(d: Draft, assets: Asset[] = [asset360()]) {
  const p: Project = { id: "p" + uid(), name: "테스트", created: 0, updated: 0, assets, folders: [], drafts: [d], chats: [] };
  set({ project: p, draftId: d.id, selClip: null });
  return p;
}

let mem: ReturnType<typeof memSink>;
beforeEach(() => { mem = memSink(); setSink(mem.sink); });
afterEach(() => { vi.useRealTimers(); });

describe("action log", () => {
  it("writes entries with local time, offset and increasing seq", async () => {
    await useLog("p1");
    const a = logAction("p1", { who: "user", kind: "quick", label: "수평 맞추기", params: { id: "level", scope: "draft" } });
    const b = logAction("p1", { who: "ai", kind: "ai", label: "편집본 수정" });
    expect(a.seq + 1).toBe(b.seq);
    expect(a.t).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
    expect(a).toMatchObject({ who: "user", kind: "quick", ok: true, run: null, chat: null, tool: null });
    expect(fmtEntry(a)).toMatch(/^\d\d:\d\d 수평 맞추기 · 초안 전체$/);
  });

  it("keeps the newest copy of a re-saved line and numbers new lines after the loaded ones", async () => {
    expect(parseLines(['{"seq":1,"label":"a"}', "{broken", '{"seq":2,"label":"b"}', '{"seq":1,"label":"a2"}']).map((e) => e.label)).toEqual(["a2", "b"]);
    const old = memSink([{ t: "", ms: 1, seq: 7, who: "user", kind: "edit", label: "예전", ok: true }]);
    setSink(old.sink);
    const loading = useLog("p2");
    // Written before the load ends: numbered after the loaded line.
    const early = logAction("p2", { who: "user", kind: "edit", label: "새로" });
    await loading;
    expect(early.seq).toBe(8);
    expect(entries().map((e) => e.label)).toEqual(["예전", "새로"]);
  });

  it("tells the AI only the user's new lines, newest 15, and where it got to", async () => {
    await useLog("p3");
    logAction("p3", { who: "user", kind: "quick", label: "흔들림 줄이기" });
    const seen = userActionsNote(0).last;
    for (let i = 0; i < 20; i++) logAction("p3", { who: "user", kind: "edit", label: `자르기 ${i}`, detail: `클립 +1` });
    logAction("p3", { who: "ai", kind: "ai", label: "편집본 수정" });
    const n = userActionsNote(seen);
    const lines = n.text.split("\n");
    expect(lines[0]).toBe("<user-actions>");
    expect(lines[1]).toBe("(앞선 5건은 get_activity_log로)");
    expect(lines.filter((l) => l.includes("[직접]"))).toHaveLength(INJECT_MAX);
    expect(n.text).not.toContain("편집본 수정");
    expect(n.text).toContain("자르기 19");
    expect(n.last).toBe(entries()[entries().length - 1].seq);
    expect(userActionsNote(n.last).text).toBe("");
    expect(activityLog({ limit: 2 }).split("\n")).toHaveLength(2);
    expect(activityLog({ who: "ai" })).toMatch(/\[ai\/ai\] 편집본 수정/);
  });
});

describe("edits in the store", () => {
  it("folds quick repeats of one hand edit into one line and marks the view as set by the user", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    openProject(draftWith([clip("c1"), clip("c2")]));
    const n0 = entries().length;
    editDraft("시점", (d) => updateClip(d, "c2", { view: { yaw: 12, pitch: 0, roll: 0, hfov: 100 } }));
    vi.setSystemTime(1_000_500);
    editDraft("시점", (d) => updateClip(d, "c2", { view: { yaw: 40, pitch: 0, roll: 0, hfov: 100 } }));
    const added = entries().slice(n0);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ who: "user", kind: "edit", label: "시점", clips: ["c2"], step: "시점" });
    expect(added[0].detail).toBe("클립 2(c2) 시점 yaw 0→40");
    expect(st.project!.drafts[0].clips[1].userSet?.view).toBeGreaterThan(0);
    expect(st.project!.drafts[0].clips[0].userSet).toBeUndefined();
    // Later than 2 s: a new line.
    vi.setSystemTime(1_003_000);
    editDraft("시점", (d) => updateClip(d, "c2", { view: { yaw: 50, pitch: 0, roll: 0, hfov: 100 } }));
    expect(entries().slice(n0)).toHaveLength(2);
  });

  it("logs AI edits as the AI's, under its request, without marking user fields", () => {
    openProject(draftWith([clip("c1")]));
    const prev = aiBegin("run1", "chat1", "edit_draft");
    editDraft("AI: 편집본 수정", (d) => updateClip(d, "c1", { volume: 0.5 }));
    editDraft("AI: 편집본 수정", (d) => updateClip(d, "c1", { volume: 0.4 }));
    const ctx = aiEnd(prev);
    expect(ctx?.logged).toBe(true);
    const e = entries()[entries().length - 1];
    expect(e).toMatchObject({ who: "ai", kind: "ai", label: "편집본 수정", run: "run1", chat: "chat1", tool: "edit_draft" });
    expect(e.detail).toBe("클립 1(c1) 음량 1→0.4");
    expect(st.project!.drafts[0].clips[0].userSet).toBeUndefined();
  });

  it("records undo and redo against the line they undo", () => {
    openProject(draftWith([clip("c1")]));
    editDraft("속도", (d) => updateClip(d, "c1", { speed: 2 }));
    const e = entries()[entries().length - 1];
    expect(canUndo()).toBe(true);
    undo();
    const u = entries()[entries().length - 1];
    expect(u).toMatchObject({ kind: "undo", label: "속도", ref: e.seq });
    expect(isUndone(e)).toBe(true);
    redo();
    expect(entries()[entries().length - 1]).toMatchObject({ kind: "redo", ref: e.seq });
    expect(isUndone(e)).toBe(false);
  });
});

describe("toolbar actions", () => {
  // A stand-in for a real button: levels the roll of the clips in scope.
  registerAction({
    id: "test.level", group: "기본", label: "수평 맞추기",
    run: ({ draft, clips }) => {
      const todo = clips.filter((c) => (c.view?.roll ?? 0) !== 0);
      let d = draft;
      for (const c of todo) d = updateClip(d, c.id, { view: { ...c.view!, roll: 0 } });
      return { draft: d, changed: todo.length, detail: `roll → 0 (${todo.length}개 클립)` };
    },
  });

  it("is one undo step and one log line, and says when there is nothing left to do", async () => {
    openProject(draftWith([clip("c1", { view: { yaw: 0, pitch: 0, roll: 5, hfov: 100 } }), clip("c2", { view: { yaw: 0, pitch: 0, roll: -3, hfov: 100 } })]));
    const n0 = entries().length;
    const r = await runAction("test.level", { scope: "draft" });
    expect(r).toMatchObject({ changed: 2, detail: "roll → 0 (2개 클립)" });
    expect(st.project!.drafts[0].clips.map((c) => c.view!.roll)).toEqual([0, 0]);
    // A button is not a hand edit: no user marks.
    expect(st.project!.drafts[0].clips.every((c) => !c.userSet)).toBe(true);
    const added = entries().slice(n0);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ who: "user", kind: "quick", label: "수평 맞추기", params: { id: "test.level", scope: "draft" }, step: "수평 맞추기" });
    undo();
    expect(st.project!.drafts[0].clips.map((c) => c.view!.roll)).toEqual([5, -3]);
    redo();
    const again = await runAction("test.level", { scope: "draft" });
    expect(again).toMatchObject({ changed: 0, detail: "수평 맞추기: 이미 적용됨" });
  });

  it("uses the selected clip, else the whole draft; the AI's runs are labelled as the AI's", async () => {
    const d = draftWith([clip("c1", { view: { yaw: 0, pitch: 0, roll: 5, hfov: 100 } }), clip("c2", { view: { yaw: 0, pitch: 0, roll: 5, hfov: 100 } })]);
    expect(resolveScope(d, "selection", "c2")).toEqual({ kind: "clips", ids: ["c2"] });
    expect(resolveScope(d, "selection", null)).toEqual({ kind: "draft" });
    expect(resolveScope(d, "draft", "c2")).toEqual({ kind: "draft" });
    expect(() => resolveScope(d, { clips: ["zz"] }, null)).toThrow("편집본에 없는 클립");
    openProject(d);
    set({ selClip: "c2" });
    const r = await runAction("test.level", { by: "ai", run: "r9", chat: "ch9" });
    expect(r.changed).toBe(1);
    expect(st.project!.drafts[0].clips.map((c) => c.view!.roll)).toEqual([5, 0]);
    expect(entries()[entries().length - 1]).toMatchObject({ who: "ai", kind: "ai", run: "r9", chat: "ch9", tool: "quick_action", step: "AI: 수평 맞추기", clips: ["c2"] });
    await expect(runAction("nope")).rejects.toThrow("없는 버튼");
  });
});

describe("what the AI may change", () => {
  it("refuses to change a view, keys or sound the user set by hand unless it says override_user", () => {
    const d = draftWith([clip("c1", { userSet: { view: 1, volume: 1 } }), clip("c2")]);
    openProject(d);
    expect(() => applyOps(d, [{ op: "set", clip_id: "c1", view: { yaw: 30 } }])).toThrow("사용자 지정 항목");
    expect(() => applyOps(d, [{ op: "set", clip_id: "c1", volume: 0.2 }])).toThrow("override_user");
    expect(() => applyOps(d, [{ op: "set_view_keys", clip_id: "c1", keys: [{ t: 0, yaw: 10 }] }])).toThrow("사용자 지정");
    expect(() => applyOps(d, [{ op: "clear_view_keys", clip_id: "c1" }])).toThrow("사용자 지정");
    expect(applyOps(d, [{ op: "set", clip_id: "c1", view: { yaw: 30 }, override_user: true }]).clips[0].view!.yaw).toBe(30);
    expect(applyOps(d, [{ op: "set", clip_id: "c1", speed: 2 }]).clips[0].speed).toBe(2);
    expect(applyOps(d, [{ op: "set", clip_id: "c2", view: { yaw: 30 } }]).clips[1].view!.yaw).toBe(30);
  });

  it("has the new tools and tells the AI about user actions", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["quick_action", "get_activity_log", "get_export_log"]));
  });

  it("describes what is switched on now", () => {
    const a = asset360();
    a.lens = { layout: "dual_fisheye", swap: false, fov: 190, stab: { mode: "horizon", strength: 1, rs: true } };
    const d: Draft = {
      ...draftWith([clip("c1", { viewPreset: "best" }), clip("c2", { viewPreset: "wide", stab: { mode: "smooth", strength: 2, rs: false } }), clip("c3", { userSet: { view: 5 } })]),
      fx: { loudnorm: true, lufs: -16 },
    };
    expect(stateLine(d, new Map([[a.id, a]]))).toBe("켜져 있는 것: 소리 고르게(초안 전체, -16 LUFS) · 흔들림 보통 360 클립 3/3 · 수평 맞추기 2/3 · 시점 최적 1, 광각 1, 사용자 지정 1 · 사용자 지정 클립 1개");
    expect(stateLine(draftWith([]), new Map())).toBe("");
  });

  it("names what changed in a draft", () => {
    const a = draftWith([clip("c1"), clip("c2")]);
    const b = { ...updateClip(a, "c1", { stab: { mode: "lock", strength: 2, rs: false }, viewPreset: "wide" }), aspect: "9:16", fx: { loudnorm: true } };
    expect(diffDraft(a, b)).toEqual({ detail: "클립 1(c1) 화각 -→광각, 흔들림 기본→강(방향 고정) · 비율 16:9→9:16 · 소리 고르게 -16 LUFS", clips: ["c1"] });
    expect(markUserSet(a, b).clips[0].userSet).toEqual({ view: expect.any(Number), stab: expect.any(Number) });
  });
});
