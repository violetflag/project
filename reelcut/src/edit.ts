// Pure edit operations on drafts (no I/O), so they can be unit-tested and shared by the
// editor and the AI agent.

import { normView, smoothViewAt } from "./framing";
import type { AnimKey, Asset, CaptionStyle, Clip, ColorAdj, Draft, Lens, MediaInfo, MusicClip, Overlay, Plan, PlanOverlay, SceneNote, Seg, ShrinkSettings, Stab, TrackId, Transform, View, ViewKey, VolKey, Word } from "./types";

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const DEFAULT_CAPTION: CaptionStyle = { size: 6, color: "#FFFFFF", outline: "#000000", position: "bottom", maxChars: 18, font: "Malgun Gothic" };

/** Asset id of an empty stretch on the main track. */
export const GAP = "__gap";
export const isGap = (c: Clip) => c.asset === GAP;
export const newGap = (dur: number): Clip => ({ id: uid(), asset: GAP, start: 0, end: r3(Math.max(0.1, dur)), speed: 1, volume: 0 });

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, crop_l: 0, crop_r: 0, crop_t: 0, crop_b: 0, opacity: 1 };
export const DEFAULT_COLOR: ColorAdj = { exposure: 0, contrast: 1, saturation: 1, temperature: 6500, lut: "" };
export const isDefaultTransform = (t?: Transform | null) => !t || Object.keys(DEFAULT_TRANSFORM).every((k) => Math.abs((t as any)[k] - (DEFAULT_TRANSFORM as any)[k]) < 1e-6);
export const isDefaultColor = (c?: ColorAdj | null) => !c || (Math.abs(c.exposure) < 1e-6 && Math.abs(c.contrast - 1) < 1e-6 && Math.abs(c.saturation - 1) < 1e-6 && Math.abs(c.temperature - 6500) < 1 && !c.lut && !c.tint && !c.highlights && !c.shadows && !c.vibrance && !c.vignette);

/** Ready-made looks: colour values applied over the clip's own. */
export const LOOKS: { id: string; label: string; color: Partial<ColorAdj> }[] = [
  { id: "warm", label: "따뜻한 필름", color: { temperature: 5400, saturation: 0.95, contrast: 1.05, shadows: 0.15, vignette: 0.35, vibrance: 0, tint: 0, highlights: 0 } },
  { id: "cool", label: "시원하게", color: { temperature: 7600, saturation: 1, contrast: 1.05, shadows: 0, vignette: 0, vibrance: 0.1, tint: 0, highlights: 0 } },
  { id: "vivid", label: "생생하게", color: { temperature: 6500, saturation: 1.05, contrast: 1.12, shadows: 0.05, vignette: 0, vibrance: 0.4, tint: 0, highlights: -0.1 } },
  { id: "soft", label: "부드럽게", color: { temperature: 6300, saturation: 0.95, contrast: 0.92, shadows: 0.25, vignette: 0, vibrance: 0, tint: 0, highlights: -0.15 } },
  { id: "bw", label: "흑백", color: { temperature: 6500, saturation: 0, contrast: 1.12, shadows: 0, vignette: 0.3, vibrance: 0, tint: 0, highlights: 0 } },
  { id: "none", label: "원래대로", color: { exposure: 0, temperature: 6500, saturation: 1, contrast: 1, shadows: 0, vignette: 0, vibrance: 0, tint: 0, highlights: 0 } },
];

/**
 * A multicam edit from recordings lined up by their sound: the picture cuts between them at the
 * given timeline moments, the sound stays with one recording throughout (A1). Offsets are seconds
 * of the reference timeline where each recording starts.
 */
export function multicamDraft(name: string, sound: Asset, cuts: { at: number; asset: Asset }[], offset: (a: Asset) => number, end: number, aspect = "16:9"): Draft {
  const d = newDraft(name, aspect);
  const ordered = cuts.slice().sort((a, b) => a.at - b.at);
  const first = ordered.length ? ordered[0].at : 0;
  const clips: Clip[] = [];
  ordered.forEach((c, i) => {
    const to = Math.min(end, i + 1 < ordered.length ? ordered[i + 1].at : end);
    const off = offset(c.asset);
    // Only the part this recording actually covers.
    const s = Math.max(0, c.at - off), e = Math.min(c.asset.info.duration, to - off);
    if (e - s < 0.05) return;
    clips.push({ ...newClip(c.asset, r3(s), r3(e)), volume: 0, detached: true });
  });
  const so = offset(sound);
  const music: MusicClip[] = [{ id: uid(), asset: sound.id, start: r3(Math.max(0, first - so)), end: r3(Math.min(sound.info.duration, end - so)), at: 0, volume: 1, fadeIn: 0, fadeOut: 0, track: 1 }];
  return { ...d, clips, music };
}

export function newDraft(name: string, aspect = "16:9", fps = 30): Draft {
  const now = Date.now();
  return { id: uid(), name, clips: [], overlays: [], music: [], markers: [], captions: false, captionStyle: { ...DEFAULT_CAPTION }, aspect, fps, tracks: {}, created: now, updated: now };
}

export const trackState = (d: Draft, t: TrackId) => d.tracks?.[t] ?? {};
/** Music/sound items on one audio track (A2 is the default for older drafts). */
export const audioTrack = (m: MusicClip) => m.track ?? 2;

export const is360 = (a?: Asset) => !!a && a.info.layout360 !== "none" && a.info.kind === "video";

/** The looks a dissolve can have (the export's xfade names). */
export const TRANSITIONS: { id: string; label: string }[] = [
  { id: "fade", label: "디졸브" }, { id: "dissolve", label: "점점이 녹이기" }, { id: "fadeblack", label: "검은 화면 거쳐" }, { id: "fadewhite", label: "흰 화면 거쳐" },
  { id: "fadegrays", label: "흑백 거쳐" }, { id: "distance", label: "밝기로 스며들기" }, { id: "wipeleft", label: "닦기 ←" }, { id: "wiperight", label: "닦기 →" },
  { id: "wipeup", label: "닦기 ↑" }, { id: "wipedown", label: "닦기 ↓" }, { id: "slideleft", label: "밀기 ←" }, { id: "slideright", label: "밀기 →" },
  { id: "slideup", label: "밀기 ↑" }, { id: "slidedown", label: "밀기 ↓" }, { id: "smoothleft", label: "부드럽게 밀기 ←" }, { id: "smoothright", label: "부드럽게 밀기 →" },
  { id: "circleopen", label: "원 열기" }, { id: "circleclose", label: "원 닫기" }, { id: "circlecrop", label: "원 닫고 열기" }, { id: "rectcrop", label: "네모 닫고 열기" },
  { id: "vertopen", label: "좌우로 열기" }, { id: "horzopen", label: "위아래로 열기" }, { id: "radial", label: "시계 방향" }, { id: "diagtl", label: "대각선 ↖" },
  { id: "diagbr", label: "대각선 ↘" }, { id: "squeezeh", label: "옆으로 눌러 넘기기" }, { id: "zoomin", label: "확대하며" }, { id: "pixelize", label: "모자이크" },
];

export type TransitionLook = { opacity?: number; clipPath?: string; transform?: string; filter?: string; mask?: string; veil?: { color: string; opacity: number }; hide?: boolean };

/** How the outgoing picture (laid over the incoming one) looks `p` (0–1) through a transition, for the preview. */
export function transitionLook(type: string | undefined, p0: number): TransitionLook {
  const p = Math.max(0, Math.min(1, p0));
  const n = (v: number) => Math.round(v * 1000) / 10;
  switch (type) {
    case "fadeblack": case "fadewhite": return { hide: p >= 0.5, veil: { color: type === "fadeblack" ? "#000" : "#fff", opacity: 1 - Math.abs(2 * p - 1) } };
    case "fadegrays": return { opacity: 1 - p, filter: `grayscale(${Math.min(1, 2 * p)})` };
    case "wipeleft": case "smoothleft": return { clipPath: `inset(0 ${n(p)}% 0 0)` };
    case "wiperight": case "smoothright": return { clipPath: `inset(0 0 0 ${n(p)}%)` };
    case "wipeup": return { clipPath: `inset(0 0 ${n(p)}% 0)` };
    case "wipedown": return { clipPath: `inset(${n(p)}% 0 0 0)` };
    case "slideleft": return { transform: `translateX(${-n(p)}%)` };
    case "slideright": return { transform: `translateX(${n(p)}%)` };
    case "slideup": return { transform: `translateY(${-n(p)}%)` };
    case "slidedown": return { transform: `translateY(${n(p)}%)` };
    case "circleopen": { const r = n(p * 0.75); return { mask: `radial-gradient(circle at center, transparent ${r}%, #000 ${r}%)` }; }
    case "circleclose": return { clipPath: `circle(${n((1 - p) * 0.75)}% at center)` };
    case "circlecrop": return { clipPath: `circle(${n((1 - p) * 0.75)}% at center)`, veil: { color: "#000", opacity: p > 0.5 ? 2 - 2 * p : 2 * p } };
    case "rectcrop": return { clipPath: `inset(${n(p / 2)}%)`, veil: { color: "#000", opacity: p > 0.5 ? 2 - 2 * p : 2 * p } };
    case "vertopen": return { mask: `linear-gradient(to right, #000 ${n((1 - p) / 2)}%, transparent ${n((1 - p) / 2)}%, transparent ${n((1 + p) / 2)}%, #000 ${n((1 + p) / 2)}%)` };
    case "horzopen": return { mask: `linear-gradient(to bottom, #000 ${n((1 - p) / 2)}%, transparent ${n((1 - p) / 2)}%, transparent ${n((1 + p) / 2)}%, #000 ${n((1 + p) / 2)}%)` };
    case "radial": return { mask: `conic-gradient(transparent ${Math.round(p * 360)}deg, #000 0)` };
    case "diagtl": return { mask: `linear-gradient(135deg, transparent ${n(p)}%, #000 ${n(p)}%)` };
    case "diagbr": return { mask: `linear-gradient(315deg, transparent ${n(p)}%, #000 ${n(p)}%)` };
    case "squeezeh": return { transform: `scaleX(${(1 - p).toFixed(3)})` };
    case "zoomin": return { opacity: 1 - p, transform: `scale(${(1 + p).toFixed(3)})` };
    case "pixelize": return { opacity: 1 - p, filter: `blur(${(p * 14).toFixed(1)}px)` };
    default: return { opacity: 1 - p };
  }
}

/** A file name that may be a whole path: its folder (only when the path is absolute) and the bare name, without a media extension. */
export function splitOutName(given: string): { dir: string; name: string } {
  const t = given.trim();
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  const name = t.slice(i + 1).replace(/\.(mp4|m4v|mov|mkv|webm|avi|wav|mp3|m4a)$/i, "");
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(t)) return { dir: "", name };
  const folder = t.slice(0, i);
  return { dir: /^[a-zA-Z]:$/.test(folder) ? `${folder}\\` : folder || t[0], name };
}

/** Stretches where a face points at the camera, from looks taken every `step` seconds. */
export function gazeSpans(looks: { t: number; faces: { front: number; w?: number }[] }[], step: number, minWidth = 0, min = 0.55): { from: number; to: number; faces: number }[] {
  const out: { from: number; to: number; faces: number }[] = [];
  for (const l of [...looks].sort((a, b) => a.t - b.t)) {
    const n = l.faces.filter((f) => f.front >= min && (f.w ?? Infinity) >= minWidth).length;
    if (!n) continue;
    const last = out[out.length - 1];
    if (last && l.t - last.to <= step * 0.5) { last.to = r3(l.t + step); last.faces = Math.max(last.faces, n); } else out.push({ from: r3(l.t), to: r3(l.t + step), faces: n });
  }
  return out;
}

/** On a 360 sheet (960 wide) a passer-by's face is tiny; the people being filmed are at least this wide. */
export const GAZE_MIN_FACE_360 = 22;

/** Groups of a clip's settings that can be copied onto other clips. */
export const CLIP_ATTRS: { id: string; label: string; keys: (keyof Clip)[] }[] = [
  { id: "color", label: "색", keys: ["color"] },
  { id: "transform", label: "위치·크기·자르기", keys: ["transform", "fit"] },
  { id: "motion", label: "움직임", keys: ["anim"] },
  { id: "speed", label: "속도", keys: ["speed"] },
  { id: "sound", label: "음량·잡음 줄이기", keys: ["volume", "volKeys", "denoise"] },
  { id: "fades", label: "페이드", keys: ["fadeIn", "fadeOut"] },
  { id: "transition", label: "전환", keys: ["xin", "xtype"] },
  { id: "view", label: "360 시점", keys: ["view", "viewPreset"] },
  { id: "stab", label: "흔들림 줄이기", keys: ["stab"] },
];

/** The chosen settings of `from` copied onto `to`. Moves keep their shape, moved to the target's own times. */
export function pasteAttrs(to: Clip, from: Clip, attrs: string[]): Clip {
  const out: Clip = { ...to };
  for (const g of CLIP_ATTRS) {
    if (!attrs.includes(g.id)) continue;
    for (const k of g.keys) (out as any)[k] = (from as any)[k];
  }
  const retime = <K extends { t: number }>(ks: K[] | undefined): K[] | undefined => {
    if (!ks?.length) return ks;
    const f = (from.end - from.start) || 1, tl = to.end - to.start;
    return ks.map((k) => ({ ...k, t: r3(to.start + ((k.t - from.start) / f) * tl) }));
  };
  if (attrs.includes("motion")) out.anim = retime(from.anim);
  if (attrs.includes("sound")) out.volKeys = retime(from.volKeys);
  return out;
}

const ease = (a: number, b: number, f: number) => a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * f));
function keyAt<K extends { t: number }>(keys: K[], t: number, mix: (a: K, b: K, f: number) => K): K {
  const k = keys.slice().sort((a, b) => a.t - b.t);
  if (t <= k[0].t) return k[0];
  for (let i = 0; i + 1 < k.length; i++) if (t < k[i + 1].t) return mix(k[i], k[i + 1], (t - k[i].t) / Math.max(1e-3, k[i + 1].t - k[i].t));
  return k[k.length - 1];
}
/** The picture's size, place and opacity at source second t (same easing as the export). */
export function animAt(keys: AnimKey[], t: number): AnimKey {
  return keyAt(keys, t, (a, b, f) => ({ t, scale: ease(a.scale, b.scale, f), x: ease(a.x, b.x, f), y: ease(a.y, b.y, f), opacity: ease(a.opacity, b.opacity, f) }));
}
/** The loudness at source second t. */
export function volAt(keys: VolKey[], t: number): number {
  return keyAt(keys, t, (a, b, f) => ({ t, v: ease(a.v, b.v, f) })).v;
}

export type MovePreset = "zoom_in" | "zoom_out" | "pan_right" | "pan_left";
export const MOVE_PRESETS: { id: MovePreset; label: string }[] = [
  { id: "zoom_in", label: "천천히 확대" }, { id: "zoom_out", label: "천천히 축소" }, { id: "pan_right", label: "오른쪽으로 이동" }, { id: "pan_left", label: "왼쪽으로 이동" },
];
/** Slow zoom or pan over a clip (Ken Burns), keys in source seconds. */
export function movePreset(p: MovePreset, start: number, end: number, amount = 0.15): AnimKey[] {
  const k = (t: number, scale: number, x: number): AnimKey => ({ t: r3(t), scale: r3(scale), x: r3(x), y: 0, opacity: 1 });
  const s = 1 + Math.max(0.02, amount), off = (s - 1) / 2 - 0.005;
  switch (p) {
    case "zoom_in": return [k(start, 1, 0), k(end, s, 0)];
    case "zoom_out": return [k(start, s, 0), k(end, 1, 0)];
    case "pan_right": return [k(start, s, off), k(end, s, -off)];
    case "pan_left": return [k(start, s, -off), k(end, s, off)];
  }
}

/**
 * Fits a piece of music to the rest of the draft from where it starts: cut with a fade-out if it is
 * longer, repeated with short fades if it is shorter.
 */
export function fitMusic(d: Draft, id: string, assetDur: number, fade = 2): Draft {
  const m = d.music.find((x) => x.id === id);
  if (!m) return d;
  const want = draftDuration(d) - m.at;
  const piece = Math.max(1, assetDur - m.start);
  if (want <= 0.5) return d;
  const parts: MusicClip[] = [];
  let at = m.at;
  while (at < m.at + want - 0.05) {
    const len = Math.min(piece, m.at + want - at);
    const last = at + len >= m.at + want - 0.05;
    parts.push({ ...m, id: parts.length ? uid() : m.id, at: r3(at), end: r3(m.start + len), fadeIn: parts.length ? 0.5 : m.fadeIn, fadeOut: last ? Math.min(fade, len / 2) : 0.5, volKeys: undefined });
    at += len;
  }
  return { ...d, music: d.music.flatMap((x) => (x.id === id ? parts : [x])), updated: Date.now() };
}

/** Scene notes merged into a list sorted by time; a note at the same second replaces the old one. */
export function mergeScenes(old: SceneNote[] | undefined, add: SceneNote[]): SceneNote[] {
  const by = new Map((old ?? []).map((n) => [Math.round(n.t), n]));
  for (const n of add) if (Number.isFinite(n.t) && String(n.text ?? "").trim()) by.set(Math.round(n.t), { t: r3(Math.max(0, n.t)), text: String(n.text).trim() });
  return [...by.values()].sort((a, b) => a.t - b.t);
}

export type SceneHit = { asset: string; t: number; text: string; score: number };

/** Moments whose notes contain the words of `query` (best matches first; every word counts). */
export function searchScenes(assets: Pick<Asset, "id" | "scenes">[], query: string, limit = 30): SceneHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: SceneHit[] = [];
  for (const a of assets) {
    for (const n of a.scenes ?? []) {
      const text = n.text.toLowerCase();
      const score = words.filter((w) => text.includes(w)).length;
      if (score) hits.push({ asset: a.id, t: n.t, text: n.text, score });
    }
  }
  return hits.sort((x, y) => y.score - x.score || x.t - y.t).slice(0, limit);
}

/**
 * Whether the WebView's video element can decode a file itself. The rest (an Osmo .osv's two lens
 * tracks, 10-bit H.264, ProRes, MPEG-TS…) goes through the live preview (src-tauri/src/live.rs).
 * HEVC plays only with the system's HEVC extension (`hevc`).
 */
export function playableInWebView(info: MediaInfo, hevc: boolean): boolean {
  if (info.kind !== "video") return true;
  if (info.layout360 === "dual" || info.videos.length > 1) return false;
  if (["avi", "mts", "m2ts", "ts", "mxf", "wmv", "flv", "mpg", "mpeg", "3gp", "insv", "360"].includes(info.ext)) return false;
  switch (info.vcodec) {
    case "h264": return (info.bit_depth || 8) <= 8;
    case "vp8": case "vp9": case "av1": return true;
    case "hevc": return hevc;
    default: return false;
  }
}

/**
 * What the preview plays for a file; nothing is converted ahead of time. `live`: ffmpeg decodes the
 * original as it plays (an .osv's lenses stitched into a sphere on the way); otherwise the WebView
 * plays the file and WebGL draws a 360 one flat (two side-by-side fisheyes shown unstitched).
 */
export type PreviewSrc = { live: boolean; path: string; proj: "flat" | "equirect" | "dfisheye"; fov: number; swap: boolean };
export function previewSource(a: Asset, live = false): PreviewSrc {
  const lens = { fov: a.lens?.fov ?? 190, swap: a.lens?.swap ?? false };
  const l = a.info.kind === "video" ? a.info.layout360 : "none";
  if (a.info.kind === "video" && (live || l === "dual")) return { live: true, path: a.info.path, proj: l === "none" ? "flat" : "equirect", ...lens };
  return { live: false, path: a.info.path, proj: l === "equirect" || l === "dfisheye" ? l : "flat", ...lens };
}
export function defaultLens(a: Asset): Lens {
  return a.lens ?? { layout: a.info.layout360 === "none" ? "none" : a.info.layout360, swap: false, fov: 190 };
}
/** Stabilisation a clip uses: its own (toolbar 흔들림 줄이기 / 수평 맞추기), else its media's (null = the default, horizon). */
export const stabFor = (c: Pick<Clip, "stab">, a: Asset | undefined): Stab | null => c.stab ?? a?.lens?.stab ?? null;
/** The lens a clip renders with: the media's, with the clip's own stabilisation when it has one. */
/** The width the user picked with a view button, if any. */
export function userWidth(c: Clip): { hfov: number; dist: number } | null {
  const v = c.viewKeys?.[0]?.view ?? c.view;
  return c.userSet?.width && v ? { hfov: v.hfov, dist: v.dist ?? 0 } : null;
}

export const lensFor = (c: Pick<Clip, "stab">, a: Asset): Lens => (c.stab ? { ...defaultLens(a), stab: c.stab } : defaultLens(a));
export const DEFAULT_VIEW: View = { yaw: 0, pitch: 0, roll: 0, hfov: 91, dist: 0.3 };

export function newClip(a: Asset, start = 0, end = a.info.duration || 5): Clip {
  return { id: uid(), asset: a.id, start: r3(start), end: r3(Math.max(start + 0.05, end)), speed: 1, volume: 1, view: is360(a) ? { ...DEFAULT_VIEW } : undefined, fit: "fit" };
}

export const clipDur = (c: Clip) => Math.max(0, (c.end - c.start) / (c.speed || 1));

/** Dissolve length actually used between clip i-1 and i (at most half of either clip). */
export function xinOf(d: Draft, i: number): number {
  const c = d.clips[i];
  if (i <= 0 || !c?.xin) return 0;
  return Math.max(0, Math.min(c.xin, clipDur(c) / 2, clipDur(d.clips[i - 1]) / 2));
}

/** Timeline start of each clip (a dissolve makes a clip start before the previous one ends). */
export function starts(d: Draft): number[] {
  const out: number[] = [];
  let t = 0;
  d.clips.forEach((c, i) => {
    t -= xinOf(d, i);
    out.push(Math.max(0, t));
    t = Math.max(0, t) + clipDur(c);
  });
  return out;
}

export function draftDuration(d: Draft): number {
  if (!d.clips.length) return 0;
  const st = starts(d);
  const i = d.clips.length - 1;
  return st[i] + clipDur(d.clips[i]);
}

/** The clip under timeline time t (the last clip at the very end). In a dissolve the incoming clip wins. */
export function clipAt(d: Draft, t: number): { index: number; clip: Clip; at: number; src: number } | null {
  if (!d.clips.length) return null;
  const st = starts(d);
  let i = 0;
  while (i + 1 < d.clips.length && t >= st[i + 1]) i++;
  const c = d.clips[i];
  const off = clamp(t - st[i], 0, clipDur(c));
  return { index: i, clip: c, at: st[i], src: c.start + off * c.speed };
}

const touch = (d: Draft, clips: Clip[]): Draft => ({ ...d, clips, updated: Date.now() });

export function splitAt(d: Draft, t: number): Draft {
  const hit = clipAt(d, t);
  if (!hit) return d;
  const { index, clip, src } = hit;
  if (src - clip.start < 0.05 || clip.end - src < 0.05) return d;
  const a: Clip = { ...clip, end: r3(src), fadeOut: 0 };
  const b: Clip = { ...clip, id: uid(), start: r3(src), fadeIn: 0 };
  const clips = d.clips.slice();
  clips.splice(index, 1, a, b);
  return touch(d, clips);
}

/** Cuts source ranges out of one clip; returns the pieces that remain (at least 0.05 s each). */
export function cutClip(c: Clip, ranges: [number, number][]): Clip[] {
  const rs = mergeRanges(ranges.map(([a, b]) => [Math.max(a, c.start), Math.min(b, c.end)] as [number, number]).filter(([a, b]) => b - a > 0.001));
  if (!rs.length) return [c];
  const keep: [number, number][] = [];
  let cur = c.start;
  for (const [a, b] of rs) { if (a - cur >= 0.05) keep.push([cur, a]); cur = Math.max(cur, b); }
  if (c.end - cur >= 0.05) keep.push([cur, c.end]);
  return keep.map(([a, b], i) => ({
    ...c, id: i === 0 ? c.id : uid(), start: r3(a), end: r3(b),
    fadeIn: i === 0 ? c.fadeIn : 0, fadeOut: i === keep.length - 1 ? c.fadeOut : 0,
  }));
}

export function mergeRanges(rs: [number, number][], join = 0): [number, number][] {
  const s = rs.slice().sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + join) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Removes the timeline range [t0, t1). */
export function removeRange(d: Draft, t0: number, t1: number): Draft {
  if (t1 <= t0) return d;
  const st = starts(d);
  const clips: Clip[] = [];
  d.clips.forEach((c, i) => {
    const a = st[i], b = a + clipDur(c);
    if (b <= t0 || a >= t1) { clips.push(c); return; }
    const s0 = c.start + (Math.max(t0, a) - a) * c.speed, s1 = c.start + (Math.min(t1, b) - a) * c.speed;
    clips.push(...cutClip(c, [[s0, s1]]));
  });
  return touch(d, clips);
}

/** Cuts source ranges out of specific clips: { clipId: [[s, e], …] }. */
export function cutSource(d: Draft, cuts: Record<string, [number, number][]>): Draft {
  return touch(d, d.clips.flatMap((c) => (cuts[c.id]?.length ? cutClip(c, cuts[c.id]) : [c])));
}

export function moveClip(d: Draft, from: number, to: number): Draft {
  const clips = d.clips.slice();
  const [c] = clips.splice(from, 1);
  clips.splice(clamp(to, 0, clips.length), 0, c);
  return touch(d, clips);
}

export function updateClip(d: Draft, id: string, patch: Partial<Clip>): Draft {
  return touch(d, d.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

export function deleteClip(d: Draft, id: string): Draft {
  return touch(d, d.clips.filter((c) => c.id !== id));
}

export function insertClips(d: Draft, clips: Clip[], at = d.clips.length): Draft {
  const out = d.clips.slice();
  out.splice(clamp(at, 0, out.length), 0, ...clips);
  return touch(d, out);
}

/** Removes a clip but keeps its time as an empty gap (lift instead of ripple delete). */
export function liftClip(d: Draft, id: string): Draft {
  const i = d.clips.findIndex((c) => c.id === id);
  if (i < 0) return d;
  const clips = d.clips.slice();
  clips.splice(i, 1, newGap(clipDur(d.clips[i])));
  return touch(d, clips);
}

/** Roll edit: moves the cut between clip i-1 and i by dt seconds of timeline (both clips change, the total stays). */
export function rollEdit(d: Draft, i: number, dt: number, assetDur: (id: string) => number): Draft {
  const a = d.clips[i - 1], b = d.clips[i];
  if (!a || !b) return d;
  const maxA = isGap(a) ? 1e9 : (assetDur(a.asset) - a.end) / a.speed;
  const maxB = (b.start) / b.speed;
  const dd = clamp(dt, -Math.min(clipDur(a) - 0.1, maxB), Math.min(clipDur(b) - 0.1, maxA));
  if (Math.abs(dd) < 1e-4) return d;
  const clips = d.clips.slice();
  clips[i - 1] = { ...a, end: r3(a.end + dd * a.speed) };
  clips[i] = { ...b, start: r3(b.start + dd * b.speed) };
  return touch(d, clips);
}

/** Slip edit: shows a different part of the source in the same slot (length stays). */
export function slipClip(d: Draft, id: string, ds: number, assetDur: number): Draft {
  const c = d.clips.find((x) => x.id === id);
  if (!c || isGap(c)) return d;
  const len = c.end - c.start;
  const s = clamp(c.start + ds, 0, Math.max(0, assetDur - len));
  return updateClip(d, id, { start: r3(s), end: r3(s + len) });
}

export function setTransition(d: Draft, id: string, dur: number): Draft {
  return updateClip(d, id, { xin: r3(Math.max(0, dur)) });
}

// ---------------------------------------------------------------- connected tracks (V2/V3, A1–A3)

export type Timed = { id: string; at: number; start: number; end: number; speed?: number };
export const timedDur = (x: Timed) => Math.max(0, (x.end - x.start) / (x.speed || 1));
export const overlays = (d: Draft): Overlay[] => d.overlays ?? [];

export function newOverlay(a: Asset, at: number, track: 2 | 3 = 2, start = 0, end = a.info.kind === "image" ? 4 : a.info.duration): Overlay {
  return {
    id: uid(), asset: a.id, track, at: r3(Math.max(0, at)), start: r3(start), end: r3(Math.max(start + 0.1, end)), speed: 1, volume: 0,
    view: is360(a) ? { ...DEFAULT_VIEW } : undefined, transform: { ...DEFAULT_TRANSFORM, scale: 0.4, x: 0.25, y: -0.22 },
  };
}

export function updateOverlay(d: Draft, id: string, p: Partial<Overlay>): Draft {
  return { ...d, overlays: overlays(d).map((o) => (o.id === id ? { ...o, ...p } : o)), updated: Date.now() };
}
export function updateAudio(d: Draft, id: string, p: Partial<MusicClip>): Draft {
  return { ...d, music: d.music.map((m) => (m.id === id ? { ...m, ...p } : m)), updated: Date.now() };
}
export function removeItem(d: Draft, id: string): Draft {
  return { ...d, overlays: overlays(d).filter((o) => o.id !== id), music: d.music.filter((m) => m.id !== id), updated: Date.now() };
}

/** Splits an overlay or sound item at timeline time t. */
export function splitItem(d: Draft, id: string, t: number): Draft {
  const cut = <T extends Timed>(x: T): T[] => {
    const sp = x.speed || 1;
    const off = t - x.at;
    if (off <= 0.05 || off >= timedDur(x) - 0.05) return [x];
    const s = r3(x.start + off * sp);
    return [{ ...x, end: s, fadeOut: 0 } as T, { ...x, id: uid(), at: r3(t), start: s, fadeIn: 0 } as T];
  };
  return {
    ...d,
    overlays: overlays(d).flatMap((o) => (o.id === id ? cut(o) : [o])),
    music: d.music.flatMap((m) => (m.id === id ? cut(m) : [m])),
    updated: Date.now(),
  };
}

/** Splits the clip's sound off to track A1 so it can be trimmed separately (J/L cuts). */
export function detachAudio(d: Draft, id: string): Draft {
  const i = d.clips.findIndex((c) => c.id === id);
  const c = d.clips[i];
  // Sound split works on 1x clips only (the split sound plays at normal speed).
  if (!c || isGap(c) || c.detached || c.speed !== 1) return d;
  const at = starts(d)[i];
  const m: MusicClip = { id: uid(), asset: c.asset, start: c.start, end: c.end, at: r3(at), volume: c.volume, fadeIn: c.fadeIn ?? 0, fadeOut: c.fadeOut ?? 0, track: 1 };
  const clips = d.clips.slice();
  clips[i] = { ...c, detached: true, volume: 0 };
  return { ...touch(d, clips), music: [...d.music, m] };
}

/**
 * Where timeline time t of `before` ends up in `after`: follows the source frame that was under
 * it. Used to keep connected clips (V2/V3, A1, A3) with the picture when the main track changes.
 */
export function mapTime(before: Draft, after: Draft, t: number): number {
  const hit = clipAt(before, t);
  if (!hit) return t;
  if (t >= draftDuration(before)) return draftDuration(after) + (t - draftDuration(before));
  const { clip, src } = hit;
  const st = starts(after);
  let best: number | null = null;
  let next: number | null = null;
  after.clips.forEach((c, i) => {
    if (c.asset !== clip.asset) return;
    if (src >= c.start - 1e-6 && src < c.end + 1e-6) {
      const tt = st[i] + (src - c.start) / c.speed;
      if (best == null || Math.abs(tt - t) < Math.abs(best - t)) best = tt;
    } else if (c.start > src) {
      const tt = st[i];
      if (next == null || Math.abs(tt - t) < Math.abs(next - t)) next = tt;
    }
  });
  return r3(best ?? next ?? Math.min(t, draftDuration(after)));
}

/** After a main-track edit, moves connected items so they stay on the same picture. A2 (music) stays put. */
export function rippleConnected(before: Draft, after: Draft): Draft {
  if (before.clips === after.clips || !before.clips.length) return after;
  const ov = overlays(after);
  const moves = (m: { at: number }) => mapTime(before, after, m.at);
  const texts = after.texts ?? [];
  const changed = ov.some((o) => moves(o) !== o.at) || texts.some((t) => moves(t) !== t.at) || after.music.some((m) => audioTrack(m) !== 2 && moves(m) !== m.at);
  if (!changed) return after;
  return {
    ...after,
    overlays: ov.map((o) => ({ ...o, at: moves(o) })),
    texts: texts.map((t) => ({ ...t, at: moves(t) })),
    music: after.music.map((m) => (audioTrack(m) === 2 ? m : { ...m, at: moves(m) })),
  };
}

/** Moves the V1 clip one place left (-1) or right (+1). */
export function nudgeClip(d: Draft, id: string, dir: -1 | 1): Draft {
  const i = d.clips.findIndex((c) => c.id === id);
  if (i < 0 || i + dir < 0 || i + dir >= d.clips.length) return d;
  return moveClip(d, i, i + dir);
}

// ---------------------------------------------------------------- 360 view animation

/** The view of a 360 clip at source time `t`: keyframes interpolate smoothly (monotone cubic, no overshoot). */
export function viewAt(view: View | undefined, keys: ViewKey[] | undefined, t: number): View {
  if (!keys?.length) return normView(view ?? DEFAULT_VIEW);
  return smoothViewAt(keys, t);
}

/** Sets (or replaces, within 1/20 s) a keyframe at t. */
export function setViewKey(keys: ViewKey[] | undefined, t: number, view: View): ViewKey[] {
  const ks = (keys ?? []).filter((k) => Math.abs(k.t - t) > 0.05);
  return [...ks, { t: r3(t), view }].sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- words

export type TWord = Word & { clip: string; ci: number; wi: number; asset: string; t0: number; t1: number };

/** Words of the draft in timeline order, with timeline times. */
export function draftWords(d: Draft, assets: Map<string, Asset>): TWord[] {
  const out: TWord[] = [];
  const st = starts(d);
  d.clips.forEach((c, ci) => {
    const ws = assets.get(c.asset)?.words;
    if (!ws) return;
    ws.forEach((w, wi) => {
      const mid = (w.s + w.e) / 2;
      if (mid < c.start || mid >= c.end) return;
      const s = Math.max(w.s, c.start), e = Math.min(w.e, c.end);
      out.push({ ...w, clip: c.id, ci, wi, asset: c.asset, t0: st[ci] + (s - c.start) / c.speed, t1: st[ci] + (e - c.start) / c.speed });
    });
  });
  return out;
}

export function transcriptText(ws: TWord[], withTimes = true): string {
  const lines: string[] = [];
  let line: string[] = [], t = 0;
  ws.forEach((w, i) => {
    if (!line.length) t = w.t0;
    line.push(w.t);
    const gap = i + 1 < ws.length ? ws[i + 1].t0 - w.t1 : 9;
    if (gap > 0.8 || /[.?!。]$/.test(w.t) || line.length >= 14) {
      lines.push((withTimes ? `[${fmtTC(t)}] ` : "") + line.join(" "));
      line = [];
    }
  });
  if (line.length) lines.push((withTimes ? `[${fmtTC(t)}] ` : "") + line.join(" "));
  return lines.join("\n");
}

/** Removes the given words (timeline-ordered TWord list entries). */
export function removeWords(d: Draft, ws: TWord[], all: TWord[]): Draft {
  const cuts: Record<string, [number, number][]> = {};
  for (const w of ws) {
    // Extend the cut to the neighbouring word edges (inside the same clip) so no breath remains.
    const k = all.findIndex((x) => x.clip === w.clip && x.wi === w.wi);
    const prev = k > 0 && all[k - 1].clip === w.clip ? all[k - 1] : null;
    const next = k >= 0 && k + 1 < all.length && all[k + 1].clip === w.clip ? all[k + 1] : null;
    const s = prev ? Math.max(prev.e, w.s - 0.08) : w.s - 0.05;
    const e = next ? Math.min(next.s, w.e + 0.08) : w.e + 0.05;
    (cuts[w.clip] ??= []).push([s, e]);
  }
  return cutSource(d, cuts);
}

const FILLERS = new Set(["음", "음음", "어", "어어", "으", "으음", "아", "에", "엄", "흠", "그", "저", "뭐", "um", "umm", "uh", "uhh", "erm", "hmm", "mm", "ah", "er"]);
export const normWord = (t: string) => t.toLowerCase().replace(/[.,?!…~\-"'“”‘’()]/g, "").trim();
export function isFiller(t: string) {
  const n = normWord(t);
  return FILLERS.has(n) || /^(음|어|으|흠)+$/.test(n);
}

// ---------------------------------------------------------------- silence

export type Pacing = "gentle" | "normal" | "tight" | "jump_cut";
export const PACING: Record<Pacing, { label: string; minGap: number; pad: number }> = {
  gentle: { label: "부드럽게", minGap: 1.2, pad: 0.35 },
  normal: { label: "보통", minGap: 0.7, pad: 0.2 },
  tight: { label: "타이트", minGap: 0.4, pad: 0.1 },
  jump_cut: { label: "점프컷", minGap: 0.25, pad: 0.04 },
};

/** Speech spans of a clip's source range from words. */
export function speechFromWords(words: Word[], s0: number, s1: number): [number, number][] {
  return words.filter((w) => w.e > s0 && w.s < s1).map((w) => [Math.max(s0, w.s), Math.min(s1, w.e)] as [number, number]);
}

/** Speech spans from the waveform (50 values per second, 0–255 = −60…0 dB). */
export function speechFromWave(wave: ArrayLike<number>, s0: number, s1: number): [number, number][] {
  const i0 = Math.max(0, Math.floor(s0 * 50)), i1 = Math.min(wave.length, Math.ceil(s1 * 50));
  if (i1 <= i0) return [];
  const vals = Array.from({ length: i1 - i0 }, (_, k) => wave[i0 + k]).sort((a, b) => a - b);
  const floor = vals[Math.floor(vals.length * 0.2)];
  const thr = clamp(floor + 0.17 * 255, 0.33 * 255, 0.62 * 255);
  const out: [number, number][] = [];
  let st = -1;
  for (let i = i0; i <= i1; i++) {
    const on = i < i1 && wave[i] > thr;
    if (on && st < 0) st = i;
    if (!on && st >= 0) { if (i - st >= 4) out.push([st / 50, i / 50]); st = -1; }
  }
  return out;
}

/** Source ranges of silence to cut from a clip, given its speech spans. */
export function silenceCuts(c: Clip, speech: [number, number][], p: Pacing): [number, number][] {
  const { minGap, pad } = PACING[p];
  if (!speech.length) return [];
  const sp = mergeRanges(speech, minGap);
  const cuts: [number, number][] = [];
  let cur = c.start;
  for (const [a, b] of sp) {
    if (a - pad - cur > 0.05 && (a - cur >= minGap || cur === c.start)) cuts.push([cur, a - pad]);
    cur = b + pad;
  }
  if (c.end - cur > 0.05) cuts.push([cur, c.end]);
  return cuts.filter(([a, b]) => b - a > 0.05);
}

/**
 * Repairs word times from speech recognition with the waveform: words squeezed into a pause
 * (zero length, or sitting in silence) are spread over the speech that follows, and words with
 * no speech anywhere near them (made up in silence, e.g. a closing "감사합니다.") are dropped.
 */
export function refineWords(words: Word[], wave: ArrayLike<number>, duration: number): Word[] {
  if (!words.length || !wave.length) return words;
  const speech = speechFromWave(wave, 0, Math.min(duration, wave.length / 50));
  if (!speech.length) return words;
  const overlap = (s: number, e: number) => speech.reduce((acc, [a, b]) => acc + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0);
  // A word stretched over a long pause (≥ 1 s of silence inside or before it) keeps only its
  // longest stretch of speech: the word before a pause stays before it, the word after it after.
  const trim = (w: Word): Word => {
    const inside = speech.filter(([a, b]) => b > w.s && a < w.e).map(([a, b]) => [Math.max(a, w.s), Math.min(b, w.e)] as [number, number]);
    if (!inside.length || w.e - w.s < 0.06) return w;
    const chunks: [number, number][] = [];
    for (const [a, b] of inside) {
      const last = chunks[chunks.length - 1];
      if (last && a - last[1] < 1) last[1] = b;
      else chunks.push([a, b]);
    }
    const lead = inside[0][0] - w.s >= 1, tail = w.e - inside[inside.length - 1][1] >= 1;
    if (chunks.length < 2 && !lead && !tail) return w;
    const best = chunks.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x));
    const s = chunks.length > 1 || lead ? best[0] : w.s, e = chunks.length > 1 || tail ? best[1] : w.e;
    return { ...w, s: r3(s), e: r3(Math.max(e, s + 0.06)) };
  };
  words = words.map(trim);
  const good = (w: Word) => w.e - w.s >= 0.06 && overlap(w.s, w.e) >= 0.3 * (w.e - w.s);
  const spread = (run: Word[], s0: number, s1: number, out: Word[]) => {
    const chars = run.reduce((n, w) => n + Math.max(1, w.t.length), 0);
    let t = s0;
    for (const w of run) {
      const len = ((s1 - s0) * Math.max(1, w.t.length)) / chars;
      out.push({ ...w, s: r3(t), e: r3(t + len) });
      t += len;
    }
  };
  const out: Word[] = [];
  let i = 0;
  while (i < words.length) {
    if (good(words[i])) { out.push(words[i]); i++; continue; }
    // A run of words with bad times: [i, j).
    let j = i;
    while (j < words.length && !good(words[j])) j++;
    const lo = out.length ? out[out.length - 1].e : 0;
    const hi = j < words.length ? words[j].s : duration;
    // Speech inside the free stretch between the neighbouring good words.
    // Speech that starts in the free stretch (a tail of the previous word's sound does not count).
    const spans = speech.filter(([a]) => a > lo + 0.02 && a < hi).map(([a, b]) => [a, Math.min(b, hi)] as [number, number]).filter(([a, b]) => b - a > 0.05);
    const run = words.slice(i, j);
    if (spans.length) {
      spread(run, spans[0][0], spans[spans.length - 1][1], out);
    } else if (j < words.length) {
      // No speech in the gap: these words belong with the next one; share its speech.
      spread([...run, words[j]], words[j].s, words[j].e, out);
      j++;
    } else if (!out.length) {
      out.push(...run);
    }
    // Trailing words with no speech anywhere (made up in silence) are dropped.
    i = j;
  }
  return out;
}

export function removeSilences(d: Draft, assets: Map<string, Asset>, waves: Map<string, ArrayLike<number>>, p: Pacing): { draft: Draft; removed: number } {
  const cuts: Record<string, [number, number][]> = {};
  let removed = 0;
  for (const c of d.clips) {
    const a = assets.get(c.asset);
    if (!a || a.info.kind === "image") continue;
    const speech = a.words?.length ? speechFromWords(a.words, c.start, c.end) : waves.get(a.id) ? speechFromWave(waves.get(a.id)!, c.start, c.end) : null;
    if (!speech) continue;
    const cs = silenceCuts(c, speech, p);
    if (cs.length) { cuts[c.id] = cs; removed += cs.reduce((s, [x, y]) => s + (y - x) / c.speed, 0); }
  }
  return { draft: cutSource(d, cuts), removed };
}

export function removeFillers(d: Draft, assets: Map<string, Asset>): { draft: Draft; count: number } {
  const all = draftWords(d, assets);
  const f = all.filter((w) => isFiller(w.t));
  return { draft: f.length ? removeWords(d, f, all) : d, count: f.length };
}

// ---------------------------------------------------------------- output

export const ASPECTS = ["16:9", "9:16", "1:1", "4:5"];
export function outSize(aspect: string, short: number): [number, number] {
  const even = (x: number) => Math.round(x / 2) * 2;
  switch (aspect) {
    case "9:16": return [short, even((short * 16) / 9)];
    case "1:1": return [short, short];
    case "4:5": return [short, even((short * 5) / 4)];
    default: return [even((short * 16) / 9), short];
  }
}

/** The still view sent with a segment: a single keyframe counts as the view (as in the preview). */
const planView = (view: View | undefined, keys: ViewKey[] | undefined): View => (keys?.length === 1 ? keys[0].view : view ?? DEFAULT_VIEW);

/** Source-time keyframes → output seconds from the segment start (only when they animate). */
function planKeys(keys: ViewKey[] | undefined, start: number, speed: number): ViewKey[] {
  if (!keys || keys.length < 2) return [];
  return keys.map((k) => ({ t: r3((k.t - start) / (speed || 1)), view: k.view }));
}

/** Keys in source seconds → output seconds from the item's start. */
function planTimed<K extends { t: number }>(keys: K[] | undefined, start: number, speed: number): K[] {
  return (keys ?? []).map((k) => ({ ...k, t: r3((k.t - start) / (speed || 1)) }));
}

export function toSegs(d: Draft, assets: Map<string, Asset>): Seg[] {
  const hideV1 = trackState(d, "V1").hide;
  const muteA1 = trackState(d, "A1").mute;
  return d.clips.flatMap((c, i) => {
    const xin = xinOf(d, i);
    const a = assets.get(c.asset);
    const gap = (dur: number): Seg => ({ path: "", kind: "gap", start: 0, dur: r3(dur), speed: 1, volume: 0, has_audio: false, lens: null, view: null, fit: "fit", fade_in: 0, fade_out: 0, xin });
    if (isGap(c)) return [gap(c.end - c.start)];
    // A switched-off clip keeps its place on the timeline: black and silent.
    if (c.disabled) return [gap(clipDur(c))];
    if (!a) return [];
    // A hidden main track keeps its timing and sound; its pictures become black ("audio" segments render black).
    if (hideV1 && a.info.kind === "image") return [gap(clipDur(c))];
    const r360 = is360(a);
    return [{
      path: a.info.path, kind: hideV1 ? "audio" : a.info.kind, start: r3(c.start), dur: r3(c.end - c.start), speed: c.speed || 1,
      volume: muteA1 || c.detached ? 0 : c.volume ?? 1,
      has_audio: a.info.has_audio, lens: r360 ? lensFor(c, a) : null, view: r360 ? planView(c.view, c.viewKeys) : null,
      fit: c.fit ?? "fit", fade_in: c.fadeIn ?? 0, fade_out: c.fadeOut ?? 0,
      transform: isDefaultTransform(c.transform) ? null : c.transform!, color: isDefaultColor(c.color) ? null : c.color!,
      denoise: !!c.denoise, view_keys: r360 ? planKeys(c.viewKeys, c.start, c.speed) : [], xin, xtype: c.xtype ?? "",
      anim: planTimed(c.anim, c.start, c.speed), vol_keys: planTimed(c.volKeys, c.start, c.speed),
    }];
  });
}

export function toOverlays(d: Draft, assets: Map<string, Asset>): PlanOverlay[] {
  const total = draftDuration(d);
  return overlays(d).flatMap((o) => {
    const a = assets.get(o.asset);
    const t = trackState(d, o.track === 3 ? "V3" : "V2");
    if (!a || t.hide || o.disabled || a.info.kind === "audio") return [];
    const sp = o.speed || 1;
    const len = Math.min(timedDur(o), total - o.at);
    if (len <= 0.05) return [];
    const r360 = is360(a);
    return [{
      path: a.info.path, kind: a.info.kind, start: r3(o.start), dur: r3(len * sp), speed: sp, at: r3(o.at), track: o.track,
      volume: t.mute ? 0 : o.volume ?? 0, has_audio: a.info.has_audio, lens: r360 ? defaultLens(a) : null, view: r360 ? planView(o.view, o.viewKeys) : null,
      view_keys: r360 ? planKeys(o.viewKeys, o.start, sp) : [], transform: o.transform ?? null, color: isDefaultColor(o.color) ? null : o.color!,
      fade_in: o.fadeIn ?? 0, fade_out: o.fadeOut ?? 0,
      anim: planTimed(o.anim, o.start, sp), vol_keys: planTimed(o.volKeys, o.start, sp),
    }];
  });
}

export type ExportOpts = {
  mode: "standard" | "shrink" | "audio";
  short: number;
  vbitrate: number;
  shrink: ShrinkSettings | null;
  out: string;
  ass: string;
  loudnorm?: boolean;
  duck?: boolean;
  abr?: number;
  /** Export only this timeline range. */
  range?: [number, number] | null;
};

/** The draft cut down to the timeline range [a, b) (connected items move with it). */
export function rangeDraft(d: Draft, a: number, b: number): Draft {
  const total = draftDuration(d);
  let x = d;
  if (b < total - 0.01) x = rippleConnected(x, removeRange(x, b, total));
  if (a > 0.01) {
    const y = rippleConnected(x, removeRange(x, 0, a));
    x = { ...y, music: y.music.map((m) => (audioTrack(m) === 2 ? { ...m, at: r3(m.at - a), start: m.at < a ? r3(m.start + (a - m.at)) : m.start } : m)).map((m) => (m.at < 0 ? { ...m, at: 0 } : m)) };
  }
  return x;
}

export function toPlan(d0: Draft, assets: Map<string, Asset>, o: ExportOpts): Plan {
  const d = o.range ? rangeDraft(d0, o.range[0], o.range[1]) : d0;
  const [width, height] = outSize(d.aspect, o.short);
  const total = draftDuration(d);
  const muted = (m: MusicClip) => { const t = trackState(d, `A${audioTrack(m)}` as TrackId); return t.mute; };
  return {
    segs: toSegs(d, assets),
    overlays: toOverlays(d, assets),
    // Sound past the end of the video is cut there, so its fade-out lands on the last frame.
    music: d.music.flatMap((m) => {
      const a = assets.get(m.asset);
      const dur = Math.min(m.end - m.start, total - m.at);
      return a && dur > 0.05 && !muted(m) && !m.disabled ? [{ path: a.info.path, start: r3(m.start), dur: r3(dur), at: r3(m.at), volume: m.volume, vol_keys: planTimed(m.volKeys, m.start, 1), fade_in: m.fadeIn, fade_out: m.fadeOut, denoise: !!m.denoise }] : [];
    }),
    width, height, fps: d.fps || 30, ass: o.ass, mode: o.mode, vbitrate: o.vbitrate, settings: o.shrink, out: o.out,
    // 소리 고르게 on the draft (toolbar) evens the loudness on export too.
    loudnorm: !!o.loudnorm || !!d.fx?.loudnorm, duck: !!o.duck, abr: o.abr ?? 256,
  };
}

export function fmtTC(s: number, frac = false) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  const p = (n: number) => String(n).padStart(2, "0");
  const base = h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
  return frac ? base + "." + String(Math.floor((s % 1) * 10)) : base;
}

/** Timecode with frames: HH:MM:SS:FF. */
export function fmtTCF(s: number, fps = 30) {
  s = Math.max(0, s);
  const f = Math.max(1, Math.round(fps));
  const total = Math.floor(s * f + 1e-6);
  const fr = total % f, secs = Math.floor(total / f);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(secs / 3600))}:${p(Math.floor((secs % 3600) / 60))}:${p(secs % 60)}:${p(fr)}`;
}

/** Parses "SS", "MM:SS", "HH:MM:SS", "HH:MM:SS:FF" or seconds with a decimal point. */
export function parseTC(text: string, fps = 30): number | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(/[:;]/).map(Number);
  if (parts.some((x) => !Number.isFinite(x))) return null;
  if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / Math.max(1, Math.round(fps));
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}
