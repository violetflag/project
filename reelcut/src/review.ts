// The AI's self-review of a draft (2.18): what a person would notice at once in a 360 edit, found
// from the numbers alone (no pictures needed): looking down like a ceiling camera, stretched
// corners, no horizon, sudden turns at cuts, clips too short to read. The review_draft tool lists
// these with timeline times so the AI fixes them before it reports; check_framing and view_frames
// show the pictures.
import { clipDur, is360, isGap, starts, viewAt } from "./edit";
import { aspectHW, clampDist, cornerStretch, vfovOf } from "./proj";
import { cutJumps } from "./quick360";
import type { Asset, Clip, Draft, View } from "./types";

export const REVIEW = { pitch: 30, stretch: 1.4, turn: 60, shortClip: 0.7, step: 0.5 };
export type Finding = { kind: "pitch" | "stretch" | "horizon" | "jump" | "short"; clip: string; at: number; to?: number; text: string };

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const r0 = (x: number) => Math.round(x);

/** Views a clip shows, every `step` seconds of source and at each key (with the clip's projection). */
function samples(c: Clip, step: number): { t: number; v: View }[] {
  const ts = new Set<number>();
  for (let t = c.start; t < c.end; t += step) ts.add(+t.toFixed(3));
  ts.add(c.end);
  for (const k of c.viewKeys ?? []) if (k.t >= c.start && k.t <= c.end) ts.add(k.t);
  return [...ts].sort((a, b) => a - b).map((t) => {
    const v = viewAt(c.view, c.viewKeys, t);
    return { t, v: { ...v, dist: v.dist ?? c.view?.dist } };
  });
}

/** Runs of samples where `bad` holds, as [first, last] source times with the worst value. */
function runs(ss: { t: number; v: View }[], bad: (v: View) => number | null): { from: number; to: number; worst: number }[] {
  const out: { from: number; to: number; worst: number }[] = [];
  let cur: { from: number; to: number; worst: number } | null = null;
  for (const s of ss) {
    const x = bad(s.v);
    if (x == null) { cur = null; continue; }
    if (cur) { cur.to = s.t; if (Math.abs(x) > Math.abs(cur.worst)) cur.worst = x; }
    else { cur = { from: s.t, to: s.t, worst: x }; out.push(cur); }
  }
  return out;
}

export function reviewDraft(d: Draft, assets: Map<string, Asset>, o = REVIEW): Finding[] {
  const hw = aspectHW(d.aspect);
  const st = starts(d);
  const out: Finding[] = [];
  d.clips.forEach((c, i) => {
    if (isGap(c) || c.disabled) return;
    const at = (src: number) => st[i] + Math.max(0, src - c.start) / (c.speed || 1);
    if (clipDur(c) < o.shortClip) out.push({ kind: "short", clip: c.id, at: st[i], text: `클립 ${i + 1}(${c.id})이 ${clipDur(c).toFixed(2)}초로 너무 짧습니다 (${o.shortClip}초 미만)` });
    if (!is360(assets.get(c.asset)) || c.viewPreset === "planet") return;
    const ss = samples(c, o.step);
    for (const r of runs(ss, (v) => (Math.abs(v.pitch) > o.pitch ? v.pitch : null)))
      out.push({ kind: "pitch", clip: c.id, at: at(r.from), to: at(r.to), text: `클립 ${i + 1}(${c.id}) ${fmt(at(r.from))}–${fmt(at(r.to))}: pitch ${r0(r.worst)}° (${r.worst < 0 ? "아래를 너무 내려다봄" : "위를 너무 올려다봄"}, quick_action level로 ±${o.pitch} 안으로. 스크립트로 시점 키를 직접 고치지 마세요)` });
    for (const r of runs(ss, (v) => { const s = cornerStretch(v.hfov, clampDist(v.dist), hw); return s > o.stretch ? s : null; }))
      out.push({ kind: "stretch", clip: c.id, at: at(r.from), to: at(r.to), text: `클립 ${i + 1}(${c.id}) ${fmt(at(r.from))}–${fmt(at(r.to))}: 모서리가 ${r.worst.toFixed(2)}배 늘어남 (quick_action undistort나 view.wide로)` });
    for (const r of runs(ss, (v) => (Math.abs(v.pitch) > vfovOf(v.hfov, clampDist(v.dist), hw) / 2 - 2 ? v.pitch : null)))
      out.push({ kind: "horizon", clip: c.id, at: at(r.from), to: at(r.to), text: `클립 ${i + 1}(${c.id}) ${fmt(at(r.from))}–${fmt(at(r.to))}: 수평선이 화면 밖 (pitch ${r0(r.worst)}°, quick_action level로)` });
  });
  for (const j of cutJumps(d, assets)) {
    if (j.turn <= o.turn) continue;
    const i = d.clips.findIndex((c) => c.id === j.clip);
    out.push({ kind: "jump", clip: j.clip, at: st[i], text: `${fmt(st[i])} 컷(클립 ${i + 1}, ${j.clip}): 같은 촬영인데 방향이 ${j.turn}° 갑자기 바뀜 (quick_action smooth.dir로 잇거나 시점을 맞추세요)` });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The review as the AI reads it. */
export function reviewText(d: Draft, assets: Map<string, Asset>, max = 40): string {
  const f = reviewDraft(d, assets);
  if (!f.length) return `편집본 "${d.name}" 점검: 문제 없음 (360 시점 ±${REVIEW.pitch}°, 모서리 늘어짐 ×${REVIEW.stretch} 이하, 수평선 보임, 컷 방향 변화 ${REVIEW.turn}° 이하, ${REVIEW.shortClip}초 넘는 클립).`;
  const count = (k: Finding["kind"]) => f.filter((x) => x.kind === k).length;
  const head = `편집본 "${d.name}" 점검: ${f.length}건 (내려다봄·올려다봄 ${count("pitch")}, 모서리 늘어짐 ${count("stretch")}, 수평선 없음 ${count("horizon")}, 컷 방향 튐 ${count("jump")}, 짧은 클립 ${count("short")}). 고친 뒤 다시 review_draft로 확인하세요. 화면은 check_framing이나 view_frames로 보세요.`;
  return [head, ...f.slice(0, max).map((x) => `- ${x.text}`), ...(f.length > max ? [`… 외 ${f.length - max}건`] : [])].join("\n");
}
