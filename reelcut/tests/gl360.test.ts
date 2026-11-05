import { describe, expect, it } from "vitest";
import { readMark } from "../src/gl360";

/** One row of the strip for frame `k` (see live.rs `frame_marks`). */
function row(k: number, always = true) {
  const r = new Uint8Array(32 * 22 * 4);
  for (let x = 0; x < 32 * 22; x++) {
    const b = Math.floor(x / 32);
    const on = b < 20 ? (Math.floor(k / 2 ** b) & 1) === 1 : b === 20 && always;
    r[x * 4] = on ? 235 : 16;
  }
  return r;
}

describe("the frame number under a 360 stream", () => {
  it("reads back the number written", () => {
    for (const k of [0, 1, 2, 8841, 43377, 86399, 2 ** 20 - 1]) expect(readMark(row(k))).toBe(k);
  });
  it("is not fooled by a picture without the strip", () => {
    expect(readMark(row(8841, false))).toBeNull();
    expect(readMark(new Uint8Array(32 * 22 * 4).fill(200))).toBeNull();
  });
});
