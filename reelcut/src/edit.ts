// Pure edit operations on drafts (no I/O), so they can be unit-tested and shared by the
// editor and the AI agent.

import type { Asset, CaptionStyle, Clip, Draft, Lens, Plan, Seg, ShrinkSettings, View, Word } from "./types";

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const DEFAULT_CAPTION: CaptionStyle = { size: 6, color: "#FFFFFF", outline: "#000000", position: "bottom", maxChars: 18, font: "Malgun Gothic" };

export function newDraft(name: string, aspect = "16:9"): Draft {
  const now = Date.now();
  return { id: uid(), name, clips: [], music: [], markers: [], captions: false, captionStyle: { ...DEFAULT_CAPTION }, aspect, fps: 30, created: now, updated: now };
}

export const is360 = (a?: Asset) => !!a && a.info.layout360 !== "none" && a.info.kind === "video";
export function defaultLens(a: Asset): Lens {
  return a.lens ?? { layout: a.info.layout360 === "none" ? "none" : a.info.layout360, swap: false, fov: 190 };
}
export const DEFAULT_VIEW: View = { yaw: 0, pitch: 0, roll: 0, hfov: 100 };

export function newClip(a: Asset, start = 0, end = a.info.duration || 5): Clip {
  return { id: uid(), asset: a.id, start: r3(start), end: r3(Math.max(start + 0.05, end)), speed: 1, volume: 1, view: is360(a) ? { ...DEFAULT_VIEW } : undefined, fit: "fit" };
}

export const clipDur = (c: Clip) => Math.max(0, (c.end - c.start) / (c.speed || 1));
export const draftDuration = (d: Draft) => d.clips.reduce((s, c) => s + clipDur(c), 0);

/** Timeline start of each clip. */
export function starts(d: Draft): number[] {
  const out: number[] = [];
  let t = 0;
  for (const c of d.clips) { out.push(t); t += clipDur(c); }
  return out;
}

/** The clip under timeline time t (the last clip at the very end). */
export function clipAt(d: Draft, t: number): { index: number; clip: Clip; at: number; src: number } | null {
  let acc = 0;
  for (let i = 0; i < d.clips.length; i++) {
    const c = d.clips[i], len = clipDur(c);
    if (t < acc + len || i === d.clips.length - 1) {
      const off = clamp(t - acc, 0, len);
      return { index: i, clip: c, at: acc, src: c.start + off * c.speed };
    }
    acc += len;
  }
  return null;
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

export function toSegs(d: Draft, assets: Map<string, Asset>): Seg[] {
  return d.clips.flatMap((c) => {
    const a = assets.get(c.asset);
    if (!a) return [];
    const r360 = is360(a);
    return [{
      path: a.info.path, kind: a.info.kind, start: r3(c.start), dur: r3(c.end - c.start), speed: c.speed || 1, volume: c.volume ?? 1,
      has_audio: a.info.has_audio, lens: r360 ? defaultLens(a) : null, view: r360 ? (c.view ?? DEFAULT_VIEW) : null,
      fit: c.fit ?? "fit", fade_in: c.fadeIn ?? 0, fade_out: c.fadeOut ?? 0,
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
};

export function toPlan(d: Draft, assets: Map<string, Asset>, o: ExportOpts): Plan {
  const [width, height] = outSize(d.aspect, o.short);
  return {
    segs: toSegs(d, assets),
    // Music past the end of the video is cut there, so its fade-out lands on the last frame.
    music: d.music.flatMap((m) => {
      const a = assets.get(m.asset);
      const dur = Math.min(m.end - m.start, draftDuration(d) - m.at);
      return a && dur > 0.05 ? [{ path: a.info.path, start: r3(m.start), dur: r3(dur), at: r3(m.at), volume: m.volume, fade_in: m.fadeIn, fade_out: m.fadeOut }] : [];
    }),
    width, height, fps: d.fps || 30, ass: o.ass, mode: o.mode, vbitrate: o.vbitrate, settings: o.shrink, out: o.out,
  };
}

export function fmtTC(s: number, frac = false) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  const p = (n: number) => String(n).padStart(2, "0");
  const base = h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
  return frac ? base + "." + String(Math.floor((s % 1) * 10)) : base;
}
