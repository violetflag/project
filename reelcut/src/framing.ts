// 360 reframing maths: view normalisation, smooth (monotone cubic) key interpolation, turning
// "where is the person" marks into dense view keys, and snapping cut points into silences.
// Pure functions only, so they can be unit tested and mirrored exactly in Rust (tests/fixtures/framing.json).
import { clampDist, cornerStretch, fovMax, presetRow, vfovOf } from "./proj";
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

export const maxFov = fovMax;

/** A view the renderer accepts: yaw/roll wrapped to [-180,180], pitch within ±89, field of view 20–160 (wider with `dist`). */
export function normView(v: Partial<View> | null | undefined, base?: View): View {
  const b = base ?? { yaw: 0, pitch: 0, roll: 0, hfov: 100 };
  return {
    yaw: r3(wrap180(num(v?.yaw, b.yaw))),
    pitch: r3(Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, num(v?.pitch, b.pitch)))),
    roll: r3(wrap180(num(v?.roll, b.roll))),
    hfov: r3(Math.max(FOV_MIN, Math.min(maxFov(num(v?.dist, b.dist ?? 0)), num(v?.hfov, b.hfov)))),
    ...(num(v?.dist, b.dist ?? 0) > 0 ? { dist: r3(Math.min(1, num(v?.dist, b.dist ?? 0))) } : {}),
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
  const ch = [yaw, ks.map((k) => k.view.pitch), ks.map((k) => k.view.roll), ks.map((k) => k.view.hfov), ks.map((k) => k.view.dist ?? 0)];
  const ms = ch.map((c) => pchipSlopes(x, c));
  return (t) => normView({ yaw: pchipAt(x, ch[0], ms[0], t), pitch: pchipAt(x, ch[1], ms[1], t), roll: pchipAt(x, ch[2], ms[2], t), hfov: pchipAt(x, ch[3], ms[3], t), dist: pchipAt(x, ch[4], ms[4], t) });
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

/** How far a followed view tilts up or down, degrees. Further than this people look seen from a ceiling. */
export const LEVEL_PITCH = 30;

/** The natural view for a frame shape and the widest a followed group may open to (`VIEW_PRESETS`): hfov is the frame's width, so a tall frame needs far less. Past the base the projection eases toward stereographic instead of stretching the corners. */
export function viewLimits(aspect: number, free = false): { base: number; baseDist: number; max: number; maxDist: number } {
  if (free) return aspect < 1 ? { base: 75, baseDist: 0, max: 105, maxDist: 0 } : { base: 90, baseDist: 0, max: 130, maxDist: 0 };
  const row = presetRow(`${aspect}:1`);
  return { base: row.best.hfov, baseDist: row.best.dist, max: row.wide.hfov, maxDist: row.wide.dist };
}

/** The projection that goes with a field of view between the natural view and the widest. */
function distFor(hfov: number, lim: ReturnType<typeof viewLimits>): number {
  if (lim.max <= lim.base) return lim.baseDist;
  const k = Math.max(0, Math.min(1, (hfov - lim.base) / (lim.max - lim.base)));
  return r3(lim.baseDist + (lim.maxDist - lim.baseDist) * k);
}

/** The steepest tilt that keeps the horizon in the picture, at most LEVEL_PITCH. */
export function pitchLimit(hfov: number, aspect: number, dist = 0): number {
  return Math.max(0, Math.min(LEVEL_PITCH, vfovOf(hfov, dist, 1 / aspect) / 2 - 5));
}

/** Corner stretch an AI-set view may have once it uses the wider projection (the presets stay under it). */
const MAX_STRETCH = 1.4;
/** An ordinary lens's widest AI view, by frame shape. */
const flatMax = (aspect: number) => (aspect < 1 ? 70 : 100);

/** A view kept near level and not stretched, unless the user asked otherwise. Presets (광각, 초광각, 작은 행성) get through. */
export function capView(v: View, aspect: number, free = false): View {
  if (free) return v;
  const d = clampDist(v.dist), hw = 1 / aspect;
  // Past 170° it is a little planet, chosen on purpose, and has no horizon to keep.
  if (d >= 1 && v.hfov > 170) return v;
  let hfov = v.hfov;
  if (d <= 0) hfov = Math.min(hfov, flatMax(aspect));
  else if (cornerStretch(hfov, d, hw) > MAX_STRETCH) {
    let lo = 20, hi = hfov;
    for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (cornerStretch(m, d, hw) > MAX_STRETCH) hi = m; else lo = m; }
    hfov = r3(lo);
  }
  const lim = pitchLimit(hfov, aspect, d);
  return { ...v, pitch: Math.max(-lim, Math.min(lim, v.pitch)), hfov };
}

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
  /** The user asked for steep or very wide views: leave LEVEL_PITCH and the width limit off. */
  free?: boolean;
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
  const aspect = o.aspect ?? 16 / 9, headroom = Math.max(0, Math.min(0.5, o.headroom ?? 0.33));
  const lim = viewLimits(aspect, o.free);
  const hf = Math.min(o.hfov ?? lim.base, lim.max);
  const ang = ms.map(markAngles);
  const yaw = unwrapYaw(ang.map((a) => a.yaw));
  const pitch = ang.map((a) => a.pitch);
  const fov = ms.map((m) => Math.min(m.hfov ?? hf, lim.max));
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
    ({ t: r3(tt), view: normView(capView({ yaw: sy[i], pitch: sp[i] - headDrop(sf[i], aspect, headroom), roll: 0, hfov: sf[i], ...(o.free ? {} : { dist: distFor(sf[i], lim) }) }, aspect, o.free)) }));
}

// ---------------------------------------------------------------- following several people at once

/** One person to keep in the frame: their head marks on the level panorama. */
export type Subject = { name: string; marks: Mark[] };

export type GroupOpts = FrameOpts & {
  /** A person counts at a moment only with a mark within this many seconds (default 3). */
  reach?: number;
  /** Degrees kept free on each side of the outermost heads (default 25). */
  margin?: number;
  /** Widest the frame may open for a group, degrees (default 130). */
  maxHfov?: number;
};

export type GroupReport = {
  /** Per person: share of the moments they are counted at where their head is inside the frame. */
  subjects: { name: string; inFrame: number; counted: number }[];
  /** Source-time ranges where the people are too far apart for one frame. */
  tooFar: [number, number][];
};

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Where a direction (yaw, pitch) lands in a flat view: u, v in -1..1 (right, down), or null behind. */
export function project(yaw: number, pitch: number, view: View, aspect: number): { u: number; v: number } | null {
  const d = [Math.cos(rad(pitch)) * Math.sin(rad(yaw)), Math.sin(rad(pitch)), Math.cos(rad(pitch)) * Math.cos(rad(yaw))];
  const cy = rad(view.yaw), cp = rad(view.pitch);
  const f = [Math.cos(cp) * Math.sin(cy), Math.sin(cp), Math.cos(cp) * Math.cos(cy)];
  const r = [Math.cos(cy), 0, -Math.sin(cy)];
  const up = [-Math.sin(cp) * Math.sin(cy), Math.cos(cp), -Math.sin(cp) * Math.cos(cy)];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = dot(d, f);
  if (z <= 1e-6 && !view.dist) return null;
  const dd = view.dist ?? 0;
  if (dd > 0) {
    const cz = Math.max(-1, Math.min(1, z)), ang = Math.acos(cz), sn = Math.sin(ang);
    if (sn < 1e-6) return { u: 0, v: 0 };
    const rr = ((1 + dd) * sn) / (dd + cz), re = ((1 + dd) * Math.sin(rad(view.hfov) / 2)) / (dd + Math.cos(rad(view.hfov) / 2));
    return { u: (dot(d, r) / sn * rr) / re, v: (-dot(d, up) / sn * rr) / (re / aspect) };
  }
  const tx = Math.tan(rad(view.hfov) / 2), ty = tx / aspect;
  return { u: dot(d, r) / z / tx, v: -dot(d, up) / z / ty };
}

/** The smallest arc of the circle holding all these yaws: its middle and its width (degrees). */
export function yawArc(yaws: number[]): { mid: number; spread: number } {
  if (yaws.length === 1) return { mid: wrap180(yaws[0]), spread: 0 };
  const s = yaws.map((y) => ((y % 360) + 360) % 360).sort((a, b) => a - b);
  let gap = -1, at = 0;
  for (let i = 0; i < s.length; i++) {
    const g = i + 1 < s.length ? s[i + 1] - s[i] : s[0] + 360 - s[i];
    if (g > gap) { gap = g; at = i; }
  }
  // The arc runs from just after the largest gap all the way round to just before it.
  const start = s[(at + 1) % s.length], spread = 360 - gap;
  return { mid: wrap180(start + spread / 2), spread };
}

/** Maximum over a window of ±`reach` seconds (sorted times). */
function rollingMax(ts: number[], vs: number[], reach: number): number[] {
  return ts.map((t, i) => {
    let m = vs[i];
    for (let j = i - 1; j >= 0 && ts[j] >= t - reach; j--) m = Math.max(m, vs[j]);
    for (let j = i + 1; j < ts.length && ts[j] <= t + reach; j++) m = Math.max(m, vs[j]);
    return m;
  });
}

/**
 * Dense view keys that keep several people in the frame together (twins, a family): each person's
 * head marks are interpolated on their own, the frame aims at the middle of the group and opens up
 * to hold everyone with a margin (never narrower than the single-person view), the higher head sits
 * on the headroom line unless that would push a lower head off the bottom, and the motion is
 * smoothed (zoom twice as slowly, widening ahead of time). One person behaves like frameSubject.
 */
export function frameGroup(subjects: Subject[], from: number, to: number, o: GroupOpts = {}): { keys: ViewKey[]; report: GroupReport } {
  const people = subjects
    .map((s) => ({ name: s.name, ms: s.marks.filter((m) => Number.isFinite(m.t) && Number.isFinite(m.x) && Number.isFinite(m.y)).sort((a, b) => a.t - b.t) }))
    .filter((s) => s.ms.length);
  if (!people.length || to <= from) return { keys: [], report: { subjects: [], tooFar: [] } };
  const step = Math.max(0.02, o.step ?? 0.1);
  const aspect = o.aspect ?? 16 / 9, headroom = Math.max(0, Math.min(0.5, o.headroom ?? 0.33));
  const lim = viewLimits(aspect, o.free);
  const base = Math.min(o.hfov ?? lim.base, lim.max);
  const reach = o.reach ?? 3, margin = o.margin ?? (aspect < 1 ? 12 : 25), maxF = Math.max(base, Math.min(o.maxHfov ?? lim.max, lim.max));
  // Each person's head path, with how far each moment is from their nearest mark.
  const paths = people.map((p) => {
    const t = p.ms.map((m) => m.t), a = p.ms.map(markAngles);
    const yaw = unwrapYaw(a.map((x) => x.yaw)), pitch = a.map((x) => x.pitch);
    const my = pchipSlopes(t, yaw), mp = pchipSlopes(t, pitch);
    return {
      at: (tt: number) => ({ yaw: wrap180(pchipAt(t, yaw, my, tt)), pitch: pchipAt(t, pitch, mp, tt) }),
      near: (tt: number) => {
        let lo = 0, hi = t.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= tt) lo = mid; else hi = mid; }
        return Math.min(Math.abs(t[lo] - tt), Math.abs(t[hi] - tt));
      },
    };
  });
  const n = Math.max(1, Math.round((to - from) / step));
  const ts: number[] = [], heads: ({ yaw: number; pitch: number } | null)[][] = [];
  const cy: number[] = [], need: number[] = [], far: boolean[] = [];
  let lastMid = 0;
  for (let i = 0; i <= n; i++) {
    const tt = Math.min(to, from + i * step);
    ts.push(tt);
    let h = paths.map((p) => (p.near(tt) <= reach ? p.at(tt) : null));
    // Nobody marked near this moment: keep following whoever was marked closest.
    if (h.every((x) => !x)) {
      const k = paths.reduce((b, p, j) => (p.near(tt) < paths[b].near(tt) ? j : b), 0);
      h = paths.map((p, j) => (j === k ? p.at(tt) : null));
    }
    heads.push(h);
    const on = h.filter((x): x is { yaw: number; pitch: number } => !!x);
    const arc = yawArc(on.map((x) => x.yaw));
    // Unwrap the centre against the previous one so smoothing never swings the long way round.
    let mid = arc.mid;
    if (i) mid = lastMid + wrap180(mid - lastMid);
    lastMid = mid;
    cy.push(mid);
    // Wide enough for the spread across (with a margin each side) and the spread up–down (with
    // room above the higher head and below the lower one, at this aspect).
    const ps = on.map((x) => x.pitch);
    const vNeed = Math.min(170, Math.max(...ps) - Math.min(...ps) + margin);
    const hFromV = deg(2 * Math.atan(Math.tan(rad(vNeed) / 2) * aspect));
    const want = on.length > 1 ? Math.max(arc.spread + 2 * margin, hFromV) : base;
    far.push(want > maxF);
    need.push(Math.min(maxF, Math.max(base, want)));
  }
  const sg = o.sigma ?? 0.4;
  // Open up ahead of time, then ease: zoom moves twice as slowly as the aim.
  const fov = gaussian(ts, rollingMax(ts, need, 0.7), sg * 2);
  const sy = gaussian(ts, cy, sg);
  // Vertical aim at each moment for the smoothed zoom.
  const pt = ts.map((_, i) => {
    const on = heads[i].filter((x): x is { yaw: number; pitch: number } => !!x);
    const top = Math.max(...on.map((x) => x.pitch)), low = Math.min(...on.map((x) => x.pitch));
    const aim = top - headDrop(fov[i], aspect, headroom);
    if (on.length < 2) return aim;
    const view = { yaw: wrap180(sy[i]), pitch: aim, roll: 0, hfov: fov[i], ...(o.free ? {} : { dist: distFor(fov[i], lim) }) };
    const lowest = Math.max(...on.map((x) => project(x.yaw, x.pitch, view, aspect)?.v ?? 1));
    return lowest > 0.7 ? (top + low) / 2 : aim;
  });
  // The view stays near level; people lower down simply sit lower in the frame.
  const dists = fov.map((f) => (o.free ? 0 : distFor(f, lim)));
  const sp = gaussian(ts, pt, sg).map((p, i) => { const limit = o.free ? 62 : pitchLimit(fov[i], aspect, dists[i]); return Math.max(-limit, Math.min(limit, p)); });
  const keys = ts.map((tt, i) => ({ t: r3(tt), view: normView({ yaw: sy[i], pitch: sp[i], roll: 0, hfov: fov[i], ...(dists[i] ? { dist: dists[i] } : {}) }) }));
  // How well everyone was kept in view, and where they could not all fit.
  const counts = people.map(() => ({ inFrame: 0, counted: 0 }));
  keys.forEach((k, i) => heads[i].forEach((h, j) => {
    if (!h || paths[j].near(ts[i]) > reach) return;
    counts[j].counted++;
    const p = project(h.yaw, h.pitch, k.view, aspect);
    if (p && Math.abs(p.u) <= 1 && Math.abs(p.v) <= 1) counts[j].inFrame++;
  }));
  const tooFar: [number, number][] = [];
  far.forEach((f, i) => {
    if (!f) return;
    const last = tooFar[tooFar.length - 1];
    if (last && ts[i] - last[1] <= step * 1.5) last[1] = r3(ts[i]);
    else tooFar.push([r3(ts[i]), r3(ts[i])]);
  });
  return {
    keys,
    report: { subjects: people.map((p, j) => ({ name: p.name, inFrame: counts[j].counted ? Math.round((counts[j].inFrame / counts[j].counted) * 100) : 0, counted: counts[j].counted })), tooFar },
  };
}

// ---------------------------------------------------------------- snapping cuts into silences

/**
 * Moves a clip's tilt toward the end of the clip before it, so cuts jump less: at most `most` degrees,
 * and only as far as everyone followed stays in frame.
 */
export function easePitch(keys: ViewKey[], target: number, people: { marks: Mark[] }[], aspect: number, most = 12): ViewKey[] {
  if (!keys.length) return keys;
  const near = (ms: Mark[], t: number) => ms.reduce<Mark | null>((b, m) => (!b || Math.abs(m.t - t) < Math.abs(b.t - t) ? m : b), null);
  const fits = (shift: number) => keys.every((k, i) => {
    if (i % 5) return true;
    const view = { ...k.view, pitch: k.view.pitch + shift };
    return people.every((p) => {
      const m = near(p.marks, k.t);
      if (!m) return true;
      const a = markAngles(m), at = project(a.yaw, a.pitch, view, aspect);
      return !!at && Math.abs(at.u) <= 0.95 && Math.abs(at.v) <= 0.95;
    });
  });
  let shift = Math.max(-most, Math.min(most, target - keys[0].view.pitch));
  for (let i = 0; i < 4 && shift && !fits(shift); i++) shift = i === 3 ? 0 : shift / 2;
  if (!shift) return keys;
  return keys.map((k) => { const lim = pitchLimit(k.view.hfov, aspect, k.view.dist ?? 0); return { ...k, view: { ...k.view, pitch: r3(Math.max(-lim, Math.min(lim, k.view.pitch + shift))) } }; });
}

/** Head marks without those near the poles of the panorama or that jump faster than a person moves. */
export function saneMarks(marks: Mark[]): Mark[] {
  const out: Mark[] = [];
  for (const m of [...marks].sort((a, b) => a.t - b.t)) {
    if (m.y < 50 || m.y > 440) continue;
    const p = out[out.length - 1];
    if (p) {
      const dt = Math.max(0.1, m.t - p.t);
      const dx = Math.abs(((m.x - p.x + 480) % 960 + 960) % 960 - 480);
      if (dx / dt > 320 || Math.abs(m.y - p.y) / dt > 200) continue;
    }
    out.push(m);
  }
  return out;
}

/** About two marks a second, enough to say where someone was. */
export function thinMarks(marks: Mark[]): { t: number; x: number; y: number }[] {
  const out: { t: number; x: number; y: number }[] = [];
  for (const m of marks) if (!out.length || m.t - out[out.length - 1].t >= 0.45) out.push({ t: r3(m.t), x: Math.round(m.x), y: Math.round(m.y) });
  return out;
}

export type SubjectLook = { t: number; missing: string[]; others: number; bigOther: boolean; ok: boolean };

/** A face or head this close on the panorama (960 wide) is the same person. */
const SAME_HEAD = 48;
/** Someone else's face wider than this share of the frame is taking the picture over. */
const BIG_FACE = 0.16;

/** At each look: who of the followed people is out of frame, and whether someone else fills it. */
export function subjectLooks(subjects: { name: string; marks: { t: number; x: number; y: number }[] }[], seen: { t: number; faces: { x: number; y: number; w: number }[] }[], viewAt: (t: number) => View, aspect: number, reach = 2): SubjectLook[] {
  const seenAt = (m: { x: number; y: number }, x: number, y: number) => Math.hypot(Math.abs(((m.x - x + 480) % 960 + 960) % 960 - 480), m.y - y);
  return seen.map(({ t, faces }) => {
    const view = viewAt(t);
    const inFrame = (x: number, y: number) => { const a = markAngles({ t, x, y }), p = project(a.yaw, a.pitch, view, aspect); return !!p && Math.abs(p.u) <= 1 && Math.abs(p.v) <= 1; };
    const heads = subjects.map((s) => {
      const near = s.marks.reduce<{ t: number; x: number; y: number } | null>((b, m) => (!b || Math.abs(m.t - t) < Math.abs(b.t - t) ? m : b), null);
      return { name: s.name, at: near && Math.abs(near.t - t) <= reach ? near : null };
    });
    const missing = heads.filter((h) => !h.at || !inFrame(h.at.x, h.at.y)).map((h) => h.name);
    const others = faces.filter((f) => inFrame(f.x + f.w / 2, f.y + f.w / 2) && !heads.some((h) => h.at && seenAt(h.at, f.x + f.w / 2, f.y + f.w / 2) <= SAME_HEAD));
    const bigOther = others.some((f) => (f.w * 0.375) / view.hfov > BIG_FACE);
    return { t, missing, others: others.length, bigOther, ok: !missing.length && !bigOther };
  });
}

/** Puts what the AI saw in the pictures over the automatic verdict of the nearest look. */
export function applyVerdicts(looks: SubjectLook[], notOk: number[], ok: number[]): SubjectLook[] {
  const nearest = (t: number) => looks.reduce((b, l, i) => (Math.abs(l.t - t) < Math.abs(looks[b].t - t) ? i : b), 0);
  const out = looks.map((l) => ({ ...l }));
  if (!out.length) return out;
  for (const t of ok) out[nearest(t)].ok = true;
  for (const t of notOk) out[nearest(t)].ok = false;
  return out;
}

export const percentOk = (looks: { ok: boolean }[]) => (looks.length ? Math.round((looks.filter((l) => l.ok).length / looks.length) * 100) : 0);

/** Pieces shorter than `keep` seconds left between cuts go too: a flash of a shot looks like a mistake. */
export function closeShortPieces(spans: [number, number][], from: number, to: number, keep = 1.5): [number, number][] {
  const out: [number, number][] = [];
  for (const sp of spans) {
    const last = out[out.length - 1];
    if (last && sp[0] - last[1] < keep) last[1] = sp[1];
    else out.push([sp[0], sp[1]]);
  }
  if (out.length && out[0][0] - from < keep) out[0][0] = from;
  if (out.length && to - out[out.length - 1][1] < keep) out[out.length - 1][1] = to;
  return out;
}

/** The source-time stretches of a clip whose looks are not all right; a single stray look at a clip's edge counts whole. */
export function badSpans(looks: { t: number; ok: boolean }[], step: number, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (const l of looks) {
    if (l.ok) continue;
    const a = Math.max(from, l.t - step / 2), b = Math.min(to, l.t + step / 2);
    const last = out[out.length - 1];
    if (last && a - last[1] < 0.01) last[1] = r3(b);
    else out.push([r3(a), r3(b)]);
  }
  return out;
}

export function lookSummary(looks: SubjectLook[]): string {
  const bad = looks.filter((l) => !l.ok);
  const lines = bad.slice(0, 12).map((l) => `${r3(l.t)}초: ${l.missing.length ? `${l.missing.join(", ")} 없음` : ""}${l.bigOther ? " 다른 사람이 크게 나옴" : ""}`.trim());
  return `따라갈 사람이 모두 화면 안에 있는 비율: ${percentOk(looks)}% (${looks.length}곳, 자동).${lines.length ? ` 문제 있는 곳:\n${lines.join("\n")}` : ""}`;
}

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
