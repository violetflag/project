import { describe, expect, it } from "vitest";
import { newDraft } from "../src/edit";
import { reviewDraft, reviewText } from "../src/review";
import type { Asset, Clip, Draft } from "../src/types";

const osv = (id: string): Asset => ({ id, folder: "", tState: "idle", added: 0, info: { path: `/v/${id}.osv`, name: `${id}.osv`, kind: "video", duration: 120, width: 3840, height: 3840, fps: 30, has_audio: true, layout360: "dual" } as any });
const flat = (id: string): Asset => ({ id, folder: "", tState: "idle", added: 0, info: { path: `/v/${id}.mp4`, name: `${id}.mp4`, kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true, layout360: "none" } as any });
const am = new Map([osv("a1"), osv("a2"), flat("f1")].map((a) => [a.id, a]));
const v = (yaw = 0, pitch = 0, hfov = 91, dist = 0.3) => ({ yaw, pitch, roll: 0, hfov, dist });
const clip = (id: string, asset: string, start: number, end: number, extra: Partial<Clip> = {}): Clip => ({ id, asset, start, end, speed: 1, volume: 1, view: v(), ...extra });
const draft = (clips: Clip[], aspect = "16:9"): Draft => ({ ...newDraft("점검", aspect), clips });

describe("self-review of a draft", () => {
  it("finds nothing in a level, natural edit", () => {
    const d = draft([clip("c1", "a1", 0, 5), clip("c2", "a1", 10, 15, { view: v(20) }), clip("c3", "f1", 0, 3, { view: undefined })]);
    expect(reviewDraft(d, am)).toEqual([]);
    expect(reviewText(d, am)).toMatch(/문제 없음/);
  });

  it("finds the ceiling-camera look, stretched corners, lost horizon, jumps and short clips, with timeline times", () => {
    const d = draft([
      // 2.5 s at pitch -48 inside a 5 s clip (keys), ordinary lens at 121°.
      clip("c1", "a1", 0, 5, { view: v(0, 0, 121, 0), viewKeys: [{ t: 0, view: v(0, -5, 121, 0) }, { t: 2.5, view: v(0, -48, 121, 0) }, { t: 5, view: v(0, -48, 121, 0) }] }),
      // Same recording, 120° turn at the cut.
      clip("c2", "a1", 20, 25, { view: v(120) }),
      clip("c3", "a2", 0, 0.5),
    ]);
    const f = reviewDraft(d, am);
    const kinds = f.map((x) => x.kind);
    expect(kinds).toContain("pitch");
    expect(kinds).toContain("stretch");
    expect(kinds).toContain("horizon");
    expect(kinds).toContain("jump");
    expect(kinds).toContain("short");
    const p = f.find((x) => x.kind === "pitch")!;
    expect(p.at).toBeGreaterThan(1);
    expect(p.text).toMatch(/pitch -48°.*내려다봄/);
    expect(f.find((x) => x.kind === "stretch")!.text).toMatch(/2\.26배/);
    expect(f.find((x) => x.kind === "jump")!).toMatchObject({ clip: "c2", at: 5 });
    expect(f.find((x) => x.kind === "short")!).toMatchObject({ clip: "c3", at: 10 });
    expect(reviewText(d, am)).toMatch(/^편집본 "점검" 점검: \d+건/);
  });

  it("leaves little planets alone and uses the draft's aspect", () => {
    const planet = draft([clip("c1", "a1", 0, 5, { view: { yaw: 0, pitch: -90, roll: 0, hfov: 263, dist: 1 }, viewPreset: "planet" })]);
    expect(reviewDraft(planet, am)).toEqual([]);
    // 9:16 at 91° is far too wide for a tall frame: corners stretch.
    const tall = draft([clip("c1", "a1", 0, 5, { view: v(0, 0, 91, 0) })], "9:16");
    expect(reviewDraft(tall, am).map((x) => x.kind)).toContain("stretch");
  });
});
