import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { cleanKeys, frameSubject, gapsFromSpeech, headDrop, markAngles, normView, pchipSlopes, sampleKeys, smoothViewAt, snapRanges, snapTime, wrap180 } from "../src/framing";
import { viewAt } from "../src/edit";
import type { ViewKey } from "../src/types";

const K = (t: number, yaw: number, pitch = 0, roll = 0, hfov = 90): ViewKey => ({ t, view: { yaw, pitch, roll, hfov } });

describe("normView", () => {
  it("wraps yaw 195 to -165 (the AI error)", () => {
    expect(normView({ yaw: 195 }).yaw).toBe(-165);
    expect(normView({ yaw: -190 }).yaw).toBe(170);
    expect(normView({ yaw: 540 }).yaw).toBe(180);
    expect(wrap180(-180)).toBe(-180);
  });
  it("clamps pitch and fov, fills missing from base, survives NaN", () => {
    const v = normView({ pitch: 120, hfov: 500, roll: 361 });
    expect(v).toMatchObject({ pitch: 89, hfov: 160, roll: 1 });
    expect(normView({ yaw: NaN, hfov: 10 })).toMatchObject({ yaw: 0, hfov: 20 });
    expect(normView({ yaw: 5 }, { yaw: 0, pitch: 7, roll: 0, hfov: 80 })).toMatchObject({ pitch: 7, hfov: 80 });
  });
});

describe("smooth interpolation", () => {
  it("passes through keys, holds outside, wraps through ±180", () => {
    const ks = [K(0, 170), K(1, -170), K(2, -150)];
    expect(smoothViewAt(ks, 0).yaw).toBe(170);
    expect(smoothViewAt(ks, -5).yaw).toBe(170);
    expect(smoothViewAt(ks, 9).yaw).toBe(-150);
    const mid = smoothViewAt(ks, 0.5).yaw;
    expect(Math.abs(mid)).toBeGreaterThan(170); // goes through 180, not through 0
  });
  it("is monotone: no overshoot between two equal-then-rising keys", () => {
    const ks = [K(0, 0), K(1, 0), K(2, 10), K(3, 10)];
    for (let t = 0; t <= 3; t += 0.05) {
      const y = smoothViewAt(ks, t).yaw;
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(10 + 1e-9);
    }
  });
  it("two keys interpolate linearly; viewAt delegates", () => {
    expect(smoothViewAt([K(0, 0), K(2, 20)], 1).yaw).toBe(10);
    expect(viewAt(undefined, [K(0, 0), K(2, 20)], 0.5).yaw).toBe(5);
    expect(viewAt({ yaw: 200, pitch: 0, roll: 0, hfov: 100 }, undefined, 0).yaw).toBe(-160);
  });
  it("handles thousands of keys quickly", () => {
    const ks = Array.from({ length: 6000 }, (_, i) => K(i * 0.1, ((i * 3) % 360) - 180));
    const t0 = Date.now();
    for (let i = 0; i < 2000; i++) smoothViewAt(ks, (i * 0.3) % 600);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it("cleanKeys sorts, dedupes, normalises", () => {
    const out = cleanKeys([K(2, 195), K(1, 0), K(1.0004, 5)]);
    expect(out.map((k) => k.t)).toEqual([1, 2]);
    expect(out[0].view.yaw).toBe(5);
    expect(out[1].view.yaw).toBe(-165);
  });
  it("pchip slopes match scipy on a sample", () => {
    // worked by hand with the scipy formulas: end slopes limited to 0 here, interior harmonic means
    const m = pchipSlopes([0, 1, 2, 4], [0, 1, 4, 5]);
    expect(m[0]).toBeCloseTo(0, 5);
    expect(m[1]).toBeCloseTo(1.5, 5);
    expect(m[2]).toBeCloseTo(0.931034, 4);
    expect(m[3]).toBeCloseTo(0, 5);
  });
});

describe("frameSubject", () => {
  it("centres a person at the front with head near the top third", () => {
    const keys = frameSubject([{ t: 0, x: 480, y: 240 }, { t: 5, x: 480, y: 240 }], 0, 5, { sigma: 0 });
    expect(keys.length).toBe(51);
    expect(keys[0].view.yaw).toBe(0);
    expect(keys[0].view.pitch).toBeLessThan(0); // camera looks below the head
    expect(keys[0].view.pitch).toBeCloseTo(-headDrop(90, 16 / 9, 0.33), 2);
  });
  it("follows across the ±180 seam without spinning", () => {
    const keys = frameSubject([{ t: 0, x: 940, y: 240 }, { t: 2, x: 20, y: 240 }], 0, 2, { sigma: 0.2 });
    const yaws = keys.map((k) => k.view.yaw);
    for (let i = 1; i < yaws.length; i++) {
      let d = Math.abs(yaws[i] - yaws[i - 1]);
      d = Math.min(d, 360 - d);
      expect(d).toBeLessThan(10);
    }
  });
  it("smoothing reduces jitter", () => {
    const marks = Array.from({ length: 9 }, (_, i) => ({ t: i, x: 480 + (i % 2 ? 6 : -6), y: 240 }));
    const rough = frameSubject(marks, 0, 8, { sigma: 0 }), smooth = frameSubject(marks, 0, 8, { sigma: 0.8 });
    const tv = (ks: ViewKey[]) => ks.reduce((a, k, i) => (i ? a + Math.abs(k.view.yaw - ks[i - 1].view.yaw) : 0), 0);
    expect(tv(smooth)).toBeLessThan(tv(rough));
  });
  it("mark angles", () => {
    expect(markAngles({ t: 0, x: 480, y: 240 })).toEqual({ yaw: 0, pitch: 0 });
    expect(markAngles({ t: 0, x: 0, y: 0 })).toEqual({ yaw: -180, pitch: 90 });
  });
});

describe("snapping cuts", () => {
  const speech: [number, number][] = [[0, 2], [3, 5], [5.1, 8], [10, 12]];
  it("finds gaps ≥ 0.35 s", () => expect(gapsFromSpeech(speech)).toEqual([[2, 3], [8, 10]]));
  it("moves a cut inside speech to the nearest gap, leaves gap cuts", () => {
    const g = gapsFromSpeech(speech);
    expect(snapTime(2.5, g)).toBe(2.5);
    expect(snapTime(1.5, g)).toBe(2.08); // nearest point inside the gap, padded by 0.08
    expect(snapTime(6.5, g)).toBe(6.5); // no gap within 1.5 s: unchanged
  });
  it("snapRanges reports moves and keeps min length", () => {
    const r = snapRanges([[1.5, 7.5]], speech);
    expect(r.ranges[0][0]).toBeGreaterThanOrEqual(2);
    expect(r.ranges[0][0]).toBeLessThanOrEqual(3);
    expect(r.moved.length).toBeGreaterThan(0);
    expect(snapRanges([[1.9, 2.2]], speech, { minLen: 5 }).moved).toEqual([]);
  });
  it("sampleKeys keeps ends", () => {
    const ks = Array.from({ length: 1000 }, (_, i) => K(i, 0));
    const s = sampleKeys(ks, 10);
    expect(s.length).toBe(10);
    expect(s[0].t).toBe(0);
    expect(s[9].t).toBe(999);
  });
});

describe("parity fixture for Rust", () => {
  it("writes tests/fixtures/framing.json", () => {
    const keys = [K(0, 170, 0, 0, 90), K(0.5, -175, 10, 2, 100), K(1.5, -120, -5, 0, 80), K(2, -100, -5, 0, 80), K(4, 30, 20, -3, 120)];
    const ts = [-1, 0, 0.1, 0.25, 0.5, 0.9, 1.5, 1.75, 2, 3, 3.9, 4, 5];
    const cases = ts.map((t) => ({ t, view: smoothViewAt(keys, t) }));
    const norm = [{ in: { yaw: 195, pitch: 0, roll: 0, hfov: 100 } }, { in: { yaw: -190, pitch: 95, roll: 361, hfov: 10 } }, { in: { yaw: 540, pitch: -120, roll: -200, hfov: 200 } }].map((c) => ({ ...c, out: normView(c.in) }));
    writeFileSync(new URL("./fixtures/framing.json", import.meta.url), JSON.stringify({ keys, cases, norm }, null, 1) + "\n");
    expect(cases.length).toBe(ts.length);
  });
});
