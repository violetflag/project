import { describe, expect, it } from "vitest";
import { promptName } from "../src/chats";
import { captionLines, draftCaptions, keyWordIndex, moveWordPrev, setHidden, setLineText, spokenIndex, toAss, toSrt, wordKey } from "../src/captions";
import { BUILTIN_SKILLS, expandSkillCommand, skillFromText, skillToText } from "../src/skills";
import { TOOLS } from "../src/agent";
import { NOT_IN_SCRIPT, SDK, transpileScript } from "../src/script";
import SDK_TYPES from "../sdk/reelcut.d.ts?raw";
import { CAPTION_PRESETS, STICKERS, stickerSvgPath, textEvent, textLook } from "../src/graphics";
import { BUILTIN_SKILLS, cleanSkillName, findSkill, skillCatalog, upsertSkill } from "../src/skills";
import { gazeSpans, CLIP_ATTRS, pasteAttrs, toSegs, transitionLook, TRANSITIONS, multicamDraft, isDefaultColor, LOOKS, animAt, DEFAULT_CAPTION, fitMusic, mergeScenes, movePreset, volAt, newDraft, playableInWebView, previewSource, searchScenes } from "../src/edit";
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
    expect(ev[0]).toMatch(/\{\\c&H004DE1FF&[^}]*\}안녕 \{\\c&H00FFFFFF&[^}]*\}하세요/);
    expect(ev[1]).toMatch(/\{\\c&H00FFFFFF&[^}]*\}안녕 \{\\c&H004DE1FF&[^}]*\}하세요/);
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

describe("multicam and looks", () => {
  it("cuts between recordings lined up by sound, keeping one sound", () => {
    const cam = (id: string, duration: number): Asset => ({ ...asset({ duration }), id, syncOffset: id === "b" ? 10 : 0 });
    const a = cam("a", 100), b = cam("b", 60);
    const d = multicamDraft("m", a, [{ at: 20, asset: a }, { at: 30, asset: b }, { at: 40, asset: a }], (x) => x.syncOffset ?? 0, 50);
    expect(d.clips.map((c) => [c.asset, c.start, c.end])).toEqual([["a", 20, 30], ["b", 20, 30], ["a", 40, 50]]);
    expect(d.clips.every((c) => c.volume === 0)).toBe(true);
    expect(d.music[0]).toMatchObject({ asset: "a", start: 20, end: 50, at: 0, track: 1 });
  });
  it("leaves out the part a camera did not record", () => {
    const a: Asset = { ...asset({ duration: 100 }), id: "a" }, b: Asset = { ...asset({ duration: 5 }), id: "b" };
    const d = multicamDraft("m", a, [{ at: 0, asset: b }, { at: 3, asset: a }], (x) => (x.id === "b" ? 2 : 0), 6);
    expect(d.clips.map((c) => [c.asset, c.start, c.end])).toEqual([["b", 0, 1], ["a", 3, 6]]);
  });
  it("counts the wider colour values as a change, and 'none' as back to neutral", () => {
    const base = { exposure: 0, contrast: 1, saturation: 1, temperature: 6500, lut: "" };
    expect(isDefaultColor(base)).toBe(true);
    expect(isDefaultColor({ ...base, vignette: 0.3 })).toBe(false);
    expect(isDefaultColor({ ...base, ...LOOKS.find((l) => l.id === "warm")!.color })).toBe(false);
    expect(isDefaultColor({ ...base, vignette: 0.3, ...LOOKS.find((l) => l.id === "none")!.color })).toBe(true);
  });
});

describe("skills", () => {
  const mine = { name: "쌍둥이 쇼츠", description: "쌍둥이 쇼츠 규칙", triggers: ["쇼츠"], body: "두 아이를 함께" };
  it("saves, replaces and finds a user's skill, and cleans its name", () => {
    expect(cleanSkillName("  쌍둥이 쇼츠! ")).toBe("쌍둥이_쇼츠");
    const a = upsertSkill([], mine);
    expect(a[0].name).toBe("쌍둥이_쇼츠");
    const b = upsertSkill(a, { ...mine, body: "새 내용" });
    expect(b).toHaveLength(1);
    expect(findSkill(b, "쌍둥이 쇼츠")?.body).toBe("새 내용");
    expect(findSkill(b, "vlog_edit")?.body).toContain("브이로그");
    expect(findSkill(b, "없는것")).toBeNull();
  });
  it("keeps the built-in names and refuses empty skills", () => {
    expect(() => upsertSkill([], { ...mine, name: "vlog_edit" })).toThrow();
    expect(() => upsertSkill([], { ...mine, body: "  " })).toThrow();
    expect(() => upsertSkill([], { ...mine, name: "!!!" })).toThrow();
  });
  it("lists the user's skills first for the AI, without their bodies", () => {
    const text = skillCatalog(upsertSkill([], mine));
    expect(text.indexOf("쌍둥이_쇼츠")).toBeLessThan(text.indexOf(BUILTIN_SKILLS[0].name));
    expect(text).not.toContain("두 아이를 함께");
    for (const k of BUILTIN_SKILLS) expect(text).toContain(k.name);
  });
});

describe("transitions, attributes and switched-off clips", () => {
  it("has 28 looks, each with its own preview", () => {
    expect(TRANSITIONS).toHaveLength(28);
    expect(new Set(TRANSITIONS.map((t) => t.id)).size).toBe(28);
    expect(transitionLook("wipeleft", 0.25).clipPath).toBe("inset(0 25% 0 0)");
    expect(transitionLook("slideup", 0.5).transform).toBe("translateY(-50%)");
    expect(transitionLook("fadeblack", 0.25).veil).toEqual({ color: "#000", opacity: 0.5 });
    expect(transitionLook("fadeblack", 0.75).hide).toBe(true);
    expect(transitionLook(undefined, 0.3).opacity).toBeCloseTo(0.7);
    for (const t of TRANSITIONS) expect(Object.keys(transitionLook(t.id, 0.5)).length).toBeGreaterThan(0);
  });
  it("pastes only what was chosen and moves keys to the target's own times", () => {
    const from: any = { id: "a", asset: "x", start: 10, end: 20, speed: 2, volume: 0.5, color: { exposure: 1 }, anim: [{ t: 10, scale: 1, x: 0, y: 0, opacity: 1 }, { t: 20, scale: 1.2, x: 0, y: 0, opacity: 1 }] };
    const to: any = { id: "b", asset: "y", start: 100, end: 104, speed: 1, volume: 1 };
    const a = pasteAttrs(to, from, ["color"]);
    expect(a.color).toEqual({ exposure: 1 });
    expect(a.speed).toBe(1);
    const b = pasteAttrs(to, from, ["motion"]);
    expect(b.anim!.map((k) => k.t)).toEqual([100, 104]);
    expect(CLIP_ATTRS.length).toBeGreaterThan(5);
  });
  it("keeps a switched-off clip's place as black and silence", () => {
    const a = asset({ duration: 30 });
    const d = { ...newDraft("t"), clips: [{ id: "c", asset: a.id, start: 0, end: 5, speed: 1, volume: 1, disabled: true } as any] };
    const [seg] = toSegs(d, new Map([[a.id, a]]));
    expect(seg.kind).toBe("gap");
    expect(seg.dur).toBe(5);
  });
});

describe("caption lines, styles and translation", () => {
  const w = (t: string, t0: number, wi = 0) => ({ t, s: t0, e: t0 + 0.3, clip: "c", ci: 0, wi, asset: "a", t0, t1: t0 + 0.3 } as any);
  const run = (list: string[]) => list.map((t, i) => w(t, i * 0.35, i));
  it("ends a long line at a natural place and keeps a lone short word with the line before", () => {
    const ws = run(["오늘은", "날씨가", "좋아서", "아이들과", "공원에", "다녀왔어요"]);
    const smart = captionLines(ws, 14);
    expect(smart[0].text).toBe("오늘은 날씨가 좋아서");
    const chars = captionLines(ws, 14, { breakBy: "chars" });
    expect(chars[0].text).not.toBe(smart[1].text);
  });
  it("makes two rows of similar length", () => {
    const [l] = captionLines(run(["첫번째줄에", "들어갈", "말과", "두번째줄에", "들어갈", "말"]), 14, { lines: 2 });
    expect(l.text.split("\n")).toHaveLength(2);
    const [a, b] = l.text.split("\n");
    expect(Math.abs(a.length - b.length)).toBeLessThan(6);
  });
  it("keeps hand changes against the spoken words", () => {
    const ws = run(["하나", "둘이", "셋이", "넷이"]);
    const [l] = captionLines(ws, 40);
    const fixed = setLineText(undefined, l, "하나 둘 셋이 넷이");
    expect(fixed.words).toEqual({ "a:1": "둘" });
    expect(captionLines(ws, 40, { edits: fixed })[0].text).toBe("하나 둘 셋이 넷이");
    const custom = setLineText(undefined, l, "전혀 다른 글");
    const [c] = captionLines(ws, 40, { edits: custom });
    expect([c.text, c.custom]).toEqual(["전혀 다른 글", true]);
    const split = captionLines(ws, 40, { edits: { breaks: { "a:2": "break" } } });
    expect(split.map((x) => x.text)).toEqual(["하나 둘이", "셋이 넷이"]);
    const moved = captionLines(ws, 40, { edits: moveWordPrev({ breaks: { "a:2": "break" } }, split[1]) });
    expect(moved.map((x) => x.text)).toEqual(["하나 둘이 셋이", "넷이"]);
    expect(captionLines(ws, 40, { edits: setHidden(undefined, "a:0", true) })[0].hidden).toBe(true);
  });
  it("picks key words and the spoken word", () => {
    const ws = [{ t: "오늘" }, { t: "3시에" }, { t: "만나기로했어요" }];
    expect(keyWordIndex(ws, "number")).toBe(1);
    expect(keyWordIndex(ws, "longest")).toBe(2);
    expect(keyWordIndex(ws, "none")).toBe(-1);
    const [l] = captionLines(run(["하나", "둘"]), 40);
    expect(spokenIndex(l, 0.1)).toBe(0);
    expect(spokenIndex(l, 0.4)).toBe(1);
  });
  it("writes entrances, marks and translation into the ASS", () => {
    const ws = run(["안녕", "하세요"]);
    const lines = captionLines(ws, 40);
    const st = { ...DEFAULT_CAPTION };
    expect(toAss(lines, { ...st, anim: "fade" }, 1920, 1080)).toContain("\\fad(180,0)");
    expect(toAss(lines, { ...st, anim: "rise" }, 1920, 1080)).toContain("\\move(960,");
    expect(toAss(lines, { ...st, markColor: "#7C4DFF" }, 1920, 1080)).toContain("\\3c&H00FF4D7C&");
    const typed = toAss(lines, { ...st, anim: "type" }, 1920, 1080);
    expect(typed).toContain("\\alpha&HFF&");
    expect((typed.match(/^Dialogue/gm) ?? []).length).toBe(2);
    const d = { ...newDraft("t"), captionStyle: st, translation: { lang: "영어", items: [{ from: "a:0", to: "a:1", text: "Hello" }] } };
    const c = draftCaptions(d, ws);
    expect(c.tr[0].text).toBe("Hello");
    const bothAss = toAss(c.lines, st, 1920, 1080, [], c.tr, "both");
    expect(bothAss).toContain(",Trans,,0,0,0,,");
    expect(bothAss).toContain("안녕");
    const trOnly = toAss(c.lines, st, 1920, 1080, [], c.tr, "tr");
    expect(trOnly).not.toContain("안녕");
    expect(toSrt(c.tr)).toContain("Hello");
    expect(wordKey(ws[1])).toBe("a:1");
  });
  it("has 15 distinct looks", () => {
    expect(CAPTION_PRESETS).toHaveLength(15);
    expect(new Set(CAPTION_PRESETS.map((p) => p.id)).size).toBe(15);
  });
});

describe("skills and gaze", () => {
  it("only names tools the AI has", () => {
    const known = new Set(TOOLS.map((t) => t.name));
    const words = new Set<string>();
    for (const k of BUILTIN_SKILLS) for (const m of k.body.matchAll(/\b([a-z]+_[a-z_]+)\b/g)) words.add(m[1]);
    // Values and guide names that look like tool names.
    const allowed = new Set([...BUILTIN_SKILLS.map((k) => k.name), "jump_cut", "break_by", "max_chars", "cut_source", "add_music", "add_overlay", "shrink_balanced", "shrink_small", "shrink_archive", "shrink_lecture", "break_before", "join_next", "move_word_prev", "fix_word", "set_line", "zoom_in", "zoom_out", "pan_left", "pan_right", "remove_range", "head_marks", "draft_id", "asset_id", "run_script", "set_view_keys"]);
    const unknown = [...words].filter((w) => !known.has(w) && !allowed.has(w));
    expect(unknown).toEqual([]);
    expect(BUILTIN_SKILLS).toHaveLength(33);
    expect(new Set(BUILTIN_SKILLS.map((k) => k.name)).size).toBe(33);
  });
  it("goes to text and back, and answers /name in chat", () => {
    const k = { name: "twins", description: "쌍둥이 쇼츠", triggers: ["쇼츠", "쌍둥이"], body: "1. 세로\n2. 15초" };
    expect(skillFromText(skillToText(k))).toEqual(k);
    expect(() => skillFromText("그냥 글")).toThrow();
    expect(expandSkillCommand("/twins 4분부터", [k])).toContain('"twins"');
    expect(expandSkillCommand("/twins 4분부터", [k])).toContain("4분부터");
    expect(expandSkillCommand("/없는것 해줘", [k])).toBe("/없는것 해줘");
  });
  it("joins looks facing the camera into stretches", () => {
    const f = (front: number) => ({ front });
    const spans = gazeSpans([{ t: 0, faces: [f(0.9)] }, { t: 2, faces: [f(0.8), f(0.7)] }, { t: 4, faces: [f(0.1)] }, { t: 6, faces: [] }, { t: 8, faces: [f(0.6)] }], 2);
    expect(spans).toEqual([{ from: 0, to: 4, faces: 2 }, { from: 8, to: 10, faces: 1 }]);
  });
});

describe("run_script", () => {
  it("declares every SDK method in the .d.ts and nothing more", () => {
    const body = SDK_TYPES.slice(SDK_TYPES.indexOf("declare const reelcut"));
    const declared: string[] = [];
    let group = "";
    for (const l of body.split("\n")) {
      const g = /^  (\w+): \{$/.exec(l);
      if (g) group = g[1];
      const m = /^    (\w+)\(/.exec(l);
      if (m) declared.push(`${group}.${m[1]}`);
    }
    expect(declared.sort()).toEqual(Object.keys(SDK).sort());
  });
  it("translates TypeScript and allows a top-level return", async () => {
    const js = await transpileScript("const n: number = 2;\nreturn n + 1;");
    expect(js).toContain("return n + 1");
    expect(js).not.toContain(": number");
    expect(new (Object.getPrototypeOf(async function () {}).constructor)(js)()).resolves.toBe(3);
  });
  it("refuses imports and reports errors by the script's own line", async () => {
    await expect(transpileScript('import x from "fs";')).rejects.toThrow("import");
    await expect(transpileScript('const m = await import("fs");')).rejects.toThrow("import");
    await expect(transpileScript("const a = 1;\nconst = 2;")).rejects.toThrow("2번째 줄");
  });
  it("keeps exporting, deleting and asking out of scripts", () => {
    for (const n of ["export_draft", "delete_draft", "ask_options", "run_script"]) expect(NOT_IN_SCRIPT.has(n)).toBe(true);
  });
});
