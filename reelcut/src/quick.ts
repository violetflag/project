// The basic toolbar buttons (2.18): 수평 맞추기, 흔들림 줄이기, 소리 고르게. They work without the AI,
// apply to the selected clip or the whole draft, and the AI can run them too (quick_action).
import { registerAction, type ActionDef, type ActionOut } from "./actions";
import { api } from "./api";
import { draftDuration, is360, isGap, r3, stabFor, updateClip } from "./edit";
import { aspectHW, clampDist, vfovOf } from "./proj";
import { assetMap } from "./store";
import type { Asset, Clip, Draft, Stab, View } from "./types";

/** What a 360 clip uses when neither it nor its media says otherwise (see src/ui/Stab360.tsx). */
export const DEFAULT_STAB: Stab = { mode: "horizon", strength: 1, rs: true };
export const TARGET_LUFS = -16;
/** Per-clip gain from 소리 고르게 stays within ±12 dB. */
export const MAX_GAIN_DB = 12;
export const STRENGTHS = [{ v: 0.5, label: "약" }, { v: 1, label: "보통" }, { v: 2, label: "강" }];
const strengthName = (v: number) => STRENGTHS.reduce((a, b) => (Math.abs(b.v - v) < Math.abs(a.v - v) ? b : a)).label;

const is360Clip = (c: Clip, am: Map<string, Asset>) => !isGap(c) && is360(am.get(c.asset));
const has360 = (clips: Clip[]) => { const am = assetMap(); return clips.some((c) => is360Clip(c, am)); };

/** Widest pitch (up or down) that still shows the horizon: 30°, or less when the view is short. */
export function levelLimit(v: Pick<View, "hfov"> & { dist?: number }, hw: number): number {
  return Math.max(0, Math.min(30, vfovOf(v.hfov, clampDist(v.dist), hw) / 2 - 5));
}
function levelView(v: View, hw: number, keepPitch = false): View {
  const lim = levelLimit(v, hw);
  return { ...v, roll: 0, pitch: keepPitch ? v.pitch : r3(Math.max(-lim, Math.min(lim, v.pitch))) };
}

/** 수평 맞추기 on one clip: horizon lock on, no tilt, pitch where the horizon stays in the picture. */
export function levelClip(c: Clip, a: Asset | undefined, hw: number): { clip: Clip; stab: boolean; roll: boolean; pitch: [number, number] | null } {
  const eff = stabFor(c, a) ?? DEFAULT_STAB;
  const stab = eff.mode === "off" || eff.mode === "smooth";
  // A little planet looks straight down on purpose.
  const planet = c.viewPreset === "planet";
  const view = c.view ? levelView(c.view, hw, planet) : c.view;
  const keys = c.viewKeys?.map((k) => ({ ...k, view: levelView(k.view, hw, planet) }));
  const rolled = (c.view?.roll ?? 0) !== 0 || !!c.viewKeys?.some((k) => k.view.roll !== 0);
  const pitches = [c.view, ...(c.viewKeys ?? []).map((k) => k.view)].filter(Boolean) as View[];
  const after = [view, ...(keys ?? []).map((k) => k.view)].filter(Boolean) as View[];
  // The pitch furthest from level, before and after.
  const worst = (vs: View[]) => vs.reduce((m, v) => (Math.abs(v.pitch) > Math.abs(m) ? v.pitch : m), 0);
  const pitch: [number, number] | null = pitches.some((v, i) => v.pitch !== after[i].pitch) ? [Math.round(worst(pitches)), Math.round(worst(after))] : null;
  if (!stab && !rolled && !pitch) return { clip: c, stab: false, roll: false, pitch: null };
  return { clip: { ...c, ...(stab ? { stab: { ...eff, mode: "horizon" } } : {}), view, viewKeys: keys }, stab, roll: rolled, pitch };
}

/** 흔들림 줄이기 on one clip: a strength (off becomes smooth, horizon and lock stay) or a mode. */
export function stabClip(c: Clip, a: Asset | undefined, p: { strength?: number; mode?: "lock" | "off" }): Clip {
  const eff = stabFor(c, a) ?? DEFAULT_STAB;
  const next: Stab = p.mode === "off" ? { ...eff, mode: "off" }
    : p.mode === "lock" ? { ...eff, mode: "lock" }
    : { ...eff, mode: eff.mode === "off" ? "smooth" : eff.mode, strength: p.strength ?? 1 };
  return JSON.stringify(next) === JSON.stringify(eff) ? c : { ...c, stab: next };
}

/** Gain (volume factor) that brings a clip measured at `lufs` to the target, within ±12 dB. */
export function gainFor(lufs: number, target = TARGET_LUFS): number {
  const db = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, target - lufs));
  return Math.round(10 ** (db / 20) * 1000) / 1000;
}
const loudCache = new Map<string, number>();
export async function measure(path: string, start: number, dur: number): Promise<number> {
  const k = `${path}|${r3(start)}|${r3(dur)}`;
  const hit = loudCache.get(k);
  if (hit != null) return hit;
  const { i } = await api.loudness(path, start, dur);
  loudCache.set(k, i);
  return i;
}

const quick: ActionDef[] = [
  {
    id: "level", group: "기본", label: "수평 맞추기", icon: "Ruler", key: "Alt+Shift+H",
    tooltip: "수평선을 똑바로: 기울기 보정을 켜고, 수평선이 화면에 보이도록 위아래 각도를 맞춥니다",
    enabled: (d) => has360(d.clips),
    run: ({ draft, clips }): ActionOut => {
      const am = assetMap(), hw = aspectHW(draft.aspect);
      let d = draft, n = 0, stabN = 0, rollN = 0, pitchN = 0;
      let from = 0, to = 0;
      const skipped: string[] = [];
      for (const c of clips) {
        if (!is360Clip(c, am)) { if (!isGap(c)) skipped.push(c.id); continue; }
        const r = levelClip(c, am.get(c.asset), hw);
        if (r.clip === c) continue;
        n++; if (r.stab) stabN++; if (r.roll) rollN++;
        if (r.pitch) { pitchN++; if (Math.abs(r.pitch[0]) > Math.abs(from)) { from = r.pitch[0]; to = r.pitch[1]; } }
        d = updateClip(d, c.id, { stab: r.clip.stab, view: r.clip.view, viewKeys: r.clip.viewKeys });
      }
      const parts = [stabN && `수평 보정 켬 ${stabN}개`, rollN && `기울기 0 (${rollN}개)`, pitchN && `pitch ${from}→${to}${pitchN > 1 ? ` 등 ${pitchN}개` : ""}`].filter(Boolean);
      return { draft: d, changed: n, detail: `수평 맞추기: ${parts.join(", ")}`, skipped };
    },
  },
  {
    id: "stab", group: "기본", label: "흔들림 줄이기", icon: "Vibrate", key: "Alt+Shift+J", marks: "stab",
    tooltip: "흔들림을 줄입니다. 화살표: 약·보통·강·방향 고정·끄기",
    enabled: (d) => has360(d.clips),
    run: ({ draft, clips, params }): ActionOut => {
      const am = assetMap();
      const mode = params.mode === "lock" || params.mode === "off" ? params.mode : undefined;
      const strength = Number(params.strength ?? 1) || 1;
      let d = draft, n = 0;
      for (const c of clips) {
        if (!is360Clip(c, am)) continue;
        const nc = stabClip(c, am.get(c.asset), { strength, mode });
        if (nc === c) continue;
        n++;
        d = updateClip(d, c.id, { stab: nc.stab });
      }
      const what = mode === "off" ? "끔" : mode === "lock" ? "방향 고정" : strengthName(strength);
      return { draft: d, changed: n, detail: `흔들림 줄이기 ${what} (${n}개 클립)` };
    },
  },
  {
    id: "loud", group: "기본", label: "소리 고르게", icon: "Gauge", key: "Alt+Shift+L", marks: "volume",
    tooltip: `클립마다 소리 크기를 ${TARGET_LUFS} LUFS로 맞추고, 내보낼 때 전체 음량을 고르게 합니다`,
    enabled: (d) => d.clips.some((c) => !isGap(c)) || draftDuration(d) > 0,
    run: async ({ clips }): Promise<ActionOut> => {
      const am = assetMap();
      const gains = new Map<string, number>();
      const skipped: string[] = [];
      for (const c of clips) {
        const a = am.get(c.asset);
        if (isGap(c) || !a?.info.has_audio || c.detached) continue;
        try {
          const lufs = await measure(a.info.path, c.start, Math.max(0.1, c.end - c.start));
          if (!(lufs > -60)) { skipped.push(c.id); continue; } // silence: leave it
          gains.set(c.id, gainFor(lufs));
        } catch {
          skipped.push(c.id);
        }
      }
      const dbs = [...gains.values()].map((g) => 20 * Math.log10(g));
      const range = dbs.length ? `${Math.min(...dbs) >= 0 ? "+" : ""}${Math.min(...dbs).toFixed(1)}~${Math.max(...dbs) >= 0 ? "+" : ""}${Math.max(...dbs).toFixed(1)} dB` : "";
      let changed = 0;
      // Applied to the draft as it is now (the user may have edited while it measured).
      const edit = (d: Draft): Draft => {
        let x = d;
        changed = 0;
        for (const [id, g] of gains) {
          const c = x.clips.find((y) => y.id === id);
          if (c && Math.abs((c.volume ?? 1) - g) > 0.0015) { x = updateClip(x, id, { volume: g }); changed++; }
        }
        if (!x.fx?.loudnorm || x.fx.lufs !== TARGET_LUFS) { x = { ...x, fx: { ...x.fx, loudnorm: true, lufs: TARGET_LUFS } }; changed++; }
        return x;
      };
      return {
        edit, get changed() { return changed; },
        get detail() { return `소리 고르게: 클립 ${gains.size}개를 ${TARGET_LUFS} LUFS로${range ? ` (${range})` : ""}, 내보낼 때 전체 음량 고르게${skipped.length ? ` · 측정 못 함 ${skipped.length}개` : ""}`; },
        skipped,
      };
    },
  },
];
for (const a of quick) registerAction(a);
