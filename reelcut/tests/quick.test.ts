import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseLines, setSink } from "../src/actionlog";
import { runAction } from "../src/actions";
import { api } from "../src/api";
import { applyKeymap, COMMANDS, eventKey, KEY_LAYOUTS } from "../src/commands";
import { newDraft, toPlan, toSegs, updateClip } from "../src/edit";
import { aspectHW, cornerStretch, presetView } from "../src/proj";
import { gainFor, levelLimit } from "../src/quick";
import { cutJumps } from "../src/quick360";
import { assetMap, set, st, undo } from "../src/store";
import type { Asset, Clip, Draft, Project } from "../src/types";
import { markButton } from "../src/actionlog";
import { userWidth } from "../src/edit";

const osv = (id: string, extra: Partial<Asset> = {}): Asset => ({
  id, folder: "", tState: "idle", added: 0,
  info: { path: `/v/${id}.osv`, name: `${id}.osv`, kind: "video", duration: 120, width: 3840, height: 3840, fps: 30, has_audio: true, layout360: "dual_fisheye" } as any,
  ...extra,
});
const flat = (id: string): Asset => ({ id, folder: "", tState: "idle", added: 0, info: { path: `/v/${id}.mp4`, name: `${id}.mp4`, kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true, layout360: "none" } as any });
const v = (yaw = 0, pitch = 0, roll = 0, hfov = 100) => ({ yaw, pitch, roll, hfov });
const clip = (id: string, asset = "a1", extra: Partial<Clip> = {}): Clip => ({ id, asset, start: 0, end: 10, speed: 1, volume: 1, view: v(), ...extra });
const cur = () => st.project!.drafts[0];
function open(clips: Clip[], aspect = "16:9", assets: Asset[] = [osv("a1"), osv("a2"), flat("f1")]): Draft {
  const d: Draft = { ...newDraft("편집본", aspect), id: "d1", clips };
  const p: Project = { id: "p" + Math.random().toString(36).slice(2), name: "t", created: 0, updated: 0, assets, folders: [], drafts: [d], chats: [] };
  set({ project: p, draftId: d.id, selClip: null, sourceId: null });
  return d;
}

beforeEach(() => {
  const lines: string[] = [];
  setSink({ load: async () => parseLines(lines), save: async (_p, es) => { lines.push(...es.map((e) => JSON.stringify(e))); } });
});

describe("수평 맞추기", () => {
  it("levels roll, keeps the horizon in the picture and turns horizon lock on", async () => {
    open([clip("c1", "a1", { view: v(10, -48, 3), stab: { mode: "off", strength: 1, rs: false }, viewKeys: [{ t: 0, view: v(0, -40, 2) }, { t: 5, view: v(20, -55, 0) }] }), clip("c2", "f1")]);
    const lim = levelLimit({ hfov: 100 }, aspectHW("16:9"));
    expect(lim).toBeCloseTo(28.8, 1);
    const r = await runAction("level", { scope: "draft" });
    expect(r.changed).toBe(1);
    const c = cur().clips[0];
    expect(c.view).toMatchObject({ yaw: 10, roll: 0 });
    expect(c.view!.pitch).toBeCloseTo(-lim, 2);
    expect(c.viewKeys!.every((k) => k.view.roll === 0 && k.view.pitch >= -lim - 1e-9)).toBe(true);
    expect(c.stab).toEqual({ mode: "horizon", strength: 1, rs: false });
    expect(r.detail).toMatch(/수평 보정 켬 1개.*기울기 0.*pitch -55→-29/);
    expect(r.skipped).toEqual(["c2"]);
    expect((await runAction("level", { scope: "draft" })).detail).toBe("수평 맞추기: 이미 적용됨");
  });

  it("keeps lock and little planets looking down", async () => {
    open([clip("c1", "a1", { view: v(0, -90, 0, 263), viewPreset: "planet", stab: { mode: "lock", strength: 1, rs: true } })]);
    await runAction("level", { scope: "draft" });
    expect(cur().clips[0].view!.pitch).toBe(-90);
    expect(cur().clips[0].stab!.mode).toBe("lock");
  });
});

describe("흔들림 줄이기", () => {
  it("sets the strength, turns off into smooth, and has lock and off", async () => {
    open([clip("c1"), clip("c2", "a1", { stab: { mode: "off", strength: 1, rs: true } })]);
    await runAction("stab", { scope: "draft", params: { strength: 2 } });
    expect(cur().clips.map((c) => c.stab)).toEqual([{ mode: "horizon", strength: 2, rs: true }, { mode: "smooth", strength: 2, rs: true }]);
    set({ selClip: "c1" });
    await runAction("stab", { params: { mode: "lock" } });
    expect(cur().clips[0].stab!.mode).toBe("lock");
    expect(cur().clips[1].stab!.mode).toBe("smooth");
    await runAction("stab", { scope: "draft", params: { mode: "off" } });
    expect(cur().clips.every((c) => c.stab!.mode === "off")).toBe(true);
    // The export renders each clip with its own setting.
    const segs = toSegs(cur(), assetMap());
    expect(segs[0].lens!.stab).toEqual({ mode: "off", strength: 2, rs: true });
  });
});

describe("소리 고르게", () => {
  it("brings each clip to -16 LUFS within ±12 dB and evens the export", async () => {
    expect(gainFor(-20)).toBeCloseTo(1.585, 3);
    expect(gainFor(-40)).toBeCloseTo(3.981, 3);
    expect(gainFor(-6)).toBeCloseTo(0.316, 3);
    const spy = vi.spyOn(api, "loudness").mockImplementation(async (path) => ({ i: path.includes("a1") ? -20 : -70 }));
    open([clip("c1"), clip("c2", "a2"), clip("c3", "a1", { start: 20, end: 30, detached: true })]);
    const r = await runAction("loud", { scope: "draft" });
    expect(cur().clips.map((c) => c.volume)).toEqual([1.585, 1, 1]);
    expect(cur().fx).toEqual({ loudnorm: true, lufs: -16 });
    expect(r.detail).toContain("클립 1개를 -16 LUFS로 (+4.0~+4.0 dB)");
    expect(r.skipped).toEqual(["c2"]);
    expect(toPlan(cur(), assetMap(), { mode: "standard", short: 1080, vbitrate: 8000, shrink: null, out: "/o.mp4", ass: "" }).loudnorm).toBe(true);
    expect((await runAction("loud", { scope: "draft" })).detail).toBe("소리 고르게: 이미 적용됨");
    undo();
    expect(cur().fx).toBeUndefined();
    spy.mockRestore();
  });
});

describe("360 buttons", () => {
  it("applies presets per aspect; best aims the horizon at the upper third unless the view was aimed", async () => {
    open([clip("c1"), clip("c2", "a1", { view: v(30, -20), userSet: { view: 1 } }), clip("c3", "f1")]);
    await runAction("view.best", { scope: "draft" });
    expect(cur().clips[0].view).toEqual({ yaw: 0, pitch: -9.9, roll: 0, hfov: 91, dist: 0.3 });
    expect(cur().clips[0].viewPreset).toBe("best");
    expect(cur().clips[1].view).toMatchObject({ yaw: 30, pitch: -20, hfov: 91, dist: 0.3 });
    expect(cur().clips[2].viewPreset).toBeUndefined();
    await runAction("view.wide", { scope: "draft" });
    expect(cur().clips[0].view).toMatchObject({ hfov: 118, dist: 0.6, pitch: -9.9 });
    expect(cornerStretch(118, 0.6, aspectHW("16:9"))).toBeLessThan(1.3);
    await runAction("view.planet", { scope: "draft" });
    expect(cur().clips[0].view).toMatchObject({ hfov: 263, dist: 1, pitch: -90 });

    open([clip("c1", "a1", { viewKeys: [{ t: 0, view: v(0, 5) }, { t: 5, view: v(40, -40) }] })], "9:16");
    await runAction("view.zoom", { scope: "draft" });
    expect(cur().clips[0].viewKeys!.map((k) => [k.view.hfov, k.view.dist])).toEqual([[38, 0], [38, 0]]);
    // Keys keep their aim, only brought back to where the horizon shows.
    expect(cur().clips[0].viewKeys![0].view.pitch).toBe(5);
    expect(cur().clips[0].viewKeys![1].view.pitch).toBeGreaterThan(-30);
    expect(presetView("9:16", "zoom").hfov).toBe(38);
  });

  it("fixes distortion in one click and says so when there is nothing to fix", async () => {
    open([clip("c1", "a1", { view: v(0, 0, 0, 121), viewPreset: "wide" })]);
    const r = await runAction("undistort", { scope: "draft" });
    expect(cur().clips[0].view).toMatchObject({ hfov: 137.1, dist: 0.625 });
    expect(cur().clips[0].viewPreset).toBeUndefined();
    expect(r.detail).toBe("왜곡 보정: 121°→137° 왜곡 0.625");
    expect((await runAction("undistort", { scope: "draft" })).detail).toBe("왜곡 보정: 이미 적용됨");
  });

  it("joins sudden turns at cuts within one recording, not across recordings or hand-aimed clips", async () => {
    const clips = [clip("c1", "a1", { view: v(0) }), clip("c2", "a1", { start: 20, end: 30, view: v(90) }), clip("c3", "a2", { view: v(-120) }), clip("c4", "a2", { start: 40, end: 50, view: v(60), userSet: { view: 1 } })];
    open(clips);
    expect(cutJumps(cur(), assetMap()).map((j) => [j.clip, j.turn])).toEqual([["c2", 90], ["c4", 180]]);
    const r = await runAction("smooth.dir", { scope: "draft" });
    expect(r.changed).toBe(1);
    expect(r.skipped).toEqual(["c4"]);
    const keys = cur().clips[1].viewKeys!;
    expect(keys.map((k) => [k.t, k.view.yaw])).toEqual([[20, 0], [20.6, 90], [30, 90]]);
  });

  it("follows the people again without the AI, leaving hand-aimed clips unless forced", async () => {
    const marks = Array.from({ length: 9 }, (_, i) => ({ t: i * 1.25, x: 480 + 40, y: 240 }));
    open([clip("c1", "a1", { subjects: [{ name: "A", marks }] }), clip("c2", "a1", { start: 0, end: 10, subjects: [{ name: "A", marks }], userSet: { view: 1 } })]);
    const r = await runAction("reframe", { scope: "draft" });
    expect(r.changed).toBe(1);
    expect(r.skipped).toEqual(["c2"]);
    const ks = cur().clips[0].viewKeys!;
    expect(ks.length).toBeGreaterThan(50);
    expect(ks.every((k) => Math.abs(k.view.pitch) <= 30)).toBe(true);
    expect((await runAction("reframe", { scope: "draft", params: { force: true } })).changed).toBe(1);
  });
});

describe("shortcuts", () => {
  it("has no key bound twice in any layout", () => {
    for (const l of KEY_LAYOUTS) {
      applyKeymap(l.keys);
      const seen = new Map<string, string>();
      for (const c of COMMANDS) for (const k of c.keys?.split("|") ?? []) {
        expect(seen.get(k), `${l.id}: ${k} on ${c.id} and ${seen.get(k)}`).toBeUndefined();
        seen.set(k, c.id);
      }
    }
    applyKeymap(undefined);
    expect(COMMANDS.find((c) => c.id === "quick-level")?.keys).toBe("Alt+Shift+H");
    expect(COMMANDS.find((c) => c.id === "quick-view.best")?.keys).toBe("Alt+Shift+1");
  });

  it("reads Alt+Shift+digit as such, also with the Korean keyboard on", () => {
    const ev = (key: string, code: string, m: Partial<KeyboardEvent>) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m }) as KeyboardEvent;
    expect(eventKey(ev("!", "Digit1", { altKey: true, shiftKey: true }))).toBe("Alt+Shift+1");
    expect(eventKey(ev("1", "Digit1", { altKey: true }))).toBe("Alt+1");
    expect(eventKey(ev("ㅗ", "KeyH", { altKey: true, shiftKey: true }))).toBe("Alt+Shift+H");
    expect(eventKey(ev("Z", "KeyZ", { shiftKey: true }))).toBe("Shift+Z");
  });
});

describe("clips keep their own settings", () => {
  it("carries stabilisation and the view preset when pasting attributes", async () => {
    const { pasteAttrs } = await import("../src/edit");
    const from = clip("a", "a1", { stab: { mode: "lock", strength: 2, rs: true }, viewPreset: "wide", view: v(0, 0, 0, 118) });
    const to = pasteAttrs(clip("b"), from, ["stab", "view"]);
    expect(to.stab).toEqual(from.stab);
    expect(to.viewPreset).toBe("wide");
    expect(updateClip).toBeTypeOf("function");
  });
});

describe("누른 버튼은 AI가 지킨다", () => {
  const cl = (id: string, hfov: number): any => ({ id, asset: "a", start: 0, end: 5, speed: 1, volume: 1, view: { yaw: 0, pitch: 0, roll: 0, hfov, dist: 0.3 } });
  const dr = (clips: any[]): any => ({ id: "d", name: "d", aspect: "16:9", clips });

  it("marks only the clips a button really changed", () => {
    const a = cl("a", 91), b = cl("b", 91);
    const after = markButton(dr([a, b]), dr([{ ...a, view: { ...a.view, hfov: 118 } }, { ...b }]), "width", 5);
    expect(after.clips[0].userSet).toEqual({ width: 5 });
    expect(after.clips[1].userSet).toBeUndefined();
  });

  it("gives back the same draft when nothing changed", () => {
    const d = dr([cl("a", 91)]);
    const next = dr([{ ...d.clips[0] }]);
    expect(markButton(d, next, "width")).toBe(next);
  });

  it("reads the width the user picked, from the keys first", () => {
    expect(userWidth(cl("a", 91))).toBeNull();
    const c = { ...cl("a", 91), userSet: { width: 1 } };
    expect(userWidth(c)).toEqual({ hfov: 91, dist: 0.3 });
    expect(userWidth({ ...c, viewKeys: [{ t: 0, view: { yaw: 9, pitch: 0, roll: 0, hfov: 118, dist: 0.6 } }] })).toEqual({ hfov: 118, dist: 0.6 });
  });
});
