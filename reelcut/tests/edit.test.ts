import { describe, expect, it } from "vitest";
import { captionLines, toAss } from "../src/captions";
import {
  clipAt, cutClip, draftDuration, draftWords, isFiller, newDraft, outSize, removeFillers, removeRange, removeSilences, removeWords,
  silenceCuts, speechFromWave, splitAt, starts, toPlan,
} from "../src/edit";
import { flatToEquirect } from "../src/gl360";
import { pickCodec, SHRINK, shrinkSettings } from "../src/presets";
import type { Asset, Clip, Draft } from "../src/types";
import { DEFAULT_TRANSFORM as DT_, isDefaultTransform, outSize, parseAspect, silenceCuts, trimClipTo } from "../src/edit";
const DEFAULT_TRANSFORM = DT_;

const asset = (id: string, extra: Partial<Asset["info"]> = {}, words?: Asset["words"]): Asset => ({
  id, folder: "", words,
  info: { path: `C:/v/${id}.mp4`, name: `${id}.mp4`, ext: "mp4", kind: "video", size: 1, duration: 20, width: 1920, height: 1080, fps: 30, vcodec: "h264", acodec: "aac", channels: 2, has_audio: true, videos: [], djmd: false, layout360: "none", lrf: null, created: 0, recorded: "", bit_depth: 8, ...extra },
});
const clip = (id: string, a: string, start: number, end: number, speed = 1): Clip => ({ id, asset: a, start, end, speed, volume: 1 });
const draftOf = (clips: Clip[]): Draft => ({ ...newDraft("t"), clips });

describe("timeline", () => {
  const d = draftOf([clip("a", "A", 2, 6), clip("b", "B", 0, 4, 2)]);
  it("durations and starts", () => {
    expect(draftDuration(d)).toBe(6);
    expect(starts(d)).toEqual([0, 4]);
  });
  it("clipAt maps timeline to source with speed", () => {
    expect(clipAt(d, 1)).toMatchObject({ index: 0, src: 3 });
    expect(clipAt(d, 5)).toMatchObject({ index: 1, src: 2 });
  });
  it("splits at the playhead", () => {
    const s = splitAt(d, 5);
    expect(s.clips.map((c) => [c.start, c.end])).toEqual([[2, 6], [0, 2], [2, 4]]);
    expect(draftDuration(s)).toBeCloseTo(6);
  });
  it("removes a timeline range across clips", () => {
    const r = removeRange(d, 3, 5);
    expect(r.clips.map((c) => [c.start, c.end])).toEqual([[2, 5], [2, 4]]);
    expect(draftDuration(r)).toBeCloseTo(4);
  });
  it("cutClip keeps the pieces outside the cuts", () => {
    expect(cutClip(clip("x", "A", 0, 10), [[2, 3], [2.5, 4], [9.99, 12]]).map((c) => [c.start, c.end])).toEqual([[0, 2], [4, 9.99]]);
  });
});

describe("words", () => {
  const words = [
    { s: 0.5, e: 1.0, t: "안녕하세요" }, { s: 1.1, e: 1.3, t: "음" }, { s: 1.4, e: 2.0, t: "오늘은" },
    { s: 5.0, e: 5.6, t: "여기서" }, { s: 5.7, e: 6.3, t: "출발합니다." },
  ];
  const A = asset("A", {}, words);
  const am = new Map([["A", A]]);
  const d = draftOf([clip("c", "A", 0, 8)]);

  it("lists words with timeline times", () => {
    const ws = draftWords(d, am);
    expect(ws.map((w) => w.t)).toEqual(words.map((w) => w.t));
    expect(ws[3].t0).toBeCloseTo(5.0);
  });
  it("finds fillers", () => {
    expect(isFiller("음")).toBe(true);
    expect(isFiller("음...")).toBe(true);
    expect(isFiller("음식")).toBe(false);
    const r = removeFillers(d, am);
    expect(r.count).toBe(1);
    const left = draftWords(r.draft, am).map((w) => w.t);
    expect(left).toEqual(["안녕하세요", "오늘은", "여기서", "출발합니다."]);
  });
  it("removes selected words", () => {
    const all = draftWords(d, am);
    const r = removeWords(d, [all[3]], all);
    expect(draftWords(r, am).map((w) => w.t)).toEqual(["안녕하세요", "음", "오늘은", "출발합니다."]);
  });
  it("cuts silences from words with padding", () => {
    const r = removeSilences(d, am, new Map(), "normal");
    // speech 0.5–2.0 and 5.0–6.3; pad 0.2 → keep 0.3–2.2 and 4.8–6.5
    expect(r.draft.clips.map((c) => [c.start, c.end])).toEqual([[0.3, 2.2], [4.8, 6.5]]);
    expect(r.removed).toBeCloseTo(8 - 1.9 - 1.7, 5);
  });
  it("jump_cut is tighter than gentle", () => {
    const g = removeSilences(d, am, new Map(), "gentle").draft, j = removeSilences(d, am, new Map(), "jump_cut").draft;
    expect(draftDuration(j)).toBeLessThan(draftDuration(g));
  });
  it("silenceCuts does nothing without speech", () => {
    expect(silenceCuts(clip("x", "A", 0, 5), [], "tight")).toEqual([]);
  });
});

describe("waveform speech", () => {
  it("finds loud spans over the noise floor", () => {
    const w = new Uint8Array(500).fill(20);
    for (let i = 100; i < 200; i++) w[i] = 200;
    for (let i = 300; i < 320; i++) w[i] = 210;
    expect(speechFromWave(w, 0, 10)).toEqual([[2, 4], [6, 6.4]]);
  });
});

describe("captions", () => {
  it("groups words into short lines and writes ASS", () => {
    const am = new Map([["A", asset("A", {}, [{ s: 0, e: 0.4, t: "하나" }, { s: 0.5, e: 0.9, t: "둘" }, { s: 3, e: 3.4, t: "셋." }])]]);
    const ws = draftWords(draftOf([clip("c", "A", 0, 5)]), am);
    const lines = captionLines(ws, 18);
    expect(lines.map((l) => l.text)).toEqual(["하나 둘", "셋."]);
    const ass = toAss(lines, { size: 6, color: "#FFFFFF", outline: "#000000", position: "bottom", maxChars: 18, font: "Malgun Gothic" }, 1920, 1080);
    expect(ass).toContain("PlayResY: 1080");
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,0:00:00\.90,Default,,0,0,0,,\{[^}]*\}하나 둘/);
  });
});

describe("plan", () => {
  it("sends originals with 360 lens and view", () => {
    const A = asset("A", { ext: "osv", layout360: "dual", width: 7680, height: 3840 });
    const d = { ...draftOf([{ ...clip("c", "A", 1, 3, 2), view: { yaw: 30, pitch: 0, roll: 0, hfov: 90 } }]), aspect: "9:16" };
    const p = toPlan(d, new Map([["A", A]]), { mode: "shrink", short: 1080, vbitrate: 8000, shrink: shrinkSettings(SHRINK[1], "hevc", "mp4"), out: "o.mp4", ass: "" });
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(p.segs[0]).toMatchObject({ path: "C:/v/A.mp4", start: 1, dur: 2, speed: 2, lens: { layout: "dual", swap: false, fov: 190 }, view: { yaw: 30 } });
    expect(p.settings).toMatchObject({ codec: "hevc", crf: 24, acodec: "aac", container: "mp4" });
  });
  it("output sizes", () => {
    expect(outSize("16:9", 2160)).toEqual([3840, 2160]);
    expect(outSize("4:5", 1080)).toEqual([1080, 1350]);
  });
  it("auto codec prefers AV1 when the GPU has it", () => {
    expect(pickCodec("auto", { av1: "av1_nvenc" } as any)).toBe("av1");
    expect(pickCodec("auto", { av1: null } as any)).toBe("hevc");
  });
});

describe("360 view math (same as ffmpeg v360)", () => {
  const v = (yaw: number, pitch = 0, hfov = 90) => ({ yaw, pitch, roll: 0, hfov });
  it("looks straight ahead at the picture centre", () => {
    const [u, w] = flatToEquirect(0.5, 0.5, v(0), 16 / 9);
    expect(u).toBeCloseTo(0.5); expect(w).toBeCloseTo(0.5);
  });
  it("yaw 90 looks right", () => {
    expect(flatToEquirect(0.5, 0.5, v(90), 16 / 9)[0]).toBeCloseTo(0.75);
  });
  it("positive pitch looks up (v smaller, y down)", () => {
    expect(flatToEquirect(0.5, 0.5, v(0, 45), 16 / 9)[1]).toBeCloseTo(0.25);
  });
  it("the right edge is half the field of view away", () => {
    expect(flatToEquirect(1, 0.5, v(0, 0, 90), 16 / 9)[0]).toBeCloseTo(0.5 + 45 / 360);
  });
});

describe("화면 비율과 잘라 당기기", () => {
  it("makes any sensible canvas, the usual four as before", () => {
    expect(outSize("16:9", 1080)).toEqual([1920, 1080]);
    expect(outSize("9:16", 1080)).toEqual([1080, 1920]);
    expect(outSize("1:1", 1080)).toEqual([1080, 1080]);
    expect(outSize("4:5", 1080)).toEqual([1080, 1350]);
    expect(outSize("3:2", 1080)).toEqual([1620, 1080]);
    expect(outSize("2:3", 1080)).toEqual([1080, 1620]);
    expect(outSize("21:9", 1080)).toEqual([2520, 1080]);
    expect(outSize("엉터리", 1080)).toEqual([1920, 1080]);
  });
  it("refuses what is not a screen shape", () => {
    expect(parseAspect("3:2")).toEqual([3, 2]);
    expect(parseAspect(" 2.35:1 ")).toEqual([2.35, 1]);
    for (const bad of ["", "3", "3:0", "0:3", "4:1", "1:4", "a:b", "-1:1"]) expect(parseAspect(bad)).toBeNull();
  });
  it("trims a clip at a source time, keeping a little", () => {
    const d: any = { id: "d", name: "d", aspect: "16:9", clips: [{ id: "a", asset: "x", start: 10, end: 20, speed: 1, volume: 1 }] };
    expect(trimClipTo(d, "a", "start", 12)!.clips[0]).toMatchObject({ start: 12, end: 20 });
    expect(trimClipTo(d, "a", "end", 12)!.clips[0]).toMatchObject({ start: 10, end: 12 });
    expect(trimClipTo(d, "a", "start", 19.95)).toBeNull();
    expect(trimClipTo(d, "a", "end", 10.05)).toBeNull();
    expect(trimClipTo(d, "없음", "end", 12)).toBeNull();
  });
  it("keeps the chosen time around speech when cutting silence", () => {
    const c: any = { id: "a", asset: "x", start: 0, end: 10, speed: 1, volume: 1 };
    const sp: [number, number][] = [[2, 3], [7, 8]];
    expect(silenceCuts(c, sp, "normal", 0.5)).toEqual([[0, 1.5], [3.5, 6.5], [8.5, 10]]);
    expect(silenceCuts(c, sp, "normal", 0)).toEqual([[0, 2], [3, 7], [8, 10]]);
    expect(silenceCuts(c, sp, "normal")).toEqual(silenceCuts(c, sp, "normal", null));
  });
  it("counts a flip as a change", () => {
    expect(isDefaultTransform({ ...DEFAULT_TRANSFORM })).toBe(true);
    expect(isDefaultTransform({ ...DEFAULT_TRANSFORM, flip_h: true })).toBe(false);
    expect(isDefaultTransform({ ...DEFAULT_TRANSFORM, flip_v: true })).toBe(false);
  });
});
