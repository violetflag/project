import { describe, expect, it } from "vitest";
import {
  clipAt, detachAudio, draftDuration, fmtTCF, GAP, insertClips, liftClip, mapTime, newClip, newDraft, newGap, newOverlay, parseTC, rangeDraft, refineWords, removeRange,
  rippleConnected, rollEdit, setTransition, setViewKey, slipClip, splitItem, starts, toPlan, viewAt,
} from "../src/edit";
import type { Asset, MusicClip } from "../src/types";

const asset = (id: string, duration = 20, extra: Partial<Asset["info"]> = {}): Asset => ({
  id, folder: "",
  info: { path: `/m/${id}.mp4`, name: `${id}.mp4`, ext: "mp4", kind: "video", size: 1, duration, width: 1920, height: 1080, fps: 30, vcodec: "h264", acodec: "aac", channels: 2, has_audio: true, videos: [], djmd: false, layout360: "none", lrf: null, created: 0, recorded: "", bit_depth: 8, ...extra },
});
const A = asset("a"), B = asset("b"), O360 = asset("o", 20, { layout360: "dual" });
const assets = new Map([A, B, O360].map((x) => [x.id, x]));
const two = () => insertClips(newDraft("t"), [newClip(A, 0, 4), newClip(B, 0, 6)]);

describe("dissolves", () => {
  it("overlap the clips and shorten the draft", () => {
    let d = two();
    d = setTransition(d, d.clips[1].id, 1);
    expect(starts(d)).toEqual([0, 3]);
    expect(draftDuration(d)).toBe(9);
    // In the overlap the incoming clip wins.
    expect(clipAt(d, 3.5)!.index).toBe(1);
    expect(clipAt(d, 2.9)!.index).toBe(0);
  });
  it("are clamped to half of the shorter clip", () => {
    let d = two();
    d = setTransition(d, d.clips[1].id, 10);
    expect(draftDuration(d)).toBe(8);
  });
  it("go into the plan", () => {
    let d = two();
    d = setTransition(d, d.clips[1].id, 0.5);
    const p = toPlan(d, assets, { mode: "standard", short: 1080, vbitrate: 8000, shrink: null, out: "o.mp4", ass: "" });
    expect(p.segs[1].xin).toBe(0.5);
  });
});

describe("gaps, lift, roll, slip", () => {
  it("lift leaves a gap of the same length", () => {
    const d0 = two();
    const d = liftClip(d0, d0.clips[0].id);
    const d2 = d;
    expect(d.clips[0].asset).toBe(GAP);
    expect(draftDuration(d2)).toBe(10);
    const p = toPlan(d, assets, { mode: "standard", short: 1080, vbitrate: 8000, shrink: null, out: "o.mp4", ass: "" });
    expect(p.segs[0]).toMatchObject({ kind: "gap", path: "", dur: 4 });
  });
  it("roll moves the cut and keeps the total", () => {
    const d0 = insertClips(newDraft("t"), [newClip(A, 2, 6), newClip(B, 3, 9)]);
    const d = rollEdit(d0, 1, 1, () => 20);
    expect(d.clips[0].end).toBe(7);
    expect(d.clips[1].start).toBe(4);
    expect(draftDuration(d)).toBe(draftDuration(d0));
  });
  it("slip keeps the length inside the source", () => {
    const d0 = insertClips(newDraft("t"), [newClip(A, 2, 6)]);
    const d = slipClip(d0, d0.clips[0].id, 30, 20);
    expect(d.clips[0]).toMatchObject({ start: 16, end: 20 });
  });
  it("gaps count in the duration", () => {
    const d = insertClips(two(), [newGap(2)], 1);
    expect(draftDuration(d)).toBe(12);
  });
});

describe("connected tracks", () => {
  it("overlays follow their picture when the main track is cut", () => {
    let d = two();
    const o = newOverlay(B, 6); // over clip b, 2 s into it
    d = { ...d, overlays: [o] };
    const cut = removeRange(d, 1, 2); // 1 s out of clip a
    const after = rippleConnected(d, cut);
    expect(after.overlays![0].at).toBeCloseTo(5, 3);
  });
  it("music on A2 stays where it is", () => {
    let d = two();
    const m: MusicClip = { id: "m", asset: "b", start: 0, end: 5, at: 6, volume: 0.3, fadeIn: 0, fadeOut: 0, track: 2 };
    d = { ...d, music: [m] };
    const after = rippleConnected(d, removeRange(d, 1, 2));
    expect(after.music[0].at).toBe(6);
  });
  it("mapTime jumps past a cut source frame to the next kept one", () => {
    const d = two();
    const cut = removeRange(d, 1, 2);
    expect(mapTime(d, cut, 1.5)).toBeCloseTo(1, 3);
  });
  it("splits an overlay at a time", () => {
    let d = two();
    const o = newOverlay(B, 2, 2, 0, 6);
    d = { ...d, overlays: [o] };
    const s = splitItem(d, o.id, 4);
    expect(s.overlays!.map((x) => [x.at, x.start, x.end])).toEqual([[2, 0, 2], [4, 2, 6]]);
  });
  it("detaches a clip's sound to A1", () => {
    const d0 = two();
    const d = detachAudio(d0, d0.clips[0].id);
    const d2 = detachAudio(d0, d0.clips[1].id);
    expect(d.clips[0].detached).toBe(true);
    expect(d.clips[0].volume).toBe(0);
    expect(d.music[0]).toMatchObject({ track: 1, at: 0, start: 0, end: 4 });
    expect(d2.music[0].at).toBe(4);
  });
  it("overlays and track state reach the plan", () => {
    let d = two();
    d = { ...d, overlays: [newOverlay(B, 8, 3)], tracks: { A1: { mute: true } } };
    const p = toPlan(d, assets, { mode: "standard", short: 1080, vbitrate: 8000, shrink: null, out: "o.mp4", ass: "", loudnorm: true, duck: true });
    expect(p.overlays).toHaveLength(1);
    expect(p.overlays![0]).toMatchObject({ track: 3, at: 8, volume: 0 });
    // Cut at the end of the timeline (10 s): 2 s left.
    expect(p.overlays![0].dur).toBe(2);
    expect(p.segs.every((s) => s.volume === 0)).toBe(true);
    expect(p).toMatchObject({ loudnorm: true, duck: true, abr: 256 });
  });
  it("exports an in/out range", () => {
    let d = two();
    d = { ...d, overlays: [newOverlay(B, 6, 2, 0, 1)] };
    const r = rangeDraft(d, 2, 8);
    expect(draftDuration(r)).toBeCloseTo(6, 3);
    expect(r.overlays![0].at).toBeCloseTo(4, 3);
  });
});

describe("360 keyframes", () => {
  it("interpolates and turns the short way round", () => {
    const keys = setViewKey(setViewKey([], 0, { yaw: 170, pitch: 0, roll: 0, hfov: 100 }), 2, { yaw: -170, pitch: 10, roll: 0, hfov: 80 });
    const v = viewAt(undefined, keys, 1);
    expect(Math.abs(v.yaw)).toBeCloseTo(180, 3);
    expect(v.pitch).toBeCloseTo(5, 3);
    expect(v.hfov).toBeCloseTo(90, 3);
    expect(viewAt(undefined, keys, -1).yaw).toBe(170);
  });
  it("sends output-time keys only when they animate", () => {
    const c = { ...newClip(O360, 4, 10), speed: 2 };
    c.viewKeys = setViewKey(setViewKey([], 4, { yaw: 0, pitch: 0, roll: 0, hfov: 100 }), 8, { yaw: 90, pitch: 0, roll: 0, hfov: 100 });
    const d = insertClips(newDraft("t"), [c]);
    const p = toPlan(d, assets, { mode: "standard", short: 1080, vbitrate: 8000, shrink: null, out: "o.mp4", ass: "" });
    expect(p.segs[0].view_keys!.map((k) => k.t)).toEqual([0, 2]);
    const one = insertClips(newDraft("t"), [{ ...c, viewKeys: [c.viewKeys[1]] }]);
    const p1 = toPlan(one, assets, { mode: "standard", short: 1080, vbitrate: 8000, shrink: null, out: "o.mp4", ass: "" });
    expect(p1.segs[0].view_keys).toEqual([]);
    expect(p1.segs[0].view!.yaw).toBe(90);
  });
});

describe("timecode", () => {
  it("formats and parses frames", () => {
    expect(fmtTCF(61.5, 30)).toBe("00:01:01:15");
    expect(parseTC("00:01:01:15", 30)).toBeCloseTo(61.5, 6);
    expect(parseTC("1:30")).toBe(90);
    expect(parseTC("12.5")).toBe(12.5);
    expect(parseTC("x")).toBeNull();
  });
});

describe("word time repair", () => {
  // 50 values per second: speech 1–3 s and 7–9 s, silence elsewhere.
  const wave = Array.from({ length: 50 * 12 }, (_, i) => ((i >= 50 && i < 150) || (i >= 350 && i < 450) ? 220 : 20));
  it("moves words squeezed into a pause onto the next speech and drops made-up ones", () => {
    const words = [
      { s: 1, e: 2, t: "안녕하세요" }, { s: 2, e: 3, t: "여러분" },
      { s: 4.0, e: 4.01, t: "오늘은" }, { s: 4.0, e: 4.01, t: "날씨가" }, { s: 4.0, e: 9, t: "좋네요" },
      { s: 10.5, e: 11.5, t: "감사합니다" },
    ];
    const r = refineWords(words, wave, 12);
    expect(r.map((w) => w.t)).toEqual(["안녕하세요", "여러분", "오늘은", "날씨가", "좋네요"]);
    expect(r[2].s).toBeGreaterThanOrEqual(6.9);
    expect(r[4].e).toBeLessThanOrEqual(9.1);
  });
});

describe("word time repair across a pause", () => {
  // speech 1–3 s, silence 3–7 s, speech 7–9 s
  const wave = Array.from({ length: 50 * 12 }, (_, i) => ((i >= 50 && i < 150) || (i >= 350 && i < 450) ? 220 : 20));
  it("keeps a word that runs into the pause before it, and one that starts in it after it", () => {
    const words = [{ s: 1, e: 2, t: "날씨가" }, { s: 2, e: 7.2, t: "좋네요." }, { s: 2.9, e: 7.4, t: "여기서" }, { s: 7.4, e: 9, t: "쉬었다가" }];
    const r = refineWords(words, wave, 12);
    expect(r[1].e).toBeLessThanOrEqual(3.05);
    expect(r[2].s).toBeGreaterThanOrEqual(6.95);
  });
});
