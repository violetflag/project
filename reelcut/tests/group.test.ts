import { describe, expect, it } from "vitest";
import { frameGroup, frameSubject, project, wrap180, yawArc, type Mark } from "../src/framing";

// Panorama x for a yaw (x 0–960 = −180..180), y for a pitch (240 = horizon, up = smaller).
const X = (yaw: number) => ((yaw + 180) / 360) * 960;
const Y = (pitch: number) => 240 - pitch / 0.375;
const marks = (from: number, to: number, yaw: (t: number) => number, pitch = 5): Mark[] =>
  Array.from({ length: Math.round((to - from) / 2.5) + 1 }, (_, i) => from + i * 2.5).map((t) => ({ t, x: X(yaw(t)), y: Y(pitch) }));

describe("framing two people together (twins)", () => {
  it("aims between two heads 60° apart and opens wider than the single-person view", () => {
    const { keys, report } = frameGroup([{ name: "A", marks: marks(0, 10, () => -30) }, { name: "B", marks: marks(0, 10, () => 30) }], 0, 10, { free: true });
    const mid = keys[50].view;
    expect(Math.abs(mid.yaw)).toBeLessThan(1);
    expect(mid.hfov).toBeGreaterThan(90);
    expect(mid.hfov).toBeCloseTo(110, 0);
    expect(report.subjects.map((s) => s.inFrame)).toEqual([100, 100]);
    expect(report.tooFar).toEqual([]);
  });

  it("works across the ±180° seam (centre behind, not in front)", () => {
    const { keys } = frameGroup([{ name: "A", marks: marks(0, 10, () => 165) }, { name: "B", marks: marks(0, 10, () => -165) }], 0, 10, { hfov: 90 });
    const v = keys[50].view;
    expect(Math.abs(wrap180(v.yaw - 180))).toBeLessThan(1);
    expect(v.hfov).toBeCloseTo(90, 0);
    expect(yawArc([165, -165])).toEqual({ mid: 180, spread: 30 });
  });

  it("follows the one twin left when the other has no marks for a while", () => {
    const a = marks(0, 20, () => -40);
    const b = marks(0, 6, () => 20).concat(marks(15, 20, () => 20));
    const { keys, report } = frameGroup([{ name: "A", marks: a }, { name: "B", marks: b }], 0, 20);
    const at = (t: number) => keys[Math.round(t * 10)].view;
    expect(Math.abs(at(10).yaw + 40)).toBeLessThan(3); // B unmarked 5–15 s (beyond the 3 s reach at 10 s): A alone
    expect(Math.abs(at(3).yaw + 10)).toBeLessThan(2); // both: between them
    expect(report.subjects[0].inFrame).toBe(100);
  });

  it("opens a group with a wider projection, and says when they do not fit", () => {
    const near = frameGroup([{ name: "A", marks: marks(0, 10, () => -30) }, { name: "B", marks: marks(0, 10, () => 30) }], 0, 10);
    expect(near.keys[50].view.hfov).toBeCloseTo(110, 0);
    expect(near.keys[50].view.dist).toBeGreaterThan(0.3);
    expect(near.report.tooFar).toEqual([]);
    const far = frameGroup([{ name: "A", marks: marks(0, 10, () => -50) }, { name: "B", marks: marks(0, 10, () => 50) }], 0, 10);
    expect(far.keys[50].view.hfov).toBeCloseTo(118, 0);
    expect(far.report.tooFar.length).toBe(1);
  });

  it("reports when they are too far apart to share one frame", () => {
    const { keys, report } = frameGroup([{ name: "A", marks: marks(0, 10, () => -90) }, { name: "B", marks: marks(0, 10, () => 90) }], 0, 10);
    expect(keys[50].view.hfov).toBeLessThanOrEqual(130.001);
    expect(report.tooFar.length).toBe(1);
    expect(report.tooFar[0][0]).toBe(0);
    expect(report.subjects.every((s) => s.inFrame < 100)).toBe(true);
  });

  it("puts the higher head on the headroom line, or centres when the lower one would drop out", () => {
    const close = frameGroup([{ name: "A", marks: marks(0, 10, () => -10, 10) }, { name: "B", marks: marks(0, 10, () => 10, 5) }], 0, 10).keys[50].view;
    const top = project(-10, 10, close, 16 / 9)!;
    expect(top.v).toBeCloseTo(-1 + 2 * 0.33, 1);
    const tall = frameGroup([{ name: "A", marks: marks(0, 10, () => -10, 30) }, { name: "B", marks: marks(0, 10, () => 10, -30) }], 0, 10, { free: true }).keys[50].view;
    const low = project(10, -30, tall, 16 / 9)!;
    expect(low.v).toBeLessThan(0.7);
  });

  it("with one person matches the single-person framing", () => {
    const m = marks(0, 10, (t) => t * 3);
    const g = frameGroup([{ name: "A", marks: m }], 0, 10).keys;
    const s = frameSubject(m, 0, 10);
    expect(Math.abs(g[40].view.yaw - s[40].view.yaw)).toBeLessThan(0.5);
    expect(Math.abs(g[40].view.pitch - s[40].view.pitch)).toBeLessThan(0.5);
  });
});
