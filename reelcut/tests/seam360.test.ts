import { describe, expect, it } from "vitest";
import { SEAM_NODES, SeamTrack, STRIP_H, STRIP_W } from "../src/seam360";

/** A textured strip; the front lens shows the same scene shifted by (sx, sy). */
function strip(sx: number, sy: number, gain = 1): Uint8Array {
  const tex = (x: number, y: number) => 110 + 45 * Math.sin(x * 0.61) * Math.cos(y * 0.83) + 30 * Math.sin(x * 0.23 + y * 0.37);
  const o = new Uint8Array(STRIP_W * STRIP_H * 4);
  for (let r = 0; r < STRIP_H; r++) {
    for (let c = 0; c < STRIP_W; c++) {
      const i = (r * STRIP_W + c) * 4;
      o[i] = tex(c, r);
      o[i + 1] = tex(c - sx, r - sy) * gain;
      o[i + 2] = 255;
    }
  }
  return o;
}
const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;

describe("lining the lenses up along the seam", () => {
  it("finds a shift between the lenses and brings them together", () => {
    const t = new SeamTrack();
    for (let i = 0; i < 12; i++) { t.update(strip(1, 2)); t.ease(); }
    expect(mean(t.fx)).toBeCloseTo(1, 0);
    expect(mean(t.fy)).toBeCloseTo(2, 0);
    expect(t.last.aligned).toBeLessThan(t.last.plain * 0.5);
  });
  it("leaves lenses that already agree alone, the cut near the middle", () => {
    const t = new SeamTrack();
    t.update(strip(0, 0));
    expect(Math.abs(mean(t.fx))).toBeLessThan(0.2);
    expect(Math.abs(mean(t.fy))).toBeLessThan(0.2);
    expect(mean(t.ts)).toBeGreaterThan(0.35);
    expect(mean(t.ts)).toBeLessThan(0.65);
  });
  it("matches the brightness half way", () => {
    const t = new SeamTrack();
    for (let i = 0; i < 30; i++) { t.update(strip(0, 0, 1.2)); t.ease(); }
    expect(mean(t.gy)).toBeGreaterThan(1.05);
    expect(mean(t.gy)).toBeLessThan(1.15);
  });
  it("gives the shader its nodes, no flow in the middle of the range", () => {
    const t = new SeamTrack();
    const out = new Uint8Array(SEAM_NODES * 4);
    t.nodes(0.08, out);
    expect(Math.abs(out[0] - 127.5)).toBeLessThan(1);
    expect(Math.abs(out[1] - 127.5)).toBeLessThan(1);
    expect(Math.abs(out[2] - 127.5)).toBeLessThan(1);
  });
  it("is quick enough for every frame", () => {
    const t = new SeamTrack();
    const s = strip(1, 1);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) t.update(s);
    expect((performance.now() - t0) / 10).toBeLessThan(25);
  });
});
