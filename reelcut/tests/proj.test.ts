import { describe, expect, it } from "vitest";
import { aOf, aspectHW, cornerStretch, dfovOf, fovMax, presetRow, presetView, rOf, thirdsPitch, undistort, vfovOf, viewDir, viewStats, VIEW_PRESETS } from "../src/proj";
import fx from "./fixtures/proj.json";

const HW = 9 / 16;

describe("360 projection with dist", () => {
  it("goes there and back: a(r(a)) = a", () => {
    for (const d of [0, 0.25, 0.5, 0.75, 1]) for (const a of [0, 5, 30, 60, 85, 110, 150]) {
      // Rays exist up to acos(-d) off the axis (90° for an ordinary lens, 180° at d = 1).
      if (a >= (Math.acos(-d) * 180) / Math.PI - 1) continue;
      expect(aOf(rOf(a, d), d)).toBeCloseTo(a, 9);
    }
  });

  it("is rectilinear at d = 0 and stereographic at d = 1", () => {
    for (const a of [10, 40, 70]) {
      expect(rOf(a, 0)).toBeCloseTo(Math.tan((a * Math.PI) / 180), 12);
      expect(rOf(a, 1)).toBeCloseTo(2 * Math.tan((a * Math.PI) / 360), 12);
    }
  });

  it("stretches the corners of an ordinary lens as today (16:9)", () => {
    expect([90, 100, 121, 130].map((h) => +cornerStretch(h, 0, HW).toFixed(2))).toEqual([1.52, 1.69, 2.26, 2.66]);
  });

  it("matches the preset table (plan §4.3)", () => {
    const s = (a: string, p: "zoom" | "best" | "wide" | "ultra") => { const v = presetView(a, p); return { ...viewStats(v.hfov, v.dist, a), pitch: v.pitch }; };
    expect(s("16:9", "zoom")).toEqual({ vfov: 38, dfov: 70.2, stretch: 1.22, pitch: 0 });
    expect(s("16:9", "best")).toEqual({ vfov: 56.5, dfov: 100.4, stretch: 1.27, pitch: -9.9 });
    expect(s("16:9", "wide")).toMatchObject({ vfov: 74.3, dfov: 129.6, stretch: 1.22 });
    expect(s("16:9", "ultra")).toMatchObject({ vfov: 96.4, dfov: 169.5, stretch: 1 });
    expect(s("9:16", "zoom").vfov).toBe(62.9);
    expect(s("9:16", "best")).toMatchObject({ vfov: 90.3, stretch: 1.26, pitch: -17.2 });
    expect(s("9:16", "wide").vfov).toBe(118.9);
    expect(s("9:16", "ultra").vfov).toBe(154.8);
    expect(s("1:1", "best")).toMatchObject({ stretch: 1.27, pitch: -14.1 });
    expect(s("4:5", "zoom").vfov).toBe(57);
    expect(s("4:5", "best")).toMatchObject({ vfov: 82.8, stretch: 1.26, pitch: -15.4 });
    expect(s("4:5", "wide").vfov).toBe(109.6);
    expect(s("4:5", "ultra").vfov).toBe(142.2);
    expect(presetView("16:9", "planet")).toEqual({ hfov: 263, dist: 1, pitch: -90 });
    // Every preset stays within what its dist allows, and none stretches the corners past ×1.3.
    for (const [a, row] of Object.entries(VIEW_PRESETS)) for (const [p, v] of Object.entries(row)) {
      expect(v.hfov, `${a} ${p}`).toBeLessThanOrEqual(fovMax(v.dist));
      if (p !== "planet") expect(cornerStretch(v.hfov, v.dist, aspectHW(a)), `${a} ${p}`).toBeLessThan(1.3);
    }
  });

  it("uses the nearest row for other aspects", () => {
    expect(presetRow("21:9")).toBe(VIEW_PRESETS["16:9"]);
    expect(presetRow("3:4")).toBe(VIEW_PRESETS["4:5"]);
    expect(presetRow("1:2")).toBe(VIEW_PRESETS["9:16"]);
    expect(aspectHW("4:5")).toBe(1.25);
  });

  it("fixes distortion in one step and keeps the short side (plan §4.4)", () => {
    const a = undistort({ hfov: 100 }, HW);
    expect(a).toEqual({ hfov: 105.1, dist: 0.294 });
    expect(+cornerStretch(a.hfov, a.dist, HW).toFixed(2)).toBe(1.39);
    expect(vfovOf(a.hfov, a.dist, HW)).toBeCloseTo(vfovOf(100, 0, HW), 0);
    const b = undistort({ hfov: 121 }, HW);
    expect(b).toEqual({ hfov: 137.1, dist: 0.625 });
    expect(+vfovOf(b.hfov, b.dist, HW).toFixed(1)).toBe(89.7);
    expect(+cornerStretch(b.hfov, b.dist, HW).toFixed(2)).toBe(1.31);
    // Portrait: the short side is the width, so only dist changes.
    const c = undistort({ hfov: 75 }, 16 / 9);
    expect(c).toEqual({ hfov: 75, dist: 0.414 });
    // Already enough (or a narrow view): nothing to do.
    expect(undistort({ hfov: 137.1, dist: 0.625 }, HW)).toEqual({ hfov: 137.1, dist: 0.625 });
    expect(undistort({ hfov: 63 }, HW)).toEqual({ hfov: 63, dist: 0 });
  });

  it("has the old 160° limit at d = 0 and allows more as d grows", () => {
    expect(fovMax(0)).toBeCloseTo(160, 9);
    expect(fovMax(0.3)).toBeCloseTo(194.9, 1);
    expect(fovMax(1)).toBe(330);
  });

  it("puts the horizon on the upper third with the best preset", () => {
    const v = presetView("16:9", "best");
    // The pixel on the upper third line (v = 1/3), seen from a view pitched down by -pitch, lies on the horizon.
    const dir = viewDir(0, 1 / 3, v.hfov, v.dist, HW);
    const elev = (Math.atan2(dir[1], dir[2]) * 180) / Math.PI;
    expect(elev + v.pitch).toBeCloseTo(0, 1);
    expect(thirdsPitch(91, 0.3, HW)).toBeCloseTo(v.pitch, 1);
  });

  it("matches the shared fixture (Rust and the shader read the same numbers)", () => {
    for (const c of fx.r) expect(rOf(c.a, c.d)).toBeCloseTo(c.r, 10);
    for (const c of fx.dir) viewDir(c.u, c.v, c.hfov, c.d, c.hw).forEach((x, i) => expect(x).toBeCloseTo(c.dir[i], 10));
    for (const c of fx.fov) {
      expect(vfovOf(c.hfov, c.d, c.hw)).toBeCloseTo(c.vfov, 9);
      expect(dfovOf(c.hfov, c.d, c.hw)).toBeCloseTo(c.dfov, 9);
      expect(cornerStretch(c.hfov, c.d, c.hw)).toBeCloseTo(c.stretch, 9);
    }
    for (const c of fx.fov_max) expect(fovMax(c.d)).toBeCloseTo(c.max, 9);
    for (const c of fx.undistort) expect(undistort({ hfov: c.hfov }, c.hw)).toEqual(c.out);
    for (const [a, row] of Object.entries(fx.presets)) for (const [p, v] of Object.entries(row)) expect(presetView(a, p as any)).toEqual(v);
    // Directions are unit length and the centre looks straight ahead.
    for (const c of fx.dir) expect(Math.hypot(...c.dir)).toBeCloseTo(1, 10);
    expect(viewDir(0, 0, 100, 0.5, HW)).toEqual([0, 0, 1]);
  });
});
