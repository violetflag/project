import { describe, expect, it } from "vitest";
import { estimateBytes, SHRINK } from "../src/presets";

const small = SHRINK.find((p) => p.id === "small")!;

describe("the export size estimate", () => {
  // Measured: a 458 s Osmo 360 edit, small preset, AV1, 29.97 fps.
  const real = (short: number) => estimateBytes("shrink", 458, 0, small, "av1", short, { is360: true, fps: 29.97 });
  it("is near what a real 360 export came to", () => {
    expect(Math.abs(real(1080) / 225_227_748 - 1)).toBeLessThan(0.05);
    expect(Math.abs(real(2160) / 655_913_463 - 1)).toBeLessThan(0.05);
  });
  it("takes a plain video for less than a 360 one, and more frames for more", () => {
    const plain = estimateBytes("shrink", 100, 0, small, "av1", 1080);
    expect(estimateBytes("shrink", 100, 0, small, "av1", 1080, { is360: true })).toBeGreaterThan(plain * 2);
    expect(estimateBytes("shrink", 100, 0, small, "av1", 1080, { fps: 60 })).toBeGreaterThan(plain * 1.3);
  });
});
