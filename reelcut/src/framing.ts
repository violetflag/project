// 360 reframing maths: view normalisation, smooth (monotone cubic) key interpolation, turning
// "where is the person" marks into dense view keys, and snapping cut points into silences.
// Pure functions only, so they can be unit tested and mirrored exactly in Rust (tests/fixtures/framing.json).
import type { View, ViewKey } from "./types";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (n: unknown, d = 0) => (typeof n === "number" && Number.isFinite(n) ? n : d);

export const MAX_KEYS = 20000;
export const PITCH_LIMIT = 89;
export const FOV_MIN = 20;
export const FOV_MAX = 160;

/** Wraps any angle into [-180, 180]. */
export function wrap180(a: number): number {
  if (!Number.isFinite(a)) return 0;
  const w = ((((a + 180) % 360) + 360) % 360) - 180;
  return w === -180 && a > 0 ? 180 : w;
}

/** A view the renderer accepts: yaw/roll wrapped to [-180,180], pitch within ±89, field of view 20–160. */
export function normView(v: Partial<View> | null | undefined, base?: View): View {
  const b = base ?? { yaw: 0, pitch: 0, roll: 0, hfov: 100 };
  return {
    yaw: r3(wrap180(num(v?.yaw, b.yaw))),
    pitch: r3(Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, num(v?.pitch, b.pitch)))),
    roll: r3(wrap180(num(v?.roll, b.roll))),
    hfov: r3(Math.max(FOV_MIN, Math.min(FOV_MAX, num(v?.hfov, b.hfov)))),
  };
}

/** Sorted, de-duplicated (within 1 ms), normalised keys, capped at MAX_KEYS. */
export function cleanKeys(keys: ViewKey[] | undefined | null): ViewKey[] {
  const ks = (keys ?? [])
    .filter((k) => k && Number.isFinite(k.t))
    .map((k) => ({ t: r3(Math.max(0, k.t)), view: normView(k.view) }))
    .sort((a, b) => a.t - b.t);
  const out: ViewKey[] = [];
  for (const k of ks) {
    if (out.length && k.t - out[out.length - 1].t < 0.001) out[out.length - 1] = k;
    else out.push(k);
  }
  return out.slice(0, MAX_KEYS);
}

// ---------------------------------------------------------------- PCHIP

/** Slopes of the shape-preserving cubic Hermite interpolant (same formula as scipy's PchipInterpolator). */
export function pchipSlopes(x: number[], y: number[]): number[] {
  const n = x.length;
  if (n < 2) return n ? [0] : [];
  const h: number[] = [], d: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    h.push(x[i + 1] - x[i]);
    d.push((y[i + 1] - y[i]) / h[i]);
  }
  if (n === 2) return [d[0], d[0]];
  const m = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] > 0) {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  const edge = (h0: number, h1: number, d0: number, d1: number) => {
    let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(s) !== Math.sign(d0)) s = 0;
    else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(s) > 3 * Math.abs(d0)) s = 3 * d0;
    return s;
  };
  m[0] = edge(h[0], h[1], d[0], d[1]);
  m[n - 1] = edge(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  return m;
}

/** Evaluates the PCHIP curve at t; values are held outside the range. */
export function pchipAt(x: number[], y: number[], m: number[], t: number): number {
  const n = x.length;
  if (!n) return 0;
  if (t <= x[0]) return y[0];
  if (t >= x[n - 1]) return y[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= t) lo = mid; else hi = mid;
  }
  const h = x[hi] - x[lo];
  const s = (t - x[lo]) / h;
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * y[lo] + (s3 - 2 * s2 + s) * h * m[lo] + (-2 * s3 + 3 * s2) * y[hi] + (s3 - s2) * h * m[hi];
}

/** Yaw values made continuous (no 360° jumps) so they can be interpolated. */
export function unwrapYaw(yaws: number[]): number[] {
  const out: number[] = [];
  yaws.forEach((y, i) => {
    if (!i) return out.push(y);
    let d = y - out[i - 1];
    d -= 360 * Math.round(d / 360);
    out.push(out[i - 1] + d);
  });
  return out;
}

/** Prepared curve for a sorted key list, so many samples can be taken cheaply. */
export function viewCurve(keys: ViewKey[]): (t: number) => View {
  const ks = cleanKeys(keys);
  if (!ks.length) return () => normView(null);
  const x = ks.map((k) => k.t);
  const yaw = unwrapYaw(ks.map((k) => k.view.yaw));
  const ch = [yaw, ks.map((k) => k.view.pitch), ks.map((k) => k.view.roll), ks.map((k) => k.view.hfov)];
  const ms = ch.map((c) => pchipSlopes(x, c));
  return (t) => normView({ yaw: pchipAt(x, ch[0], ms[0], t), pitch: pchipAt(x, ch[1], ms[1], t), roll: pchipAt(x, ch[2], ms[2], t), hfov: pchipAt(x, ch[3], ms[3], t) });
}

/** The smooth view at source time `t` (keys are in source seconds). */
const curves = new WeakMap<ViewKey[], (t: number) => View>();
export function smoothViewAt(keys: ViewKey[], t: number): View {
  let f = curves.get(keys);
  if (!f) curves.set(keys, (f = viewCurve(keys)));
  return f(t);
}

// ---------------------------------------------------------------- following a person

/** A mark on the level 960x480 panorama sheet: time, x (0–960 = azimuth −180..180), y (240 = horizon), optional zoom. */
export type Mark = { t: number; x: number; y: number; hfov?: number };

export type FrameOpts = {
  /** Output aspect, width / height (default 16/9). */
  aspect?: number;
  /** Horizontal field of view of the frame, degrees (default 90). */
  hfov?: number;
  /** Space above the head as a fraction of the frame height (0.33 = head at the top third). */
  headroom?: number;
  /** Seconds between keys (default 0.1). */
  step?: number;
  /** Gaussian smoothing, seconds (default 0.4; 0 = none). */
  sigma?: number;
};

/** Azimuth and elevation (degrees) of a panorama point. */
export const markAngles = (m: Mark): { yaw: number; pitch: number } => ({ yaw: wrap180((m.x / 960) * 360 - 180), pitch: (240 - m.y) * 0.375 });

/** Degrees the camera must look below the head so the head sits `headroom` from the top edge. */
export function headDrop(hfov: number, aspect: number, headroom: number): number {
  const H = (hfov * Math.PI) / 180;
  const V = 2 * Math.atan(Math.tan(H / 2) / aspect);
  return (Math.atan((1 - 2 * headroom) * Math.tan(V / 2)) * 180) / Math.PI;
}

function gaussian(ts: number[], vs: number[], sigma: number): number[] {
  if (sigma <= 0 || ts.length < 2) return vs.slice();
  const out: number[] = [];
  const reach = 3 * sigma;
  let lo = 0;
  for (let i = 0; i < ts.length; i++) {
    while (ts[lo] < ts[i] - reach) lo++;
    let sw = 0, sv = 0;
    for (let j = lo; j < ts.length && ts[j] <= ts[i] + reach; j++) {
      const w = Math.exp(-0.5 * ((ts[j] - ts[i]) / sigma) ** 2);
      sw += w; sv += w * vs[j];
    }
    out.push(sv / sw);
  }
  return out;
}

/**
 * Turns sparse person marks into dense view keys (one per `step` seconds): the frame follows the head,
 * with the head placed at the top third, and the motion smoothed. Marks are in source seconds.
 */
export function frameSubject(marks: Mark[], from: number, to: number, o: FrameOpts = {}): ViewKey[] {
  const ms = marks.filter((m) => Number.isFinite(m.t) && Number.isFinite(m.x) && Number.isFinite(m.y)).sort((a, b) => a.t - b.t);
  if (!ms.length || to <= from) return [];
  const step = Math.max(0.02, o.step ?? 0.1);
  const hf = o.hfov ?? 90, aspect = o.aspect ?? 16 / 9, headroom = Math.max(0, Math.min(0.5, o.headroom ?? 0.33));
  const ang = ms.map(markAngles);
  const yaw = unwrapYaw(ang.map((a) => a.yaw));
  const pitch = ang.map((a) => a.pitch);
  const fov = ms.map((m) => m.hfov ?? hf);
  const t = ms.map((m) => m.t);
  const my = pchipSlopes(t, yaw), mp = pchipSlopes(t, pitch), mf = pchipSlopes(t, fov);
  const n = Math.max(1, Math.round((to - from) / step));
  const ts: number[] = [], ys: number[] = [], ps: number[] = [], fs: number[] = [];
  for (let i = 0; i <= n; i++) {
    const tt = Math.min(to, from + i * step);
    ts.push(tt);
    ys.push(pchipAt(t, yaw, my, tt));
    ps.push(pchipAt(t, pitch, mp, tt));
    fs.push(pchipAt(t, fov, mf, tt));
  }
  const sg = o.sigma ?? 0.4;
  const sy = gaussian(ts, ys, sg), sp = gaussian(ts, ps, sg), sf = gaussian(ts, fs, sg);
  return ts.map((tt, i) =>
    ({ t: r3(tt), view: normView({ yaw: sy[i], pitch: sp[i] - headDrop(sf[i], aspect, headroom), roll: 0, hfov: sf[i] }) }));
}

// ---------------------------------------------------------------- snapping cuts into silences

export type Gap = [number, number];

/** Gaps between speech runs (source seconds) from word times: gaps of at least `min` seconds. */
export function gapsFromSpeech(speech: [number, number][], min = 0.35): Gap[] {
  const sp = speech.slice().sort((a, b) => a[0] - b[0]);
  const out: Gap[] = [];
  for (let i = 0; i + 1 < sp.length; i++) if (sp[i + 1][0] - sp[i][1] >= min) out.push([sp[i][1], sp[i + 1][0]]);
  return out;
}

/**
 * Moves one cut time into the nearest silent gap within `reach` seconds (never into speech).
 * Returns the new time, or the old one when no gap is near. A cut already inside a gap stays put.
 */
export function snapTime(t: number, gaps: Gap[], reach = 1.5, pad = 0.08): number {
  let best = t, bestD = Infinity;
  for (const [a, b] of gaps) {
    if (t >= a && t <= b) return t;
    const lo = a + pad, hi = b - pad;
    const target = lo < hi ? Math.min(hi, Math.max(lo, t)) : (a + b) / 2;
    const d = Math.abs(target - t);
    if (d <= reach && d < bestD) { best = target; bestD = d; }
  }
  return r3(best);
}

/** Snaps every [start, end] range's boundaries into silences; keeps ranges at least `minLen` long. */
export function snapRanges(ranges: [number, number][], speech: [number, number][], opt: { reach?: number; minLen?: number } = {}): { ranges: [number, number][]; moved: { i: number; side: "start" | "end"; from: number; to: number }[] } {
  const gaps = gapsFromSpeech(speech);
  const minLen = opt.minLen ?? 0.5;
  const moved: { i: number; side: "start" | "end"; from: number; to: number }[] = [];
  const out = ranges.map(([s, e], i): [number, number] => {
    const ns = snapTime(s, gaps, opt.reach), ne = snapTime(e, gaps, opt.reach);
    const [rs, re] = ne - ns >= minLen ? [ns, ne] : [s, e];
    if (rs !== s) moved.push({ i, side: "start", from: s, to: rs });
    if (re !== e) moved.push({ i, side: "end", from: e, to: re });
    return [rs, re];
  });
  return { ranges: out, moved };
}

/** Thins a key list to at most `max` evenly spread entries (always keeps first and last), for listing to the AI. */
export function sampleKeys(keys: ViewKey[], max = 60): ViewKey[] {
  if (keys.length <= max) return keys;
  const out: ViewKey[] = [];
  for (let i = 0; i < max; i++) out.push(keys[Math.round((i * (keys.length - 1)) / (max - 1))]);
  return out;
}
