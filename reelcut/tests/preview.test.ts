import { describe, expect, it } from "vitest";
import { promptName } from "../src/chats";
import { playableInWebView, previewSource } from "../src/edit";
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
