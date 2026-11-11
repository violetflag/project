// 360 view projection (2.18): one family from rectilinear to stereographic, set by `dist` d in 0..1.
// d = 0 is an ordinary (rectilinear) lens: straight lines stay straight, but wide views stretch
// the corners (×2.26 at 121° in 16:9). d = 1 is stereographic: shapes keep their form at any width.
// In between, the corners stretch less as d grows. The same maths is in Rust (src-tauri/src/proj.rs)
// and in the preview shader (src/gl360.ts); tests/fixtures/proj.json holds shared numbers.
//
// A ray at angle a from the view axis lands at radius
//   r(a, d) = (1 + d)·sin a / (d + cos a)
// and back:  k = ρ/(1 + d);  a(ρ, d) = atan k + asin(k·d / √(1 + k²)).
// The picture's half-width is r_e = r(hfov/2, d); a pixel at u,v ∈ [-1, 1] sits at
// p = (u·r_e, v·r_e·H/W).
import type { View, ViewPreset } from "./types";

const RAD = Math.PI / 180;
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
export const clampDist = (d: number | undefined) => Math.min(1, Math.max(0, Number.isFinite(d as number) ? (d as number) : 0));

/** Radius of a ray `a` degrees off the axis. */
export function rOf(aDeg: number, d: number): number {
  const a = aDeg * RAD;
  return ((1 + d) * Math.sin(a)) / (d + Math.cos(a));
}
/** Angle (degrees) off the axis of the ray at radius ρ. */
export function aOf(rho: number, d: number): number {
  const k = rho / (1 + d);
  return (Math.atan(k) + Math.asin(Math.min(1, Math.max(-1, (k * d) / Math.sqrt(1 + k * k))))) / RAD;
}
/** Half-width of the picture in projection units. */
export const halfWidth = (hfov: number, d: number) => rOf(hfov / 2, d);

/** Direction (view space: x right, y up, z forward) of the pixel at u,v ∈ [-1,1]; hw = H/W. */
export function viewDir(u: number, v: number, hfov: number, d: number, hw: number): [number, number, number] {
  const re = halfWidth(hfov, d);
  const px = u * re, py = v * re * hw;
  const rho = Math.hypot(px, py);
  if (rho < 1e-9) return [0, 0, 1];
  const a = aOf(rho, d) * RAD;
  return [(px / rho) * Math.sin(a), (py / rho) * Math.sin(a), Math.cos(a)];
}

export const vfovOf = (hfov: number, d: number, hw: number) => 2 * aOf(halfWidth(hfov, d) * hw, d);
export const dfovOf = (hfov: number, d: number, hw: number) => 2 * aOf(halfWidth(hfov, d) * Math.sqrt(1 + hw * hw), d);
/** How much a small round thing is stretched (radial over tangential scale) `a` degrees off the axis. */
export function stretchAt(aDeg: number, d: number): number {
  const c = Math.cos(aDeg * RAD);
  return (1 + d * c) / (d + c);
}
/** Stretch in the picture corners. */
export const cornerStretch = (hfov: number, d: number, hw: number) => stretchAt(dfovOf(hfov, d, hw) / 2, d);
/** Widest field of view a dist allows (the old fixed limit, 160°, at d = 0). */
export const fovMax = (d: number) => Math.min(330, 2 * Math.acos(-clampDist(d)) / RAD - 20);
/** Pitch that puts the horizon on the upper third line (looking slightly down). */
export const thirdsPitch = (hfov: number, d: number, hw: number) => -aOf((halfWidth(hfov, d) * hw) / 3, d);

/** H/W of an aspect like "16:9". */
export function aspectHW(aspect: string): number {
  const [w, h] = String(aspect).split(":").map(Number);
  return w > 0 && h > 0 ? h / w : 9 / 16;
}

type Preset = { hfov: number; dist: number };
/** Field of view (degrees, horizontal) and dist per output aspect (plan-2.18 §4.3). */
export const VIEW_PRESETS: Record<"16:9" | "9:16" | "1:1" | "4:5", Record<ViewPreset, Preset>> = {
  "16:9": { zoom: { hfov: 63, dist: 0 }, best: { hfov: 91, dist: 0.3 }, wide: { hfov: 118, dist: 0.6 }, ultra: { hfov: 154, dist: 1 }, planet: { hfov: 263, dist: 1 } },
  "9:16": { zoom: { hfov: 38, dist: 0 }, best: { hfov: 56, dist: 0.3 }, wide: { hfov: 75, dist: 0.6 }, ultra: { hfov: 97, dist: 1 }, planet: { hfov: 205, dist: 1 } },
  "1:1": { zoom: { hfov: 53, dist: 0 }, best: { hfov: 77, dist: 0.3 }, wide: { hfov: 101, dist: 0.6 }, ultra: { hfov: 132, dist: 1 }, planet: { hfov: 205, dist: 1 } },
  "4:5": { zoom: { hfov: 47, dist: 0 }, best: { hfov: 69, dist: 0.3 }, wide: { hfov: 92, dist: 0.6 }, ultra: { hfov: 119, dist: 1 }, planet: { hfov: 205, dist: 1 } },
};
export const PRESET_LABEL: Record<ViewPreset, string> = { best: "최적", zoom: "확대", wide: "광각", ultra: "초광각", planet: "작은 행성" };

/** The preset row for an aspect; other aspects use the nearest row by H/W. */
export function presetRow(aspect: string): Record<ViewPreset, Preset> {
  if (aspect in VIEW_PRESETS) return VIEW_PRESETS[aspect as keyof typeof VIEW_PRESETS];
  const hw = aspectHW(aspect);
  const keys = Object.keys(VIEW_PRESETS) as (keyof typeof VIEW_PRESETS)[];
  const near = keys.reduce((a, b) => (Math.abs(Math.log(aspectHW(b) / hw)) < Math.abs(Math.log(aspectHW(a) / hw)) ? b : a));
  return VIEW_PRESETS[near];
}

/** A preset's view settings for an aspect: hfov, dist, and the pitch it suggests (best: horizon on the upper third; planet: straight down). */
export function presetView(aspect: string, p: ViewPreset): Preset & { pitch: number } {
  const x = presetRow(aspect)[p];
  const pitch = p === "planet" ? -90 : p === "best" ? r1(thirdsPitch(x.hfov, x.dist, aspectHW(aspect))) : 0;
  return { ...x, pitch };
}

/**
 * 왜곡 보정: from how wide the view is (its diagonal as an ordinary lens, D), choose d = (D − 90)/60
 * and keep the short side's field of view. In landscape the short side is vertical, so the width
 * grows a little (16:9: 100° → 105.1°, 121° → 137.1°); in portrait and square only d changes.
 */
export function undistort(v: Pick<View, "hfov"> & { dist?: number }, hw: number): { hfov: number; dist: number } {
  const d0 = clampDist(v.dist);
  const D = dfovOf(v.hfov, d0, hw);
  // The diagonal an ordinary lens would have at the same short-side field of view.
  const shortFov = hw <= 1 ? vfovOf(v.hfov, d0, hw) : v.hfov;
  const rectHfov = hw <= 1 ? 2 * aOf(Math.tan((shortFov / 2) * RAD) / hw, 0) : shortFov;
  const Drect = d0 === 0 ? D : dfovOf(rectHfov, 0, hw);
  const d = r3(Math.min(1, Math.max(0, (Drect - 90) / 60)));
  if (d <= d0) return { hfov: v.hfov, dist: d0 };
  if (hw > 1 || hw === 1) return { hfov: v.hfov, dist: d };
  const re = rOf(shortFov / 2, d) / hw;
  return { hfov: r1(2 * aOf(re, d)), dist: d };
}

/** The numbers shown next to a view: vertical and diagonal field of view, and corner stretch. */
export function viewStats(hfov: number, dist: number | undefined, aspect: string) {
  const d = clampDist(dist), hw = aspectHW(aspect);
  return { vfov: r1(vfovOf(hfov, d, hw)), dfov: r1(dfovOf(hfov, d, hw)), stretch: r2(cornerStretch(hfov, d, hw)) };
}
