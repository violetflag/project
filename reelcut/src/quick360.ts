// 360 toolbar buttons (2.18): view presets (최적·확대·광각·초광각·작은 행성), 왜곡 보정 in one click,
// 시점 다시 맞추기 (follow the people again with the level rules, no AI), and 방향 이어 붙이기 (no
// sudden turns at cuts within one recording). Registered in group "360", so the toolbar shows them
// only when the draft has 360 clips.
import { registerAction, type ActionDef, type ActionOut } from "./actions";
import { is360, isGap, r3, updateClip, viewAt } from "./edit";
import { frameGroup, wrap180 } from "./framing";
import { aspectHW, fovMax, presetView, PRESET_LABEL, undistort } from "./proj";
import { levelLimit } from "./quick";
import { assetMap } from "./store";
import type { Asset, Clip, Draft, View, ViewKey, ViewPreset } from "./types";

const is360Clip = (c: Clip, am: Map<string, Asset>) => !isGap(c) && is360(am.get(c.asset));
const any360 = (d: Draft) => { const am = assetMap(); return d.clips.some((c) => is360Clip(c, am)); };
/** Sorted keys, one per time (keeps dist, which the general key cleaner does not know yet). */
function sortKeys(ks: ViewKey[]): ViewKey[] {
  const out: ViewKey[] = [];
  for (const k of [...ks].sort((a, b) => a.t - b.t)) {
    if (out.length && k.t - out[out.length - 1].t < 0.001) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

/** A turn bigger than this between two cuts of one recording is a jump. */
export const JUMP_DEG = 45;
/** How long the turn across such a cut takes, seconds of the clip. */
export const JOIN_SECONDS = 0.6;

/** A preset on one view: width and dist; pitch to the preset's (best/planet) when allowed, else kept level. */
export function presetOnView(v: View, p: ViewPreset, aspect: string, setPitch: boolean): View {
  const x = presetView(aspect, p);
  const hw = aspectHW(aspect);
  const out: View = { ...v, hfov: x.hfov, dist: x.dist };
  if (p === "planet") return { ...out, pitch: -90, roll: 0 };
  if (setPitch && p === "best") return { ...out, pitch: x.pitch };
  const lim = levelLimit(out, hw);
  return { ...out, pitch: r3(Math.max(-lim, Math.min(lim, v.pitch === -90 ? 0 : v.pitch))) };
}

export function presetClip(c: Clip, p: ViewPreset, aspect: string): Clip {
  const base = c.view ?? { yaw: 0, pitch: 0, roll: 0, hfov: 100 };
  // The preset's own pitch only where nothing was aimed: no keys and no hand-set view.
  const setPitch = !c.viewKeys?.length && !c.userSet?.view;
  const view = presetOnView(base, p, aspect, setPitch);
  const viewKeys = c.viewKeys?.map((k) => ({ ...k, view: presetOnView(k.view, p, aspect, false) }));
  const same = JSON.stringify(view) === JSON.stringify(c.view) && JSON.stringify(viewKeys) === JSON.stringify(c.viewKeys) && c.viewPreset === p;
  return same ? c : { ...c, view, viewKeys, viewPreset: p };
}

/** 왜곡 보정 on one clip (view and every key); the preset name goes, as the view is now its own. */
export function undistortClip(c: Clip, aspect: string): Clip {
  const hw = aspectHW(aspect);
  const fix = (v: View): View => { const u = undistort(v, hw); return u.dist === (v.dist ?? 0) && u.hfov === v.hfov ? v : { ...v, ...u }; };
  const view = c.view ? fix(c.view) : c.view;
  const viewKeys = c.viewKeys?.map((k) => { const v = fix(k.view); return v === k.view ? k : { ...k, view: v }; });
  const changed = view !== c.view || viewKeys?.some((k, i) => k !== c.viewKeys![i]);
  return changed ? { ...c, view, viewKeys, viewPreset: undefined } : c;
}

/** Cuts between clips of one recording where the view turns more than JUMP_DEG: the clip after and the turn. */
export function cutJumps(d: Draft, am: Map<string, Asset>): { clip: string; from: View; to: View; turn: number }[] {
  const out: { clip: string; from: View; to: View; turn: number }[] = [];
  for (let i = 1; i < d.clips.length; i++) {
    const a = d.clips[i - 1], b = d.clips[i];
    if (!is360Clip(a, am) || !is360Clip(b, am) || a.asset !== b.asset || (b.xin ?? 0) > 0) continue;
    const from = viewAt(a.view, a.viewKeys, a.end), to = viewAt(b.view, b.viewKeys, b.start);
    const turn = Math.abs(wrap180(to.yaw - from.yaw));
    if (turn > JUMP_DEG) out.push({ clip: b.id, from, to, turn: Math.round(turn) });
  }
  return out;
}

const presets: ViewPreset[] = ["best", "zoom", "wide", "ultra", "planet"];
const ICON: Record<ViewPreset, string> = { best: "Focus", zoom: "ZoomIn", wide: "Expand", ultra: "Aperture", planet: "Globe" };
const TIP: Record<ViewPreset, string> = {
  best: "사람 눈과 비슷한 자연스러운 화면 (수평선이 위 1/3에 오도록)",
  zoom: "가까이 (좁은 화각)",
  wide: "넓게, 모서리 늘어짐은 줄여서",
  ultra: "아주 넓게 (주변 전체)",
  planet: "작은 행성 모양 (아래를 내려다보는 둥근 화면)",
};
const KEY: Partial<Record<ViewPreset, string>> = { best: "Alt+Shift+1", zoom: "Alt+Shift+2", wide: "Alt+Shift+3", ultra: "Alt+Shift+4" };

const actions: ActionDef[] = [
  ...presets.map((p): ActionDef => ({
    id: `view.${p}`, group: "360", label: PRESET_LABEL[p], icon: ICON[p], tooltip: TIP[p], key: KEY[p],
    enabled: any360,
    run: ({ draft, clips }): ActionOut => {
      const am = assetMap();
      let d = draft, n = 0;
      for (const c of clips) {
        if (!is360Clip(c, am)) continue;
        const nc = presetClip(c, p, draft.aspect);
        if (nc === c) continue;
        n++;
        d = updateClip(d, c.id, { view: nc.view, viewKeys: nc.viewKeys, viewPreset: p });
      }
      const x = presetView(draft.aspect, p);
      return { draft: d, changed: n, detail: `${PRESET_LABEL[p]}: 화각 ${x.hfov}°, 왜곡 보정 ${x.dist} (${n}개 클립)` };
    },
  })),
  {
    id: "undistort", group: "360", label: "왜곡 보정", icon: "LensConvex", key: "Alt+Shift+D",
    tooltip: "넓은 화각에서 모서리가 늘어나는 것을 한 번에 바로잡습니다 (짧은 변의 화각은 그대로)",
    enabled: any360,
    run: ({ draft, clips }): ActionOut => {
      const am = assetMap();
      let d = draft, n = 0;
      let from = "", to = "";
      for (const c of clips) {
        if (!is360Clip(c, am)) continue;
        const nc = undistortClip(c, draft.aspect);
        if (nc === c) continue;
        if (!from && c.view && nc.view) { from = `${Math.round(c.view.hfov)}°`; to = `${Math.round(nc.view.hfov)}° 왜곡 ${r3(nc.view.dist ?? 0)}`; }
        n++;
        d = updateClip(d, c.id, { view: nc.view, viewKeys: nc.viewKeys, viewPreset: undefined });
      }
      return { draft: d, changed: n, detail: `왜곡 보정: ${from ? `${from}→${to}` : ""}${n > 1 ? ` 등 ${n}개 클립` : ""}` };
    },
  },
  {
    id: "reframe", group: "360", label: "시점 다시 맞추기", icon: "ScanEye", key: "Alt+Shift+R",
    tooltip: "찾아 둔 사람을 새 기준(수평선 보이게, ±30도)으로 다시 따라갑니다. AI 대화 없이. 직접 맞춘 클립은 Shift를 누른 채로만",
    enabled: (d) => d.clips.some((c) => c.subjects?.length),
    run: ({ draft, clips, params }): ActionOut => {
      const am = assetMap();
      const [w, h] = draft.aspect.split(":").map(Number);
      const aspect = w / h || 16 / 9;
      // Shift+click (scope "draft") or the AI's override also redoes clips the user aimed by hand.
      const force = !!params.force || !!params.override_user;
      let d = draft, n = 0;
      const skipped: string[] = [];
      for (const c of clips) {
        if (!is360Clip(c, am) || !c.subjects?.length) continue;
        if (c.userSet?.view && !force) { skipped.push(c.id); continue; }
        const { keys } = frameGroup(c.subjects, c.start, c.end, { aspect });
        if (!keys.length) { skipped.push(c.id); continue; }
        const viewKeys = sortKeys(keys.map((k) => ({ t: k.t, view: c.view?.dist ? { ...k.view, dist: c.view.dist } : k.view })));
        if (JSON.stringify(viewKeys) === JSON.stringify(c.viewKeys)) continue;
        n++;
        d = updateClip(d, c.id, { viewKeys, viewPreset: undefined });
      }
      return { draft: d, changed: n, detail: `시점 다시 맞추기: ${n}개 클립${skipped.length ? ` (직접 맞춘 클립 등 ${skipped.length}개 건너뜀)` : ""}`, skipped };
    },
  },
  {
    id: "smooth.dir", group: "360", label: "방향 이어 붙이기", icon: "Route",
    tooltip: `같은 촬영에서 컷마다 방향이 ${JUMP_DEG}도 넘게 확 바뀌는 곳을 ${JOIN_SECONDS}초 동안 부드럽게 돌려 잇습니다`,
    enabled: any360,
    run: ({ draft, clips }): ActionOut => {
      const am = assetMap();
      const inScope = new Set(clips.map((c) => c.id));
      let d = draft, n = 0;
      const skipped: string[] = [];
      for (const j of cutJumps(draft, am)) {
        const c = d.clips.find((x) => x.id === j.clip)!;
        if (!inScope.has(c.id)) continue;
        if (c.userSet?.view) { skipped.push(c.id); continue; }
        const span = Math.min(JOIN_SECONDS * (c.speed || 1), (c.end - c.start) / 2);
        // Interpolated views lose the projection setting; the clip keeps its own.
        const dist = (v: View): View => (c.view?.dist != null ? { ...v, dist: c.view.dist } : v);
        const own: ViewKey[] = c.viewKeys?.length ? c.viewKeys.filter((k) => k.t > c.start + span) : [];
        const keys: ViewKey[] = sortKeys([
          { t: r3(c.start), view: dist({ ...j.to, yaw: j.from.yaw, pitch: j.from.pitch }) },
          { t: r3(c.start + span), view: dist(j.to) },
          ...own,
          ...(own.length ? [] : [{ t: r3(c.end), view: dist(viewAt(c.view, c.viewKeys, c.end)) }]),
        ]);
        n++;
        d = updateClip(d, c.id, { viewKeys: keys });
      }
      return { draft: d, changed: n, detail: `방향 이어 붙이기: 컷 ${n}곳${skipped.length ? ` (직접 맞춘 클립 ${skipped.length}개 건너뜀)` : ""}`, skipped };
    },
  },
];
for (const a of actions) registerAction(a);

/** The widest the wheel/slider may open a view with this dist. */
export const viewFovMax = (v: Pick<View, "dist">) => fovMax(v.dist ?? 0);
