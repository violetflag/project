import { describe, expect, it } from "vitest";
import { promptName } from "../src/chats";
import { captionLines, toAss } from "../src/captions";
import { STICKERS, stickerSvgPath, textEvent, textLook } from "../src/graphics";
import { animAt, DEFAULT_CAPTION, fitMusic, mergeScenes, movePreset, volAt, newDraft, playableInWebView, previewSource, searchScenes } from "../src/edit";
import { dirToDfisheye } from "../src/gl360";
import type { Asset, MediaInfo } from "../src/types";

const info = (p: Partial<MediaInfo>): MediaInfo => ({
  path: "C:/v/a.mp4", name: "a.mp4", ext: "mp4", kind: "video", size: 1, duration: 10, width: 1920, height: 1080, fps: 30,
  vcodec: "h264", acodec: "aac", channels: 2, has_audio: true, videos: [{ index: 0, width: 1920, height: 1080, codec: "h264" }],
  djmd: false, layout360: "none", lrf: null, created: 0, recorded: "", bit_depth: 8, ...p,
});
const asset = (p: Partial<MediaInfo>): Asset => ({ id: "a", info: info(p), folder: "" });

describe("what the preview plays", () => {
  it("plays ordinary H.264 straight, sends what the WebView can't decode to the live stream", () => {
    expect(playableInWebView(info({}), false)).toBe(true);
    expect(playableInWebView(info({ bit_depth: 10 }), false)).toBe(false);
    expect(playableInWebView(info({ vcodec: "hevc", bit_depth: 10 }), false)).toBe(false);
    expect(playableInWebView(info({ vcodec: "hevc", bit_depth: 10 }), true)).toBe(true);
    expect(playableInWebView(info({ vcodec: "prores" }), true)).toBe(false);
    expect(playableInWebView(info({ ext: "mts" }), true)).toBe(false);
    expect(playableInWebView(info({ kind: "audio", vcodec: "" }), false)).toBe(true);
  });

  it("opens an .osv itself (live, stitched to a sphere) even when an .lrf is next to it", () => {
    const osv = asset({ ext: "osv", vcodec: "hevc", layout360: "dual", lrf: "C:/v/a.LRF", videos: [{ index: 0, width: 3840, height: 3840, codec: "hevc" }, { index: 1, width: 3840, height: 3840, codec: "hevc" }] });
    expect(playableInWebView(osv.info, true)).toBe(false);
    expect(previewSource(osv)).toMatchObject({ live: true, path: "C:/v/a.mp4", proj: "equirect" });
    expect(previewSource(asset({}))).toMatchObject({ live: false, proj: "flat" });
    expect(previewSource(asset({}), true)).toMatchObject({ live: true, proj: "flat" });
    expect(previewSource(asset({ layout360: "dfisheye" }))).toMatchObject({ live: false, proj: "dfisheye", fov: 190 });
  });
});

describe("side-by-side fisheyes (v360 dfisheye layout)", () => {
  it("puts ahead in the middle of the right lens and behind in the middle of the left", () => {
    expect(dirToDfisheye(0, 0, 1, 190)).toEqual([0.75, 0.5]);
    expect(dirToDfisheye(0, 0, -1, 190)).toEqual([0.25, 0.5]);
    expect(dirToDfisheye(0, 0, 1, 190, true)).toEqual([0.25, 0.5]);
  });
  it("mirrors the back lens and leaves out what neither lens saw", () => {
    const right = dirToDfisheye(Math.sin(0.5), 0, Math.cos(0.5), 190)!;
    const backRight = dirToDfisheye(Math.sin(0.5), 0, -Math.cos(0.5), 190)!;
    expect(right[0]).toBeGreaterThan(0.75);
    expect(backRight[0]).toBeLessThan(0.25);
    expect(dirToDfisheye(1, 0, 0, 170)).toBeNull();
    expect(dirToDfisheye(1, 0, 0, 190)).not.toBeNull();
  });
});

describe("saved prompts", () => {
  it("names a prompt after its first 20 characters", () => {
    expect(promptName("무음을 정리하고 자막을 켜 줘")).toBe("무음을 정리하고 자막을 켜 줘");
    expect(promptName("  핵심만 남겨서\n1분짜리 세로 쇼츠 편집본을 새로 만들어 줘")).toBe("핵심만 남겨서 1분짜리 세로 쇼츠 편…");
  });
});

describe("scene notes", () => {
  it("merges notes by the second, sorted, and ignores empty ones", () => {
    const a = mergeScenes([{ t: 10, text: "기린 앞" }], [{ t: 5, text: "입구" }, { t: 10.2, text: "기린 앞 아이들" }, { t: 20, text: "  " }]);
    expect(a.map((n) => n.text)).toEqual(["입구", "기린 앞 아이들"]);
  });
  it("finds moments by words, the best match first", () => {
    const assets = [{ id: "a", scenes: [{ t: 1, text: "미끄럼틀 타는 아이" }, { t: 9, text: "아이들이 기린 앞에 서 있음" }] }, { id: "b", scenes: [{ t: 3, text: "기린 조형물" }] }];
    const hits = searchScenes(assets, "기린 아이");
    expect(hits[0]).toMatchObject({ asset: "a", t: 9, score: 2 });
    expect(hits.map((h) => h.asset)).toContain("b");
    expect(searchScenes(assets, "   ")).toEqual([]);
    expect(searchScenes(assets, "바닷가")).toEqual([]);
  });
});

describe("titles, stickers and caption looks", () => {
  const word = (t: string, t0: number, t1: number) => ({ t, s: t0, e: t1, t0, t1, clip: "c", ci: 0, wi: 0, asset: "a" });
  it("writes titles and pins with position, size and fade, on top of the captions", () => {
    const e = textEvent({ id: "1", kind: "title", at: 2, dur: 3, text: "식물원 나들이" }, 1920, 1080);
    expect(e).toContain("Dialogue: 2,0:00:02.00,0:00:05.00,Default");
    expect(e).toContain("\\pos(960,454)");
    expect(e).toContain("\\fs119");
    expect(e).toContain("\\fad(300,300)");
    const pin = textEvent({ id: "2", kind: "pin", at: 0, dur: 5, text: "식물원 · 2026.10.25" }, 1920, 1080);
    expect(pin).toContain("\\p1");
    expect(pin).toContain("식물원 · 2026.10.25");
  });
  it("draws stickers as the same shape in the export and the preview", () => {
    const e = textEvent({ id: "3", kind: "sticker", at: 1, dur: 2, text: "", sticker: "heart", size: 20 }, 1000, 1000);
    expect(e).toContain(STICKERS.heart.path);
    expect(e).toContain("\\fscx200");
    expect(stickerSvgPath("heart").startsWith("M 50 90 C")).toBe(true);
    expect(textLook({ id: "4", kind: "sticker", at: 0, dur: 1, text: "", sticker: "star" }).color).toBe(STICKERS.star.color);
  });
  it("colours the word being spoken, one event per word", () => {
    const lines = captionLines([word("안녕", 1, 1.5), word("하세요", 1.5, 2)], 18);
    const ass = toAss(lines, { ...DEFAULT_CAPTION, highlight: "#FFE14D" }, 1280, 720);
    const ev = ass.split("\n").filter((l) => l.startsWith("Dialogue"));
    expect(ev).toHaveLength(2);
    expect(ev[0]).toContain("{\\c&H004DE1FF&}안녕{\\r} 하세요");
    expect(ev[1]).toContain("안녕 {\\c&H004DE1FF&}하세요{\\r}");
    const plain = toAss(lines, DEFAULT_CAPTION, 1280, 720).split("\n").filter((l) => l.startsWith("Dialogue"));
    expect(plain).toHaveLength(1);
  });
  it("uses a box instead of an outline when asked", () => {
    const ass = toAss([], { ...DEFAULT_CAPTION, box: true }, 1280, 720);
    expect(ass.split("\n").find((l) => l.startsWith("Style: Default"))).toMatch(/,3,\d+,0,2,/);
  });
});

describe("keyframes and music fit", () => {
  it("eases between keys and holds outside them", () => {
    const k = [{ t: 2, scale: 1, x: 0, y: 0, opacity: 1 }, { t: 4, scale: 1.2, x: 0.1, y: 0, opacity: 0.5 }];
    expect(animAt(k, 0).scale).toBe(1);
    expect(animAt(k, 3).scale).toBeCloseTo(1.1);
    expect(animAt(k, 3).opacity).toBeCloseTo(0.75);
    expect(animAt(k, 9).x).toBe(0.1);
    expect(volAt([{ t: 0, v: 1 }, { t: 2, v: 0 }], 1)).toBeCloseTo(0.5);
  });
  it("makes zoom and pan moves that never show the frame edge", () => {
    expect(movePreset("zoom_in", 5, 9).map((k) => k.scale)).toEqual([1, 1.15]);
    const pan = movePreset("pan_right", 0, 4);
    expect(pan[0].scale).toBe(1.15);
    expect(Math.abs(pan[0].x)).toBeLessThanOrEqual((1.15 - 1) / 2);
  });
  it("cuts long music with a fade and repeats short music to the end of the video", () => {
    const base = newDraft("t");
    const clip = { id: "c", asset: "a", start: 0, end: 30, speed: 1, volume: 1, fit: "fit" } as any;
    const m = { id: "m", asset: "s", start: 0, end: 10, at: 0, volume: 1, fadeIn: 0, fadeOut: 0, track: 2 } as any;
    const d = { ...base, clips: [clip], music: [m] };
    const long = fitMusic(d, "m", 100);
    expect(long.music).toHaveLength(1);
    expect(long.music[0].end).toBe(30);
    expect(long.music[0].fadeOut).toBe(2);
    const short = fitMusic(d, "m", 12);
    expect(short.music.map((x) => x.at)).toEqual([0, 12, 24]);
    expect(short.music[2].end).toBe(6);
    expect(short.music[2].fadeOut).toBe(2);
  });
});
